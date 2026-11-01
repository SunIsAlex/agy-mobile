// Voice dictation for the app through Claude's own speech-to-text: the endpoint Claude Code's
// /voice uses (wss://api.anthropic.com/api/ws/speech_to_text/voice_stream), signed in with the
// same claude.ai login as the CLI. The app records 16 kHz mono 16-bit PCM and sends it here;
// transcripts come back as they're recognised.
//
// Protocol (read from Claude Code 2.1.316): query encoding=linear16&sample_rate=16000&channels=1
// &endpointing_ms=300&utterance_end_ms=1000&language=en&use_conversation_engine=true; headers
// Authorization: Bearer <OAuth token>, x-app: cli. Client sends binary audio frames,
// {"type":"KeepAlive"} every 8 s and {"type":"CloseStream"} to finish. Server sends
// TranscriptInterim/TranscriptText {data} (the current utterance so far), TranscriptEndpoint
// (that utterance is final), TranscriptError {description|error_code} and error {message}.
//
// Node 20 (Debian's) has no WebSocket client that can send headers, so this is a small one.

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

// Overridable for tests (ws:// is allowed there).
const BASE = process.env.CCM_VOICE_URL ?? 'wss://api.anthropic.com';
const PATH = '/api/ws/speech_to_text/voice_stream';
const KEEPALIVE_MS = 8000;
// After CloseStream, wait this long for the last transcript before giving up.
const FINISH_TIMEOUT_MS = 5000;

// ---------- login ----------

function credentialsFile() {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), '.credentials.json');
}

function readToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, expiresAt: Infinity };
  try {
    const o = JSON.parse(fs.readFileSync(credentialsFile(), 'utf8')).claudeAiOauth;
    return o?.accessToken ? { token: o.accessToken, expiresAt: Number(o.expiresAt) || Infinity } : null;
  } catch { return null; }
}

function run(bin, args) {
  return new Promise((resolve) => execFile(bin, args, { timeout: 60_000, env: { ...process.env, CLAUDECODE: '' } }, () => resolve()));
}

// The CLI refreshes an expired login whenever it talks to the API, and rotates the refresh
// token when it does, so the bridge never refreshes by itself: it lets claude do it.
let refreshing = null;
export async function voiceToken(claudeBin) {
  const fresh = (t) => t && t.expiresAt > Date.now() + 60_000;
  let t = readToken();
  if (fresh(t)) return t.token;
  if (!t) throw new Error('Claude isn\'t signed in with a claude.ai account here. Voice uses that login (Settings › Log in to Claude).');
  refreshing ??= (async () => {
    await run(claudeBin, ['auth', 'status']);
    if (fresh(readToken())) return;
    // A one-word request makes the CLI refresh the token first.
    await run(claudeBin, ['-p', '--model', 'haiku', '--no-session-persistence', 'Reply with: ok']);
  })().finally(() => { refreshing = null; });
  await refreshing;
  t = readToken();
  if (!fresh(t)) throw new Error('Claude\'s login has expired. Open a task or log in to Claude again.');
  return t.token;
}

// ---------- a minimal WebSocket client ----------

class WsClient {
  constructor(url, headers, { onOpen, onText, onClose, onError }) {
    const u = new URL(url);
    this.closed = false;
    this.handlers = { onOpen, onText, onClose, onError };
    this.buf = Buffer.alloc(0);
    this.open = false;
    this.fragments = [];
    const key = randomBytes(16).toString('base64');
    const secure = u.protocol === 'wss:';
    const connect = secure
      ? (cb) => tls.connect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname, ALPNProtocols: ['http/1.1'] }, cb)
      : (cb) => net.connect({ host: u.hostname, port: Number(u.port) || 80 }, cb);
    this.socket = connect(() => {
      const lines = [
        `GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      this.socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    this.expectAccept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    this.socket.on('data', (d) => this.onData(d));
    this.socket.on('error', (e) => this.fail(e.message));
    this.socket.on('close', () => this.finish(1006, ''));
  }

  fail(message) {
    if (this.closed) return;
    this.handlers.onError(message);
    this.finish(1006, message);
  }

  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.handlers.onClose(code, reason);
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (!this.open) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = this.buf.subarray(0, end).toString('latin1');
      this.buf = this.buf.subarray(end + 4);
      const status = Number(head.split(' ')[1]);
      const accept = /\r\nsec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      if (status !== 101 || accept !== this.expectAccept) {
        this.fail(status === 401 || status === 403
          ? `Claude's speech service refused the login (HTTP ${status}). Log in to Claude again.`
          : `Claude's speech service refused the connection (HTTP ${status || '?'}).`);
        return;
      }
      this.open = true;
      this.handlers.onOpen();
    }
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const masked = b1 & 0x80;
      const maskOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (masked) { const m = this.buf.subarray(maskOff, maskOff + 4); payload = Buffer.from(payload.map((x, i) => x ^ m[i % 4])); }
      this.buf = this.buf.subarray(off + len);
      const opcode = b0 & 0x0f;
      const fin = b0 & 0x80;
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.subarray(2).toString('utf8');
        this.sendFrame(0x8, payload.subarray(0, 2));
        this.finish(code, reason);
        return;
      }
      if (opcode === 0x9) { this.sendFrame(0xa, payload); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        this.fragments.push(payload);
        if (!fin) continue;
        const whole = Buffer.concat(this.fragments);
        this.fragments = [];
        this.handlers.onText(whole.toString('utf8'));
      }
    }
  }

  sendFrame(opcode, payload) {
    if (this.closed || !this.open) return;
    const len = payload.length;
    const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    if (len < 126) head[1] = 0x80 | len;
    else if (len < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    const mask = randomBytes(4);
    const body = Buffer.alloc(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([head, mask, body]));
  }

  text(s) { this.sendFrame(0x1, Buffer.from(s, 'utf8')); }
  binary(b) { this.sendFrame(0x2, b); }
  close() {
    if (this.closed) return;
    if (this.open) this.sendFrame(0x8, Buffer.from([0x03, 0xe8]));
    setTimeout(() => this.finish(1000, ''), 1000).unref();
  }
}

