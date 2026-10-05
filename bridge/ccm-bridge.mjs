#!/usr/bin/env node
// ccm-bridge: runs Claude Code sessions and exposes them to the CC Mobile app.
//
// Transport: newline-delimited JSON over TCP. The first line from a client must be
// {"op":"hello","token":"..."}; anything else closes the connection.
// Each session is a `claude -p` process speaking stream-json on stdio, with
// permission prompts routed to the app (--permission-prompt-tool stdio).

import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_ONLY as PHONE_READ_ONLY } from './phone-mcp.mjs';

const VERSION = 1;
const MAX_EVENTS = 4000;
const MAX_DIFF_BYTES = 1_000_000;
// History sent when the app opens a task; older events are left out past this. The app reads
// each message as one line, and a 61 MB history crashed it with OutOfMemoryError.
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
// Sent for the user when a task continues after a usage limit resets.
const CONTINUE_PROMPT = 'Your usage limit has reset. Continue where you left off.';
// When a limit's reset time is unknown, retry after this long, doubling up to an hour.
const LIMIT_RETRY_MS = 10 * 60_000;
// Wait this long past a reset before continuing, so the first request isn't refused again.
const LIMIT_GRACE_MS = Number(process.env.CCM_LIMIT_GRACE_MS ?? 60_000);
// How often waiting tasks compare resumeAt with the wall clock. Not one long setTimeout: Node's
// timers stop while Android is in deep sleep, so a 3-hour wait could fire hours late. The app
// also wakes the phone at resumeAt and sends 'tick' (see ResumeAlarm in the app).
const RESUME_CHECK_MS = Number(process.env.CCM_RESUME_CHECK_MS ?? 30_000);
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// Image types and size the Messages API takes inline; other files are only saved for Claude to Read.
const INLINE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_INLINE_IMAGE_BYTES = 3_750_000; // 5 MB once base64-encoded

// ---------- args & config ----------

function parseArgs(argv) {
  // The Debian chroot's own storage (chroot/ccm-chroot) is a default root too, when this side can read it.
  const chrootHome = '/data/ccm/home';
  const readable = (d) => { try { fs.accessSync(d, fs.constants.R_OK | fs.constants.X_OK); return fs.statSync(d).isDirectory(); } catch { return false; } };
  const roots = [os.homedir(), ...(readable(chrootHome) && fs.realpathSync(chrootHome) !== fs.realpathSync(os.homedir()) ? [chrootHome] : [])];
  const opts = { host: '127.0.0.1', port: 8765, roots, pair: false, showToken: false };
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
// Images Claude looked at, per session, named by content hash (see saveImage()).
const imagesDir = path.join(stateDir, 'images');
fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
const phoneMcp = path.join(path.dirname(fileURLToPath(import.meta.url)), 'phone-mcp.mjs');
const keeperJs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'keeper.mjs');
// One folder per running Claude process; see keeper.mjs and KeeperLink.
const keepersDir = path.join(stateDir, 'keepers');
const claudeBin = process.env.CCM_CLAUDE_BIN ?? 'claude';
const claudeProjectsDir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
// bypassPermissions is the app's "YOLO" mode: tools run without asking. Claude Code still sends
// writes to settings, git and tool-configuration files to the permission handler (the app).
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'manual', 'dontAsk', 'bypassPermissions'];
// Reasoning effort (--effort); null leaves it to the model's default.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

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

// Only one bridge may use a state folder: two would both read the keepers' output and clean up
// each other's keepers (a second bridge started by hand while a restart was under way did that).
const pidFile = path.join(stateDir, 'bridge.pid');
{
  let other = 0;
  try { other = Number(fs.readFileSync(pidFile, 'utf8')); } catch {}
  let running = false;
  try { running = other > 0 && other !== process.pid && fs.readFileSync(`/proc/${other}/cmdline`, 'utf8').includes('ccm-bridge'); } catch {}
  if (running) {
    // --pair or --show-token for the bridge that's already running: that's what the user wants.
    if (opts.pair || opts.showToken) {
      const args = fs.readFileSync(`/proc/${other}/cmdline`, 'utf8').split('\0');
      const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
      const host = arg('--host', '127.0.0.1');
      const url = `ccmobile://pair?host=${encodeURIComponent(host === '0.0.0.0' ? '127.0.0.1' : host)}&port=${arg('--port', '8765')}&token=${encodeURIComponent(token)}`;
      console.log(`ccm-bridge is already running (pid ${other}).`);
      if (opts.showToken) console.log(`Token: ${token}\nPair link: ${url}`);
      if (opts.pair) await new Promise((done) => execFile('am', ['start', '-a', 'android.intent.action.VIEW', '-d', url], (err) => { if (err) console.log(`Pair link: ${url}`); done(); }));
      process.exit(0);
    } else {
      console.error(`Another ccm-bridge (pid ${other}) is already using ${stateDir}. Stop it first, or use a different --state-dir.`);
      process.exit(1);
    }
  }
  fs.writeFileSync(pidFile, String(process.pid));
}

function tokenMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- keepers ----------

/**
 * The bridge's end of a keeper (keeper.mjs), which runs one Claude process detached from the
 * bridge. Messages go to the keeper's pipe; Claude's output is read from the keeper's `out`
 * file, and the position after the last line handled is saved in `read`, so a restarted
 * bridge carries on from there without losing or repeating a line.
 */
class KeeperLink {
  constructor(dir, { onLine, onExit }) {
    this.dir = dir;
    this.onLine = onLine;
    this.onExit = onExit;
    this.offset = Number(readText(path.join(dir, 'read'))) || 0;
    this.partial = Buffer.alloc(0);
    this.closed = false;
    this.killRequested = false;
    this.since = Date.now();
    this.input = null;
    this.queued = []; // lines written before the keeper opened its pipe
    try { this.watcher = fs.watch(dir, () => this.poll()); } catch {}
    this.timer = setInterval(() => this.poll(true), 1000);
    this.poll();
  }

  get info() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'keeper.json'), 'utf8')); } catch { return null; }
  }

  write(line) {
    if (this.openInput()) this.input.write(line + '\n');
    else this.queued.push(line + '\n');
  }

  /**
   * Opens the keeper's pipe without blocking (a blocking open waits forever if the keeper never
   * reads it, and a stuck thread keeps Node from exiting). Fails until the keeper is reading.
   */
  openInput() {
    if (this.input) return true;
    if (this.closed) return false;
    let fd;
    try { fd = fs.openSync(path.join(this.dir, 'in'), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); } catch { return false; }
    this.input = new net.Socket({ fd, readable: false, writable: true });
    this.input.on('error', () => {});
    for (const line of this.queued.splice(0)) this.input.write(line);
    return true;
  }

  kill() {
    const pid = this.info?.pid;
    if (!pid) { this.killRequested = true; return; } // not started yet; poll() kills it
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }

  /** Stops reading (the bridge is shutting down); the keeper and Claude keep running. */
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.watcher?.close();
    this.input?.end();
  }

  poll(tick = false) {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      // Checked before reading: once exit.json exists, `out` is complete.
      const exited = fs.existsSync(path.join(this.dir, 'exit.json'));
      if (this.queued.length) this.openInput();
      this.read();
      if (this.closed) return;
      const pid = this.info?.pid;
      if (pid && this.killRequested) { this.killRequested = false; try { process.kill(pid, 'SIGTERM'); } catch {} }
      if (exited) {
        let code = null, signal = null;
        try { ({ code, signal } = JSON.parse(fs.readFileSync(path.join(this.dir, 'exit.json'), 'utf8'))); } catch {}
        this.finish(code, signal);
      } else if (tick && pid && !alive(pid) && !fs.existsSync(path.join(this.dir, 'exit.json'))) {
        this.read();
        this.finish(null, 'SIGKILL'); // the keeper itself was killed
      } else if (tick && (!fs.existsSync(this.dir) || (!pid && Date.now() - this.since > 15_000))) {
        // The folder was removed under us, or the keeper never started: nothing will ever answer.
        this.finish(null, 'SIGKILL');
      }
    } finally {
      this.polling = false;
    }
  }

  read() {
    let fd;
    try { fd = fs.openSync(path.join(this.dir, 'out'), 'r'); } catch { return; }
    try {
      const buf = Buffer.alloc(1 << 20);
      let n;
      while (!this.closed && (n = fs.readSync(fd, buf, 0, buf.length, this.offset + this.partial.length)) > 0) {
        this.partial = Buffer.concat([this.partial, buf.subarray(0, n)]);
        let nl;
        while (!this.closed && (nl = this.partial.indexOf(10)) >= 0) {
          const line = this.partial.subarray(0, nl).toString('utf8');
          this.partial = this.partial.subarray(nl + 1);
          this.offset += nl + 1;
          this.onLine(line);
        }
        // The folder can vanish under us (see poll()); the next tick notices and ends the link.
        try { fs.writeFileSync(path.join(this.dir, 'read'), String(this.offset)); } catch {}
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  finish(code, signal) {
    const err = readText(path.join(this.dir, 'err')).slice(-4000);
    this.close();
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.onExit(code, signal, err);
  }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---------- sessions ----------

const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const IMAGE_REF = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;
const IMAGE_MIME = Object.fromEntries(Object.entries(IMAGE_EXT).map(([m, e]) => [e, m]));

/** Saves a base64 image for [sid] and returns its ref (file name), or null for other types. */
function saveImage(sid, mediaType, data) {
  const ext = IMAGE_EXT[mediaType];
  if (!ext || !sid) return null;
  const ref = `${createHash('sha256').update(data).digest('hex').slice(0, 32)}.${ext}`;
  const file = path.join(imagesDir, sid, ref);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, Buffer.from(data, 'base64'), { mode: 0o600 });
  }
  return ref;
}

// Images and documents in transcripts (screenshots, video frames Claude Reads) are base64, often
// a megabyte each, too much to send with every message. Images are saved to disk and events keep
// a placeholder with a ref the app can fetch ('image' op); other data is only described.
// tool_use_result repeats the tool output and isn't used by the app, so it's dropped.
function slimEvent(msg, sid) {
  const content = msg?.message?.content;
  if (!msg?.tool_use_result && !Array.isArray(content)) return msg;
  const slimBlock = (b) => {
    if (typeof b?.source?.data === 'string') {
      const ref = b.type === 'image' ? saveImage(sid, b.source.media_type, b.source.data) : null;
      return {
        type: b.type, source: { type: b.source.type, media_type: b.source.media_type },
        omittedBytes: Math.floor(b.source.data.length * 3 / 4), ...(ref ? { ref } : {}),
      };
    }
    if (b?.type === 'tool_result' && Array.isArray(b.content)) return { ...b, content: b.content.map(slimBlock) };
    return b;
  };
  const { tool_use_result, ...rest } = msg;
  return Array.isArray(content) ? { ...rest, message: { ...msg.message, content: content.map(slimBlock) } } : rest;
}

/** The newest events that fit in MAX_HISTORY_BYTES, with a note in place of the rest. */
function historyEvents(events) {
  let bytes = 0;
  let i = events.length;
  while (i > 0) {
    const n = JSON.stringify(events[i - 1]).length;
    if (bytes + n > MAX_HISTORY_BYTES) break;
    bytes += n;
    i--;
  }
  if (i === 0) return events;
  return [{ type: 'bridge', subtype: 'note', message: `${i} earlier events not shown: too large to load on the phone.` }, ...events.slice(i)];
}

/** @type {Map<string, Session>} */
const sessions = new Map();
/** @type {Set<Client>} */
const clients = new Set();

class Session {
  constructor({ id, cwd, title, model, effort, mode, createdAt, status, phone, autoContinue, resumeAt }) {
    this.id = id;
    this.cwd = cwd;
    this.title = title;
    this.model = model ?? null;
    this.effort = EFFORTS.includes(effort) ? effort : null;
    this.mode = mode ?? 'default';
    this.phone = !!phone; // "Phone use": the phone MCP server is attached
    this.createdAt = createdAt ?? Date.now();
    this.updatedAt = this.createdAt;
    this.status = status ?? 'idle'; // working | needs_approval | idle | stopped | error
    this.lastActivity = '';
    this.events = [];
    this.pending = new Map(); // request_id -> control_request message
    this.link = null; // KeeperLink to the running Claude process
    this.started = false; // true once claude has created this session id on disk
    this.costUsd = 0;
    this.costBase = 0; // totals from earlier processes, if one started counting from zero
    this.costLast = 0;
    // Usage limits: a task that hits one waits in status 'limited' until resumeAt; with
    // autoContinue it then carries on by itself.
    this.autoContinue = !!autoContinue;
    this.resumeAt = resumeAt ?? null;
    this.limitHit = false; // this turn ended on a rate_limit error
    this.rejectedResetAt = null; // reset time from this turn's rejected rate_limit_event
    this.limitRetryMs = 0;
    // Background jobs Claude started (Bash run_in_background). Claude wakes up by itself when one
    // finishes, but only while its process lives, so the process must not be stopped meanwhile.
    this.background = [];
  }

  summary() {
    return {
      id: this.id, cwd: this.cwd, title: this.title, model: this.model, effort: this.effort, mode: this.mode,
      status: this.status, createdAt: this.createdAt, updatedAt: this.updatedAt,
      lastActivity: this.lastActivity, pending: this.pending.size, costUsd: this.costUsd,
      running: this.link !== null, phone: this.phone, autoContinue: this.autoContinue, resumeAt: this.resumeAt,
      background: this.background.map((t) => t.description),
      ports: this.ports ?? [],
    };
  }

  get logFile() { return path.join(sessionsDir, `${this.id}.jsonl`); }
  get attachmentsDir() { return path.join(attachmentsDir, this.id); }

  persistMeta() {
    if (this.archived) return;
    // Pending requests and background jobs are restored if the keeper is still running after a restart.
    const meta = { ...this.summary(), started: this.started, cliSize: this.cliSize, pendingRequests: [...this.pending.values()], backgroundTasks: this.background };
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

  get keeperDir() { return path.join(keepersDir, this.id); }

  ensureProcess() {
    if (this.link) return;
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio',
      '--permission-mode', this.mode,
      // Only makes YOLO available, so setMode() can switch a running session into it.
      '--allow-dangerously-skip-permissions',
    ];
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    // Attachments are saved here; allowing the folder lets Claude Read them without asking.
    fs.mkdirSync(this.attachmentsDir, { recursive: true, mode: 0o700 });
    args.push('--add-dir', this.attachmentsDir);
    if (this.phone) {
      const config = { mcpServers: { phone: { type: 'stdio', command: process.execPath, args: [phoneMcp], env: process.env.CCM_SU ? { CCM_SU: process.env.CCM_SU } : {} } } };
      args.push('--mcp-config', JSON.stringify(config), '--append-system-prompt', PHONE_PROMPT,
        '--allowedTools', PHONE_READ_ONLY.map((t) => `mcp__phone__${t}`).join(','));
    }
    args.push(...(this.started ? ['--resume', this.id] : ['--session-id', this.id]));

    // Claude runs under a keeper, detached, so it outlives the bridge (see keeper.mjs).
    const dir = this.keeperDir;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync('mkfifo', ['-m', '600', path.join(dir, 'in')]);
    spawn(process.execPath, [keeperJs, dir, this.cwd, claudeBin, ...args], { detached: true, stdio: 'ignore', env: process.env }).unref();
    this.started = true;
    this.attach();
    this.persistMeta();
    this.writeCli({ type: 'control_request', request_id: `init-${randomUUID()}`, request: { subtype: 'initialize' } });
  }

  attach() {
    this.link = new KeeperLink(this.keeperDir, {
      onLine: (line) => this.onLine(line),
      onExit: (code, signal, stderr) => this.onProcessExit(code, signal, stderr),
    });
  }

  onProcessExit(code, signal, stderr) {
    this.link = null;
    try { this.cliSize = fs.statSync(findCliTranscript(this.id)).size; } catch {}
    this.pending.clear();
    if (this.background.length) {
      this.emitLocal({ type: 'bridge', subtype: 'error', message: `Background work stopped with Claude's process: ${this.background.map((t) => t.description).join(', ')}` });
      this.background = [];
    }
    if (this.status === 'stopped') { this.setStatus('stopped'); return; }
    if (this.status === 'limited') { this.setStatus('limited'); return; }
    if (code === 0 || signal === 'SIGTERM') this.setStatus('idle');
    else {
      this.emitLocal({ type: 'bridge', subtype: 'error', message: `claude exited (${code ?? signal}). ${stderr.trim().slice(-800)}` });
      this.setStatus('error', 'claude exited unexpectedly');
    }
  }

  writeCli(obj) {
    if (!this.link) return false;
    this.link.write(JSON.stringify(obj));
    return true;
  }

  onLine(line) {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    this.onCliMessage(msg);
  }

  onCliMessage(msg) {
    // The initialize reply lists every command and skill: large and not useful to the app.
    if (msg.type === 'control_response') return;
    // Partial deltas are forwarded live but not stored; the final message replaces them.
    if (msg.type === 'stream_event') { sendToSubscribers(this.id, { ev: 'cli', sid: this.id, msg }); return; }
    if (msg.type === 'rate_limit_event') {
      onRateLimit(msg.rate_limit_info);
      if (msg.rate_limit_info?.status === 'rejected') this.rejectedResetAt = limitResetAt(msg.rate_limit_info);
      return;
    }
    if (msg.type === 'system' && msg.subtype === 'thinking_tokens') return;
    if (msg.type === 'system' && msg.subtype === 'background_tasks_changed' && Array.isArray(msg.tasks)) {
      this.background = msg.tasks.map((t) => ({ id: t.task_id, description: t.description || 'Background task' }));
      if (this.status === 'idle') this.lastActivity = this.background.length ? `In the background: ${this.background[0].description}` : 'Waiting for you';
      this.setStatus(this.status);
    }
    if (msg.type === 'system' && msg.subtype === 'init') {
      msg = { type: 'system', subtype: 'init', model: msg.model, cwd: msg.cwd, permissionMode: msg.permissionMode, session_id: msg.session_id };
    }

    msg = slimEvent(msg, this.id);
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
      if (msg.error === 'rate_limit') this.limitHit = true;
      const tool = msg.message?.content?.find((c) => c.type === 'tool_use');
      const text = msg.message?.content?.find((c) => c.type === 'text');
      if (this.status !== 'needs_approval') {
        this.setStatus('working', tool ? `${tool.name}: ${describeInput(tool.input)}` : text ? text.text.slice(0, 120) : this.lastActivity);
      }
    } else if (msg.type === 'result') {
      this.addCost(msg.total_cost_usd);
      const limited = this.limitHit;
      this.limitHit = false;
      if (limited) { this.onLimited(); this.rejectedResetAt = null; return; }
      this.rejectedResetAt = null;
      this.limitRetryMs = 0;
      const waiting = this.background.length ? `In the background: ${this.background[0].description}` : 'Waiting for you';
      this.setStatus(msg.is_error ? 'error' : 'idle', msg.is_error ? (msg.result ?? 'Error') : waiting);
    }
  }

  // Events the bridge itself adds to a transcript (errors, user prompts).
  emitLocal(msg) {
    msg = slimEvent(msg, this.id);
    this.record(msg);
    sendToSubscribers(this.id, { ev: 'cli', sid: this.id, msg });
  }

  sendUser(text, attachments = []) {
    this.clearResume();
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
    this.link?.kill();
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

  setEffort(effort) {
    this.effort = effort;
    // Applies from the next turn; null goes back to the model's default. A stopped session
    // picks it up from --effort when it restarts.
    if (this.link) this.writeCli({ type: 'control_request', request_id: `effort-${randomUUID()}`, request: { subtype: 'apply_flag_settings', settings: { effortLevel: effort } } });
    this.emitLocal({ type: 'bridge', subtype: 'note', message: `Reasoning effort: ${effort ?? 'model default'}` });
    this.setStatus(this.status);
  }

  interrupt() {
    this.writeCli({ type: 'control_request', request_id: `int-${randomUUID()}`, request: { subtype: 'interrupt' } });
  }

  /**
   * total_cost_usd is the session's running total at API list prices (it carries over --resume),
   * not the turn's cost. If it ever drops, a process started from zero: keep the earlier total.
   */
  addCost(total) {
    if (!(total > 0)) return; // interrupted or limited turns report 0
    if (total < this.costLast) this.costBase += this.costLast;
    this.costLast = total;
    this.costUsd = this.costBase + total;
  }

  /** The turn ended because a usage limit was reached: wait for it to reset. */
  onLimited() {
    const now = Date.now();
    const resetAt = this.rejectedResetAt > now ? this.rejectedResetAt : null;
    this.limitRetryMs = resetAt ? 0 : Math.min(this.limitRetryMs ? this.limitRetryMs * 2 : LIMIT_RETRY_MS, 60 * 60_000);
    this.resumeAt = resetAt ? resetAt + LIMIT_GRACE_MS : now + this.limitRetryMs;
    this.setStatus('limited', resetAt ? 'Usage limit reached' : 'Rate limited');
    this.resumeIfDue();
  }

  /** Continues a task waiting out a usage limit once its reset time has passed, if it should. */
  resumeIfDue() {
    if (!this.autoContinue || this.status !== 'limited' || !this.resumeAt || this.archived) return;
    if (Date.now() < this.resumeAt) return;
    this.emitLocal({ type: 'bridge', subtype: 'note', message: 'Usage limit reset: continuing automatically' });
    this.sendUser(CONTINUE_PROMPT);
  }

  clearResume() {
    this.resumeAt = null;
  }

  setAutoContinue(on) {
    this.autoContinue = on;
    this.emitLocal({ type: 'bridge', subtype: 'note', message: on ? 'Will continue automatically when usage limits reset' : 'Won\'t continue automatically after usage limits' });
    this.resumeIfDue();
    this.setStatus(this.status);
  }

  stop() {
    this.clearResume();
    this.status = 'stopped';
    if (this.link) this.link.kill();
    else this.setStatus('stopped');
  }

  // Appends turns taken outside the bridge (e.g. `claude --resume` in a terminal) from
  // Claude Code's own transcript, picking up after the last message the bridge has seen.
  /**
   * Gives image placeholders that have no ref (logs slimmed before images were kept) their
   * image back from Claude Code's transcript, which still has them. Runs once per session.
   */
  backfillImages() {
    if (this.imagesBackfilled) return;
    this.imagesBackfilled = true;
    const missing = (b) => b?.type === 'image' && b.omittedBytes && !b.ref && !b.missing;
    const results = (e) => (e.type === 'user' && Array.isArray(e.message?.content) ? e.message.content : [])
      .filter((b) => b?.type === 'tool_result' && Array.isArray(b.content) && b.content.some(missing));
    if (!this.events.some((e) => results(e).length)) return;
    const found = new Map(); // tool_use_id -> image blocks with data
    const file = findCliTranscript(this.id);
    if (file) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"image"')) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        for (const b of Array.isArray(r.message?.content) ? r.message.content : []) {
          if (b?.type !== 'tool_result' || !Array.isArray(b.content)) continue;
          const images = b.content.filter((x) => x?.type === 'image' && typeof x.source?.data === 'string');
          if (images.length) found.set(b.tool_use_id, images);
        }
      }
    }
    for (const e of this.events) {
      for (const result of results(e)) {
        const images = found.get(result.tool_use_id) ?? [];
        let i = 0;
        result.content = result.content.map((b) => {
          if (b?.type !== 'image') return b;
          const src = images[i++];
          if (!missing(b)) return b;
          const ref = src ? saveImage(this.id, src.source.media_type, src.source.data) : null;
          return ref ? { ...b, ref } : { ...b, missing: true };
        });
      }
    }
    fs.writeFileSync(this.logFile, this.events.map((e) => JSON.stringify(e) + '\n').join(''));
  }

  syncFromCli() {
    if (this.link) return;
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
  // Root on Android, not just root: Termux's su, or the chroot's su (chroot/su) whose commands run
  // on Android although this Node reports linux.
  return new Promise((resolve) => execFile(process.env.CCM_SU ?? 'su', ['-c', 'id -u; getprop ro.build.version.sdk'], { timeout: 10_000 },
    (err, out) => resolve(!err && /^0\n\d+\s*$/.test(out))));
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
  const events = readJsonl(file).map(cliRecordToEvent).filter(Boolean).map((e) => slimEvent(e, id));
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

/** When a rejected rate_limit_event's limit resets (ms), or null if it doesn't say. */
function limitResetAt(info) {
  const full = Object.values(info.unifiedWindows ?? {}).filter((w) => w?.utilization >= 1 && w.resetsAt);
  const at = full.length ? Math.max(...full.map((w) => w.resetsAt)) : info.resetsAt;
  return at ? at * 1000 : null;
}

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
      const s = new Session({ ...meta, status: ['stopped', 'error', 'limited'].includes(meta.status) ? meta.status : 'idle' });
      s.updatedAt = meta.updatedAt ?? s.createdAt;
      s.lastActivity = meta.lastActivity ?? '';
      s.costUsd = meta.costUsd ?? 0;
      s.started = !!meta.started;
      s.cliSize = meta.cliSize;
      try {
        const lines = fs.readFileSync(s.logFile, 'utf8').split('\n').filter(Boolean).slice(-MAX_EVENTS);
        s.events = lines.map((l) => slimEvent(JSON.parse(l), s.id));
        // Recount from the turn results: costUsd used to add up running totals, overstating it.
        if (s.events.some((e) => e.type === 'result' && e.total_cost_usd > 0)) {
          s.costUsd = 0;
          for (const e of s.events) if (e.type === 'result') s.addCost(e.total_cost_usd);
        }
        // Logs written before slimEvent() existed can be tens of megabytes; rewrite them once.
        const slim = s.events.map((e) => JSON.stringify(e) + '\n').join('');
        if (slim.length < lines.reduce((n, l) => n + l.length + 1, 0)) fs.writeFileSync(s.logFile, slim);
      } catch {}
      sessions.set(s.id, s);
      // Claude still running under a keeper from before the restart (or finished meanwhile):
      // restore what was in flight and carry on reading its output.
      if (fs.existsSync(path.join(s.keeperDir, 'keeper.json'))) {
        s.status = meta.status ?? 'idle';
        s.pending = new Map((meta.pendingRequests ?? []).map((r) => [r.request_id, r]));
        s.background = meta.backgroundTasks ?? [];
        s.attach();
      }
    } catch {}
  }
  // Keepers whose session is gone (archived while the bridge was down, or never saved).
  let dirs = [];
  try { dirs = fs.readdirSync(keepersDir); } catch {}
  for (const id of dirs) {
    if (sessions.get(id)?.link) continue;
    const dir = path.join(keepersDir, id);
    try { process.kill(JSON.parse(fs.readFileSync(path.join(dir, 'keeper.json'), 'utf8')).pid, 'SIGTERM'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- processes ----------

// The processes running as this user, for the app's Processes screen. Without root Android shows
// only our own uid's entries in /proc, which is exactly Termux's processes.
const CLK_TCK = 100; // USER_HZ, fixed on Linux and Android
const INTERPRETERS = new Set(['node', 'python', 'python3', 'bash', 'sh', 'zsh', 'perl', 'ruby']);
const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGSTOP', 'SIGCONT'];
const processLogsDir = path.join(stateDir, 'process-logs');
const cpuSamples = new Map(); // pid -> { ticks, at }

function procStat(pid) {
  const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const close = s.lastIndexOf(')');
  const f = s.slice(close + 2).split(' ');
  return { state: f[0], ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), start: Number(f[19]) };
}

// /proc/uptime is off limits, so boot time comes from our own start time in clock ticks.
const bootWall = Date.now() - process.uptime() * 1000 - procStat(process.pid).start * 1000 / CLK_TCK;

/** A short name: the program, or interpreter plus script ("python3 render.py"), not the glibc loader. */
function processName(args) {
  const base = (s) => (s ?? '').split('/').pop();
  let i = 0;
  if (/^ld-linux/.test(base(args[0]))) i = args.findIndex((a, k) => k > 0 && !a.startsWith('-') && args[k - 1] !== '--library-path');
  const name = base(args[Math.max(i, 0)]).replace(/-native$/, '');
  const script = args.slice(i + 1).find((a) => !a.startsWith('-'));
  return INTERPRETERS.has(name.replace(/[\d.]+$/, '')) && script && !script.includes(' ') ? `${name} ${base(script)}` : name;
}

function readEnviron(pid) {
  try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean); } catch { return []; }
}

