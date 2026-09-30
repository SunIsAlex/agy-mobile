#!/usr/bin/env node
// ccm-bridge: runs Claude Code sessions and exposes them to the CC Mobile app.
//
// Transport: newline-delimited JSON over TCP. The first line from a client must be
// {"op":"hello","token":"..."}; anything else closes the connection.
// Each session is a `claude -p` process speaking stream-json on stdio, with
// permission prompts routed to the app (--permission-prompt-tool stdio).

import { spawn, execFile } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_ONLY as PHONE_READ_ONLY } from './phone-mcp.mjs';

const VERSION = 1;
const MAX_EVENTS = 4000;
const MAX_DIFF_BYTES = 1_000_000;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// Image types and size the Messages API takes inline; other files are only saved for Claude to Read.
const INLINE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_INLINE_IMAGE_BYTES = 3_750_000; // 5 MB once base64-encoded

// ---------- args & config ----------

function parseArgs(argv) {
  const opts = { host: '127.0.0.1', port: 8765, roots: [os.homedir()], pair: false, showToken: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--host') opts.host = next();
    else if (a === '--port') opts.port = Number(next());
    else if (a === '--roots') opts.roots = next().split(',').map((r) => path.resolve(r.replace(/^~/, os.homedir())));
    else if (a === '--pair') opts.pair = true;
    else if (a === '--show-token') opts.showToken = true;
    else if (a === '--state-dir') opts.stateDir = next();
    else if (a === '-h' || a === '--help') {
      console.log(`Usage: ccm-bridge [--host 127.0.0.1] [--port 8765] [--roots ~/src,~/work] [--pair] [--show-token]

  --host        Interface to listen on. Keep 127.0.0.1 on the phone. On a computer,
                bind a private interface (e.g. Tailscale) — traffic is not encrypted.
  --roots       Folders scanned (two levels deep) for git repositories.
  --pair        Open the app's pairing screen with this bridge's address and token.
  --show-token  Print the access token.`);
      process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const stateDir = opts.stateDir ?? path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'ccm-bridge');
const sessionsDir = path.join(stateDir, 'sessions');
const attachmentsDir = path.join(stateDir, 'attachments');
fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
const phoneMcp = path.join(path.dirname(fileURLToPath(import.meta.url)), 'phone-mcp.mjs');
const claudeBin = process.env.CCM_CLAUDE_BIN ?? 'claude';
const claudeProjectsDir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
// bypassPermissions is the app's "YOLO" mode: tools run without asking. Claude Code still sends
// writes to settings, git and tool-configuration files to the permission handler (the app).
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'manual', 'dontAsk', 'bypassPermissions'];

function loadToken() {
  const file = path.join(stateDir, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {}
  const t = randomBytes(24).toString('base64url');
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}
const token = loadToken();

function tokenMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- sessions ----------

/** @type {Map<string, Session>} */
const sessions = new Map();
/** @type {Set<Client>} */
const clients = new Set();

class Session {
  constructor({ id, cwd, title, model, mode, createdAt, status, phone }) {
    this.id = id;
    this.cwd = cwd;
    this.title = title;
    this.model = model ?? null;
    this.mode = mode ?? 'default';
    this.phone = !!phone; // "Phone use": the phone MCP server is attached
    this.createdAt = createdAt ?? Date.now();
    this.updatedAt = this.createdAt;
    this.status = status ?? 'idle'; // working | needs_approval | idle | stopped | error
    this.lastActivity = '';
    this.events = [];
    this.pending = new Map(); // request_id -> control_request message
    this.proc = null;
    this.stdoutBuf = '';
    this.started = false; // true once claude has created this session id on disk
    this.costUsd = 0;
  }

  summary() {
    return {
      id: this.id, cwd: this.cwd, title: this.title, model: this.model, mode: this.mode,
      status: this.status, createdAt: this.createdAt, updatedAt: this.updatedAt,
      lastActivity: this.lastActivity, pending: this.pending.size, costUsd: this.costUsd,
      running: this.proc !== null, phone: this.phone,
    };
  }

  get logFile() { return path.join(sessionsDir, `${this.id}.jsonl`); }
  get attachmentsDir() { return path.join(attachmentsDir, this.id); }

  persistMeta() {
    if (this.archived) return;
    const meta = { ...this.summary(), started: this.started, cliSize: this.cliSize };
    fs.writeFileSync(path.join(sessionsDir, `${this.id}.json`), JSON.stringify(meta));
  }

  record(msg) {
    this.events.push(msg);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    fs.appendFile(this.logFile, JSON.stringify(msg) + '\n', () => {});
  }

  setStatus(status, activity) {
    this.status = status;
    if (activity !== undefined) this.lastActivity = activity;
    this.updatedAt = Date.now();
    this.persistMeta();
    broadcast({ ev: 'session', session: this.summary() });
  }

  ensureProcess() {
    if (this.proc) return;
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio',
      '--permission-mode', this.mode,
      // Only makes YOLO available, so setMode() can switch a running session into it.
      '--allow-dangerously-skip-permissions',
    ];
    if (this.model) args.push('--model', this.model);
    // Attachments are saved here; allowing the folder lets Claude Read them without asking.
    fs.mkdirSync(this.attachmentsDir, { recursive: true, mode: 0o700 });
    args.push('--add-dir', this.attachmentsDir);
    if (this.phone) {
      const config = { mcpServers: { phone: { type: 'stdio', command: process.execPath, args: [phoneMcp], env: process.env.CCM_SU ? { CCM_SU: process.env.CCM_SU } : {} } } };
      args.push('--mcp-config', JSON.stringify(config), '--append-system-prompt', PHONE_PROMPT,
        '--allowedTools', PHONE_READ_ONLY.map((t) => `mcp__phone__${t}`).join(','));
    }
    args.push(...(this.started ? ['--resume', this.id] : ['--session-id', this.id]));

    const proc = spawn(claudeBin, args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.proc = proc;
    this.started = true;
    this.persistMeta();
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.onStdout(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => {
      this.emitLocal({ type: 'bridge', subtype: 'error', message: `Could not start claude: ${err.message}` });
    });
    proc.on('exit', (code, signal) => {
      this.proc = null;
      try { this.cliSize = fs.statSync(findCliTranscript(this.id)).size; } catch {}
      this.pending.clear();
      if (this.status === 'stopped') { this.setStatus('stopped'); return; }
      if (code === 0 || signal === 'SIGTERM') this.setStatus('idle');
      else {
        this.emitLocal({ type: 'bridge', subtype: 'error', message: `claude exited (${code ?? signal}). ${stderr.trim().slice(-800)}` });
        this.setStatus('error', 'claude exited unexpectedly');
      }
    });
    this.writeCli({ type: 'control_request', request_id: `init-${randomUUID()}`, request: { subtype: 'initialize' } });
  }

  writeCli(obj) {
    if (!this.proc) return false;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  onStdout(chunk) {
    this.stdoutBuf += chunk;
    let nl;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.onCliMessage(msg);
    }
  }

  onCliMessage(msg) {
    // The initialize reply lists every command and skill: large and not useful to the app.
    if (msg.type === 'control_response') return;
    // Partial deltas are forwarded live but not stored; the final message replaces them.
    if (msg.type === 'stream_event') { sendToSubscribers(this.id, { ev: 'cli', sid: this.id, msg }); return; }
    if (msg.type === 'rate_limit_event') { onRateLimit(msg.rate_limit_info); return; }
    if (msg.type === 'system' && msg.subtype === 'thinking_tokens') return;
    if (msg.type === 'system' && msg.subtype === 'init') {
      msg = { type: 'system', subtype: 'init', model: msg.model, cwd: msg.cwd, permissionMode: msg.permissionMode, session_id: msg.session_id };
    }

    this.record(msg);
    sendToSubscribers(this.id, { ev: 'cli', sid: this.id, msg });

    if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
      this.pending.set(msg.request_id, msg);
      this.setStatus('needs_approval', `${msg.request.display_name ?? msg.request.tool_name}: ${describeInput(msg.request.input)}`);
      broadcast({ ev: 'approval', sid: this.id, title: this.title, request: msg });
    } else if (msg.type === 'control_cancel_request') {
      this.pending.delete(msg.request_id);
      if (this.pending.size === 0 && this.status === 'needs_approval') this.setStatus('working');
    } else if (msg.type === 'assistant') {
      const tool = msg.message?.content?.find((c) => c.type === 'tool_use');
      const text = msg.message?.content?.find((c) => c.type === 'text');
      if (this.status !== 'needs_approval') {
        this.setStatus('working', tool ? `${tool.name}: ${describeInput(tool.input)}` : text ? text.text.slice(0, 120) : this.lastActivity);
      }
    } else if (msg.type === 'result') {
      this.costUsd += msg.total_cost_usd ?? 0;
      this.setStatus(msg.is_error ? 'error' : 'idle', msg.is_error ? (msg.result ?? 'Error') : 'Waiting for you');
    }
  }

  // Events the bridge itself adds to a transcript (errors, user prompts).
  emitLocal(msg) {
    this.record(msg);
    sendToSubscribers(this.id, { ev: 'cli', sid: this.id, msg });
  }

  sendUser(text, attachments = []) {
    const saved = this.saveAttachments(attachments);
    this.ensureProcess();
    let content = text;
    if (saved.length) {
      const list = saved.map((a) => `- ${a.path} (${a.mime}, ${formatBytes(a.size)}${a.inline ? ', image included below' : ''})`).join('\n');
      content = [
        { type: 'text', text: `${text || 'See the attached files.'}\n\nAttached files, saved on this machine:\n${list}` },
        ...saved.filter((a) => a.inline).map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } })),
      ];
    }
    // The stored copy keeps file names, not file contents.
    this.emitLocal({
      type: 'user', message: { role: 'user', content: text }, local: true,
      ...(saved.length ? { attachments: saved.map(({ name, mime, size, path: p }) => ({ name, mime, size, path: p })) } : {}),
    });
    this.writeCli({ type: 'user', message: { role: 'user', content } });
    this.setStatus('working', 'Thinking');
  }

  /** Writes attachments ({name, mime, data: base64}) to this session's folder. */
  saveAttachments(list) {
    if (!Array.isArray(list) || !list.length) return [];
    if (list.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} attachments per message`);
    fs.mkdirSync(this.attachmentsDir, { recursive: true, mode: 0o700 });
    return list.map((a) => {
      const bytes = Buffer.from(String(a.data ?? ''), 'base64');
      if (!bytes.length) throw new Error(`Attachment ${a.name} is empty`);
      if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment ${a.name} is over ${formatBytes(MAX_ATTACHMENT_BYTES)}`);
      const name = uniqueName(this.attachmentsDir, path.basename(String(a.name || 'file')).replace(/[\x00-\x1f/\\]/g, '_').replace(/^\.+/, '') || 'file');
      const file = path.join(this.attachmentsDir, name);
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      const mime = String(a.mime || 'application/octet-stream');
      const inline = INLINE_IMAGE_TYPES.includes(mime) && bytes.length <= MAX_INLINE_IMAGE_BYTES;
      return { name, mime, size: bytes.length, path: file, inline, data: inline ? bytes.toString('base64') : undefined };
    });
  }

  setPhone(on) {
    if (on && !phoneAvailable) throw new Error('Phone use needs the bridge running in Termux with root (su).');
    this.phone = on;
    // MCP servers are fixed at launch; the next message restarts claude with --resume.
    if (this.proc) this.proc.kill('SIGTERM');
    this.emitLocal({ type: 'bridge', subtype: 'note', message: on ? 'Phone use on: Claude can see and operate this phone' : 'Phone use off' });
    this.setStatus(this.status === 'working' || this.status === 'needs_approval' ? 'idle' : this.status);
  }

  answer(requestId, decision, always, message) {
    const req = this.pending.get(requestId);
    if (!req) return false;
    this.pending.delete(requestId);
    const response = decision === 'allow'
      ? { behavior: 'allow', updatedInput: req.request.input, ...(always && req.request.permission_suggestions ? { updatedPermissions: req.request.permission_suggestions.filter((s) => s.type === 'addRules') } : {}) }
      : { behavior: 'deny', message: message || 'The user denied this from the CC Mobile app.' };
    this.writeCli({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.emitLocal({ type: 'bridge', subtype: 'permission_answer', request_id: requestId, decision, always: !!always });
    if (this.pending.size === 0) this.setStatus('working', decision === 'allow' ? 'Approved' : 'Denied');
    return true;
  }

  setMode(mode) {
    this.mode = mode;
    this.writeCli({ type: 'control_request', request_id: `mode-${randomUUID()}`, request: { subtype: 'set_permission_mode', mode } });
    this.emitLocal({ type: 'bridge', subtype: 'note', message: mode === 'bypassPermissions' ? 'YOLO mode on: tools run without asking' : `Permission mode: ${mode}` });
    this.setStatus(this.status);
  }

  interrupt() {
    this.writeCli({ type: 'control_request', request_id: `int-${randomUUID()}`, request: { subtype: 'interrupt' } });
  }

  stop() {
    this.status = 'stopped';
    if (this.proc) this.proc.kill('SIGTERM');
    else this.setStatus('stopped');
  }

  // Appends turns taken outside the bridge (e.g. `claude --resume` in a terminal) from
  // Claude Code's own transcript, picking up after the last message the bridge has seen.
  syncFromCli() {
    if (this.proc) return;
    const file = findCliTranscript(this.id);
    if (!file) return;
    const { size, mtimeMs } = fs.statSync(file);
    if (size === this.cliSize) return;
    this.cliSize = size;
    const known = new Set(this.events.map((e) => e.uuid).filter(Boolean));
    const records = readJsonl(file);
    const last = records.findLastIndex((r) => known.has(r.uuid));
    const fresh = last < 0 ? [] : records.slice(last + 1).map(cliRecordToEvent).filter((e) => e && !known.has(e.uuid));
    if (fresh.length) {
      this.emitLocal({ type: 'bridge', subtype: 'note', message: 'Continued in Claude Code outside this app' });
      for (const e of fresh) this.emitLocal(e);
      this.updatedAt = Math.max(this.updatedAt, Math.round(mtimeMs));
      this.status = 'idle';
      broadcast({ ev: 'session', session: this.summary() });
    }
    this.persistMeta();
  }
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${stem}-${i}${ext}`;
  return candidate;
}

function formatBytes(n) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- phone use ----------

const PHONE_PROMPT = `You are also acting as the user's Android assistant. You run on their phone (Termux, root available), and the phone MCP tools let you see and operate it: screen_elements (accessibility tree with tap targets), screenshot, tap, long_press, swipe, type_text, key, list_apps, open_app, open_uri, set_alarm, set_timer.
- The user talks to you through the CC Mobile app (package app.ccmobile), which runs this session via Termux (com.termux). Never force-stop, clear or uninstall those two; switching to other apps is fine, and the user can come back with the app switcher.
- Prefer direct intents (set_alarm, set_timer, open_uri, open_app) over tapping through menus. When you must use the UI: look (screen_elements, or screenshot for visual detail), act, then look again to confirm the result.
- If the screen is off, press WAKEUP. If it is locked with a PIN, pattern or biometrics, ask the user to unlock it; don't try to guess credentials.
- Ask the user before anything hard to undo or that acts for them: sending messages or email, calls, purchases or payments, deleting data, changing security settings, posting publicly.
- For deeper debugging use Bash with su -c (logcat, dumpsys, settings, pm, am). Be careful with commands that can brick or wipe the device.
- Report what you did in a sentence or two.`;

// Resolved before the server starts listening, so hello can report it.
let phoneAvailable = false;
async function detectPhone() {
  if (process.env.CCM_PHONE) return process.env.CCM_PHONE === '1';
  if (process.platform !== 'android') return false;
  return new Promise((resolve) => execFile(process.env.CCM_SU ?? 'su', ['-c', 'id -u'], { timeout: 10_000 }, (err, out) => resolve(!err && out.trim() === '0')));
}

// ---------- Claude Code's own transcripts (~/.claude/projects/<cwd>/<session id>.jsonl) ----------

const CLI_HEAD_TAIL = 256 * 1024;

function readJsonl(file, text = fs.readFileSync(file, 'utf8')) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function findCliTranscript(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(claudeProjectsDir); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(claudeProjectsDir, d, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// Turns a transcript record into the stream-json message the CLI would have printed live,
// or null for bookkeeping the app doesn't show (attachments, titles, meta prompts, sub-agents).
function cliRecordToEvent(r) {
  if (r.isSidechain || r.isMeta || r.isCompactSummary) return null;
  if (r.type === 'system' && r.subtype === 'compact_boundary') return { type: 'system', subtype: 'compact_boundary', uuid: r.uuid };
  if ((r.type !== 'user' && r.type !== 'assistant') || !r.message) return null;
  let content = r.message.content;
  if (typeof content === 'string') {
    const cmd = content.match(/<command-name>([^<]*)<\/command-name>/);
    const args = content.match(/<command-args>([^<]*)<\/command-args>/)?.[1];
    const bash = content.match(/^<bash-input>([\s\S]*)<\/bash-input>$/);
    if (cmd) content = [cmd[1], args].filter(Boolean).join(' ');
    else if (bash) content = `!${bash[1]}`;
    else if (/^<(local-command-\w+|bash-std\w+)>/.test(content)) return null;
  }
  return { type: r.type, message: { ...r.message, content }, uuid: r.uuid, parent_tool_use_id: null };
}

function promptText(event) {
  const c = event?.message?.content;
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.find((b) => b.type === 'text')?.text ?? '' : '';
}

// What the resume list needs, read from the head and tail of the file so large transcripts stay cheap.
function cliSessionInfo(file) {
  const { size, mtimeMs, birthtimeMs } = fs.statSync(file);
  let text;
  if (size <= CLI_HEAD_TAIL * 2) text = fs.readFileSync(file, 'utf8');
  else {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(CLI_HEAD_TAIL);
    const tail = Buffer.alloc(CLI_HEAD_TAIL);
    fs.readSync(fd, head, 0, CLI_HEAD_TAIL, 0);
    fs.readSync(fd, tail, 0, CLI_HEAD_TAIL, size - CLI_HEAD_TAIL);
    fs.closeSync(fd);
    text = `${head.toString('utf8')}\n${tail.toString('utf8')}`; // cut lines fail to parse and are skipped
  }
  const info = { cwd: null, title: null, aiTitle: null, firstPrompt: null, lastPrompt: null, model: null, mode: null, createdAt: null };
  for (const r of readJsonl(file, text)) {
    if (r.cwd && !r.isSidechain) info.cwd ??= r.cwd;
    if (r.type === 'custom-title' && r.customTitle) info.title = r.customTitle;
    else if (r.type === 'ai-title' && r.aiTitle) info.aiTitle = r.aiTitle;
    else if (r.type === 'summary' && r.summary) info.aiTitle ??= r.summary;
    else if (r.type === 'last-prompt' && r.lastPrompt) info.lastPrompt = r.lastPrompt;
    else if (r.type === 'permission-mode' && r.permissionMode) info.mode = r.permissionMode;
    else if (r.type === 'assistant' && !r.isSidechain && r.message?.model && r.message.model !== '<synthetic>') info.model = r.message.model;
    else if (r.type === 'user' && !info.firstPrompt) {
      const event = cliRecordToEvent(r);
      const prompt = promptText(event).trim();
      if (prompt) { info.firstPrompt = prompt; info.createdAt = Date.parse(r.timestamp) || null; }
    }
    if (r.type === 'user' && !r.isSidechain && r.permissionMode) info.mode = r.permissionMode;
  }
  if (!info.firstPrompt) return null; // nothing was ever asked: not worth resuming
  const firstLine = (s) => s.split('\n')[0].slice(0, 100);
  return {
    cwd: info.cwd,
    title: firstLine(info.title ?? info.aiTitle ?? info.firstPrompt),
    lastPrompt: (info.lastPrompt ?? info.firstPrompt).slice(0, 200),
    model: info.model,
    mode: MODES.includes(info.mode) ? info.mode : 'default',
    createdAt: info.createdAt ?? Math.round(birthtimeMs || mtimeMs),
    updatedAt: Math.round(mtimeMs),
  };
}

/** Claude Code sessions on this machine that the bridge isn't already tracking, newest first. */
function listCliSessions(limit = 50) {
  const files = [];
  let dirs = [];
  try { dirs = fs.readdirSync(claudeProjectsDir); } catch { return []; }
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(claudeProjectsDir, d)); } catch { continue; }
    for (const n of names) {
      const id = n.slice(0, -'.jsonl'.length);
      if (!n.endsWith('.jsonl') || sessions.has(id)) continue;
      const file = path.join(claudeProjectsDir, d, n);
      try { files.push({ id, file, mtime: fs.statSync(file).mtimeMs }); } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const { id, file } of files) {
    if (out.length >= limit) break;
    let info;
    try { info = cliSessionInfo(file); } catch { continue; }
    if (info?.cwd && fs.existsSync(info.cwd)) out.push({ id, ...info });
  }
  return out;
}

/** Makes a Claude Code session started elsewhere into a bridge session; the next message runs `claude --resume`. */
function importCliSession(id) {
  const file = findCliTranscript(id);
  if (!file) throw new Error('No Claude Code session with that id on this machine.');
  const info = cliSessionInfo(file);
  if (!info?.cwd) throw new Error('That session has no conversation to resume.');
  if (!fs.existsSync(info.cwd)) throw new Error(`Its folder no longer exists: ${info.cwd}`);
  const s = new Session({ id, cwd: info.cwd, title: info.title, model: info.model, mode: info.mode, createdAt: info.createdAt });
  s.started = true;
  s.updatedAt = info.updatedAt;
  s.lastActivity = 'Resumed from Claude Code';
  s.cliSize = fs.statSync(file).size;
  const events = readJsonl(file).map(cliRecordToEvent).filter(Boolean);
  events.push({ type: 'bridge', subtype: 'note', message: 'Resumed from Claude Code. New messages continue this session.' });
  s.events = events.slice(-MAX_EVENTS);
  fs.writeFileSync(s.logFile, s.events.map((e) => JSON.stringify(e) + '\n').join(''));
  sessions.set(id, s);
  s.persistMeta();
  return s;
}

// ---------- usage ----------

// Plan limits come from the CLI's rate_limit_event, sent with every reply. They cover the whole
// account (claude.ai and every Claude Code), not just this bridge, so the latest one is kept.
const limitsFile = path.join(stateDir, 'limits.json');
let limits = null;
try { limits = JSON.parse(fs.readFileSync(limitsFile, 'utf8')); } catch {}

function onRateLimit(info) {
  if (!info) return;
  const windows = Object.entries(info.unifiedWindows ?? {})
    .filter(([, w]) => typeof w?.utilization === 'number')
    .map(([id, w]) => ({ id, utilization: w.utilization, resetsAt: (w.resetsAt ?? 0) * 1000 }));
  if (!windows.length && typeof info.utilization === 'number') {
    windows.push({ id: info.rateLimitType ?? 'five_hour', utilization: info.utilization, resetsAt: (info.resetsAt ?? 0) * 1000 });
  }
  if (!windows.length) return;
  limits = { status: info.status ?? 'allowed', windows, updatedAt: Date.now() };
  try { fs.writeFileSync(limitsFile, JSON.stringify(limits)); } catch {}
  broadcast({ ev: 'limits', limits });
}

// Token use per assistant message, read from Claude Code's transcripts (terminal and bridge
// sessions alike). Parsed files are cached until they change.
/** @type {Map<string, {mtimeMs: number, size: number, records: object[]}>} */
const usageCache = new Map();

function transcriptFiles(dir = claudeProjectsDir, depth = 0, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 3) transcriptFiles(f, depth + 1, out); }
    else if (e.name.endsWith('.jsonl')) out.push(f);
  }
  return out;
}

function usageRecords(file, stat) {
  const hit = usageCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.records;
  const records = [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const u = r.message?.usage;
    if (r.type !== 'assistant' || !u || r.message.model === '<synthetic>') continue;
    records.push({
      // A message split into several content blocks repeats its usage on each record.
      id: r.message.id ?? r.requestId ?? r.uuid,
      t: Date.parse(r.timestamp) || 0,
      model: r.message.model ?? 'unknown',
      cwd: r.cwd ?? '',
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    });
  }
  usageCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, records });
  return records;
}

/** Totals per day (in the caller's time zone), model and project over the last [days] days. */
function usageSummary(days, tzOffsetMin) {
  days = Math.min(Math.max(Math.trunc(days) || 7, 1), 90);
  const offset = (Number(tzOffsetMin) || 0) * 60_000;
  const dayOf = (t) => new Date(t + offset).toISOString().slice(0, 10);
  const today = Date.now();
  const byDay = new Map();
  for (let i = days - 1; i >= 0; i--) {
    byDay.set(dayOf(today - i * 86_400_000), { date: dayOf(today - i * 86_400_000), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });
  }
  const since = Date.parse(byDay.keys().next().value + 'T00:00:00Z') - offset;
  const byModel = new Map();
  const byProject = new Map();
  const seen = new Set();
  const sessionFiles = new Set();
  for (const file of transcriptFiles()) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (stat.mtimeMs < since) continue;
    for (const r of usageRecords(file, stat)) {
      if (r.t < since || seen.has(r.id)) continue;
      seen.add(r.id);
      const d = byDay.get(dayOf(r.t));
      if (!d) continue;
      sessionFiles.add(file);
      d.input += r.input; d.output += r.output; d.cacheRead += r.cacheRead; d.cacheWrite += r.cacheWrite; d.requests++;
      for (const [map, key] of [[byModel, r.model], [byProject, r.cwd]]) {
        const e = map.get(key) ?? { key, output: 0, input: 0, requests: 0 };
        e.output += r.output; e.input += r.input + r.cacheRead + r.cacheWrite; e.requests++;
        map.set(key, e);
      }
    }
  }
  const ranked = (map) => [...map.values()].sort((a, b) => b.output - a.output);
  return { days: [...byDay.values()], models: ranked(byModel), projects: ranked(byProject), sessions: sessionFiles.size };
}

function describeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  return typeof v === 'string' ? v.slice(0, 160) : '';
}

function loadSessions() {
  for (const f of fs.readdirSync(sessionsDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8'));
      const s = new Session({ ...meta, status: meta.status === 'stopped' || meta.status === 'error' ? meta.status : 'idle' });
      s.updatedAt = meta.updatedAt ?? s.createdAt;
      s.lastActivity = meta.lastActivity ?? '';
      s.costUsd = meta.costUsd ?? 0;
      s.started = !!meta.started;
      s.cliSize = meta.cliSize;
      try {
        const lines = fs.readFileSync(s.logFile, 'utf8').split('\n').filter(Boolean).slice(-MAX_EVENTS);
        s.events = lines.map((l) => JSON.parse(l));
      } catch {}
      sessions.set(s.id, s);
    } catch {}
  }
}

// ---------- repos & git ----------

function currentBranch(repo) {
  try {
    const head = fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
  } catch { return null; }
}

function listRepos() {
  const found = [];
  const seen = new Set();
  const visit = (dir, depth) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    if (fs.existsSync(path.join(dir, '.git'))) { found.push({ path: dir, name: path.basename(dir), branch: currentBranch(dir) }); return; }
    if (depth === 0) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') visit(path.join(dir, e.name), depth - 1);
  };
  for (const r of opts.roots) visit(r, 2);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// Creates a folder for new work under one of the roots. It is kept within the depth listRepos()
// scans and made a git repository so it shows up in the repo picker.
async function makeFolder(root, name) {
  const base = root == null ? opts.roots[0] : path.resolve(String(root));
  if (!opts.roots.includes(base)) throw new Error(`Not one of the bridge's --roots: ${base}`);
  const parts = String(name ?? '').trim().split('/').filter(Boolean);
  if (!parts.length) throw new Error('Enter a folder name');
  if (parts.length > 2) throw new Error('Use at most one subfolder (a/b); deeper folders are not scanned');
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) throw new Error('Folder names can\'t start with a dot');
  const dir = path.join(base, ...parts);
  if (fs.existsSync(dir)) throw new Error(`Already exists: ${dir}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir);
  await new Promise((resolve, reject) => execFile('git', ['init', '-q'], { cwd: dir }, (err, _out, stderr) =>
    err ? reject(new Error(`Created ${dir}, but git init failed: ${stderr.trim() || err.message}`)) : resolve()));
  return dir;
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: MAX_DIFF_BYTES * 2 }, (err, stdout) => resolve(err && !stdout ? '' : stdout));
  });
}

async function workingDiff(cwd) {
  let diff = await git(cwd, ['diff', 'HEAD', '--no-color', '--no-ext-diff']);
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  for (const f of untracked.slice(0, 50)) {
    if (diff.length > MAX_DIFF_BYTES) break;
    diff += await git(cwd, ['diff', '--no-index', '--no-color', '--', '/dev/null', f]);
  }
  const truncated = diff.length > MAX_DIFF_BYTES;
  return { diff: truncated ? diff.slice(0, MAX_DIFF_BYTES) : diff, truncated, branch: currentBranch(cwd) };
}

// ---------- clients ----------

class Client {
  constructor(socket) {
    this.socket = socket;
    this.authed = false;
    this.subs = new Set();
    this.buf = '';
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 30_000);
    socket.on('data', (c) => this.onData(c));
    socket.on('close', () => clients.delete(this));
    socket.on('error', () => {});
    // Unauthenticated connections get 10 s to say hello.
    this.helloTimer = setTimeout(() => { if (!this.authed) socket.destroy(); }, 10_000);
  }

  send(obj) { if (!this.socket.destroyed) this.socket.write(JSON.stringify(obj) + '\n'); }

  onData(chunk) {
    this.buf += chunk;
    if (!this.authed && this.buf.length > 4096) { this.socket.destroy(); return; }
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { this.send({ ev: 'error', message: 'Bad JSON' }); continue; }
      this.handle(msg).catch((e) => this.send({ ev: 'error', ref: msg.ref, message: String(e?.message ?? e) }));
    }
  }

  async handle(msg) {
    if (!this.authed) {
      if (msg.op === 'hello' && tokenMatches(msg.token)) {
        this.authed = true;
        clearTimeout(this.helloTimer);
        clients.add(this);
        this.send({ ev: 'hello', version: VERSION, host: os.hostname(), platform: process.platform, roots: opts.roots, phone: phoneAvailable });
        this.send({ ev: 'sessions', sessions: [...sessions.values()].map((s) => s.summary()) });
        if (limits) this.send({ ev: 'limits', limits });
        for (const s of sessions.values()) for (const req of s.pending.values()) this.send({ ev: 'approval', sid: s.id, title: s.title, request: req });
      } else {
        this.send({ ev: 'error', message: 'Unauthorized' });
        this.socket.end();
      }
      return;
    }
    const ref = msg.ref;
    const s = msg.sid ? sessions.get(msg.sid) : undefined;
    if (msg.sid && !s) { this.send({ ev: 'error', ref, message: 'Unknown session' }); return; }
    switch (msg.op) {
      case 'ping': this.send({ ev: 'pong', ref }); break;
      case 'repos': this.send({ ev: 'repos', ref, repos: listRepos() }); break;
      case 'mkdir': {
        const created = await makeFolder(msg.root, msg.name);
        this.send({ ev: 'repos', ref, repos: listRepos(), created });
        break;
      }
      case 'sessions': this.send({ ev: 'sessions', ref, sessions: [...sessions.values()].map((x) => x.summary()) }); break;
      case 'start': {
        const cwd = path.resolve(String(msg.cwd ?? '').replace(/^~/, os.homedir()));
        if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Not a folder: ${cwd}`);
        const prompt = String(msg.prompt ?? '').trim();
        const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
        if (!prompt && !attachments.length) throw new Error('Empty prompt');
        if (msg.phone && !phoneAvailable) throw new Error('Phone use needs the bridge running in Termux with root (su).');
        const mode = MODES.includes(msg.mode) ? msg.mode : 'default';
        const title = prompt.split('\n')[0].slice(0, 100) || `Attached ${attachments.map((a) => a.name).join(', ')}`.slice(0, 100);
        const session = new Session({ id: randomUUID(), cwd, title, model: msg.model || null, mode, phone: !!msg.phone });
        sessions.set(session.id, session);
        this.subs.add(session.id);
        try { session.sendUser(prompt, attachments); } catch (e) {
          sessions.delete(session.id);
          session.archived = true;
          session.stop();
          fs.rm(session.attachmentsDir, { recursive: true, force: true }, () => {});
          throw e;
        }
        session.persistMeta();
        this.send({ ev: 'started', ref, session: session.summary() });
        break;
      }
      case 'usage': this.send({ ev: 'usage', ref, limits, ...usageSummary(msg.days, msg.tzOffsetMin) }); break;
      case 'claude_sessions': this.send({ ev: 'claude_sessions', ref, sessions: listCliSessions() }); break;
      case 'resume': {
        const id = String(msg.id ?? '');
        const session = sessions.get(id) ?? importCliSession(id);
        session.syncFromCli();
        this.subs.add(session.id);
        broadcast({ ev: 'session', session: session.summary() });
        this.send({ ev: 'started', ref, session: session.summary() });
        break;
      }
      case 'subscribe':
        s.syncFromCli();
        this.subs.add(s.id);
        this.send({ ev: 'history', sid: s.id, session: s.summary(), events: s.events, pending: [...s.pending.values()] });
        break;
      case 'unsubscribe': this.subs.delete(s.id); break;
      case 'send': s.sendUser(String(msg.text ?? ''), msg.attachments); break;
      case 'phone': s.setPhone(!!msg.on); break;
      case 'permission':
        if (!s.answer(msg.requestId, msg.decision === 'allow' ? 'allow' : 'deny', !!msg.always, msg.message)) {
          this.send({ ev: 'error', ref, message: 'That request was already answered.' });
        }
        broadcast({ ev: 'approval_done', sid: s.id, requestId: msg.requestId });
        break;
      case 'mode':
        if (!MODES.includes(msg.mode)) throw new Error(`Unknown mode: ${msg.mode}`);
        s.setMode(msg.mode);
        break;
      case 'interrupt': s.interrupt(); break;
      case 'stop': s.stop(); break;
      case 'archive':
        s.archived = true;
        s.stop();
        sessions.delete(s.id);
        for (const ext of ['.json', '.jsonl']) fs.rm(path.join(sessionsDir, s.id + ext), { force: true }, () => {});
        fs.rm(s.attachmentsDir, { recursive: true, force: true }, () => {});
        broadcast({ ev: 'removed', sid: s.id });
        break;
      case 'diff': this.send({ ev: 'diff', ref, sid: s.id, ...(await workingDiff(s.cwd)) }); break;
      default: this.send({ ev: 'error', ref, message: `Unknown op: ${msg.op}` });
    }
  }
}