// ---------- a dictation stream ----------

// Audio kept for a retry in English, until the first words come back (30 s at 32 kB/s).
const MAX_REPLAY_BYTES = 30 * 32_000;

// One recording. emit(obj) gets {type:'ready'|'transcript'|'error'|'closed', ...}.
// Transcripts carry the whole text so far (finished utterances plus the one in progress), so the
// app just shows the latest; final:true marks a finished utterance.
export class VoiceStream {
  constructor({ claudeBin, language = 'en', keyterms = [], emit }) {
    this.emit = emit;
    this.claudeBin = claudeBin;
    this.keyterms = keyterms;
    this.done = [];
    this.current = '';
    this.queue = [];
    this.sent = [];
    this.sentBytes = 0;
    this.heard = false;
    this.stopping = false;
    this.ended = false;
    this.connect(/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/.test(language) ? language : 'en');
  }

  connect(language) {
    this.language = language;
    this.open(language).catch((e) => this.end(String(e?.message ?? e)));
  }

  async open(language) {
    const token = await voiceToken(this.claudeBin);
    if (this.ended) return;
    const q = new URLSearchParams({
      encoding: 'linear16', sample_rate: '16000', channels: '1', endpointing_ms: '300', utterance_end_ms: '1000',
      language, use_conversation_engine: 'true',
    });
    const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'ccm-bridge', 'x-app': 'cli', 'anthropic-client-platform': 'cli' };
    // Words to listen for (project names and so on), as Claude Code sends them.
    const terms = [...new Set(this.keyterms.map((k) => String(k).replace(/,/g, ' ').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
    let list = '';
    for (const k of terms) { if (list.length + k.length + 1 > 1024) break; list += (list ? ',' : '') + k; }
    if (list) headers['x-config-keyterms'] = list;
    const ws = new WsClient(`${BASE}${PATH}?${q}`, headers, {
      onOpen: () => {
        ws.text('{"type":"KeepAlive"}');
        this.keepAlive = setInterval(() => ws.text('{"type":"KeepAlive"}'), KEEPALIVE_MS);
        if (!this.readySent) { this.readySent = true; this.emit({ type: 'ready' }); }
        for (const b of this.queue) ws.binary(b);
        this.queue = [];
        if (this.stopping) ws.text('{"type":"CloseStream"}');
      },
      onText: (s) => this.onMessage(s),
      onError: (m) => this.end(m),
      onClose: (code, reason) => {
        // 1003: the speech service doesn't take this language. English also understands
        // several others (Chinese, for one), so try again in English with what was recorded.
        if (code === 1003 && language !== 'en' && !this.heard && !this.ended) {
          clearInterval(this.keepAlive);
          this.queue = [...this.sent];
          this.connect('en');
          return;
        }
        this.end(code === 1000 || code === 1005 || this.stopping ? null : `Connection closed (${code}${reason ? `: ${reason}` : ''})`);
      },
    });
    this.ws = ws;
  }

  text() { return [...this.done, this.current].filter(Boolean).join(' '); }

  onMessage(s) {
    let m;
    try { m = JSON.parse(s); } catch { return; }
    if (m.type === 'TranscriptInterim' || m.type === 'TranscriptText') {
      if (!m.data) return;
      this.heard = true;
      this.sent = [];
      this.current = m.data;
      this.emit({ type: 'transcript', text: this.text(), final: false });
    } else if (m.type === 'TranscriptEndpoint') {
      if (this.current) { this.done.push(this.current); this.current = ''; }
      this.emit({ type: 'transcript', text: this.text(), final: true });
      if (this.stopping) this.end(null);
    } else if (m.type === 'TranscriptError') {
      this.end(m.description ?? m.error_code ?? 'Transcription failed');
    } else if (m.type === 'error') {
      this.end(m.message ?? 'Transcription failed');
    }
  }

  audio(buf) {
    if (this.ended || this.stopping || !buf.length) return;
    if (!this.heard && this.sentBytes < MAX_REPLAY_BYTES) { this.sent.push(buf); this.sentBytes += buf.length; }
    if (this.ws?.open && !this.ws.closed) this.ws.binary(buf);
    else this.queue.push(buf);
  }

  // Finish: whatever was said last is still sent back as final before 'closed'.
  stop() {
    if (this.ended || this.stopping) return;
    this.stopping = true;
    if (this.ws?.open && !this.ws.closed) this.ws.text('{"type":"CloseStream"}');
    this.finishTimer = setTimeout(() => this.end(null), FINISH_TIMEOUT_MS);
  }

  cancel() { if (!this.ended) this.end(null, true); }

  end(error, silent = false) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.keepAlive);
    clearTimeout(this.finishTimer);
    this.ws?.close();
    if (silent) return;
    if (this.current) { this.done.push(this.current); this.current = ''; this.emit({ type: 'transcript', text: this.text(), final: true }); }
    if (error) this.emit({ type: 'error', message: error });
    this.emit({ type: 'closed', text: this.text() });
  }
}