/**
 * The executable a command line starts, or null. Programs that rename themselves (npm sets its
 * title to "npm run dev ...") no longer show a runnable command, so they can't be restarted.
 */
function resolveProgram(arg0, env) {
  const runnable = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
  if (!arg0 || /\s/.test(arg0)) return null;
  if (arg0.includes('/')) return runnable(arg0) ? arg0 : null;
  for (const dir of (env.PATH ?? process.env.PATH ?? '').split(':')) {
    if (dir && runnable(path.join(dir, arg0))) return path.join(dir, arg0);
  }
  return null;
}

function envObject(pid) {
  return Object.fromEntries(readEnviron(pid).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
}

function listProcesses() {
  const now = Date.now();
  const roles = new Map(); // pid -> { role, sid }
  roles.set(process.pid, { role: 'bridge' });
  for (const s of sessions.values()) {
    const info = s.link?.info;
    if (info?.pid) roles.set(info.pid, { role: 'keeper', sid: s.id });
    if (info?.claudePid) roles.set(info.claudePid, { role: 'claude', sid: s.id });
  }
  const list = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (!args.length) continue; // kernel threads
      const st = procStat(pid);
      let cwd = null;
      try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
      const rss = Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)?.[1] ?? 0);
      const prev = cpuSamples.get(pid);
      const cpu = prev && now > prev.at ? Math.max(0, ((st.ticks - prev.ticks) / CLK_TCK) / ((now - prev.at) / 1000) * 100) : null;
      cpuSamples.set(pid, { ticks: st.ticks, at: now });
      const env = envObject(pid);
      const sid = env.CLAUDE_CODE_SESSION_ID ?? null;
      list.push({
        pid, ppid: st.ppid, name: processName(args), args, cwd, state: st.state,
        startedAt: Math.round(bootWall + st.start * 1000 / CLK_TCK), cpuSeconds: st.ticks / CLK_TCK, cpu, rssKb: rss,
        envSid: sid, runnable: !!resolveProgram(args[0], env), ...(roles.get(pid) ?? {}),
      });
    } catch {} // gone meanwhile
  }
  // Everything Claude started belongs to its task: by parentage, or by the session id Claude Code
  // puts in each command's environment (which detached nohup/setsid jobs keep).
  const byPid = new Map(list.map((p) => [p.pid, p]));
  for (const p of list) {
    if (p.role) continue;
    for (let q = byPid.get(p.ppid), n = 0; q && n < 50; q = byPid.get(q.ppid), n++) {
      if (q.role === 'claude') { p.role = 'job'; p.sid = q.sid; break; }
    }
    if (!p.role && p.envSid && sessions.has(p.envSid)) { p.role = 'job'; p.sid = p.envSid; p.detached = true; }
    p.role ??= 'other';
    delete p.envSid;
  }
  for (const p of list) {
    delete p.envSid;
    p.restartable = p.runnable && (p.role === 'job' || p.role === 'other');
    delete p.runnable;
  }
  for (const pid of cpuSamples.keys()) if (!byPid.has(pid)) cpuSamples.delete(pid);
  return list.sort((a, b) => a.startedAt - b.startedAt);
}

