#!/usr/bin/env node
// ccm-bridge: runs Antigravity CLI (agy) sessions and exposes them to the AGY Mobile app.
//
// Transport: newline-delimited JSON over TCP. The first line from a client must be
// {"op":"hello","token":"..."}; anything else closes the connection.
// Each session is an `agy -p=` process speaking stream-json on stdio.

import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoiceStream } from './voice.mjs';

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
// Image types and size kept inline in transcripts; other files are saved to disk for agy to view.
const INLINE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_INLINE_IMAGE_BYTES = 3_750_000; // 5 MB once base64-encoded
// A finished turn leaves agy's process waiting for the next message, holding memory and waking
// the phone. It's stopped after this long idle; the next message resumes the session (--conversation).
const IDLE_EXIT_MS = Number(process.env.CCM_IDLE_EXIT_MS ?? 60_000);

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
// Images agy looked at, per session, named by content hash (see saveImage()).
const imagesDir = path.join(stateDir, 'images');
fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
const ptyPy = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ptyhost.py'); // not pty.py: that would shadow Python's pty
const keeperJs = path.join(path.dirname(fileURLToPath(import.meta.url)), 'keeper.mjs');
// One folder per running agy process; see keeper.mjs and KeeperLink.
const keepersDir = path.join(stateDir, 'keepers');
// Ensure ~/.local/bin and Termux's agy wrapper directories are on PATH even when started from an app broadcast.
{
  const extraBins = [
    path.join(os.homedir(), '.local', 'bin'),
    '/data/data/com.termux/files/home/.local/bin',
    '/data/data/com.termux/files/home/.agy-termux-musl',
  ];
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const b of extraBins.reverse()) {
    if (fs.existsSync(b)) {
      const idx = dirs.indexOf(b);
      if (idx >= 0) dirs.splice(idx, 1);
      dirs.unshift(b);
    }
  }
  process.env.PATH = dirs.join(':');
}
const claudeBin = process.env.CCM_AGY_BIN ?? process.env.CCM_CLAUDE_BIN ?? 'agy';
const agyDataDir = process.env.CCM_AGY_DIR ?? process.env.AGY_DATA_DIR ?? path.join(os.homedir(), '.gemini', 'antigravity-cli');
const claudeProjectsDir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
// bypassPermissions is the app's "YOLO" mode (--dangerously-skip-permissions).
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
      const url = `agymobile://pair?host=${encodeURIComponent(host === '0.0.0.0' ? '127.0.0.1' : host)}&port=${arg('--port', '8765')}&token=${encodeURIComponent(token)}`;
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
  constructor(dir, { onLine, onExit, onTick }) {
    this.dir = dir;
    this.onLine = onLine;
    this.onExit = onExit;
    this.onTick = onTick;
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
      if (tick) this.onTick?.();
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
  constructor({ id, cwd, title, model, effort, mode, createdAt, status, autoContinue, resumeAt, cliSessionId }) {
    this.id = id;
    this.cliSessionId = cliSessionId ?? null;
    this.cwd = cwd;
    this.title = title;
    this.model = model ?? null;
    this.currentModel = this.model;
    this.effort = EFFORTS.includes(effort) ? effort : null;
    this.mode = mode ?? 'bypassPermissions';
    this.createdAt = createdAt ?? Date.now();
    this.updatedAt = this.createdAt;
    this.status = status ?? 'idle'; // working | needs_approval | idle | stopped | error
    this.lastActivity = '';
    this.events = [];
    this.pending = new Map(); // request_id -> control_request message
    this.link = null; // KeeperLink to the running agy process
    this.started = false; // true once agy has created this session id on disk
    this.costUsd = 0;
    this.costBase = 0; // totals from earlier processes, if one started counting from zero
    this.costLast = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.thinkingTokens = 0;
    this.cacheReadTokens = 0;
    this.requests = 0;
    // Usage limits: a task that hits one waits in status 'limited' until resumeAt; with
    // autoContinue it then carries on by itself.
    this.autoContinue = !!autoContinue;
    this.resumeAt = resumeAt ?? null;
    this.limitHit = false; // this turn ended on a rate_limit error
    this.rejectedResetAt = null; // reset time from this turn's rejected rate_limit_event
    this.limitRetryMs = 0;
    // Background jobs agy started.
    this.background = [];
    this.idleTimer = null;
    this.idleExit = false; // agy's process is being stopped for being idle
    this.interrupted = false; // agy's process is being stopped due to user interrupt
    this.afterExit = []; // messages for agy sent meanwhile, for the process that resumes it
    this.stepText = new Map(); // step_index -> accumulated streamed text
    this.emittedTools = new Set(); // step_index where tool_use was emitted
    this.emittedThinking = new Set(); // step_index where thinking was emitted
    this.syncedTranscriptSteps = new Set(); // step_index synced from transcript while a background tool was running
    this.turnHadText = false;
    this.stuckToolDetectedAt = null;
  }

  summary() {
    return {
      id: this.id, cwd: this.cwd, title: this.title, model: this.model, effort: this.effort, mode: this.mode,
      status: this.status, createdAt: this.createdAt, updatedAt: this.updatedAt,
      lastActivity: this.lastActivity, pending: this.pending.size, costUsd: this.costUsd,
      inputTokens: this.inputTokens, outputTokens: this.outputTokens, thinkingTokens: this.thinkingTokens,
      cacheReadTokens: this.cacheReadTokens, requests: this.requests,
      running: this.link !== null, autoContinue: this.autoContinue, resumeAt: this.resumeAt,
      background: this.background.map((t) => t.description),
      ports: this.ports ?? [],
    };
  }

  addUsage(u) {
    if (!u || typeof u !== 'object') return false;
    const inp = Number(u.input_tokens) || 0;
    const out = Number(u.output_tokens) || 0;
    const think = Number(u.thinking_tokens) || 0;
    const cacheRead = Number(u.cache_read_input_tokens ?? u.cache_read_tokens) || 0;
    if (!inp && !out && !think && !cacheRead) return false;
    this.inputTokens += inp;
    this.outputTokens += out >= think ? out : out + think;
    this.thinkingTokens += think;
    this.cacheReadTokens += cacheRead;
    this.requests += 1;
    return true;
  }

  get logFile() { return path.join(sessionsDir, `${this.id}.jsonl`); }
  get attachmentsDir() { return path.join(attachmentsDir, this.id); }

  persistMeta() {
    if (this.archived) return;
    // Pending requests and background jobs are restored if the keeper is still running after a restart.
    const meta = {
      ...this.summary(),
      cliSessionId: this.cliSessionId,
      started: this.started,
      cliSize: this.cliSize,
      pendingRequests: [...this.pending.values()],
      backgroundTasks: this.background,
    };
    fs.writeFileSync(path.join(sessionsDir, `${this.id}.json`), JSON.stringify(meta));
  }

  record(msg) {
    const isEmptyAssistant = msg?.type === 'assistant' && Array.isArray(msg.message?.content) && msg.message.content.length === 0;
    if (!isEmptyAssistant) {
      this.events.push(msg);
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    const u = msg?.type === 'assistant' && msg.message?.model !== '<synthetic>' ? msg.message?.usage : null;
    if (u) {
      try { fs.appendFileSync(this.logFile, JSON.stringify(msg) + '\n'); } catch {}
      if (this.addUsage(u)) {
        this.persistMeta();
        broadcast({ ev: 'session', session: this.summary() });
        broadcast({ ev: 'usage_tick', sid: this.id, t: Date.now() });
      }
    } else {
      fs.appendFile(this.logFile, JSON.stringify(msg) + '\n', () => {});
    }
  }

  setStatus(status, activity) {
    this.status = status;
    if (activity !== undefined) this.lastActivity = activity;
    this.updatedAt = Date.now();
    this.persistMeta();
    broadcast({ ev: 'session', session: this.summary() });
    this.scheduleIdleExit();
  }

  /** Stops agy's process once the task has been idle for IDLE_EXIT_MS, unless something still needs it. */
  scheduleIdleExit() {
    clearTimeout(this.idleTimer);
    if (!this.link || this.idleExit || !['idle', 'error', 'limited'].includes(this.status)) return;
    this.idleTimer = setTimeout(() => {
      if (!this.link || this.idleExit || !['idle', 'error', 'limited'].includes(this.status) || this.pending.size) return;
      // Background jobs wake agy when they finish, and its child processes (a dev server, say) die with
      // it. Detached ones (a Gradle daemon, nohup jobs) outlive it, even when they listen on a port.
      const busy = this.background.length || listProcesses().some((p) => p.sid === this.id && p.role === 'job' && !p.detached);
      if (busy) { this.scheduleIdleExit(); return; } // look again later
      this.idleExit = true;
      this.link.kill();
    }, IDLE_EXIT_MS);
    this.idleTimer.unref();
  }

  get keeperDir() { return path.join(keepersDir, this.id); }

  /**
   * Resolves --model and --effort for agy:
   * - Multi-effort models (gemini-4-argon, gemini-3.8-flash, claude-opus-5-5, claude-sonnet-5-5)
   *   require --effort (low, medium, high) whenever --model is specified without an effort suffix;
   *   when effort is unset ("Default"), default to "high".
   * - Single-effort models like gpt-oss-120b only support "medium" (or no --effort flag).
   * - If model already has a -(low|medium|high) suffix, strip it when an explicit effort is chosen.
   */
  resolveAgyModelEffort(rawModel, rawEffort) {
    const validEffort = rawEffort && ['low', 'medium', 'high'].includes(rawEffort) ? rawEffort : null;
    if (!rawModel) return { model: null, effort: validEffort };
    const suffixMatch = String(rawModel).match(/^(.*)-(low|medium|high)$/);
    const baseModel = suffixMatch ? suffixMatch[1] : String(rawModel);
    const suffixEffort = suffixMatch ? suffixMatch[2] : null;
    if (baseModel.startsWith('gpt-oss')) {
      return { model: baseModel, effort: null };
    }
    return {
      model: baseModel,
      effort: validEffort ?? suffixEffort ?? 'high',
    };
  }

  ensureProcess() {
    if (this.link) return;
    const args = ['-p=', '--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (process.env.CCM_LEGACY_PROTO === '1') {
      args.push('--permission-mode', this.mode, '--allow-dangerously-skip-permissions');
      if (this.effort) args.push('--effort', this.effort);
      if (this.model) args.push('--model', this.model);
      args.push(...(this.started ? ['--resume', this.id] : ['--session-id', this.id]));
    } else {
      if (this.mode === 'plan') args.push('--mode', 'plan');
      else if (this.mode === 'acceptEdits') args.push('--mode', 'accept-edits');
      else args.push('--dangerously-skip-permissions');
      const { model, effort } = this.resolveAgyModelEffort(this.model, this.effort);
      if (model) args.push('--model', model);
      if (effort) args.push('--effort', effort);
      if (this.cliSessionId) args.push('--conversation', this.cliSessionId);
    }
    // Attachments are saved here; allowing the folder and workspace lets agy access them directly.
    fs.mkdirSync(this.attachmentsDir, { recursive: true, mode: 0o700 });
    args.push('--add-dir', this.cwd, '--add-dir', this.attachmentsDir);

    // agy runs under a keeper, detached, so it outlives the bridge (see keeper.mjs).
    const dir = this.keeperDir;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync('mkfifo', ['-m', '600', path.join(dir, 'in')]);
    const env = {
      ...process.env,
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      AGY_SESSION_ID: this.id,
      CLAUDE_CODE_SESSION_ID: this.id,
    };
    spawn(process.execPath, [keeperJs, dir, this.cwd, claudeBin, ...args], { detached: true, stdio: 'ignore', env }).unref();
    this.started = true;
    this.attach();
    this.persistMeta();
    if (process.env.CCM_LEGACY_PROTO === '1') {
      this.writeCli({ type: 'control_request', request_id: `init-${randomUUID()}`, request: { subtype: 'initialize' } });
    }
  }

  attach() {
    this.link = new KeeperLink(this.keeperDir, {
      onLine: (line) => this.onLine(line),
      onExit: (code, signal, stderr) => this.onProcessExit(code, signal, stderr),
      onTick: () => this.checkStuckTools(),
    });
  }

  onProcessExit(code, signal, stderr) {
    this.link = null;
    this.stuckToolDetectedAt = null;
    clearTimeout(this.idleTimer);
    try { this.cliSize = fs.statSync(findCliTranscript(this.cliSessionId ?? this.id)).size; } catch {}
    if (this.idleExit) {
      // Stopped for being idle: the task itself hasn't changed, unless a message came meanwhile.
      this.idleExit = false;
      const queued = this.afterExit.splice(0);
      if (queued.length && !this.archived) { this.ensureProcess(); queued.forEach((m) => this.writeCli(m)); }
      this.persistMeta();
      broadcast({ ev: 'session', session: this.summary() });
      return;
    }
    if (this.interrupted) {
      this.interrupted = false;
      this.stepText.clear();
      this.emittedTools.clear();
      this.turnHadText = false;
      this.setStatus('idle', 'Interrupted');
      return;
    }
    this.pending.clear();
    if (this.background.length) {
      this.emitLocal({ type: 'bridge', subtype: 'error', message: `Background work stopped with agy's process: ${this.background.map((t) => t.description).join(', ')}` });
      this.background = [];
    }
    if (this.status === 'stopped') { this.setStatus('stopped'); return; }
    if (this.status === 'limited') { this.setStatus('limited'); return; }
    if (code === 0 || signal === 'SIGTERM') this.setStatus('idle');
    else {
      this.emitLocal({ type: 'bridge', subtype: 'error', message: `agy exited (${code ?? signal}). ${stderr.trim().slice(-800)}` });
      this.setStatus('error', 'agy exited unexpectedly');
    }
  }

  writeCli(obj) {
    if (this.idleExit) { this.afterExit.push(obj); return true; }
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

  /** Reads the model's internal thinking for a step from agy's transcript.jsonl if available. */
  readStepThinking(stepIndex) {
    if (this.emittedThinking.has(stepIndex)) return null;
    const convId = this.cliSessionId ?? this.id;
    const file = path.join(agyDataDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line || !line.includes(`"step_index":${stepIndex}`)) continue;
        const r = JSON.parse(line);
        if (r.step_index === stepIndex && typeof r.thinking === 'string' && r.thinking.trim()) {
          this.emittedThinking.add(stepIndex);
          return r.thinking.trim();
        }
      }
    } catch {}
    return null;
  }

  /**
   * Detects and unblocks background commands that have been backgrounded by AGY CLI
   * but whose child process is still running and blocking the sequential stream-json emitter.
   */
  checkStuckTools() {
    if (this.status !== 'working' || !this.link || this.emittedTools.size === 0) {
      this.stuckToolDetectedAt = null;
      return;
    }
    const claudePid = this.link.info?.claudePid;
    if (!claudePid || !alive(claudePid)) return;

    const file = findCliTranscript(this.cliSessionId ?? this.id);
    if (!file || !fs.existsSync(file)) return;

    const minActiveStep = Math.min(...this.emittedTools);
    let maxTranscriptStep = -1;
    let taskKilled = false;
    let minActiveStepDone = false;
    const stepsByIndex = new Map();
    const completedBgTasks = new Map(); // taskStepIdx -> { state, output }
    try {
      const stat = fs.statSync(file);
      const readLen = Math.min(stat.size, 65536);
      const buf = Buffer.alloc(readLen);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, readLen, stat.size - readLen);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n');
      for (const line of lines) {
        if (!line.includes('"step_index"')) continue;
        try {
          const r = JSON.parse(line);
          if (typeof r.step_index === 'number') {
            stepsByIndex.set(r.step_index, r);
            if (r.step_index > maxTranscriptStep) maxTranscriptStep = r.step_index;
            if (r.step_index > minActiveStep && line.includes('manage_task') && line.includes('kill')) {
              taskKilled = true;
            }
            if (r.step_index === minActiveStep && r.type === 'GENERIC' && r.status === 'DONE') {
              minActiveStepDone = true;
            }
            if (r.type === 'SYSTEM_MESSAGE' && typeof r.content === 'string') {
              const m = r.content.match(/Task id "[^"]*\/task-(\d+)" (finished with result:|was canceled(?: with result:)?)\s*([\s\S]*?)(?:\n\nLog: file:\/\/|\n<\/SYSTEM_MESSAGE>|$)/);
              if (m) {
                const taskStep = Number(m[1]);
                const canceled = m[2].startsWith('was canceled');
                completedBgTasks.set(taskStep, {
                  state: canceled ? 'CANCELED' : 'DONE',
                  output: (m[3] ?? '').trim(),
                });
              }
            }
          }
        } catch {}
      }
    } catch {}

    const findToolCallForStep = (stepIdx) => {
      for (let pIdx = stepIdx - 1; pIdx >= Math.max(0, stepIdx - 10); pIdx--) {
        const p = stepsByIndex.get(pIdx);
        if (!p) break;
        if (p.type === 'PLANNER_RESPONSE' && Array.isArray(p.tool_calls) && p.tool_calls.length > 0) {
          return p.tool_calls[stepIdx - pIdx - 1] ?? p.tool_calls[0];
        }
        if (p.type !== 'GENERIC') break;
      }
      return null;
    };

    // If a background task (task-N) has already finished and posted its SYSTEM_MESSAGE wakeup to
    // transcript.jsonl, complete its tool step immediately without killing any processes.
    for (const [taskStep, info] of completedBgTasks.entries()) {
      if (this.emittedTools.has(taskStep) && !this.syncedTranscriptSteps.has(taskStep)) {
        const tc = findToolCallForStep(taskStep);
        const toolName = tc?.name || 'run_command';
        const params = tc ? parseAgyToolArgs(tc.args) : {};
        this.syncedTranscriptSteps.add(taskStep);
        this.onAgyMessage({
          event: 'step_update',
          step_update: {
            step_index: taskStep,
            step_type: 'tool',
            state: info.state,
            tool_name: toolName,
            tool_info: {
              name: toolName,
              parameters: params,
              output: info.output,
              ...(info.state === 'CANCELED' ? { error: { message: info.output || 'Task canceled' } } : {}),
            },
          },
        }, true);
      }
    }

    // While a legitimate background task (minActiveStep) is still RUNNING, AGY's sequential stdout
    // emitter buffers subsequent completed steps (like view_file on a QR image, an assistant status
    // message, or wakeup steps) until minActiveStep finishes. Sync those completed steps from
    // transcript.jsonl immediately so the user sees them in real time without killing the task.
    if (!taskKilled && maxTranscriptStep > minActiveStep) {
      const sorted = [...stepsByIndex.entries()].sort((a, b) => a[0] - b[0]);
      for (const [stepIdx, r] of sorted) {
        if (stepIdx <= minActiveStep || this.syncedTranscriptSteps.has(stepIdx)) continue;
        if (r.type === 'PLANNER_RESPONSE' && r.status === 'DONE') {
          const hasText = typeof r.content === 'string' && r.content.trim().length > 0;
          const hasPureThinking = (!Array.isArray(r.tool_calls) || r.tool_calls.length === 0) &&
            typeof r.thinking === 'string' && r.thinking.trim().length > 0;
          if ((hasText || hasPureThinking) && !this.stepText.has(stepIdx)) {
            this.syncedTranscriptSteps.add(stepIdx);
            if (hasText) this.stepText.set(stepIdx, r.content);
            this.onAgyMessage({
              event: 'step_update',
              step_update: {
                step_index: stepIdx,
                step_type: 'agent_response',
                state: 'DONE',
              },
            }, true);
          }
        } else if (r.type === 'GENERIC' && (r.status === 'DONE' || r.status === 'ERROR' || r.status === 'CANCELED')) {
          const tc = findToolCallForStep(stepIdx);
          if (tc) {
            const toolName = tc.name || 'tool';
            const params = parseAgyToolArgs(tc.args);
            this.syncedTranscriptSteps.add(stepIdx);
            this.onAgyMessage({
              event: 'step_update',
              step_update: {
                step_index: stepIdx,
                step_type: 'tool',
                state: r.status,
                tool_name: toolName,
                tool_info: {
                  name: toolName,
                  parameters: params,
                  output: r.content ?? '',
                  ...(r.status === 'ERROR' ? { error: { message: r.content || 'Tool error' } } : {}),
                },
              },
            }, true);
          }
        }
      }
    }

    const forcedGraceMs = process.env.CCM_STUCK_TOOL_GRACE_MS ? Number(process.env.CCM_STUCK_TOOL_GRACE_MS) : null;
    const isStuck =
      this.emittedTools.size > 0 &&
      maxTranscriptStep > minActiveStep &&
      (forcedGraceMs !== null || taskKilled || minActiveStepDone);

    if (isStuck) {
      const now = Date.now();
      if (!this.stuckToolDetectedAt) {
        this.stuckToolDetectedAt = now;
        return;
      }
      const defaultGraceMs = taskKilled ? 2_000 : (minActiveStepDone ? 3_000 : 10_000);
      const graceMs = forcedGraceMs ?? defaultGraceMs;
      if (now - this.stuckToolDetectedAt >= graceMs) {
        const descendants = findDescendantPids(claudePid);
        if (descendants.length > 0) {
          this.emitLocal({
            type: 'bridge',
            subtype: 'note',
            message: `Unblocking AGY stream: terminating stuck background tool process(es) (PID ${descendants.join(', ')})`,
          });
          for (const pid of [...descendants].reverse()) {
            try { process.kill(pid, 'SIGTERM'); } catch {}
          }
          setTimeout(() => {
            for (const pid of [...descendants].reverse()) {
              if (alive(pid)) {
                try { process.kill(pid, 'SIGKILL'); } catch {}
              }
            }
          }, 500).unref();
        }
        this.stuckToolDetectedAt = null;
      }
    } else {
      this.stuckToolDetectedAt = null;
    }
  }

  /** Normalizes agy's stream-json events ({event: 'init' | 'step_update' | 'result'}) into bridge events. */
  onAgyMessage(msg, fromTranscriptSync = false) {
    if (msg.event === 'init') {
      if (msg.conversation_id && this.cliSessionId !== msg.conversation_id) {
        this.cliSessionId = msg.conversation_id;
        this.persistMeta();
      }
      const init = msg.init ?? {};
      this.currentModel = init.model || this.model || 'agy';
      this.onCliMessage({
        type: 'system',
        subtype: 'init',
        model: this.currentModel,
        cwd: init.cwd || this.cwd,
        permissionMode: this.mode,
        session_id: this.cliSessionId ?? this.id,
      });
      return;
    }

    if (msg.event === 'step_update') {
      const su = msg.step_update;
      if (!su) return;
      if (su.conversation_id && !this.cliSessionId) {
        this.cliSessionId = su.conversation_id;
        this.persistMeta();
      }
      const idx = su.step_index ?? 0;
      if (!fromTranscriptSync && this.syncedTranscriptSteps.has(idx)) return;

      if (su.step_type === 'agent_response') {
        if (typeof su.text_delta === 'string' && su.text_delta.length > 0) {
          const prev = this.stepText.get(idx) ?? '';
          const next = prev + su.text_delta;
          this.stepText.set(idx, next);
          sendToSubscribers(this.id, {
            ev: 'cli',
            sid: this.id,
            msg: { type: 'stream_event', step_index: idx, text_delta: su.text_delta },
          });
          if (this.status !== 'needs_approval') {
            this.setStatus('working', next.trim().slice(0, 120) || 'Thinking');
          }
        }
        if (su.state === 'DONE' || su.state === 'ERROR' || su.state === 'CANCELED') {
          const text = this.stepText.get(idx) ?? '';
          this.stepText.delete(idx);
          const thinking = this.readStepThinking(idx);
          const content = [];
          if (thinking) content.push({ type: 'thinking', thinking });
          if (text) content.push({ type: 'text', text });
          const usage = su.usage ? {
            input_tokens: su.usage.input_tokens ?? 0,
            output_tokens: su.usage.output_tokens ?? 0,
            cache_read_input_tokens: su.usage.cache_read_tokens ?? 0,
            cache_creation_input_tokens: 0,
            thinking_tokens: su.usage.thinking_tokens ?? 0,
          } : undefined;
          if (content.length > 0 || usage) {
            if (text) this.turnHadText = true;
            this.onCliMessage({
              type: 'assistant',
              uuid: `step-${idx}`,
              timestamp: new Date().toISOString(),
              cwd: this.cwd,
              message: {
                id: `${this.cliSessionId ?? this.id}-step-${idx}`,
                model: this.currentModel ?? this.model ?? 'agy',
                role: 'assistant',
                content,
                ...(usage ? { usage } : {}),
              },
            });
            if (usage) refreshAgyLimits(false);
          }
        }
        return;
      }

      if (su.step_type === 'tool') {
        const toolName = su.tool_info?.name || su.tool_name || (su.subagent_info ? 'invoke_subagent' : 'tool');
        const toolId = `tool-${idx}`;
        let input = su.tool_info?.parameters ?? {};
        if (su.subagent_info?.subagents?.length && !Object.keys(input).length) {
          input = {
            Subagents: su.subagent_info.subagents,
            description: su.subagent_info.subagents.map((s) => s.role || s.type_name).join(', '),
          };
        }
        if (!this.emittedTools.has(idx)) {
          this.emittedTools.add(idx);
          const priorThinking = idx > 0 ? this.readStepThinking(idx - 1) : null;
          const content = [];
          if (priorThinking) content.push({ type: 'thinking', thinking: priorThinking });
          content.push({ type: 'tool_use', id: toolId, name: toolName, input });
          this.onCliMessage({
            type: 'assistant',
            uuid: `step-${idx}-call`,
            timestamp: new Date().toISOString(),
            cwd: this.cwd,
            message: {
              id: `${this.cliSessionId ?? this.id}-step-${idx}-call`,
              model: this.currentModel ?? this.model ?? 'agy',
              role: 'assistant',
              content,
            },
          });
        }
        if (su.state === 'DONE' || su.state === 'ERROR' || su.state === 'CANCELED') {
          this.emittedTools.delete(idx);
          const isErr = su.state === 'ERROR' || !!su.tool_info?.error;
          const outText = isErr
            ? (su.tool_info?.error?.message || su.tool_info?.output || 'Tool error')
            : (su.tool_info?.output ?? '');
          let resultContent = outText;
          // If view_file read an image on disk, attach the image block so slimEvent saves it for the app.
          const viewedPath = !isErr && toolName === 'view_file' && typeof input?.AbsolutePath === 'string' ? input.AbsolutePath : null;
          if (viewedPath) {
            const ext = path.extname(viewedPath).toLowerCase().slice(1);
            const mime = IMAGE_MIME[ext === 'jpg' ? 'jpeg' : ext];
            try {
              const stat = mime ? fs.statSync(viewedPath) : null;
              if (stat && stat.isFile() && stat.size <= MAX_INLINE_IMAGE_BYTES) {
                const data = fs.readFileSync(viewedPath).toString('base64');
                resultContent = [
                  ...(outText ? [{ type: 'text', text: outText }] : []),
                  { type: 'image', source: { type: 'base64', media_type: mime, data } },
                ];
              }
            } catch {}
          }
          const usage = su.usage ? {
            input_tokens: su.usage.input_tokens ?? 0,
            output_tokens: su.usage.output_tokens ?? 0,
            cache_read_input_tokens: su.usage.cache_read_tokens ?? 0,
            cache_creation_input_tokens: 0,
            thinking_tokens: su.usage.thinking_tokens ?? 0,
          } : undefined;
          if (usage) {
            this.record({
              type: 'assistant',
              uuid: `step-${idx}-usage`,
              timestamp: new Date().toISOString(),
              cwd: this.cwd,
              message: {
                id: `${this.cliSessionId ?? this.id}-step-${idx}-usage`,
                model: this.currentModel ?? this.model ?? 'agy',
                role: 'assistant',
                content: [],
                usage,
              },
            });
            refreshAgyLimits(false);
          }
          this.onCliMessage({
            type: 'user',
            uuid: `step-${idx}-result`,
            message: {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: toolId,
                content: resultContent,
                is_error: isErr,
              }],
            },
          });
        }
        return;
      }

      if (su.step_type === 'system_message' && su.state === 'DONE' && su.text_delta) {
        this.emitLocal({ type: 'bridge', subtype: 'note', message: su.text_delta });
      }
      return;
    }

    if (msg.event === 'result') {
      const res = msg.result ?? {};
      if (res.conversation_id && !this.cliSessionId) {
        this.cliSessionId = res.conversation_id;
        this.persistMeta();
      }
      for (const [idx, text] of this.stepText.entries()) {
        if (text) {
          this.turnHadText = true;
          this.onCliMessage({
            type: 'assistant',
            uuid: `step-${idx}`,
            timestamp: new Date().toISOString(),
            cwd: this.cwd,
            message: {
              id: `${this.cliSessionId ?? this.id}-step-${idx}`,
              model: this.currentModel ?? this.model ?? 'agy',
              role: 'assistant',
              content: [{ type: 'text', text }],
            },
          });
        }
      }
      this.stepText.clear();
      this.emittedTools.clear();

      const isError = res.status ? res.status !== 'SUCCESS' : !!res.error;
      const errText = isError ? (res.error || res.response || '') : '';
      const turnUsage = res.usage ? {
        input_tokens: res.usage.input_tokens ?? 0,
        output_tokens: res.usage.output_tokens ?? 0,
        cache_read_input_tokens: res.usage.cache_read_tokens ?? 0,
        cache_creation_input_tokens: 0,
        thinking_tokens: res.usage.thinking_tokens ?? 0,
      } : undefined;
      if (!this.turnHadText && !isError && typeof res.response === 'string' && res.response.trim()) {
        this.onCliMessage({
          type: 'assistant',
          uuid: `turn-${Date.now()}`,
          timestamp: new Date().toISOString(),
          cwd: this.cwd,
          message: {
            id: `${this.cliSessionId ?? this.id}-turn-${Date.now()}`,
            model: this.currentModel ?? this.model ?? 'agy',
            role: 'assistant',
            content: [{ type: 'text', text: res.response }],
            ...(turnUsage ? { usage: turnUsage } : {}),
          },
        });
      }
      this.turnHadText = false;

      if (Array.isArray(res.denied_actions) && res.denied_actions.length) {
        const names = res.denied_actions.map((d) => d.display_name || d.action).join(', ');
        this.emitLocal({
          type: 'bridge',
          subtype: 'note',
          message: `Denied in ${this.mode} mode: ${names}. Switch mode to YOLO to allow all tool actions automatically.`,
        });
      }
      if (isError && (this.idleExit || /stream input cancelled/i.test(errText))) {
        return;
      }
      if (isError && /rate.?limit|quota|429|resource_exhausted/i.test(errText)) {
        this.limitHit = true;
      }
      this.onCliMessage({
        type: 'result',
        subtype: isError ? 'error' : 'success',
        is_error: isError,
        result: isError ? (errText || 'Error') : (res.response ?? ''),
        duration_ms: Math.round((res.duration_seconds ?? 0) * 1000),
        num_turns: res.num_turns ?? 1,
        total_cost_usd: 0,
        ...(turnUsage ? { usage: turnUsage } : {}),
      });
      refreshAgyLimits(true);
    }
  }

  onCliMessage(msg) {
    if (typeof msg.event === 'string' && !msg.type) {
      this.onAgyMessage(msg);
      return;
    }
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
      if (this.status !== 'needs_approval' && (tool || text)) {
        this.setStatus('working', tool ? `${tool.name}: ${describeInput(tool.input)}` : text.text.slice(0, 120));
      }
    } else if (msg.type === 'result') {
      this.addCost(msg.total_cost_usd);
      const limited = this.limitHit;
      this.limitHit = false;
      if (limited) { this.onLimited(); this.rejectedResetAt = null; return; }
      this.clearResume();
      this.rejectedResetAt = null;
      this.limitRetryMs = 0;
      const waiting = this.background.length ? `In the background: ${this.background[0].description}` : 'Waiting for you';
      this.setStatus(msg.is_error ? 'error' : 'idle', msg.is_error ? (msg.result ?? 'Error') : waiting);
      if (this.restartAfterTurn && this.link) {
        this.restartAfterTurn = false;
        this.idleExit = true;
        this.link.kill();
      }
    }
  }

  // Events the bridge itself adds to a transcript (errors, user prompts).
  emitLocal(msg) {
    msg = slimEvent(msg, this.id);
    this.record(msg);
    sendToSubscribers(this.id, { ev: 'cli', sid: this.id, msg });
  }

  /** Executes built-in agy CLI slash commands (/usage, /quota, /models, /skills, etc.) that run as one-shot print commands. */
  runSlashCommand(cmd) {
    const args = ['-p', cmd, '--output-format', 'json'];
    if (this.cliSessionId) args.push('--conversation', this.cliSessionId);
    execFile(claudeBin, args, {
      cwd: this.cwd,
      timeout: 30_000,
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
    }, (err, stdout, stderr) => {
      let reply = '';
      let isError = false;
      try {
        const parsed = JSON.parse(stdout);
        const isCmdError = parsed.status ? parsed.status !== 'SUCCESS' : (parsed.status === 'ERROR' || !!parsed.error);
        if (isCmdError) {
          isError = true;
          reply = parsed.error || parsed.response || 'Command error';
        } else {
          reply = parsed.response || (parsed.command ? JSON.stringify(parsed.command.data, null, 2) : stdout.trim());
        }
        if (parsed.command?.name === 'usage' || parsed.command?.name === 'quota') {
          parseAgyLimitsOutput(parsed);
        }
      } catch {
        isError = !!err;
        reply = (stdout || stderr || err?.message || 'Command failed').trim();
      }
      if (reply) {
        this.onCliMessage({
          type: 'assistant',
          uuid: `slash-${Date.now()}`,
          timestamp: new Date().toISOString(),
          cwd: this.cwd,
          message: {
            id: `${this.id}-slash-${Date.now()}`,
            model: this.currentModel ?? this.model ?? 'agy',
            role: 'assistant',
            content: [{ type: 'text', text: reply }],
          },
        });
      }
      this.onCliMessage({
        type: 'result',
        subtype: isError ? 'error' : 'success',
        is_error: isError,
        result: reply,
        duration_ms: 0,
        num_turns: 1,
        total_cost_usd: 0,
      });
    });
  }

  sendUser(text, attachments = []) {
    this.clearResume();
    const saved = this.saveAttachments(attachments);
    const trimmed = String(text ?? '').trim();
    const modelCmd = !saved.length && trimmed.match(/^\/model(?:\s+(.*))?$/i);
    if (modelCmd) {
      this.emitLocal({ type: 'user', message: { role: 'user', content: text }, local: true });
      const arg = (modelCmd[1] ?? '').trim();
      if (!arg) {
        this.setStatus('working', trimmed);
        this.runSlashCommand('/models');
        return;
      }
      const aliases = {
        default: null,
        auto: null,
        argon: 'gemini-4-argon',
        'gemini-4-argon': 'gemini-4-argon',
        flash: 'gemini-3.8-flash',
        'gemini-3.8-flash': 'gemini-3.8-flash',
        opus: 'claude-opus-5-5',
        'claude-opus-5-5': 'claude-opus-5-5',
        sonnet: 'claude-sonnet-5-5',
        'claude-sonnet-5-5': 'claude-sonnet-5-5',
        'gpt-oss': 'gpt-oss-120b',
        'gpt-oss-120b': 'gpt-oss-120b',
      };
      const resolved = Object.prototype.hasOwnProperty.call(aliases, arg.toLowerCase())
        ? aliases[arg.toLowerCase()]
        : arg;
      this.setModel(resolved);
      return;
    }
    // Built-in CLI slash commands cannot be sent over stream-json stdin in agy; run them via one-shot print mode.
    if (!saved.length && /^\/(usage|quota|credits|models|agents|skills|permissions|effort|help|config|changelog)(\s|$)/i.test(trimmed)) {
      this.emitLocal({ type: 'user', message: { role: 'user', content: text }, local: true });
      this.setStatus('working', trimmed);
      this.runSlashCommand(trimmed);
      return;
    }

    this.ensureProcess();
    let promptText = text;
    let legacyContent = text;
    if (saved.length) {
      const list = saved.map((a) => `- ${a.path} (${a.mime}, ${formatBytes(a.size)})`).join('\n');
      promptText = `${text || 'See the attached files.'}\n\nAttached files, saved on this machine (use view_file to read or view them):\n${list}`;
      legacyContent = [
        { type: 'text', text: promptText },
        ...saved.filter((a) => a.inline).map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } })),
      ];
    }
    // The stored copy keeps file names, not file contents.
    this.emitLocal({
      type: 'user', message: { role: 'user', content: text }, local: true,
      ...(saved.length ? { attachments: saved.map(({ name, mime, size, path: p }) => ({ name, mime, size, path: p })) } : {}),
    });
    this.turnHadText = false;
    if (process.env.CCM_LEGACY_PROTO === '1') {
      this.writeCli({ type: 'user', message: { role: 'user', content: legacyContent } });
    } else {
      this.writeCli({
        event: 'user',
        message: { role: 'user', content: [{ type: 'text', text: promptText }] },
      });
    }
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

  /**
   * Moves the task to another working folder. agy restarts there on the next message and resumes
   * the same conversation (--conversation <id>). Refused while agy is busy.
   */
  async moveTo(dir) {
    const target = path.resolve(String(dir ?? '').replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`Not a folder: ${target}`);
    if (target === this.cwd) return;
    if (['working', 'needs_approval'].includes(this.status) || this.background.length) {
      throw new Error('AGY is busy in this task. Wait for it to finish, or stop it, then change the folder.');
    }
    if (this.link) {
      this.link.kill();
      for (let i = 0; i < 100 && this.link; i++) await new Promise((r) => setTimeout(r, 100));
      if (this.link) throw new Error("AGY didn't stop; try again.");
    }
    const from = this.cwd;
    this.cwd = target;
    this.ports = [];
    this.emitLocal({ type: 'bridge', subtype: 'note', message: `Working folder: ${target} (was ${from})` });
    this.setStatus(this.status === 'stopped' || this.status === 'error' ? 'idle' : this.status);
  }

  /**
   * [answers] replies to AskUserQuestion / ask_question: {question text: chosen label(s) or the user's own words}.
   */
  answer(requestId, decision, always, message, answers) {
    const req = this.pending.get(requestId);
    if (!req) return false;
    this.pending.delete(requestId);
    const ok = answers && typeof answers === 'object' && Object.values(answers).every((v) => typeof v === 'string');
    const input = ok ? { ...req.request.input, answers } : req.request.input;
    const response = decision === 'allow'
      ? { behavior: 'allow', updatedInput: input, ...(always && req.request.permission_suggestions ? { updatedPermissions: req.request.permission_suggestions.filter((s) => s.type === 'addRules') } : {}) }
      : { behavior: 'deny', message: message || 'The user denied this from the AGY Mobile app.' };
    this.writeCli({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.emitLocal({ type: 'bridge', subtype: 'permission_answer', request_id: requestId, decision, always: !!always });
    if (this.pending.size === 0) this.setStatus('working', decision === 'allow' ? 'Approved' : 'Denied');
    return true;
  }

  restartProcessForNextTurn() {
    if (!this.link) return;
    if (this.status === 'working' || this.status === 'needs_approval') {
      this.restartAfterTurn = true;
    } else {
      this.idleExit = true;
      this.link.kill();
    }
  }

  setMode(mode) {
    this.mode = mode;
    if (process.env.CCM_LEGACY_PROTO === '1') {
      this.writeCli({ type: 'control_request', request_id: `mode-${randomUUID()}`, request: { subtype: 'set_permission_mode', mode } });
    } else {
      this.restartProcessForNextTurn();
    }
    this.emitLocal({ type: 'bridge', subtype: 'note', message: mode === 'bypassPermissions' ? 'YOLO mode on: tools run without asking' : `Permission mode: ${mode}` });
    this.setStatus(this.status);
  }

  setModel(model) {
    this.model = model || null;
    this.currentModel = this.model;
    if (process.env.CCM_LEGACY_PROTO !== '1') {
      this.restartProcessForNextTurn();
    }
    this.emitLocal({ type: 'bridge', subtype: 'note', message: `Model: ${this.model ?? 'default'}` });
    this.setStatus(this.status);
  }

  setEffort(effort) {
    this.effort = effort;
    if (process.env.CCM_LEGACY_PROTO === '1' && this.link) {
      this.writeCli({ type: 'control_request', request_id: `effort-${randomUUID()}`, request: { subtype: 'apply_flag_settings', settings: { effortLevel: effort } } });
    } else {
      this.restartProcessForNextTurn();
    }
    this.emitLocal({ type: 'bridge', subtype: 'note', message: `Reasoning effort: ${effort ?? 'model default'}` });
    this.setStatus(this.status);
  }

  interrupt() {
    if (process.env.CCM_LEGACY_PROTO === '1') {
      this.writeCli({ type: 'control_request', request_id: `int-${randomUUID()}`, request: { subtype: 'interrupt' } });
      return;
    }
    const claudePid = this.link?.info?.claudePid;
    if (claudePid && alive(claudePid)) {
      const descendants = findDescendantPids(claudePid);
      if (descendants.length > 0) {
        this.emitLocal({ type: 'bridge', subtype: 'note', message: 'Stopping running command' });
        for (const pid of [...descendants].reverse()) {
          try { process.kill(pid, 'SIGINT'); process.kill(pid, 'SIGTERM'); } catch {}
        }
        return;
      }
    }
    if (this.link) {
      this.interrupted = true;
      this.link.kill();
    }
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
    this.limitRetryMs = 0;
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

  /**
   * Gives image placeholders that have no ref (logs slimmed before images were kept) their
   * image back from the CLI's transcript, which still has them. Runs once per session.
   */
  backfillImages() {
    if (this.imagesBackfilled) return;
    this.imagesBackfilled = true;
    const missing = (b) => b?.type === 'image' && b.omittedBytes && !b.ref && !b.missing;
    const results = (e) => (e.type === 'user' && Array.isArray(e.message?.content) ? e.message.content : [])
      .filter((b) => b?.type === 'tool_result' && Array.isArray(b.content) && b.content.some(missing));
    if (!this.events.some((e) => results(e).length)) return;
    const found = new Map(); // tool_use_id -> image blocks with data
    const file = findCliTranscript(this.cliSessionId ?? this.id);
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
    const file = findCliTranscript(this.cliSessionId ?? this.id);
    if (!file) return;
    const { size, mtimeMs } = fs.statSync(file);
    if (size === this.cliSize) return;
    this.cliSize = size;
    const known = new Set(this.events.map((e) => e.uuid).filter(Boolean));
    const records = readJsonl(file).map(cliRecordToEvent).filter(Boolean);
    const last = records.findLastIndex((r) => known.has(r.uuid));
    const fresh = (last < 0 ? records : records.slice(last + 1)).filter((e) => !known.has(e.uuid));
    if (fresh.length) {
      this.emitLocal({ type: 'bridge', subtype: 'note', message: 'Continued in AGY CLI outside this app' });
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

// ---------- root ----------

// Resolved before the server starts listening, so hello can report it.
// With root Claude can operate the phone itself (su -c: screencap, input, am, pm...), and the bridge
// can read the socket table for the ports a task listens on.
let rootAvailable = false;
async function detectRoot() {
  if (process.env.CCM_ROOT) return process.env.CCM_ROOT === '1';
  // Root on Android, not just root: Termux's su, or the chroot's su (chroot/su) whose commands run
  // on Android although this Node reports linux.
  return new Promise((resolve) => execFile(process.env.CCM_SU ?? 'su', ['-c', 'id -u; getprop ro.build.version.sdk'], { timeout: 10_000 },
    (err, out) => resolve(!err && /^0\n\d+\s*$/.test(out))));
}

// ---------- CLI transcripts (~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl & ~/.claude/projects) ----------

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
  const agyTranscript = path.join(agyDataDir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  if (fs.existsSync(agyTranscript)) return agyTranscript;
  let dirs = [];
  try { dirs = fs.readdirSync(claudeProjectsDir); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(claudeProjectsDir, d, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function stripUserRequestTags(s) {
  if (typeof s !== 'string') return '';
  const m = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return (m ? m[1] : s).trim();
}

function parseAgyToolArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      try { out[k] = JSON.parse(v); } catch { out[k] = v; }
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Turns a transcript record (from either agy's transcript.jsonl or legacy .claude/projects/*.jsonl)
// into the normalized message the app renders.
function cliRecordToEvent(r) {
  // agy transcript.jsonl step record
  if (typeof r.step_index === 'number' && typeof r.type === 'string') {
    const uuid = `step-${r.step_index}`;
    if (r.type === 'USER_INPUT') {
      const content = stripUserRequestTags(r.content ?? '');
      if (!content) return null;
      return { type: 'user', message: { role: 'user', content }, uuid, timestamp: r.created_at, parent_tool_use_id: null };
    }
    if (r.type === 'PLANNER_RESPONSE') {
      const blocks = [];
      if (typeof r.thinking === 'string' && r.thinking.trim()) {
        blocks.push({ type: 'thinking', thinking: r.thinking.trim() });
      }
      if (typeof r.content === 'string' && r.content.trim()) {
        blocks.push({ type: 'text', text: r.content });
      }
      if (Array.isArray(r.tool_calls)) {
        r.tool_calls.forEach((tc, idx) => {
          if (tc?.name) {
            blocks.push({
              type: 'tool_use',
              id: `step-${r.step_index}-tool-${idx}`,
              name: tc.name,
              input: parseAgyToolArgs(tc.args),
            });
          }
        });
      }
      if (!blocks.length) return null;
      return {
        type: 'assistant',
        message: { role: 'assistant', content: blocks },
        uuid,
        timestamp: r.created_at,
        parent_tool_use_id: null,
      };
    }
    if (r.type === 'ERROR_MESSAGE' && r.content) {
      return { type: 'result', subtype: 'error', is_error: true, result: r.content, uuid };
    }
    return null;
  }

  // Legacy Claude Code transcript record
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

let agyMetaCache = { mtime: 0, map: new Map() };
function getAgyConversationMeta() {
  const dbPath = path.join(agyDataDir, 'conversation_summaries.db');
  const histPath = path.join(agyDataDir, 'history.jsonl');
  let mtime = 0;
  try { mtime += fs.statSync(dbPath).mtimeMs; } catch {}
  try { mtime += fs.statSync(histPath).mtimeMs; } catch {}
  if (mtime && mtime === agyMetaCache.mtime) return agyMetaCache.map;

  const map = new Map();
  // Read history.jsonl first
  try {
    for (const r of readJsonl(histPath)) {
      if (!r.conversationId) continue;
      const cur = map.get(r.conversationId) ?? {};
      if (r.workspace && !cur.cwd) cur.cwd = r.workspace;
      if (r.display) {
        cur.firstPrompt ??= r.display;
        cur.lastPrompt = r.display;
      }
      if (r.timestamp) {
        cur.createdAt ??= r.timestamp;
        cur.updatedAt = Math.max(cur.updatedAt ?? 0, r.timestamp);
      }
      map.set(r.conversationId, cur);
    }
  } catch {}

  // Read conversation_summaries.db via python3 if present
  if (fs.existsSync(dbPath)) {
    try {
      const py = `
import sqlite3, json, sys
conn = sqlite3.connect(sys.argv[1])
cur = conn.cursor()
cur.execute("SELECT conversation_id, title, preview, workspace_uris, parent_conversation_id, last_modified_time FROM conversation_summaries")
print(json.dumps(cur.fetchall()))
`;
      const out = execFileSync('python3', ['-c', py, dbPath], { timeout: 5000, encoding: 'utf8' });
      for (const [id, title, preview, urisJson, parentId, lastMod] of JSON.parse(out)) {
        const cur = map.get(id) ?? {};
        if (parentId) cur.isSubagent = true;
        if (title) cur.title = title;
        if (preview) {
          cur.firstPrompt ??= preview;
          cur.lastPrompt ??= preview;
        }
        if (urisJson && !cur.cwd) {
          try {
            const uris = JSON.parse(urisJson);
            const firstUri = Array.isArray(uris) ? uris[0] : null;
            if (typeof firstUri === 'string' && firstUri.startsWith('file://')) {
              cur.cwd = decodeURIComponent(firstUri.slice('file://'.length));
            }
          } catch {}
        }
        const ts = Date.parse(lastMod);
        if (ts) cur.updatedAt = Math.max(cur.updatedAt ?? 0, ts);
        map.set(id, cur);
      }
    } catch {}
  }

  agyMetaCache = { mtime, map };
  return map;
}

// What the resume list needs, read from the head and tail of the file so large transcripts stay cheap.
function cliSessionInfo(file, sessionId = null) {
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
  const agyMeta = sessionId ? getAgyConversationMeta().get(sessionId) : null;
  if (agyMeta?.isSubagent) return null;

  const info = {
    cwd: agyMeta?.cwd ?? null,
    title: agyMeta?.title ?? null,
    aiTitle: null,
    firstPrompt: agyMeta?.firstPrompt ?? null,
    lastPrompt: agyMeta?.lastPrompt ?? null,
    model: null,
    mode: null,
    createdAt: agyMeta?.createdAt ?? null,
  };
  for (const r of readJsonl(file, text)) {
    if (typeof r.step_index === 'number') {
      if (r.type === 'USER_INPUT') {
        const prompt = stripUserRequestTags(r.content ?? '');
        if (prompt) {
          if (!info.firstPrompt) {
            info.firstPrompt = prompt;
            info.createdAt ??= Date.parse(r.created_at) || null;
          }
          info.lastPrompt = prompt;
        }
      }
      continue;
    }
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
  if (!info.cwd && sessionId && file.startsWith(agyDataDir)) info.cwd = opts.roots[0] ?? os.homedir();
  const firstLine = (s) => s.split('\n')[0].slice(0, 100);
  return {
    cwd: info.cwd,
    title: firstLine(info.title ?? info.aiTitle ?? info.firstPrompt),
    lastPrompt: (info.lastPrompt ?? info.firstPrompt).slice(0, 200),
    model: info.model,
    mode: MODES.includes(info.mode) ? info.mode : 'bypassPermissions',
    createdAt: info.createdAt ?? Math.round(birthtimeMs || mtimeMs),
    updatedAt: agyMeta?.updatedAt ?? Math.round(mtimeMs),
  };
}

/** CLI sessions on this machine that the bridge isn't already tracking, newest first. */
function listCliSessions(limit = 50) {
  const trackedCliIds = new Set();
  for (const s of sessions.values()) {
    trackedCliIds.add(s.id);
    if (s.cliSessionId) trackedCliIds.add(s.cliSessionId);
  }
  const files = [];
  // 1. Scan agy brain transcripts
  const brainDir = path.join(agyDataDir, 'brain');
  try {
    for (const id of fs.readdirSync(brainDir)) {
      if (trackedCliIds.has(id)) continue;
      const file = path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      try { files.push({ id, file, mtime: fs.statSync(file).mtimeMs }); } catch {}
    }
  } catch {}

  // 2. Scan legacy .claude/projects transcripts
  let dirs = [];
  try { dirs = fs.readdirSync(claudeProjectsDir); } catch {}
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(claudeProjectsDir, d)); } catch { continue; }
    for (const n of names) {
      const id = n.slice(0, -'.jsonl'.length);
      if (!n.endsWith('.jsonl') || trackedCliIds.has(id)) continue;
      const file = path.join(claudeProjectsDir, d, n);
      try { files.push({ id, file, mtime: fs.statSync(file).mtimeMs }); } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const { id, file } of files) {
    if (out.length >= limit) break;
    let info;
    try { info = cliSessionInfo(file, id); } catch { continue; }
    if (info?.cwd && fs.existsSync(info.cwd)) out.push({ id, ...info });
  }
  return out;
}

/** Makes a CLI session started elsewhere into a bridge session; the next message runs `agy --conversation <id>`. */
function importCliSession(id) {
  const file = findCliTranscript(id);
  if (!file) throw new Error('No AGY CLI session with that id on this machine.');
  const info = cliSessionInfo(file, id);
  if (!info?.cwd) throw new Error('That session has no conversation to resume.');
  if (!fs.existsSync(info.cwd)) throw new Error(`Its folder no longer exists: ${info.cwd}`);
  const s = new Session({ id, cliSessionId: id, cwd: info.cwd, title: info.title, model: info.model, mode: info.mode, createdAt: info.createdAt });
  s.started = true;
  s.updatedAt = info.updatedAt;
  s.lastActivity = 'Resumed from AGY CLI';
  s.cliSize = fs.statSync(file).size;
  const events = readJsonl(file).map(cliRecordToEvent).filter(Boolean).map((e) => slimEvent(e, id));
  events.push({ type: 'bridge', subtype: 'note', message: 'Resumed from AGY CLI. New messages continue this session.' });
  s.events = events.slice(-MAX_EVENTS);
  fs.writeFileSync(s.logFile, s.events.map((e) => JSON.stringify(e) + '\n').join(''));
  sessions.set(id, s);
  s.persistMeta();
  return s;
}

// ---------- usage ----------

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

/** Parses `agy -p /usage --output-format json` or direct `retrieveUserQuotaSummary` output into bridge `limits`. */
function parseAgyLimitsOutput(parsed) {
  const groups = parsed?.command?.data?.groups ?? parsed?.groups;
  if (!Array.isArray(groups)) return false;
  const windows = [];
  let anyExhausted = false;
  for (const g of groups) {
    for (const b of g?.buckets ?? []) {
      const rem = typeof b?.remaining_fraction === 'number'
        ? b.remaining_fraction
        : (typeof b?.remainingFraction === 'number' ? b.remainingFraction : null);
      if (rem === null) continue;
      const utilization = Math.max(0, Math.min(1, 1 - rem));
      if (rem <= 0) anyExhausted = true;
      const resetStr = b.reset_time ?? b.resetTime;
      const resetsAt = resetStr ? (Date.parse(resetStr) || 0) : 0;
      const id = b.id || b.bucketId || b.label || b.displayName || 'quota';
      const disabled = Boolean(b.disabled);
      const description = typeof b.description === 'string' && b.description ? b.description : undefined;
      windows.push({
        id,
        utilization,
        resetsAt,
        ...(disabled ? { disabled: true } : {}),
        ...(description ? { description } : {}),
      });
    }
  }
  if (!windows.length) return false;
  limits = { status: anyExhausted ? 'rejected' : 'allowed', windows, updatedAt: Date.now() };
  try { fs.writeFileSync(limitsFile, JSON.stringify(limits)); } catch {}
  broadcast({ ev: 'limits', limits });
  return true;
}

/**
 * Fetches quota directly from Cloud Code PA (`retrieveUserQuotaSummary`) in ~400ms using AGY's
 * saved OAuth token, avoiding a 12-second `agy.bin -p /usage` subprocess spawn when possible.
 */
async function fetchDirectAgyQuota() {
  if (process.env.CCM_LEGACY_PROTO === '1') return false;
  if (process.env.FAKE_AGY_USAGE === '1' && !process.env.CCM_QUOTA_URL) return false;
  const tokenPath = path.join(agyDataDir, 'antigravity-oauth-token');
  if (!fs.existsSync(tokenPath)) return false;
  let accessToken = null;
  try {
    const data = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    accessToken = data?.token?.access_token;
  } catch { return false; }
  if (!accessToken || typeof accessToken !== 'string') return false;
  if (!process.env.CCM_QUOTA_URL && (accessToken === 'ya29.test' || accessToken.startsWith('ya29.fake'))) return false;
  let project = 'default-cli-project';
  try {
    const p = fs.readFileSync(path.join(agyDataDir, 'cache', 'default_project_id.txt'), 'utf8').trim();
    if (p) project = p;
  } catch {}
  const url = process.env.CCM_QUOTA_URL || 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': `antigravity/cli/1.2.7 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=984112147; auth_method=consumer)`,
      },
      body: JSON.stringify({ project }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const json = await res.json();
    return parseAgyLimitsOutput(json);
  } catch {
    return false;
  }
}

let limitsRefreshPromise = null;
let lastLimitsRefresh = 0;
function refreshAgyLimits(force = false) {
  if (process.env.CCM_LEGACY_PROTO === '1') return Promise.resolve(limits);
  if (limitsRefreshPromise) return limitsRefreshPromise;
  if (!force && Date.now() - lastLimitsRefresh < 4_000) return Promise.resolve(limits);
  lastLimitsRefresh = Date.now();
  limitsRefreshPromise = (async () => {
    try {
      if (await fetchDirectAgyQuota()) return limits;
      await new Promise((resolve) => {
        execFile(claudeBin, ['-p', '/usage', '--output-format', 'json'], {
          timeout: 15_000,
          env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
        }, (err, stdout) => {
          if (!err && stdout) {
            try { parseAgyLimitsOutput(JSON.parse(stdout)); } catch {}
          }
          resolve();
        });
      });
    } finally {
      limitsRefreshPromise = null;
    }
    return limits;
  })();
  return limitsRefreshPromise;
}

// Token use per assistant message, read from bridge session logs and CLI transcripts.
/** @type {Map<string, {mtimeMs: number, size: number, records: object[]}>} */
const usageCache = new Map();

function transcriptFiles(dir = claudeProjectsDir, depth = 0, out = []) {
  if (depth === 0) {
    // Include bridge session jsonl logs (which store normalized assistant usage records from agy)
    try {
      for (const e of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(sessionsDir, e.name));
      }
    } catch {}
  }
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
    const outTok = u.output_tokens ?? 0;
    const thinkTok = u.thinking_tokens ?? 0;
    records.push({
      id: r.message.id ?? r.requestId ?? r.uuid,
      t: Date.parse(r.timestamp) || stat.mtimeMs || 0,
      model: r.message.model ?? 'unknown',
      cwd: r.cwd ?? '',
      input: u.input_tokens ?? 0,
      output: outTok >= thinkTok ? outTok : outTok + thinkTok,
      thinking: thinkTok,
      cacheRead: u.cache_read_input_tokens ?? u.cache_read_tokens ?? 0,
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
    byDay.set(dayOf(today - i * 86_400_000), { date: dayOf(today - i * 86_400_000), input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });
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
      d.input += r.input; d.output += r.output; d.thinking += r.thinking ?? 0; d.cacheRead += r.cacheRead; d.cacheWrite += r.cacheWrite; d.requests++;
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
  const v = input.CommandLine ?? input.command
    ?? input.TargetFile ?? input.AbsolutePath ?? input.file_path
    ?? input.DirectoryPath ?? input.SearchPath ?? input.SearchDirectory ?? input.path
    ?? input.Query ?? input.Pattern ?? input.pattern
    ?? input.Url ?? input.url
    ?? input.query
    ?? input.toolSummary ?? input.toolAction ?? input.description;
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
      s.inputTokens = meta.inputTokens ?? 0;
      s.outputTokens = meta.outputTokens ?? 0;
      s.thinkingTokens = meta.thinkingTokens ?? 0;
      s.cacheReadTokens = meta.cacheReadTokens ?? 0;
      s.requests = meta.requests ?? 0;
      s.started = !!meta.started;
      s.cliSize = meta.cliSize;
      try {
        const allLines = fs.readFileSync(s.logFile, 'utf8').split('\n').filter(Boolean);
        const parsedAll = allLines.map((l) => slimEvent(JSON.parse(l), s.id));
        if (parsedAll.some((e) => e.type === 'result' && e.total_cost_usd > 0)) {
          s.costUsd = 0;
          for (const e of parsedAll) if (e.type === 'result') s.addCost(e.total_cost_usd);
        }
        if (parsedAll.some((e) => e.type === 'assistant' && e.message?.usage)) {
          s.inputTokens = 0; s.outputTokens = 0; s.thinkingTokens = 0; s.cacheReadTokens = 0; s.requests = 0;
          for (const e of parsedAll) {
            if (e.type === 'assistant' && e.message?.model !== '<synthetic>' && e.message?.usage) {
              s.addUsage(e.message.usage);
            }
          }
        }
        const slim = parsedAll.map((e) => JSON.stringify(e) + '\n').join('');
        if (slim.length < allLines.reduce((n, l) => n + l.length + 1, 0)) fs.writeFileSync(s.logFile, slim);
        s.events = parsedAll
          .filter((e) => !(e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.length === 0))
          .slice(-MAX_EVENTS);
      } catch {}
      sessions.set(s.id, s);
      // agy still running under a keeper from before the restart (or finished meanwhile):
      // restore what was in flight and carry on reading its output.
      if (fs.existsSync(path.join(s.keeperDir, 'keeper.json'))) {
        s.status = meta.status ?? 'idle';
        s.pending = new Map((meta.pendingRequests ?? []).map((r) => [r.request_id, r]));
        s.background = meta.backgroundTasks ?? [];
        s.attach();
        s.scheduleIdleExit();
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

/** A short name: the program, or interpreter plus script ("python3 render.py"), not the glibc/musl loader. */
function processName(args) {
  const base = (s) => (s ?? '').split('/').pop();
  let i = 0;
  if (/^ld-(linux|musl)/.test(base(args[0]))) i = args.findIndex((a, k) => k > 0 && !a.startsWith('-') && args[k - 1] !== '--library-path');
  const name = base(args[Math.max(i, 0)]).replace(/(-native|\.bin)$/, '');
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
  const cliIdToSid = new Map();
  roles.set(process.pid, { role: 'bridge' });
  for (const s of sessions.values()) {
    if (s.cliSessionId) cliIdToSid.set(s.cliSessionId, s.id);
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
      const sid = env.AGY_SESSION_ID ?? env.CLAUDE_CODE_SESSION_ID ?? (env.ANTIGRAVITY_CONVERSATION_ID ? cliIdToSid.get(env.ANTIGRAVITY_CONVERSATION_ID) : null) ?? null;
      list.push({
        pid, ppid: st.ppid, name: processName(args), args, cwd, state: st.state,
        startedAt: Math.round(bootWall + st.start * 1000 / CLK_TCK), cpuSeconds: st.ticks / CLK_TCK, cpu, rssKb: rss,
        envSid: sid, runnable: !!resolveProgram(args[0], env), ...(roles.get(pid) ?? {}),
      });
    } catch {} // gone meanwhile
  }
  // Everything agy started belongs to its task: by parentage, or by the session id put in each
  // command's environment (which detached nohup/setsid jobs keep).
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

/** Recursively returns all tool subprocess IDs that descend from rootPid (excluding agy.bin and its proxy). */
function findDescendantPids(rootPid) {
  if (!rootPid) return [];
  const childrenOf = new Map();
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        const st = procStat(pid);
        if (!childrenOf.has(st.ppid)) childrenOf.set(st.ppid, []);
        childrenOf.get(st.ppid).push(pid);
      } catch {}
    }
  } catch {}
  const isAgyRuntime = (pid) => {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return /(?:^|\/|\0)(?:agy\.bin|termux-http-proxy|dns-proxy)(?:\0|$)/.test(cmd);
    } catch {
      return false;
    }
  };
  const res = [];
  const queue = [...(childrenOf.get(rootPid) ?? [])];
  while (queue.length) {
    const p = queue.shift();
    if (!isAgyRuntime(p)) res.push(p);
    const ch = childrenOf.get(p);
    if (ch) queue.push(...ch);
  }
  return res;
}

/** Stops a process and runs its command again in the same folder and environment; returns the new pid. */
async function restartProcess(pid) {
  const p = ownProcess(pid);
  if (['bridge', 'keeper', 'claude'].includes(p.role)) throw new Error("Restart a task's AGY process by stopping the task and sending it a message.");
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

// ---------- terminal ----------

// A shell in the Debian chroot for the app's Terminal screen. It runs in a pseudo-terminal (ptyhost.py)
// and outlives the screen: closing the screen detaches, and reopening replays recent output.
const TERM_BUFFER = 256 * 1024;
/** @type {Map<string, Terminal>} */
const terminals = new Map();

/** A login shell in the Debian chroot: bash itself for the chroot's bridge, else through ccm-chroot. */
function chrootShell() {
  if (process.env.CCM_TERM_SHELL) return process.env.CCM_TERM_SHELL.split(' ');
  if (fs.existsSync('/etc/debian_version') && !process.execPath.includes('/com.termux/')) return ['bash', '-l'];
  if (!fs.existsSync('/data/ccm/ccm-chroot')) throw new Error("The Debian chroot isn't installed. Set it up with: sh chroot/ccm-chroot install");
  return [process.env.CCM_SU ?? 'su', '-c', `sh ${path.join(path.dirname(ptyPy), '..', 'chroot', 'ccm-chroot')} shell`];
}

// Sign-in pages opened with $BROWSER pass the link to the bridge instead, which sends it to the app to open.
const openUrlSh = path.join(stateDir, 'open-url.sh');
fs.writeFileSync(openUrlSh, `#!${['/bin/sh', '/system/bin/sh'].find((p) => fs.existsSync(p))}
printf '%s\\n' "$1" > "$CCM_OPEN_URL.tmp" && mv "$CCM_OPEN_URL.tmp" "$CCM_OPEN_URL"
`, { mode: 0o755 });

class Terminal {
  /** kind 'shell' is the Debian terminal; 'login' runs `agy` interactive login where this bridge runs AGY. */
  constructor(cols, rows, kind = 'shell') {
    this.id = randomUUID();
    this.kind = kind;
    this.chunks = [];
    this.size = 0;
    this.clients = new Set();
    this.links = []; // sign-in pages for the app to open, as {url, local}
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
    let command = chrootShell;
    if (kind === 'login') {
      command = () => process.env.CCM_LEGACY_PROTO === '1' ? [claudeBin, 'auth', 'login'] : [claudeBin];
      this.urlFile = path.join(stateDir, `login-${this.id}.url`);
      Object.assign(env, { BROWSER: openUrlSh, CCM_OPEN_URL: this.urlFile });
      this.urlCheck = setInterval(() => this.checkLink(), 250);
    }
    this.proc = spawn('python3', [ptyPy, String(cols), String(rows), ...command()], {
      cwd: os.homedir(), env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    for (const s of [this.proc.stdin, this.proc.stdio[3]]) s.on('error', () => {});
    this.proc.stdout.on('data', (d) => this.output(d));
    this.proc.stderr.on('data', (d) => this.output(d));
    this.proc.on('error', (e) => this.output(Buffer.from(`\r\nCan't start the terminal: ${e.message}\r\n`)));
    this.proc.on('close', (code) => {
      clearInterval(this.urlCheck);
      if (this.urlFile) fs.rm(this.urlFile, { force: true }, () => {});
      terminals.delete(this.id);
      for (const c of this.clients) c.send({ ev: 'term_exit', id: this.id, code });
    });
    terminals.set(this.id, this);
  }

  /** The page $BROWSER was asked to open. */
  checkLink() {
    let url;
    try { url = fs.readFileSync(this.urlFile, 'utf8').trim(); } catch { return; }
    fs.rmSync(this.urlFile, { force: true });
    if (/^https:\/\//.test(url)) this.link(url, true);
  }

  /** local: the sign-in only finishes in a browser on this machine; otherwise it shows a code to paste. */
  link(url, local) {
    if (this.links.some((l) => l.url === url)) return;
    this.links.push({ url, local });
    for (const c of this.clients) c.send({ ev: 'term_link', id: this.id, url, local });
  }

  output(data) {
    if (this.kind === 'login') {
      const str = data.toString();
      for (const m of str.matchAll(/\x1b\]8;;(https:\/\/[^\x07\x1b]+)/g)) this.link(m[1], false);
      for (const m of str.matchAll(/(https:\/\/accounts\.google\.com\/[^\s\x1b"']+)/g)) this.link(m[1], true);
    }
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > TERM_BUFFER && this.chunks.length > 1) this.size -= this.chunks.shift().length;
    const msg = { ev: 'term_output', id: this.id, data: data.toString('base64') };
    for (const c of this.clients) c.send(msg);
  }

  replay() { return Buffer.concat(this.chunks).toString('base64'); }
  write(base64) { this.proc.stdin.write(Buffer.from(String(base64 ?? ''), 'base64')); }
  resize(cols, rows) {
    if (cols > 0 && rows > 0) this.proc.stdio[3].write(`${Math.min(cols, 1000)} ${Math.min(rows, 1000)}\n`);
  }
  close() { this.proc.kill('SIGTERM'); } // the shell gets SIGHUP when the terminal closes
}

function terminalFor(id) {
  const term = terminals.get(String(id ?? ''));
  if (!term) throw new Error('That terminal has ended.');
  return term;
}

/** Who AGY is signed in as here: reads ~/.gemini/antigravity-cli/antigravity-oauth-token (or falls back to `auth status --json`). */
function authStatus() {
  const tokenPath = path.join(agyDataDir, 'antigravity-oauth-token');
  if (fs.existsSync(tokenPath) && process.env.CCM_LEGACY_PROTO !== '1') {
    try {
      const data = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      const loggedIn = Boolean(data?.token?.access_token || data?.token?.refresh_token);
      let email = null;
      let orgName = null;
      if (typeof data?.id_token === 'string') {
        const parts = data.id_token.split('.');
        if (parts.length >= 2) {
          const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
          email = claims.email ?? null;
          orgName = claims.hd ?? claims.name ?? null;
        }
      }
      return Promise.resolve({
        loggedIn,
        authMethod: data?.auth_method || 'google-oauth',
        email,
        subscriptionType: 'Antigravity',
        orgName,
      });
    } catch {}
  }
  return new Promise((resolve) => execFile(claudeBin, ['auth', 'status', '--json'], { timeout: 15_000 }, (err, stdout) => {
    try { resolve(JSON.parse(stdout)); } catch {
      resolve({ loggedIn: false, authMethod: null, email: null, subscriptionType: null, orgName: null });
    }
  }));
}

// ---------- listening ports ----------

// TCP ports that processes a task started are listening on (a dev server, say), for the task list.
const PORTS_CHECK_MS = Number(process.env.CCM_PORTS_CHECK_MS ?? 5000);

/** Listening sockets by inode, from /proc/net/tcp and tcp6 (through su where an app can't read them). */
async function listeningSockets() {
  let text = '';
  try { text = fs.readFileSync('/proc/net/tcp', 'utf8') + fs.readFileSync('/proc/net/tcp6', 'utf8'); } catch {
    if (!rootAvailable) return new Map();
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

/** Ports each task's processes listen on, by session id (the bridge's and AGY's own are left out). */
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
    this.voices = new Map(); // dictations in progress, by the app's id (see voice.mjs)
    this.buf = '';
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 30_000);
    socket.on('data', (c) => this.onData(c));
    socket.on('close', () => {
      clients.delete(this);
      for (const term of terminals.values()) term.clients.delete(this);
      for (const v of this.voices.values()) v.cancel();
      this.voices.clear();
    });
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
        this.send({ ev: 'hello', version: VERSION, host: os.hostname(), platform: process.platform, roots: opts.roots, root: rootAvailable });
        this.send({ ev: 'sessions', sessions: [...sessions.values()].map((s) => s.summary()) });
        if (limits) this.send({ ev: 'limits', limits });
        refreshAgyLimits(false);
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
        const mode = MODES.includes(msg.mode) ? msg.mode : (process.env.CCM_LEGACY_PROTO === '1' ? 'default' : 'bypassPermissions');
        const title = prompt.split('\n')[0].slice(0, 100) || `Attached ${attachments.map((a) => a.name).join(', ')}`.slice(0, 100);
        const session = new Session({ id: randomUUID(), cwd, title, model: msg.model || null, effort: msg.effort, mode, autoContinue: !!msg.autoContinue });
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
      case 'term_open': {
        // Attaches to the running terminal (or the one asked for), or starts one.
        const cols = Number(msg.cols) || 80;
        const rows = Number(msg.rows) || 24;
        const kind = msg.kind === 'login' ? 'login' : 'shell';
        const ofKind = [...terminals.values()].filter((t) => t.kind === kind);
        if (msg.fresh && kind === 'login') ofKind.forEach((t) => t.close());
        const term = terminals.get(String(msg.id ?? '')) ?? (msg.fresh ? null : ofKind.at(-1)) ?? new Terminal(cols, rows, kind);
        term.clients.add(this);
        if (msg.cols && msg.rows) term.resize(cols, rows);
        this.send({ ev: 'term_opened', ref, id: term.id, kind: term.kind, data: term.replay(), links: term.links });
        break;
      }
      case 'term_input': terminalFor(msg.id).write(msg.data); break;
      case 'term_resize': terminalFor(msg.id).resize(Number(msg.cols), Number(msg.rows)); break;
      case 'term_detach': terminals.get(String(msg.id ?? ''))?.clients.delete(this); break;
      case 'term_close': terminalFor(msg.id).close(); break;
      case 'auth': this.send({ ev: 'auth', ref, auth: await authStatus() }); break;
      case 'voice_start': {
        const id = String(msg.id ?? '');
        if (!id || this.voices.has(id)) throw new Error('Bad voice id');
        const keyterms = (Array.isArray(msg.keyterms) ? msg.keyterms : []).slice(0, 50).map(String);
        if (s) keyterms.unshift(path.basename(s.cwd));
        const v = new VoiceStream({
          claudeBin, language: String(msg.language ?? 'en'), keyterms,
          emit: (e) => {
            this.send({ ev: 'voice', id, ...e });
            if (e.type === 'closed') this.voices.delete(id);
          },
        });
        this.voices.set(id, v);
        this.send({ ev: 'voice_started', ref, id });
        break;
      }
      case 'voice_audio': this.voices.get(String(msg.id ?? ''))?.audio(Buffer.from(String(msg.data ?? ''), 'base64')); break;
      case 'voice_stop': this.voices.get(String(msg.id ?? ''))?.stop(); break;
      case 'voice_cancel': {
        const id = String(msg.id ?? '');
        this.voices.get(id)?.cancel();
        this.voices.delete(id);
        break;
      }
      case 'processes': this.send({ ev: 'processes', ref, processes: listProcesses() }); break;
      case 'signal': signalProcess(Number(msg.pid), String(msg.signal)); this.send({ ev: 'processes', ref, processes: listProcesses() }); break;
      case 'restart_process': {
        const started = await restartProcess(Number(msg.pid));
        this.send({ ev: 'processes', ref, processes: listProcesses(), started });
        break;
      }
      case 'usage': {
        await refreshAgyLimits(true);
        this.send({ ev: 'usage', ref, limits, ...usageSummary(msg.days, msg.tzOffsetMin) });
        break;
      }
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
      case 'cwd': await s.moveTo(msg.cwd); this.send({ ev: 'session', ref, session: s.summary() }); break;
      case 'auto_continue': s.setAutoContinue(!!msg.on); break;
      // From the app's alarm at a task's resumeAt, which wakes the phone: check now.
      case 'tick': resumeDue(); this.send({ ev: 'tock', ref }); break;
      case 'permission':
        if (!s.answer(msg.requestId, msg.decision === 'allow' ? 'allow' : 'deny', !!msg.always, msg.message, msg.answers)) {
          this.send({ ev: 'error', ref, message: 'That request was already answered.' });
        }
        broadcast({ ev: 'approval_done', sid: s.id, requestId: msg.requestId });
        break;
      case 'mode':
        if (!MODES.includes(msg.mode)) throw new Error(`Unknown mode: ${msg.mode}`);
        s.setMode(msg.mode);
        break;
      case 'model':
        s.setModel(msg.model ? String(msg.model) : null);
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
setInterval(() => {
  if (clients.size > 0 && [...sessions.values()].some((s) => s.status === 'working')) {
    refreshAgyLimits(false);
  }
}, 15_000).unref();
rootAvailable = await detectRoot();
const server = net.createServer((socket) => new Client(socket));
server.listen(opts.port, opts.host, () => {
  const { address, port } = server.address();
  const loopback = address === '127.0.0.1' || address === '::1';
  console.log(`ccm-bridge listening on ${address}:${port} (${sessions.size} saved sessions${rootAvailable ? ', root available' : ''})`);
  if (!loopback) console.log('Warning: listening beyond this device. Traffic is not encrypted; use a private network such as Tailscale or an SSH tunnel.');
  const pairUrl = `agymobile://pair?host=${encodeURIComponent(loopback ? '127.0.0.1' : address)}&port=${port}&token=${encodeURIComponent(token)}`;
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
  // AGY processes keep running under their keepers; the next bridge reattaches to them.
  for (const s of sessions.values()) if (s.link) { s.link.close(); s.persistMeta(); }
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