function broadcast(obj) { for (const c of clients) c.send(obj); }
function sendToSubscribers(sid, obj) { for (const c of clients) if (c.subs.has(sid)) c.send(obj); }

// ---------- main ----------

loadSessions();
phoneAvailable = await detectPhone();
const server = net.createServer((socket) => new Client(socket));
server.listen(opts.port, opts.host, () => {
  const { address, port } = server.address();
  const loopback = address === '127.0.0.1' || address === '::1';
  console.log(`ccm-bridge listening on ${address}:${port} (${sessions.size} saved sessions${phoneAvailable ? ', phone use available' : ''})`);
  if (!loopback) console.log('Warning: listening beyond this device. Traffic is not encrypted; use a private network such as Tailscale or an SSH tunnel.');
  const pairUrl = `ccmobile://pair?host=${encodeURIComponent(loopback ? '127.0.0.1' : address)}&port=${port}&token=${encodeURIComponent(token)}`;
  if (opts.showToken) console.log(`Token: ${token}\nPair link: ${pairUrl}`);
  else console.log('Run with --pair to connect the app, or --show-token to print the token.');
  if (opts.pair) {
    execFile('am', ['start', '-a', 'android.intent.action.VIEW', '-d', pairUrl], (err) => {
      if (err) console.log(`Could not open the app (${err.message}). Pair link:\n${pairUrl}`);
    });
  }
});

function shutdown() {
  for (const s of sessions.values()) if (s.proc) s.proc.kill('SIGTERM');
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