function ownProcess(pid) {
  const p = listProcesses().find((x) => x.pid === pid);
  if (!p) throw new Error('No such process (it may have ended).');
  return p;
}

function signalProcess(pid, signal) {
  if (!SIGNALS.includes(signal)) throw new Error(`Unknown signal: ${signal}`);
  const p = ownProcess(pid);
  if (p.role === 'bridge') throw new Error("That's the bridge itself.");
  process.kill(pid, signal);
}

/** Stops a process and runs its command again in the same folder and environment; returns the new pid. */
async function restartProcess(pid) {
  const p = ownProcess(pid);
  if (['bridge', 'keeper', 'claude'].includes(p.role)) throw new Error("Restart a task's Claude by stopping the task and sending it a message.");
  const env = envObject(pid);
  // Checked before anything is stopped, so a restart that can't work leaves the process running.
  const program = resolveProgram(p.args[0], env);
  if (!program) throw new Error(`Can't restart ${p.name}: it renamed itself, so its original command isn't known. Stop it and start it again from its task.`);
  const gone = () => { try { return procStat(pid).state === 'Z'; } catch { return true; } };
  try { process.kill(pid, 'SIGCONT'); process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 50 && !gone(); i++) await new Promise((r) => setTimeout(r, 100));
  if (!gone()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  fs.mkdirSync(processLogsDir, { recursive: true, mode: 0o700 });
  const log = path.join(processLogsDir, `${p.name.replace(/[^\w.-]+/g, '_')}-${Date.now()}.log`);
  const fd = fs.openSync(log, 'a', 0o600);
  const child = spawn(program, p.args.slice(1), { argv0: p.args[0], cwd: p.cwd ?? os.homedir(), env, detached: true, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return { pid: child.pid, log };
}

// ---------- listening ports ----------

// TCP ports that processes a task started are listening on (a dev server, say), for the task list.
const PORTS_CHECK_MS = Number(process.env.CCM_PORTS_CHECK_MS ?? 5000);

/** Listening sockets by inode, from /proc/net/tcp and tcp6 (through su where an app can't read them). */
async function listeningSockets() {
  let text = '';
  try { text = fs.readFileSync('/proc/net/tcp', 'utf8') + fs.readFileSync('/proc/net/tcp6', 'utf8'); } catch {
    if (!phoneAvailable) return new Map();
    text = await new Promise((resolve) => execFile(process.env.CCM_SU ?? 'su', ['-c', 'cat /proc/net/tcp /proc/net/tcp6'],
      { timeout: 5000, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? '' : out)));
  }
  const byInode = new Map();
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f[3] !== '0A' || !f[1]?.includes(':')) continue; // 0A: LISTEN
    byInode.set(f[9], parseInt(f[1].split(':')[1], 16));
  }
  return byInode;
}

/** Ports each task's processes listen on, by session id (the bridge's and Claude's own are left out). */
async function taskPorts() {
  const sockets = await listeningSockets();
  const ports = new Map();
  if (!sockets.size) return ports;
  for (const p of listProcesses()) {
    if (p.role !== 'job' || !p.sid) continue;
    let fds = [];
    try { fds = fs.readdirSync(`/proc/${p.pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`/proc/${p.pid}/fd/${fd}`); } catch { continue; }
      const port = sockets.get(link.match(/^socket:\[(\d+)\]$/)?.[1]);
      if (port) (ports.get(p.sid) ?? ports.set(p.sid, new Set()).get(p.sid)).add(port);
    }
  }
  return ports;
}

let checkingPorts = false;
async function updatePorts() {
  if (checkingPorts || !clients.size) return; // only while someone is looking
  checkingPorts = true;
  try {
    const ports = await taskPorts();
    for (const s of sessions.values()) {
      const now = [...(ports.get(s.id) ?? [])].sort((a, b) => a - b);
      if (now.join() === (s.ports ?? []).join()) continue;
      s.ports = now;
      broadcast({ ev: 'session', session: s.summary() });
    }
  } finally {
    checkingPorts = false;
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
        const session = new Session({ id: randomUUID(), cwd, title, model: msg.model || null, effort: msg.effort, mode, phone: !!msg.phone, autoContinue: !!msg.autoContinue });
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
      case 'processes': this.send({ ev: 'processes', ref, processes: listProcesses() }); break;
      case 'signal': signalProcess(Number(msg.pid), String(msg.signal)); this.send({ ev: 'processes', ref, processes: listProcesses() }); break;
      case 'restart_process': {
        const started = await restartProcess(Number(msg.pid));
        this.send({ ev: 'processes', ref, processes: listProcesses(), started });
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
        s.backfillImages();
        this.subs.add(s.id);
        this.send({ ev: 'history', sid: s.id, session: s.summary(), events: historyEvents(s.events), pending: [...s.pending.values()] });
        break;
      case 'unsubscribe': this.subs.delete(s.id); break;
      case 'image': {
        const image = String(msg.image ?? '');
        if (!IMAGE_REF.test(image)) throw new Error('Bad image ref');
        let data;
        try { data = fs.readFileSync(path.join(imagesDir, s.id, image)).toString('base64'); } catch { throw new Error('That image is no longer on the bridge.'); }
        this.send({ ev: 'image', ref, sid: s.id, image, mime: IMAGE_MIME[image.split('.').pop()], data });
        break;
      }
      case 'send': s.sendUser(String(msg.text ?? ''), msg.attachments); break;
      case 'phone': s.setPhone(!!msg.on); break;
      case 'auto_continue': s.setAutoContinue(!!msg.on); break;
      // From the app's alarm at a task's resumeAt, which wakes the phone: check now.
      case 'tick': resumeDue(); this.send({ ev: 'tock', ref }); break;
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
      case 'effort':
        if (msg.effort != null && !EFFORTS.includes(msg.effort)) throw new Error(`Unknown effort: ${msg.effort}`);
        s.setEffort(msg.effort ?? null);
        break;
      case 'interrupt': s.interrupt(); break;
      case 'stop': s.stop(); break;
      case 'archive':
        s.archived = true;
        s.stop();
        sessions.delete(s.id);
        for (const ext of ['.json', '.jsonl']) fs.rm(path.join(sessionsDir, s.id + ext), { force: true }, () => {});
        fs.rm(s.attachmentsDir, { recursive: true, force: true }, () => {});
        fs.rm(path.join(imagesDir, s.id), { recursive: true, force: true }, () => {});
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
function resumeDue() { for (const s of sessions.values()) s.resumeIfDue(); }
resumeDue();
setInterval(resumeDue, RESUME_CHECK_MS);
setInterval(updatePorts, PORTS_CHECK_MS);
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
  try { if (Number(fs.readFileSync(pidFile, 'utf8')) === process.pid) fs.rmSync(pidFile); } catch {}
  // Claude processes keep running under their keepers; the next bridge reattaches to them.
  for (const s of sessions.values()) if (s.link) { s.link.close(); s.persistMeta(); }
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
