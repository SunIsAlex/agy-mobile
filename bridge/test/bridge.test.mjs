// End-to-end test of ccm-bridge against fake-claude. Run: node --test bridge/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(here, '..', 'ccm-bridge.mjs');
const fakeClaude = path.join(here, 'fake-claude.mjs');

// Isolate test processes from ambient agent environment if tests are run from inside an active AGY session.
delete process.env.AGY_SESSION_ID;
delete process.env.ANTIGRAVITY_CONVERSATION_ID;
delete process.env.ANTIGRAVITY_SOURCE_METADATA;
delete process.env.GEMINI_API_KEY;
delete process.env.AGY_ADC_AUTH;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const emptyGcloudDir = path.join(os.tmpdir(), 'ccm-empty-gcloud');
fs.mkdirSync(emptyGcloudDir, { recursive: true });
process.env.CLOUDSDK_CONFIG = emptyGcloudDir;

// A wrapper script, because shebangs like /usr/bin/env don't exist everywhere (e.g. Termux).
function fakeClaudeWrapper(dir) {
  const sh = ['/bin/sh', '/system/bin/sh'].find((p) => fs.existsSync(p));
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!${sh}\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`, { mode: 0o755 });
  return file;
}

function startBridge(stateDir, repoRoot, port, env = {}) {
  const proc = spawn(process.execPath, [bridgePath, '--port', String(port), '--roots', repoRoot, '--state-dir', stateDir], {
    env: {
      ...process.env,
      CCM_ROOT: '0',
      CCM_LEGACY_PROTO: '1',
      CCM_AGY_DIR: path.join(path.dirname(stateDir), 'agy-data'),
      ...env,
      CCM_CLAUDE_BIN: fakeClaudeWrapper(path.dirname(stateDir)),
      CLAUDE_CONFIG_DIR: path.join(path.dirname(stateDir), 'claude-config'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve) => proc.stdout.once('data', () => resolve(proc)));
}

// Stops the bridge and the keepers it started, which would otherwise keep fake-claude running.
async function stopAll(bridge, stateDir) {
  bridge.kill('SIGTERM');
  if (bridge.exitCode === null && bridge.signalCode === null) await new Promise((r) => bridge.once('exit', r));
  const dir = path.join(stateDir, 'keepers');
  let ids = [];
  try { ids = fs.readdirSync(dir); } catch {}
  for (const id of ids) {
    try { process.kill(JSON.parse(fs.readFileSync(path.join(dir, id, 'keeper.json'), 'utf8')).pid, 'SIGTERM'); } catch {}
  }
  await new Promise((r) => setTimeout(r, 300));
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function connect(port) {
  const socket = net.connect(port, '127.0.0.1');
  socket.setEncoding('utf8');
  const queue = [];
  const waiters = [];
  let buf = '';
  socket.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else queue.push(msg);
    }
  });
  return {
    send: (o) => socket.write(JSON.stringify(o) + '\n'),
    next: (pred, ms = 5000, where = new Error().stack.split("\n")[2]) => {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          // A timed-out waiter must not swallow a later message.
          const j = waiters.indexOf(w);
          if (j >= 0) waiters.splice(j, 1);
          reject(new Error("timed out at " + where));
        }, ms).unref();
      });
    },
    closed: new Promise((r) => socket.on('close', r)),
    end: () => socket.end(),
  };
}

test('bridge runs a session through a permission round-trip', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'new.txt'), 'hello\n');
  const port = 20000 + Math.floor(Math.random() * 20000);
  let bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();

  try {
    const bad = connect(port);
    bad.send({ op: 'hello', token: 'wrong' });
    assert.equal((await bad.next((m) => m.ev === 'error')).message, 'Unauthorized');
    await bad.closed;

    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');

    c.send({ op: 'repos', ref: 1 });
    const repos = await c.next((m) => m.ev === 'repos');
    assert.deepEqual(repos.repos.map((r) => [r.name, r.branch]), [['demo', 'main']]);

    c.send({ op: 'mkdir', ref: 10, name: 'work/fresh' });
    const made = await c.next((m) => m.ev === 'repos' && m.ref === 10);
    assert.equal(made.created, path.join(tmp, 'repos', 'work', 'fresh'));
    assert.ok(fs.existsSync(path.join(made.created, '.git')));
    assert.deepEqual(made.repos.map((r) => r.name), ['demo', 'fresh']);
    for (const [name, root] of [['../escape', undefined], ['a/b/c', undefined], ['.hidden', undefined], ['demo', undefined], ['x', tmp]]) {
      c.send({ op: 'mkdir', ref: 11, name, root });
      assert.equal((await c.next((m) => m.ev === 'error' && m.ref === 11)).ref, 11);
    }
    assert.ok(!fs.existsSync(path.join(tmp, 'escape')) && !fs.existsSync(path.join(tmp, 'x')));
    fs.rmSync(path.join(tmp, 'repos', 'work'), { recursive: true });

    c.send({ op: 'start', ref: 2, cwd: repo, prompt: 'fix the bug', mode: 'default' });
    const { session } = await c.next((m) => m.ev === 'started');
    assert.equal(session.title, 'fix the bug');

    const approval = await c.next((m) => m.ev === 'approval');
    assert.equal(approval.request.request.input.command, 'touch x');
    assert.equal((await c.next((m) => m.ev === 'session' && m.session.status === 'needs_approval')).session.pending, 1);

    c.send({ op: 'permission', sid: session.id, requestId: approval.request.request_id, decision: 'allow', always: true });
    const toolResult = await c.next((m) => m.ev === 'cli' && m.msg.type === 'user' && Array.isArray(m.msg.message.content));
    assert.equal(toolResult.msg.message.content[0].content, 'allow always');
    await c.next((m) => m.ev === 'session' && m.session.status === 'idle');

    c.send({ op: 'diff', ref: 3, sid: session.id });
    const diff = await c.next((m) => m.ev === 'diff');
    assert.match(diff.diff, /\+\+\+ b\/new\.txt/);

    // A second client subscribing later gets the stored transcript, without stream deltas.
    const c2 = connect(port);
    c2.send({ op: 'hello', token });
    c2.send({ op: 'subscribe', sid: session.id });
    const history = await c2.next((m) => m.ev === 'history');
    assert.ok(history.events.some((e) => e.type === 'result'));
    assert.ok(!history.events.some((e) => e.type === 'stream_event'));
    assert.ok(!history.events.some((e) => e.type === 'control_response'));
    c2.end();
    c.end();

    // Sessions and transcripts survive a bridge restart, and resume uses --resume.
    bridge.kill('SIGTERM');
    await new Promise((r) => bridge.once('exit', r));
    bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
    const c3 = connect(port);
    c3.send({ op: 'hello', token });
    const list = await c3.next((m) => m.ev === 'sessions');
    assert.equal(list.sessions[0].id, session.id);
    c3.send({ op: 'subscribe', sid: session.id });
    assert.ok((await c3.next((m) => m.ev === 'history')).events.length > 3);
    c3.send({ op: 'send', sid: session.id, text: 'again' });
    const again = await c3.next((m) => m.ev === 'approval');
    c3.send({ op: 'permission', sid: session.id, requestId: again.request.request_id, decision: 'deny' });
    const denied = await c3.next((m) => m.ev === 'cli' && m.msg.type === 'user' && Array.isArray(m.msg.message.content));
    assert.equal(denied.msg.message.content[0].content, 'deny');

    c3.send({ op: 'archive', sid: session.id });
    await c3.next((m) => m.ev === 'removed');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(fs.readdirSync(path.join(stateDir, 'sessions')), []);
    c3.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('bridge resumes a Claude Code session started in a terminal', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const id = '11111111-2222-4333-8444-555555555555';
  const projectDir = path.join(tmp, 'claude-config', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${id}.jsonl`);
  const rec = (o) => JSON.stringify({ sessionId: id, cwd: repo, timestamp: '2026-09-29T10:00:00.000Z', isSidechain: false, ...o }) + '\n';
  fs.writeFileSync(file, [
    rec({ type: 'permission-mode', permissionMode: 'acceptEdits' }),
    rec({ type: 'user', isMeta: true, uuid: 'm0', message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' } }),
    rec({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'add a README' } }),
    rec({ type: 'attachment', uuid: 'a0', attachment: { type: 'environment' } }),
    rec({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'README.md', content: 'x' } }] } }),
    rec({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    rec({ type: 'assistant', uuid: 's1', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub-agent chatter' }] } }),
    rec({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Added it.' }] } }),
    rec({ type: 'ai-title', aiTitle: 'Add README' }),
    rec({ type: 'user', uuid: 'u3', message: { role: 'user', content: '<command-name>/model</command-name>\n<command-args>haiku</command-args>' } }),
    rec({ type: 'user', uuid: 'u4', message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' } }),
  ].join(''));
  // Only a title, never a prompt: not listed.
  fs.writeFileSync(path.join(projectDir, 'empty.jsonl'), rec({ type: 'ai-title', aiTitle: 'nothing' }));

  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');

    c.send({ op: 'claude_sessions', ref: 1 });
    const list = (await c.next((m) => m.ev === 'claude_sessions')).sessions;
    assert.equal(list.length, 1);
    assert.deepEqual({ ...list[0], createdAt: 0, updatedAt: 0 }, {
      id, cwd: repo, title: 'Add README', lastPrompt: 'add a README', model: 'claude-sonnet-5', mode: 'acceptEdits', createdAt: 0, updatedAt: 0,
    });

    c.send({ op: 'resume', ref: 2, id });
    const { session } = await c.next((m) => m.ev === 'started');
    assert.equal(session.id, id);
    assert.equal(session.title, 'Add README');
    c.send({ op: 'subscribe', sid: id });
    const history = await c.next((m) => m.ev === 'history');
    assert.deepEqual(history.events.map((e) => e.uuid ?? e.subtype), ['u1', 'a1', 'u2', 'a2', 'u3', 'note']);
    assert.equal(history.events[4].message.content, '/model haiku');

    // Once imported it drops out of the resume list.
    c.send({ op: 'claude_sessions', ref: 3 });
    assert.equal((await c.next((m) => m.ev === 'claude_sessions')).sessions.length, 0);

    // Turns taken in the terminal afterwards show up the next time the app opens it.
    fs.appendFileSync(file, rec({ type: 'user', uuid: 'u5', message: { role: 'user', content: 'and a licence' } })
      + rec({ type: 'assistant', uuid: 'a5', message: { role: 'assistant', content: [{ type: 'text', text: 'MIT it is.' }] } }));
    c.send({ op: 'subscribe', sid: id });
    const synced = await c.next((m) => m.ev === 'history');
    assert.deepEqual(synced.events.slice(-3).map((e) => e.uuid ?? e.subtype), ['note', 'u5', 'a5']);

    // Sending continues the same CLI session with --conversation.
    c.send({ op: 'send', sid: id, text: 'thanks' });
    const init = await c.next((m) => m.ev === 'cli' && m.msg.type === 'system' && m.msg.subtype === 'init');
    assert.equal(init.msg.session_id, id);
    await c.next((m) => m.ev === 'approval');

    c.send({ op: 'resume', ref: 4, id: 'no-such-session' });
    assert.match((await c.next((m) => m.ev === 'error' && m.ref === 4)).message, /No AGY CLI session/);
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('YOLO mode runs tools without asking, and can be switched on mid-session', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  const ranUnasked = (m) => m.ev === 'cli' && m.msg.type === 'user' && Array.isArray(m.msg.message.content) && m.msg.message.content[0].content === 'ran without asking';
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');

    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'go wild', mode: 'bypassPermissions' });
    const { session } = await c.next((m) => m.ev === 'started');
    assert.equal(session.mode, 'bypassPermissions');
    await c.next(ranUnasked);
    await c.next((m) => m.ev === 'session' && m.session.status === 'idle');

    // A normal session asks, then stops asking once YOLO is switched on while it runs.
    c.send({ op: 'start', ref: 2, cwd: repo, prompt: 'careful', mode: 'default' });
    const second = (await c.next((m) => m.ev === 'started' && m.ref === 2)).session;
    const approval = await c.next((m) => m.ev === 'approval' && m.sid === second.id);
    c.send({ op: 'permission', sid: second.id, requestId: approval.request.request_id, decision: 'allow' });
    await c.next((m) => m.ev === 'session' && m.session.id === second.id && m.session.status === 'idle');
    c.send({ op: 'mode', sid: second.id, mode: 'bypassPermissions' });
    await c.next((m) => m.ev === 'session' && m.session.id === second.id && m.session.mode === 'bypassPermissions');
    c.send({ op: 'send', sid: second.id, text: 'now go' });
    await c.next(ranUnasked);

    c.send({ op: 'mode', ref: 3, sid: second.id, mode: 'sudo' });
    assert.match((await c.next((m) => m.ev === 'error' && m.ref === 3)).message, /Unknown mode/);
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('attachments are saved for Claude, images also sent inline', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, { CCM_ROOT: '1' });
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  const b64 = (s) => Buffer.from(s).toString('base64');
  const said = (sid) => (m) => m.ev === 'cli' && m.sid === sid && m.msg.type === 'assistant' && m.msg.message.content[0].type === 'text';
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    assert.equal((await c.next((m) => m.ev === 'hello')).root, true);

    c.send({
      op: 'start', ref: 1, cwd: repo, prompt: 'what is this?',
      attachments: [{ name: 'shot.png', mime: 'image/png', data: b64('png-bytes') }, { name: '../notes.txt', mime: 'text/plain', data: b64('hi') }],
    });
    const { session } = await c.next((m) => m.ev === 'started');
    const dir = path.join(stateDir, 'attachments', session.id);
    assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'hi');
    const echo = await c.next((m) => m.ev === 'cli' && m.msg.type === 'user' && m.msg.local);
    assert.equal(echo.msg.message.content, 'what is this?');
    assert.deepEqual(echo.msg.attachments.map((a) => a.name), ['shot.png', 'notes.txt']);
    const reply = (await c.next(said(session.id))).msg.message.content[0].text;
    assert.match(reply, /^Looking at: what is this\?\n\nAttached files.*\n- .*shot\.png \(image\/png, 9 B\)\n- .*notes\.txt.* \[image image\/png\]$/s);
    assert.doesNotMatch(reply, /\[mcp/);

    // Same name again gets a new file; a bad attachment is refused without starting anything.
    c.send({ op: 'send', sid: session.id, text: '', attachments: [{ name: 'notes.txt', mime: 'text/plain', data: b64('again') }] });
    assert.deepEqual((await c.next((m) => m.ev === 'cli' && m.msg.local && m.msg.attachments?.[0].name === 'notes-2.txt')).msg.attachments.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'notes-2.txt'), 'utf8'), 'again');
    c.send({ op: 'start', ref: 2, cwd: repo, prompt: 'x', attachments: [{ name: 'empty', data: '' }] });
    assert.match((await c.next((m) => m.ev === 'error' && m.ref === 2)).message, /empty/);

    c.send({ op: 'archive', sid: session.id });
    await c.next((m) => m.ev === 'removed');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!fs.existsSync(dir));
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('usage: plan limits from rate_limit_event, token totals from Claude Code transcripts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  // Two transcripts. A message split into blocks repeats its usage; a forked session copies it.
  const projects = path.join(tmp, 'claude-config', 'projects', '-demo');
  fs.mkdirSync(projects, { recursive: true });
  const now = Date.now();
  const rec = (id, t, model, output, cwd = repo) => JSON.stringify({
    type: 'assistant', timestamp: new Date(t).toISOString(), cwd,
    message: { id, model, usage: { input_tokens: 1, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } },
  });
  fs.writeFileSync(path.join(projects, 'a.jsonl'), [
    rec('m1', now - 60_000, 'claude-opus-5-5', 50), rec('m1', now - 60_000, 'claude-opus-5-5', 50),
    rec('m2', now - 60_000, 'claude-haiku-4-5', 5, '/elsewhere'),
    rec('old', now - 40 * 86_400_000, 'claude-opus-5-5', 999),
    JSON.stringify({ type: 'user', message: { content: 'hi "usage"' } }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(projects, 'b.jsonl'), rec('m1', now - 60_000, 'claude-opus-5-5', 50) + '\n');

  const port = 20000 + Math.floor(Math.random() * 20000);
  let bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    let c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');

    c.send({ op: 'usage', ref: 1, days: 7 });
    const u = await c.next((m) => m.ev === 'usage');
    assert.equal(u.limits, null);
    assert.equal(u.days.length, 7);
    const today = u.days.at(-1);
    assert.deepEqual([today.output, today.requests, today.cacheRead], [55, 2, 200]);
    assert.deepEqual(u.models.map((m) => [m.key, m.output]), [['claude-opus-5-5', 50], ['claude-haiku-4-5', 5]]);
    assert.deepEqual(u.projects.map((p) => p.key), [repo, '/elsewhere']);
    assert.equal(u.sessions, 1);

    c.send({ op: 'start', ref: 2, cwd: repo, prompt: 'go', mode: 'bypassPermissions' });
    const limits = (await c.next((m) => m.ev === 'limits')).limits;
    assert.deepEqual(limits.windows, [
      { id: 'five_hour', utilization: 0.07, resetsAt: 2000000000000 },
      { id: 'seven_day', utilization: 0.85, resetsAt: 2000500000000 },
    ]);
    c.end();

    // Limits survive a restart and are sent on connect.
    bridge.kill('SIGTERM');
    await new Promise((r) => bridge.once('exit', r));
    bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
    c = connect(port);
    c.send({ op: 'hello', token });
    assert.equal((await c.next((m) => m.ev === 'limits')).limits.windows[1].utilization, 0.85);
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reasoning effort is set at launch and changed on a running session', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  const said = (re) => (m) => m.ev === 'cli' && m.msg.type === 'assistant' && re.test(m.msg.message.content[0].text ?? '');
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');

    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'think', mode: 'bypassPermissions', effort: 'low' });
    const { session } = await c.next((m) => m.ev === 'started');
    assert.equal(session.effort, 'low');
    await c.next(said(/\[effort: low\]/));
    await c.next((m) => m.ev === 'session' && m.session.status === 'idle');

    c.send({ op: 'effort', sid: session.id, effort: 'max' });
    assert.equal((await c.next((m) => m.ev === 'session' && m.session.effort === 'max')).session.id, session.id);
    c.send({ op: 'send', sid: session.id, text: 'harder' });
    await c.next(said(/harder \[effort: max\]/));

    // No effort means the model's default.
    c.send({ op: 'effort', sid: session.id });
    await c.next((m) => m.ev === 'session' && m.session.id === session.id && m.session.effort === null);
    c.send({ op: 'send', sid: session.id, text: 'plain' });
    await c.next(said(/plain$/));

    // Three turns at a running total of 0.01, 0.02, 0.03: the task cost is the last, not the sum.
    const idle = await c.next((m) => m.ev === 'session' && m.session.id === session.id && m.session.costUsd >= 0.025);
    assert.equal(Math.round(idle.session.costUsd * 100), 3);

    c.send({ op: 'effort', ref: 2, sid: session.id, effort: 'huge' });
    assert.match((await c.next((m) => m.ev === 'error' && m.ref === 2)).message, /Unknown effort/);
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('images Claude looked at are kept on the bridge and sent on request, not inline', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  const isImageResult = (m) => m.type === 'user' && m.message.content[0]?.content?.[0]?.type === 'image';
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'take a screenshot', mode: 'bypassPermissions' });
    const { session } = await c.next((m) => m.ev === 'started');
    const live = (await c.next((m) => m.ev === 'cli' && isImageResult(m.msg))).msg;
    const placeholder = live.message.content[0].content[0];
    assert.match(placeholder.ref, /^[0-9a-f]{32}\.png$/);
    assert.deepEqual({ ...placeholder, ref: undefined }, { type: 'image', source: { type: 'base64', media_type: 'image/png' }, omittedBytes: 300_000, ref: undefined });
    assert.equal(live.tool_use_result, undefined);
    c.send({ op: 'image', ref: 5, sid: session.id, image: placeholder.ref });
    const fetched = await c.next((m) => m.ev === 'image' && m.ref === 5);
    assert.equal(fetched.mime, 'image/png');
    assert.deepEqual(Buffer.from(fetched.data, 'base64'), Buffer.alloc(300_000, 7));
    for (const image of ['../token', 'nope.png']) {
      c.send({ op: 'image', ref: 6, sid: session.id, image });
      assert.equal((await c.next((m) => m.ev === 'error' && m.ref === 6)).ref, 6);
    }
    await c.next((m) => m.ev === 'session' && m.session.status === 'idle');

    c.send({ op: 'subscribe', sid: session.id });
    const history = await c.next((m) => m.ev === 'history');
    assert.equal(history.events.find(isImageResult).message.content[0].content[0].omittedBytes, 300_000);
    assert.ok(fs.statSync(path.join(stateDir, 'sessions', session.id + '.jsonl')).size < 20_000);
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a task stopped by a usage limit waits, and continues by itself after the reset when asked to', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { CCM_LIMIT_GRACE_MS: '0', CCM_RESUME_CHECK_MS: '200' };
  let bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, env);
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  const continued = (m) => m.ev === 'cli' && m.msg.type === 'assistant' && /Looking at: Your usage limit has reset/.test(m.msg.message.content[0].text ?? '');
  try {
    let c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');

    // Off by default: the task waits for the user even after the reset.
    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'hit the limit', mode: 'bypassPermissions' });
    const { session } = await c.next((m) => m.ev === 'started');
    const limited = (await c.next((m) => m.ev === 'session' && m.session.status === 'limited')).session;
    assert.equal(limited.lastActivity, 'Usage limit reached');
    assert.ok(limited.resumeAt > Date.now() && limited.resumeAt < Date.now() + 4000);
    assert.equal(limited.autoContinue, false);
    await assert.rejects(c.next(continued, 3000), /timed out/);
    // Turning it on after the reset continues straight away.
    c.send({ op: 'auto_continue', sid: session.id, on: true });
    await c.next(continued, 5000);
    await c.next((m) => m.ev === 'session' && m.session.id === session.id && m.session.status === 'idle' && m.session.resumeAt === null);

    // On from the start, and the wait survives a bridge restart.
    c.send({ op: 'start', ref: 2, cwd: repo, prompt: 'hit the limit again', mode: 'bypassPermissions', autoContinue: true });
    const second = (await c.next((m) => m.ev === 'started' && m.ref === 2)).session;
    await c.next((m) => m.ev === 'session' && m.session.id === second.id && m.session.status === 'limited');
    c.end();
    bridge.kill('SIGTERM');
    await new Promise((r) => bridge.once('exit', r));
    bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, env);
    c = connect(port);
    c.send({ op: 'hello', token });
    const restored = (await c.next((m) => m.ev === 'sessions')).sessions.find((s) => s.id === second.id);
    assert.equal(restored.status, 'limited');
    c.send({ op: 'subscribe', sid: second.id });
    await c.next(continued, 6000);
    await c.next((m) => m.ev === 'session' && m.session.id === second.id && m.session.status === 'idle');

    // Sending a message yourself cancels the wait.
    c.send({ op: 'send', sid: second.id, text: 'hit the limit once more' });
    await c.next((m) => m.ev === 'session' && m.session.id === second.id && m.session.status === 'limited');
    c.send({ op: 'send', sid: second.id, text: 'never mind' });
    await c.next((m) => m.ev === 'session' && m.session.id === second.id && m.session.resumeAt === null);
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    await new Promise((r) => (bridge.exitCode !== null || bridge.signalCode !== null ? r() : bridge.once('exit', r)));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('images left out of older logs are recovered from Claude Code transcripts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const id = '11111111-2222-3333-4444-555555555555';
  const data = Buffer.from('frame-bytes').toString('base64');
  const block = (extra) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', ...extra } });
  const result = (images) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: images }] } });
  // The bridge's log, slimmed before images were kept: a placeholder without a ref.
  fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'sessions', id + '.json'), JSON.stringify({ id, cwd: repo, title: 'Old', started: true }));
  fs.writeFileSync(path.join(stateDir, 'sessions', id + '.jsonl'), JSON.stringify(result([{ ...block(), omittedBytes: 11 }])) + '\n');
  // Claude Code's transcript still has the data.
  const projects = path.join(tmp, 'claude-config', 'projects', '-demo');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, id + '.jsonl'), JSON.stringify({ ...result([block({ data })]), uuid: 'u1', cwd: repo }) + '\n');

  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    c.send({ op: 'subscribe', sid: id });
    const history = await c.next((m) => m.ev === 'history');
    const image = history.events[0].message.content[0].content[0].ref;
    assert.match(image, /^[0-9a-f]{32}\.jpg$/);
    c.send({ op: 'image', ref: 1, sid: id, image });
    assert.equal((await c.next((m) => m.ev === 'image')).data, data);
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('background work is tracked until Claude wakes up for it, and reported if it is cut off', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  const meta = (id) => JSON.parse(fs.readFileSync(path.join(stateDir, 'sessions', id + '.json'), 'utf8'));
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'encode in the background', mode: 'bypassPermissions' });
    const { session } = await c.next((m) => m.ev === 'started');
    const waiting = (await c.next((m) => m.ev === 'session' && m.session.status === 'idle' && m.session.background.length)).session;
    assert.deepEqual(waiting.background, ['Encode the film']);
    assert.equal(waiting.lastActivity, 'In the background: Encode the film');
    assert.deepEqual(meta(session.id).background, ['Encode the film']); // what restart-when-idle reads
    // Claude wakes up by itself when the job is done.
    await c.next((m) => m.ev === 'cli' && m.msg.type === 'assistant' && m.msg.message.content[0].text === 'The encode finished.');
    const done = (await c.next((m) => m.ev === 'session' && m.session.status === 'idle' && m.session.lastActivity === 'Waiting for you')).session;
    assert.deepEqual(done.background, []);

    // Stopping Claude's process mid-job says so.
    const sentAt = Date.now();
    c.send({ op: 'send', sid: session.id, text: 'again in the background for 60000 ms' });
    await c.next((m) => m.ev === 'session' && m.session.background.length && m.session.updatedAt >= sentAt);
    c.send({ op: 'stop', sid: session.id });
    const note = await c.next((m) => m.ev === 'cli' && m.msg.type === 'bridge' && m.msg.subtype === 'error');
    assert.match(note.msg.message, /Background work stopped with agy's process: Encode the film/);
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('tasks survive the bridge restarting: Claude keeps running, and nothing it said is lost', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  let bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  const keeperPid = (id) => JSON.parse(fs.readFileSync(path.join(stateDir, 'keepers', id, 'keeper.json'), 'utf8')).pid;
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const restart = async (signal) => {
    bridge.kill(signal);
    if (bridge.exitCode === null && bridge.signalCode === null) await new Promise((r) => bridge.once('exit', r));
    bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    return c;
  };
  const said = (text) => (m) => m.ev === 'cli' && m.msg.type === 'assistant' && m.msg.message.content[0].text === text;
  try {
    let c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'encode in the background for 1500 ms', mode: 'bypassPermissions' });
    const { session } = await c.next((m) => m.ev === 'started');
    await c.next((m) => m.ev === 'session' && m.session.background.length);
    const pid = keeperPid(session.id);
    c.end();

    // The bridge dies without warning; the job finishes and Claude replies while it's down.
    bridge.kill('SIGKILL');
    await new Promise((r) => bridge.once('exit', r));
    assert.ok(isAlive(pid));
    await new Promise((r) => setTimeout(r, 2500));
    c = await restart('SIGTERM');
    c.send({ op: 'subscribe', sid: session.id });
    const history = await c.next((m) => m.ev === 'history');
    const texts = history.events.filter((e) => e.type === 'assistant').map((e) => e.message.content[0].text);
    assert.equal(texts.filter((x) => x === 'The encode finished.').length, 1);
    assert.equal(history.session.status, 'idle');
    assert.deepEqual(history.session.background, []);
    assert.equal(history.session.running, true);

    // The same Claude process carries on.
    c.send({ op: 'send', sid: session.id, text: 'still there?' });
    await c.next((m) => m.ev === 'cli' && m.msg.type === 'assistant' && /Looking at: still there\?/.test(m.msg.message.content[0].text ?? ''));
    assert.equal(keeperPid(session.id), pid);

    // A permission prompt pending across a restart can still be answered.
    c.send({ op: 'start', ref: 2, cwd: repo, prompt: 'careful', mode: 'default' });
    const second = (await c.next((m) => m.ev === 'started' && m.ref === 2)).session;
    const asked = await c.next((m) => m.ev === 'approval' && m.sid === second.id);
    c.end();
    c = await restart('SIGTERM');
    const again = await c.next((m) => m.ev === 'approval' && m.sid === second.id);
    assert.equal(again.request.request_id, asked.request.request_id);
    c.send({ op: 'subscribe', sid: second.id });
    c.send({ op: 'permission', sid: second.id, requestId: again.request.request_id, decision: 'allow' });
    await c.next((m) => m.ev === 'session' && m.session.id === second.id && m.session.status === 'idle');

    // Stopping a task still ends its Claude process.
    c.send({ op: 'stop', sid: session.id });
    await c.next((m) => m.ev === 'session' && m.session.id === session.id && m.session.status === 'stopped' && !m.session.running);
    // The keeper writes exit.json just before exiting; it must not linger.
    for (let i = 0; i < 30 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(!isAlive(pid));
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a tick from the app continues a task whose reset has passed, without waiting for the next check', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  // As if the phone slept: the bridge's own check doesn't come round in time.
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, { CCM_LIMIT_GRACE_MS: '0', CCM_RESUME_CHECK_MS: '3600000' });
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'hit the limit', mode: 'bypassPermissions', autoContinue: true });
    const { session } = await c.next((m) => m.ev === 'started');
    const limited = (await c.next((m) => m.ev === 'session' && m.session.status === 'limited')).session;
    await new Promise((r) => setTimeout(r, limited.resumeAt - Date.now() + 300));
    await assert.rejects(c.next((m) => m.ev === 'session' && m.session.status === 'working' && m.session.updatedAt > limited.updatedAt, 500), /timed out/);
    c.send({ op: 'tick', ref: 2 });
    await c.next((m) => m.ev === 'tock' && m.ref === 2);
    await c.next((m) => m.ev === 'cli' && m.msg.type === 'assistant' && /Looking at: Your usage limit has reset/.test(m.msg.message.content[0].text ?? ''));
    assert.equal(session.id, limited.id);
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('one bridge per state folder, and a task whose keeper vanished recovers on the next message', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    // A second bridge on the same folder refuses to start.
    const second = spawn(process.execPath, [bridgePath, '--port', String(port + 1), '--state-dir', stateDir], { env: { ...process.env, CCM_ROOT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    second.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise((r) => second.once('exit', r));
    assert.equal(code, 1);
    assert.match(stderr, /Another ccm-bridge \(pid \d+\) is already using/);

    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'first', mode: 'bypassPermissions' });
    const { session } = await c.next((m) => m.ev === 'started');
    await c.next((m) => m.ev === 'session' && m.session.status === 'idle');

    // Its keeper and folder disappear behind the bridge's back.
    const dir = path.join(stateDir, 'keepers', session.id);
    process.kill(JSON.parse(fs.readFileSync(path.join(dir, 'keeper.json'), 'utf8')).pid, 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
    await c.next((m) => m.ev === 'session' && m.session.id === session.id && !m.session.running, 5000);

    // The next message starts a fresh Claude instead of waiting on a pipe nobody reads.
    c.send({ op: 'send', sid: session.id, text: 'go on' });
    await c.next((m) => m.ev === 'cli' && m.msg.type === 'assistant' && /Looking at: go on/.test(m.msg.message.content[0].text ?? ''));
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('processes: listed with their task, paused, resumed, restarted and killed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  let job;
  const pids = [];
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'hello', mode: 'bypassPermissions' });
    const { session } = await c.next((m) => m.ev === 'started');
    await c.next((m) => m.ev === 'session' && m.session.status === 'idle');

    // Like Claude running \`nohup ... &\`: detached, but carrying its session id.
    job = spawn('sleep', ['300'], { cwd: repo, detached: true, stdio: 'ignore', env: { ...process.env, CLAUDE_CODE_SESSION_ID: session.id } });
    job.unref();
    pids.push(job.pid);
    let n = 10;
    const list = async () => { c.send({ op: 'processes', ref: ++n }); return (await c.next((m) => m.ev === 'processes' && m.ref === n)).processes; };
    let procs = await list();
    const find = (pid) => procs.find((p) => p.pid === pid);
    assert.equal(procs.find((p) => p.role === 'bridge')?.pid, bridge.pid);
    assert.equal(procs.find((p) => p.role === 'claude')?.sid, session.id);
    assert.deepEqual([find(job.pid)?.role, find(job.pid)?.sid, find(job.pid)?.detached, find(job.pid)?.name, find(job.pid)?.cwd], ['job', session.id, true, 'sleep', repo]);
    assert.deepEqual(find(job.pid).args, ['sleep', '300']);
    assert.ok(Math.abs(find(job.pid).startedAt - Date.now()) < 10_000);
    assert.ok(procs.every((p) => !('env' in p) && !('envSid' in p))); // environments stay on the bridge

    c.send({ op: 'signal', ref: 20, pid: job.pid, signal: 'SIGSTOP' });
    procs = (await c.next((m) => m.ev === 'processes' && m.ref === 20)).processes;
    assert.equal(find(job.pid).state, 'T');
    c.send({ op: 'signal', ref: 21, pid: job.pid, signal: 'SIGCONT' });
    procs = (await c.next((m) => m.ev === 'processes' && m.ref === 21)).processes;
    assert.notEqual(find(job.pid).state, 'T');

    c.send({ op: 'restart_process', ref: 22, pid: job.pid });
    const restarted = await c.next((m) => m.ev === 'processes' && m.ref === 22, 10_000);
    const fresh = restarted.processes.find((p) => p.pid === restarted.started.pid);
    pids.push(fresh.pid);
    assert.ok(!restarted.processes.some((p) => p.pid === job.pid));
    assert.deepEqual([fresh.args, fresh.cwd, fresh.sid], [['sleep', '300'], repo, session.id]);

    c.send({ op: 'signal', ref: 23, pid: fresh.pid, signal: 'SIGKILL' });
    procs = (await c.next((m) => m.ev === 'processes' && m.ref === 23)).processes;
    // Signal delivery and the kernel's exit are asynchronous; allow a moment for the process to
    // become a zombie instead of requiring it to have happened before the reply was built.
    for (let i = 0; i < 20 && find(fresh.pid) && find(fresh.pid).state !== 'Z'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      procs = await list();
    }
    assert.ok(!find(fresh.pid) || find(fresh.pid).state === 'Z');

    // A program that renames itself, as npm does, can't be restarted, and a refused restart leaves it running.
    const renamed = spawn(process.execPath, ['-e', "process.title = 'npm run dev --no-pdf'; setInterval(() => {}, 1e6)"], { detached: true, stdio: 'ignore' });
    renamed.unref();
    pids.push(renamed.pid);
    await new Promise((r) => setTimeout(r, 500));
    procs = await list();
    assert.deepEqual([find(renamed.pid)?.name, find(renamed.pid)?.restartable], ['npm run dev --no-pdf', false]);
    assert.equal(fresh.restartable, true);
    c.send({ op: 'restart_process', ref: 25, pid: renamed.pid });
    assert.match((await c.next((m) => m.ev === 'error' && m.ref === 25)).message, /renamed itself/);
    process.kill(renamed.pid, 0); // still running

    c.send({ op: 'signal', ref: 24, pid: bridge.pid, signal: 'SIGKILL' });
    assert.match((await c.next((m) => m.ev === 'error' && m.ref === 24)).message, /the bridge itself/);
    c.end();
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ports a task\'s processes listen on show in its summary, and go when they stop', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, { CCM_PORTS_CHECK_MS: '200', CCM_ROOT: '1' });
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  let server;
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'serve', mode: 'bypassPermissions' });
    const { session } = await c.next((m) => m.ev === 'started');
    // A dev server Claude started (detached, so found by the session id in its environment).
    server = spawn(process.execPath, ['-e', "const s = require('http').createServer(() => {}).listen(0, '127.0.0.1', () => console.log(s.address().port))"],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, CLAUDE_CODE_SESSION_ID: session.id } });
    const served = Number(await new Promise((r) => server.stdout.once('data', (d) => r(String(d).trim()))));
    const up = await c.next((m) => m.ev === 'session' && m.session.id === session.id && m.session.ports?.length, 5000);
    assert.deepEqual(up.session.ports, [served]);
    server.kill('SIGKILL');
    await c.next((m) => m.ev === 'session' && m.session.id === session.id && m.session.ports?.length === 0, 5000);
    c.end();
  } finally {
    try { server?.kill('SIGKILL'); } catch {}
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('terminal: a shell in a real pty that resizes, survives detaching, and closes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(path.join(tmp, 'repos'), { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, { CCM_TERM_SHELL: 'sh' });
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    let c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    let seen = '';
    const until = async (text) => {
      while (!seen.includes(text)) seen += Buffer.from((await c.next((m) => m.ev === 'term_output')).data, 'base64').toString();
    };
    c.send({ op: 'term_open', ref: 1, cols: 100, rows: 30 });
    const { id } = await c.next((m) => m.ev === 'term_opened');
    const type = (s) => c.send({ op: 'term_input', id, data: Buffer.from(s).toString('base64') });
    type('stty size; echo mark-$((6*7))\n');
    await until('30 100');
    await until('mark-42');
    c.send({ op: 'term_resize', id, cols: 120, rows: 40 });
    await new Promise((r) => setTimeout(r, 200));
    type('stty size\n');
    await until('40 120');

    // Leaving the screen detaches; opening again finds the same shell and what it printed.
    c.send({ op: 'term_detach', id });
    c.end();
    c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    c.send({ op: 'term_open', ref: 2, cols: 120, rows: 40 });
    const again = await c.next((m) => m.ev === 'term_opened');
    assert.equal(again.id, id);
    assert.match(Buffer.from(again.data, 'base64').toString(), /mark-42/);

    c.send({ op: 'term_close', id });
    await c.next((m) => m.ev === 'term_exit' && m.id === id);
    c.send({ op: 'term_input', ref: 3, id, data: '' });
    assert.match((await c.next((m) => m.ev === 'error' && m.ref === 3)).message, /ended/);
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an idle task\'s Claude process stops after a while, and the next message resumes it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'proj');
  fs.mkdirSync(repo, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, { CCM_IDLE_EXIT_MS: '400' });
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  const claudes = (sid) => execFileSync('ps', ['-eo', 'args']).toString().split('\n').filter((l) => l.includes('fake-claude') && l.includes(sid));
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'first', mode: 'bypassPermissions' });
    const sid = (await c.next((m) => m.ev === 'started')).session.id;
    const done = await c.next((m) => m.ev === 'session' && m.session.id === sid && m.session.status === 'idle');
    assert.equal(done.session.running, true);
    assert.equal(claudes(sid).length, 1);

    // Stopped without the task changing: still idle, still where it was in the list.
    const slept = await c.next((m) => m.ev === 'session' && m.session.id === sid && !m.session.running, 3000);
    assert.equal(slept.session.status, 'idle');
    assert.equal(slept.session.updatedAt, done.session.updatedAt);
    assert.equal(claudes(sid).length, 0);

    c.send({ op: 'send', sid, text: 'second' });
    await c.next((m) => m.ev === 'session' && m.session.id === sid && m.session.status === 'idle' && m.session.running);
    assert.ok(claudes(sid).length === 1);
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('login: claude auth login runs in a pty, its sign-in pages go to the app, and auth reports the result', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(path.join(tmp, 'repos'), { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, { CCM_TERM_SHELL: 'sh' });
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    c.send({ op: 'auth', ref: 1 });
    assert.equal((await c.next((m) => m.ev === 'auth' && m.ref === 1)).auth.loggedIn, false);

    // A shell is open too: login gets its own terminal, and the shell stays the Debian screen's.
    c.send({ op: 'term_open', ref: 2, cols: 80, rows: 24 });
    const shell = (await c.next((m) => m.ev === 'term_opened' && m.ref === 2)).id;
    c.send({ op: 'term_open', ref: 3, cols: 80, rows: 24, kind: 'login', fresh: true });
    const { id, kind } = await c.next((m) => m.ev === 'term_opened' && m.ref === 3);
    assert.notEqual(id, shell);
    assert.equal(kind, 'login');
    const local = await c.next((m) => m.ev === 'term_link' && m.id === id && m.local);
    assert.match(local.url, /redirect_uri=http%3A%2F%2Flocalhost/);
    const manual = await c.next((m) => m.ev === 'term_link' && m.id === id && !m.local);
    assert.equal(manual.url, 'https://claude.test/authorize?code=true');

    // Coming back to the screen finds the same sign-in and both pages.
    c.send({ op: 'term_open', ref: 4, cols: 80, rows: 24, kind: 'login' });
    const again = await c.next((m) => m.ev === 'term_opened' && m.ref === 4);
    assert.equal(again.id, id);
    assert.deepEqual(again.links.map((l) => l.local).sort(), [false, true]);
    c.send({ op: 'term_open', ref: 5, cols: 80, rows: 24 });
    assert.equal((await c.next((m) => m.ev === 'term_opened' && m.ref === 5)).id, shell);

    c.send({ op: 'term_input', id, data: Buffer.from('ada\r').toString('base64') });
    await c.next((m) => m.ev === 'term_exit' && m.id === id);
    c.send({ op: 'auth', ref: 6 });
    const { auth } = await c.next((m) => m.ev === 'auth' && m.ref === 6);
    assert.equal(auth.loggedIn, true);
    assert.equal(auth.email, 'ada@example.com');
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a task moves to another working folder and Claude carries on there', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const a = path.join(tmp, 'repos', 'a');
  const b = path.join(tmp, 'repos', 'b');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    c.send({ op: 'start', ref: 1, cwd: a, prompt: 'first', mode: 'bypassPermissions' });
    const { session } = await c.next((m) => m.ev === 'started');
    await c.next((m) => m.ev === 'session' && m.session.status === 'idle');

    c.send({ op: 'cwd', ref: 2, sid: session.id, cwd: b });
    assert.equal((await c.next((m) => m.ev === 'session' && m.ref === 2)).session.cwd, b);
    c.send({ op: 'subscribe', sid: session.id });
    await c.next((m) => m.ev === 'history');
    c.send({ op: 'send', sid: session.id, text: 'second' });
    const init = await c.next((m) => m.ev === 'cli' && m.msg.type === 'system' && m.msg.subtype === 'init' && m.msg.cwd === b);
    assert.equal(init.msg.cwd, b);
    await c.next((m) => m.ev === 'session' && m.session.id === session.id && m.session.status === 'idle');

    c.send({ op: 'cwd', ref: 3, sid: session.id, cwd: path.join(tmp, 'nope') });
    assert.match((await c.next((m) => m.ev === 'error' && m.ref === 3)).message, /Not a folder/);
    // Busy: a background job is running.
    c.send({ op: 'send', sid: session.id, text: 'run in the background for 60000 ms' });
    const sentAt = Date.now();
    await c.next((m) => m.ev === 'session' && m.session.background.length && m.session.updatedAt >= sentAt);
    c.send({ op: 'cwd', ref: 4, sid: session.id, cwd: a });
    assert.match((await c.next((m) => m.ev === 'error' && m.ref === 4)).message, /busy/);
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Claude\'s questions (AskUserQuestion) get the user\'s answers', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port);
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'ask me something', mode: 'bypassPermissions' });
    const { session } = await c.next((m) => m.ev === 'started');
    const asked = await c.next((m) => m.ev === 'approval' && m.sid === session.id);
    assert.equal(asked.request.request.tool_name, 'AskUserQuestion');
    c.send({ op: 'permission', sid: session.id, requestId: asked.request.request_id, decision: 'allow', answers: { 'Which color?': 'Blue' } });
    const result = await c.next((m) => m.ev === 'cli' && m.msg.type === 'user' && Array.isArray(m.msg.message.content) && m.msg.message.content[0].type === 'tool_result');
    assert.equal(result.msg.message.content[0].content, 'answered {"Which color?":"Blue"}');
    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// A stand-in for Claude's speech service: checks the login, answers each audio frame with the text
// so far, and ends the utterance on CloseStream. Languages other than en and zh are refused (1003).
function fakeSpeechServer() {
  const seen = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let open = false;
    let words = [];
    let request;
    const frame = (op, payload) => {
      const head = payload.length < 126 ? Buffer.from([0x80 | op, payload.length]) : Buffer.from([0x80 | op, 126, payload.length >> 8, payload.length & 255]);
      sock.write(Buffer.concat([head, payload]));
    };
    const json = (o) => frame(1, Buffer.from(JSON.stringify(o)));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        const key = /sec-websocket-key: (\S+)/i.exec(head)[1];
        const url = new URL(head.split(' ')[1], 'http://x');
        request = { auth: /authorization: ([^\r]+)/i.exec(head)?.[1], language: url.searchParams.get('language'), keyterms: /x-config-keyterms: ([^\r]+)/i.exec(head)?.[1], audio: 0 };
        seen.push(request);
        if (request.auth !== 'Bearer test-token') { sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        open = true;
        if (!['en', 'zh'].includes(request.language)) { frame(8, Buffer.concat([Buffer.from([0x03, 0xeb]), Buffer.from('unsupported language')])); return; }
      }
      while (buf.length >= 6) {
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((x, i) => x ^ mask[i % 4]));
        const op = buf[0] & 0x0f;
        buf = buf.subarray(off + 4 + len);
        if (op === 2) {
          request.audio += payload.length;
          words.push(`word${words.length + 1}`);
          json({ type: 'TranscriptInterim', data: words.join(' ') });
        } else if (op === 1 && JSON.parse(payload).type === 'CloseStream') {
          json({ type: 'TranscriptEndpoint' });
          frame(8, Buffer.from([0x03, 0xe8]));
        } else if (op === 8) sock.end();
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `ws://127.0.0.1:${server.address().port}` })));
}

test('voice: audio goes to Claude\'s speech service with the CLI\'s login, and transcripts come back', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.mkdirSync(path.join(tmp, 'claude-config'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'claude-config', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'test-token', expiresAt: Date.now() + 3_600_000 } }));
  const speech = await fakeSpeechServer();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, { CCM_VOICE_URL: speech.url });
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'hi', mode: 'default' });
    const { session } = await c.next((m) => m.ev === 'started');

    const pcm = Buffer.alloc(3200).toString('base64');
    c.send({ op: 'voice_start', ref: 2, id: 'v1', language: 'en', sid: session.id, keyterms: ['ccm-bridge'] });
    await c.next((m) => m.ev === 'voice_started' && m.ref === 2);
    // Audio sent before the connection is up is queued, not lost.
    c.send({ op: 'voice_audio', id: 'v1', data: pcm });
    await c.next((m) => m.ev === 'voice' && m.id === 'v1' && m.type === 'ready');
    assert.equal((await c.next((m) => m.ev === 'voice' && m.type === 'transcript')).text, 'word1');
    c.send({ op: 'voice_audio', id: 'v1', data: pcm });
    assert.deepEqual(await c.next((m) => m.ev === 'voice' && m.type === 'transcript'), { ev: 'voice', id: 'v1', type: 'transcript', text: 'word1 word2', final: false });
    c.send({ op: 'voice_stop', id: 'v1' });
    assert.equal((await c.next((m) => m.ev === 'voice' && m.type === 'transcript')).final, true);
    assert.equal((await c.next((m) => m.ev === 'voice' && m.type === 'closed')).text, 'word1 word2');
    assert.equal(speech.seen[0].keyterms, 'demo,ccm-bridge');
    assert.equal(speech.seen[0].audio, 6400);

    // A language the service refuses falls back to English, keeping what was already said.
    c.send({ op: 'voice_start', ref: 3, id: 'v2', language: 'xx' });
    c.send({ op: 'voice_audio', id: 'v2', data: pcm });
    assert.equal((await c.next((m) => m.ev === 'voice' && m.id === 'v2' && m.type === 'transcript')).text, 'word1');
    assert.deepEqual(speech.seen.slice(1).map((r) => r.language), ['xx', 'en']);
    c.send({ op: 'voice_cancel', id: 'v2' });

    // A rejected login is reported, not left hanging.
    fs.writeFileSync(path.join(tmp, 'claude-config', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'stale', expiresAt: Date.now() + 3_600_000 } }));
    c.send({ op: 'voice_start', ref: 4, id: 'v3', language: 'en' });
    assert.match((await c.next((m) => m.ev === 'voice' && m.id === 'v3' && m.type === 'error')).message, /HTTP 401/);
    await c.next((m) => m.ev === 'voice' && m.id === 'v3' && m.type === 'closed');
    c.end();
  } finally {
    speech.server.close();
    await stopAll(bridge, stateDir);
  }
});

test('AGY native stream-json protocol: init, step_update, result, usage limits, OAuth token, and brain transcript resume', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const agyDir = path.join(tmp, 'agy-data');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });

  // Create a fake AGY OAuth token with JWT id_token claims
  fs.mkdirSync(agyDir, { recursive: true });
  const claims = Buffer.from(JSON.stringify({ email: 'user@antigravity.dev', name: 'AGY User' })).toString('base64url');
  fs.writeFileSync(path.join(agyDir, 'antigravity-oauth-token'), JSON.stringify({
    token: { access_token: 'ya29.test', refresh_token: '1//test' },
    auth_method: 'consumer',
    id_token: `eyJhbGciOiJSUzI1NiJ9.${claims}.sig`,
  }));

  // Create an AGY brain transcript on disk to test resume
  const existingConvId = '22222222-3333-4444-8555-666666666666';
  const logDir = path.join(agyDir, 'brain', existingConvId, '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(agyDir, 'history.jsonl'), JSON.stringify({
    display: 'port the app to agy',
    timestamp: Date.now() - 10_000,
    workspace: repo,
    conversationId: existingConvId,
  }) + '\n');
  fs.writeFileSync(path.join(logDir, 'transcript.jsonl'), [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-05T10:00:00Z', content: '<USER_REQUEST>\nport the app to agy\n</USER_REQUEST>' }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-05T10:00:02Z',
      thinking: 'Inspecting files first.',
      content: 'Porting now.',
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"ls -la"', Cwd: JSON.stringify(repo) } }],
    }),
  ].join('\n') + '\n');

  const port = 20000 + Math.floor(Math.random() * 20000);
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, {
    CCM_LEGACY_PROTO: '0',
    FAKE_AGY_STREAM: '1',
    FAKE_AGY_USAGE: '1',
    CCM_STUCK_TOOL_GRACE_MS: '1000',
  });
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');

    // 1. Check AGY OAuth status
    c.send({ op: 'auth', ref: 10 });
    const { auth } = await c.next((m) => m.ev === 'auth' && m.ref === 10);
    assert.equal(auth.loggedIn, true);
    assert.equal(auth.email, 'user@antigravity.dev');
    assert.equal(auth.subscriptionType, 'Antigravity');

    // 1b. Switch to Gemini API key and back
    c.send({ op: 'set_auth', ref: 101, provider: 'gemini', apiKey: 'AQ.TestKey123456789' });
    const geminiAuth = (await c.next((m) => m.ev === 'auth' && m.ref === 101)).auth;
    assert.equal(geminiAuth.loggedIn, true);
    assert.equal(geminiAuth.provider, 'gemini');
    assert.equal(geminiAuth.subscriptionType, 'Gemini API');
    assert.equal(geminiAuth.hasGeminiKey, true);

    c.send({ op: 'set_auth', ref: 102, provider: 'google' });
    const googleAuth = (await c.next((m) => m.ev === 'auth' && m.ref === 102)).auth;
    assert.equal(googleAuth.loggedIn, true);
    assert.equal(googleAuth.provider, 'google');
    assert.equal(googleAuth.subscriptionType, 'Antigravity');

    // 2. Check AGY resume list from brain/<id>/transcript.jsonl
    c.send({ op: 'claude_sessions', ref: 11 });
    const resumeList = (await c.next((m) => m.ev === 'claude_sessions' && m.ref === 11)).sessions;
    assert.equal(resumeList.length, 1);
    assert.equal(resumeList[0].id, existingConvId);
    assert.equal(resumeList[0].title, 'port the app to agy');
    assert.equal(resumeList[0].cwd, repo);

    // 3. Resume existing AGY conversation
    c.send({ op: 'resume', ref: 12, id: existingConvId });
    await c.next((m) => m.ev === 'started' && m.ref === 12);
    c.send({ op: 'subscribe', sid: existingConvId });
    const hist = await c.next((m) => m.ev === 'history' && m.sid === existingConvId);
    assert.equal(hist.events[0].type, 'user');
    assert.equal(hist.events[0].message.content, 'port the app to agy');
    assert.equal(hist.events[1].type, 'assistant');
    assert.equal(hist.events[1].message.content[0].type, 'thinking');
    assert.equal(hist.events[1].message.content[1].text, 'Porting now.');
    assert.equal(hist.events[1].message.content[2].name, 'run_command');
    assert.equal(hist.events[1].message.content[2].input.CommandLine, 'ls -la');

    // 4. Start a new AGY session with model gemini-3.8-flash and default (unset) effort, verifying --effort high is auto-supplied
    c.send({ op: 'start', ref: 13, cwd: repo, prompt: 'build apk', model: 'gemini-3.8-flash' });
    const { session } = await c.next((m) => m.ev === 'started' && m.ref === 13);
    assert.equal(session.mode, 'bypassPermissions');

    const toolCall = await c.next((m) => m.ev === 'cli' && m.sid === session.id && m.msg.type === 'assistant' && m.msg.message.content.some((b) => b.type === 'tool_use'));
    assert.equal(toolCall.msg.message.content[0].name, 'run_command');
    assert.equal(toolCall.msg.message.content[0].input.CommandLine, 'echo hi');

    const toolRes = await c.next((m) => m.ev === 'cli' && m.sid === session.id && m.msg.type === 'user' && m.msg.message.content[0].type === 'tool_result');
    assert.equal(toolRes.msg.message.content[0].content, 'hi\n');

    const streamDelta = await c.next((m) => m.ev === 'cli' && m.sid === session.id && m.msg.type === 'stream_event');
    assert.equal(streamDelta.msg.text_delta, 'AGY reply ');

    const finalReply = await c.next((m) => m.ev === 'cli' && m.sid === session.id && m.msg.type === 'assistant' && m.msg.message.content.some((b) => b.type === 'text'));
    assert.equal(finalReply.msg.message.content[0].text, 'AGY reply to: build apk [effort: high]');

    const idleFirst = await c.next((m) => m.ev === 'session' && m.session.id === session.id && m.session.status === 'idle');
    assert.ok(idleFirst.session.outputTokens >= 30);
    assert.ok(idleFirst.session.inputTokens > 0);
    assert.ok(idleFirst.session.requests >= 1);

    // 5. Check usage & quota limits parsed from `agy -p /usage --output-format json`
    c.send({ op: 'usage', ref: 14, days: 7 });
    const usage = await c.next((m) => m.ev === 'usage' && m.ref === 14);
    assert.ok(usage.limits);
    assert.equal(usage.limits.windows.length, 2);
    assert.equal(usage.limits.windows[0].id, 'gemini-5h');
    assert.equal(Math.round(usage.limits.windows[0].utilization * 100), 7);
    assert.equal(usage.limits.windows[1].id, 'gemini-weekly');
    assert.equal(Math.round(usage.limits.windows[1].utilization * 100), 85);
    assert.ok(usage.days.at(-1).output >= 30);
    assert.equal(typeof usage.days.at(-1).thinking, 'number');

    // 6. Test built-in slash command (/models) executed via one-shot print mode
    c.send({ op: 'send', sid: session.id, text: '/models' });
    const slashReply = await c.next((m) => m.ev === 'cli' && m.sid === session.id && m.msg.type === 'assistant' && /gemini-4-argon/.test(m.msg.message.content[0]?.text ?? ''));
    assert.match(slashReply.msg.message.content[0].text, /gemini-4-carbon/);
    assert.match(slashReply.msg.message.content[0].text, /gemini-3\.8-flash/);
    await c.next((m) => m.ev === 'session' && m.session.id === session.id && m.session.status === 'idle');

    // 7. Change model in the same session and send another prompt
    c.send({ op: 'model', sid: session.id, model: 'claude-opus-5-5' });
    const updatedSession = (await c.next((m) => m.ev === 'session' && m.session.id === session.id && m.session.model === 'claude-opus-5-5')).session;
    c.send({ op: 'send', sid: session.id, text: 'hello with opus' });
    const opusReply = await c.next((m) => m.ev === 'cli' && m.sid === session.id && m.msg.type === 'assistant' && m.msg.message.content.some((b) => b.type === 'text' && b.text.includes('hello with opus')));
    assert.equal(opusReply.msg.message.model, 'claude-opus-5-5');

    // 8. Result with status SUCCESS and historical error details (stale quota error) does NOT trigger rate limit
    c.send({ op: 'send', sid: session.id, text: 'turn with stale-quota-error' });
    const resMsg = await c.next((m) => m.ev === 'cli' && m.sid === session.id && m.msg.type === 'result');
    assert.equal(resMsg.msg.is_error, false);
    assert.equal(resMsg.msg.subtype, 'success');
    const finalSession = (await c.next((m) => m.ev === 'session' && m.session.id === session.id && m.session.status === 'idle')).session;
    assert.equal(finalSession.status, 'idle');
    assert.equal(finalSession.resumeAt, null);

    // 8b. Result with status ERROR and stale quota error on completed turn does NOT trigger rate limit
    c.send({ op: 'send', sid: session.id, text: 'turn with stale-quota-error stale-quota-status-error' });
    const resMsgErr = await c.next((m) => m.ev === 'cli' && m.sid === session.id && m.msg.type === 'result');
    assert.equal(resMsgErr.msg.is_error, false);
    assert.equal(resMsgErr.msg.subtype, 'success');
    const finalSessionErr = (await c.next((m) => m.ev === 'session' && m.session.id === session.id && m.session.status === 'idle')).session;
    assert.equal(finalSessionErr.status, 'idle');
    assert.equal(finalSessionErr.resumeAt, null);

    // 8c. Result with stream interrupted error on completed turn does NOT fail turn or mark session as error
    c.send({ op: 'send', sid: session.id, text: 'turn with stream-interrupted-after-response' });
    const resMsgInterrupted = await c.next((m) => m.ev === 'cli' && m.sid === session.id && m.msg.type === 'result' && m.msg.result.includes('stream-interrupted'));
    assert.equal(resMsgInterrupted.msg.is_error, false);
    assert.equal(resMsgInterrupted.msg.subtype, 'success');
    const sessionAfterInterrupted = (await c.next((m) => m.ev === 'session' && m.session.id === session.id && m.session.status === 'idle')).session;
    assert.equal(sessionAfterInterrupted.status, 'idle');

    // 9. Stuck background tool unblocking: when a command runs forever and transcript advances, bridge terminates child process to unblock stream
    c.send({ op: 'send', sid: session.id, text: 'test-stuck-tool' });
    const stuckNote = await c.next((m) => m.ev === 'cli' && m.sid === session.id && m.msg.type === 'bridge' && m.msg.subtype === 'note' && m.msg.message.includes('Unblocking AGY stream'));
    assert.match(stuckNote.msg.message, /Unblocking AGY stream: terminating stuck background tool process/);
    const unblockedRes = await c.next((m) => m.ev === 'cli' && m.sid === session.id && m.msg.type === 'result' && m.msg.result === 'Unblocked successfully!');
    assert.equal(unblockedRes.msg.subtype, 'success');
    assert.equal(unblockedRes.msg.result, 'Unblocked successfully!');
    const idleAfterUnblock = (await c.next((m) => m.ev === 'session' && m.session.id === session.id && m.session.status === 'idle')).session;
    assert.equal(idleAfterUnblock.status, 'idle');

    // 10. Gemini 4 Carbon that AGY's sign-in cannot select gets an explanation, not a silent fallback
    c.send({ op: 'start', ref: 15, cwd: repo, prompt: 'use carbon', model: 'gemini-4-carbon' });
    const carbon = (await c.next((m) => m.ev === 'started' && m.ref === 15)).session;
    const carbonNote = await c.next((m) => m.ev === 'cli' && m.sid === carbon.id && m.msg.type === 'bridge' && m.msg.subtype === 'note' && /Carbon/.test(m.msg.message));
    assert.match(carbonNote.msg.message, /Application Default Credentials/);
    const carbonErr = await c.next((m) => m.ev === 'cli' && m.sid === carbon.id && m.msg.type === 'bridge' && m.msg.subtype === 'error');
    assert.match(carbonErr.msg.message, /agy exited/);
    await c.next((m) => m.ev === 'session' && m.session.id === carbon.id && m.session.status === 'error');

    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGY provider switching without OAuth token, GENERIC brain sync, read_file JPG/PNG, non-duplicated usage, and clean tool close on stop', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const agyDir = path.join(tmp, 'agy-data');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8]);
  const jpgFile = path.join(repo, 'photo.jpg');
  const pngFile = path.join(repo, 'icon.png');
  fs.writeFileSync(jpgFile, jpgBytes);
  fs.writeFileSync(pngFile, pngBytes);

  // Create an untracked AGY CLI brain transcript with GENERIC tool outputs, read_file .jpg, and token usage
  const brainId = '33333333-4444-4555-8666-777777777777';
  const logDir = path.join(agyDir, 'brain', brainId, '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const nowIso = new Date().toISOString();
  fs.writeFileSync(path.join(agyDir, 'history.jsonl'), JSON.stringify({
    display: 'inspect photo',
    timestamp: Date.now() - 5000,
    workspace: repo,
    conversationId: brainId,
  }) + '\n');
  const brainFile = path.join(logDir, 'transcript.jsonl');
  fs.writeFileSync(brainFile, [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: nowIso, content: '<USER_REQUEST>\ninspect photo\n</USER_REQUEST>' }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      content: 'Reading photo.jpg.',
      input_tokens: 400,
      cache_read_tokens: 100,
      output_tokens: 60,
      tool_calls: [{ id: 'call_jpg_1', name: 'read_file', args: { Path: JSON.stringify(jpgFile) } }],
    }),
    JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', created_at: nowIso, content: 'Read image file' }),
  ].join('\n') + '\n');

  const port = await freePort();
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, {
    CCM_LEGACY_PROTO: '0',
    FAKE_AGY_STREAM: '1',
    CCM_TERM_SHELL: 'sh',
  });
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');

    // 1. Untracked brain session contributes to usage before resume
    c.send({ op: 'usage', ref: 1, days: 7 });
    const uBefore = await c.next((m) => m.ev === 'usage' && m.ref === 1);
    assert.equal(uBefore.days.at(-1).output, 60);
    assert.equal(uBefore.days.at(-1).input, 400);
    assert.equal(uBefore.days.at(-1).cacheRead, 100);

    // 2. Provider switching when NO OAuth token exists yet: gemini -> google must NOT get stuck in gemini mode
    c.send({ op: 'set_auth', ref: 2, provider: 'gemini', apiKey: 'AIzaSyTestKey987654321' });
    const gemAuth = (await c.next((m) => m.ev === 'auth' && m.ref === 2)).auth;
    assert.equal(gemAuth.loggedIn, true);
    assert.equal(gemAuth.provider, 'gemini');
    assert.equal(gemAuth.hasGeminiKey, true);

    c.send({ op: 'set_auth', ref: 3, provider: 'google' });
    const gooUnauth = (await c.next((m) => m.ev === 'auth' && m.ref === 3)).auth;
    assert.equal(gooUnauth.loggedIn, false);
    assert.equal(gooUnauth.provider, 'google');
    assert.equal(gooUnauth.hasGeminiKey, true);

    // Login terminal must strip GEMINI_API_KEY so AGY runs interactive Google OAuth
    c.send({ op: 'term_open', ref: 4, cols: 80, rows: 24, kind: 'login', fresh: true });
    const termOpened = await c.next((m) => m.ev === 'term_opened' && m.ref === 4);
    let termOut = Buffer.from(termOpened.data ?? '', 'base64').toString();
    while (!termOut.includes('Paste code here')) {
      const chunk = await c.next((m) => m.ev === 'term_output' && m.id === termOpened.id);
      termOut += Buffer.from(chunk.data, 'base64').toString();
    }
    assert.match(termOut, /\[gemini-env:absent\]/);
    c.send({ op: 'term_input', id: termOpened.id, data: Buffer.from('bob\r').toString('base64') });
    await c.next((m) => m.ev === 'term_exit' && m.id === termOpened.id);

    c.send({ op: 'auth', ref: 5 });
    const gooLogged = (await c.next((m) => m.ev === 'auth' && m.ref === 5)).auth;
    assert.equal(gooLogged.loggedIn, true);
    assert.equal(gooLogged.provider, 'google');
    assert.equal(gooLogged.email, 'bob@example.com');
    assert.equal(gooLogged.hasGeminiKey, true);

    // 3. Resume brain session: GENERIC step becomes tool_result with extracted .jpg thumbnail, and usage is NOT double-counted
    c.send({ op: 'resume', ref: 6, id: brainId });
    await c.next((m) => m.ev === 'started' && m.ref === 6);
    c.send({ op: 'subscribe', sid: brainId });
    const hist1 = await c.next((m) => m.ev === 'history' && m.sid === brainId);
    const toolResultEv = hist1.events.find((e) => e.type === 'user' && Array.isArray(e.message?.content) && e.message.content[0]?.type === 'tool_result');
    assert.ok(toolResultEv, 'expected GENERIC step to produce tool_result');
    assert.equal(toolResultEv.message.content[0].tool_use_id, 'call_jpg_1');
    const jpgRef = toolResultEv.message.content[0].content.find((b) => b.type === 'image')?.ref;
    assert.match(jpgRef, /^[0-9a-f]{32}\.jpg$/);

    c.send({ op: 'image', ref: 7, sid: brainId, image: jpgRef });
    const fetchedJpg = await c.next((m) => m.ev === 'image' && m.ref === 7);
    assert.equal(fetchedJpg.mime, 'image/jpeg');
    assert.deepEqual(Buffer.from(fetchedJpg.data, 'base64'), jpgBytes);

    c.send({ op: 'usage', ref: 8, days: 7 });
    const uAfterResume = await c.next((m) => m.ev === 'usage' && m.ref === 8);
    assert.equal(uAfterResume.days.at(-1).output, 60);

    // Append a second turn to brain transcript and verify syncFromCli appends ONLY the new turn
    fs.appendFileSync(brainFile, [
      JSON.stringify({ step_index: 3, type: 'USER_INPUT', status: 'DONE', created_at: nowIso, content: '<USER_REQUEST>\nand check status\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: nowIso, content: 'All clean.' }),
    ].join('\n') + '\n');
    c.send({ op: 'subscribe', sid: brainId });
    const hist2 = await c.next((m) => m.ev === 'history' && m.sid === brainId);
    const userPrompts = hist2.events.filter((e) => e.type === 'user' && typeof e.message?.content === 'string').map((e) => e.message.content);
    assert.deepEqual(userPrompts, ['inspect photo', 'and check status']);

    // 4. Live fallback-response-only does NOT double-count cumulative res.usage
    c.send({ op: 'start', ref: 9, cwd: repo, prompt: 'fallback-response-only' });
    const fbSession = (await c.next((m) => m.ev === 'started' && m.ref === 9)).session;
    const fbIdle = (await c.next((m) => m.ev === 'session' && m.session.id === fbSession.id && m.session.status === 'idle')).session;
    assert.equal(fbIdle.outputTokens, 40);
    assert.equal(fbIdle.inputTokens, 100);
    assert.equal(fbIdle.cacheReadTokens, 50);

    // 5. Live read_file on .png captures image ref
    c.send({ op: 'send', sid: fbSession.id, text: `read-image: ${pngFile}` });
    const liveImgEv = await c.next((m) => m.ev === 'cli' && m.sid === fbSession.id && m.msg.type === 'user' && Array.isArray(m.msg.message.content) && Array.isArray(m.msg.message.content[0]?.content));
    const pngRef = liveImgEv.msg.message.content[0].content.find((b) => b.type === 'image')?.ref;
    assert.match(pngRef, /^[0-9a-f]{32}\.png$/);
    await c.next((m) => m.ev === 'session' && m.session.id === fbSession.id && m.session.status === 'idle');

    // 6. Stopping a session during slow-tool closes running tool with an error tool_result
    c.send({ op: 'send', sid: fbSession.id, text: 'slow-tool' });
    const slowCall = await c.next((m) => m.ev === 'cli' && m.sid === fbSession.id && m.msg.type === 'assistant' && m.msg.message.content.some((b) => b.type === 'tool_use' && b.input?.CommandLine === 'sleep 60'));
    const slowToolId = slowCall.msg.message.content[0].id;
    c.send({ op: 'stop', sid: fbSession.id });
    const closedTool = await c.next((m) => m.ev === 'cli' && m.sid === fbSession.id && m.msg.type === 'user' && m.msg.message.content?.[0]?.tool_use_id === slowToolId);
    assert.equal(closedTool.msg.message.content[0].is_error, true);
    const stoppedSess = (await c.next((m) => m.ev === 'session' && m.session.id === fbSession.id && m.session.status === 'stopped' && !m.session.running)).session;
    assert.equal(stoppedSess.status, 'stopped');

    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Hybrid (Sub -> API 4 Hydrogen -> Sub) mode, API key isolation, explicit gemini-4-hydrogen, and daily API budget cap', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const agyDir = path.join(tmp, 'agy-data');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(agyDir, { recursive: true });

  // Pre-seed OAuth token + legacy settings.json/gemini-api-key in agyDir to test isolateAgyApiKeyFiles()
  const claims = Buffer.from(JSON.stringify({ email: 'hybrid@antigravity.dev', name: 'Hybrid User' })).toString('base64url');
  fs.writeFileSync(path.join(agyDir, 'antigravity-oauth-token'), JSON.stringify({
    token: { access_token: 'ya29.hybrid', refresh_token: '1//hybrid' },
    auth_method: 'consumer',
    id_token: `eyJhbGciOiJSUzI1NiJ9.${claims}.sig`,
  }));
  fs.writeFileSync(path.join(agyDir, 'gemini-api-key'), 'AIzaSyMigrated123456\n');
  fs.writeFileSync(path.join(agyDir, 'settings.json'), JSON.stringify({
    geminiApiKey: 'AIzaSyMigrated123456',
    modelProvider: 'gemini',
    theme: 'dark',
  }, null, 2));

  const writeFakeUsage = (remaining) => {
    fs.writeFileSync(path.join(agyDir, 'fake-usage.json'), JSON.stringify({
      status: 'SUCCESS',
      response: 'Usage limits',
      command: {
        name: 'usage',
        data: {
          groups: [{
            buckets: [{
              id: 'gemini-5h',
              remaining_fraction: remaining,
              reset_time: new Date(Date.now() + 3600_000).toISOString(),
            }],
          }],
        },
      },
    }));
  };
  writeFakeUsage(0.9);

  const port = await freePort();
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, {
    CCM_LEGACY_PROTO: '0',
    FAKE_AGY_STREAM: '1',
    FAKE_AGY_USAGE: '1',
  });
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    // 1. Verify isolateAgyApiKeyFiles() migrated the key into stateDir and cleaned agyDir
    assert.equal(fs.existsSync(path.join(agyDir, 'gemini-api-key')), false);
    const cleanedSettings = JSON.parse(fs.readFileSync(path.join(agyDir, 'settings.json'), 'utf8'));
    assert.equal('geminiApiKey' in cleanedSettings, false);
    assert.equal('modelProvider' in cleanedSettings, false);
    assert.equal(cleanedSettings.theme, 'dark');
    assert.equal(fs.readFileSync(path.join(stateDir, 'gemini-api-key'), 'utf8').trim(), 'AIzaSyMigrated123456');

    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');

    // 2. Switch to Hybrid mode with $0.02 daily API cap using the already-migrated key
    c.send({ op: 'set_auth', ref: 1, provider: 'hybrid', dailyApiLimitUsd: 0.02 });
    const hybAuth = (await c.next((m) => m.ev === 'auth' && m.ref === 1)).auth;
    assert.equal(hybAuth.loggedIn, true);
    assert.equal(hybAuth.provider, 'hybrid');
    assert.equal(hybAuth.email, 'hybrid@antigravity.dev');
    assert.equal(hybAuth.hasGeminiKey, true);
    assert.equal(hybAuth.maskedGeminiKey, 'AIza...3456');
    assert.equal(hybAuth.dailyApiLimitUsd, 0.02);

    // 3a. Explicit gemini-4-hydrogen session uses Google Subscription first ($0 marginal cost, supports xhigh)
    c.send({ op: 'start', ref: 2, cwd: repo, prompt: 'hydrogen-sub', model: 'gemini-4-hydrogen', effort: 'xhigh' });
    const h4SubSess = (await c.next((m) => m.ev === 'started' && m.ref === 2)).session;
    const h4SubReply = await c.next((m) => m.ev === 'cli' && m.sid === h4SubSess.id && m.msg.type === 'assistant' && m.msg.message.content.some((b) => b.type === 'text'));
    assert.match(h4SubReply.msg.message.content[0].text, /\[via:sub:gemini-4-hydrogen\]/);
    assert.match(h4SubReply.msg.message.content[0].text, /\[effort: xhigh\]/);
    const h4SubIdle = (await c.next((m) => m.ev === 'session' && m.session.id === h4SubSess.id && m.session.status === 'idle')).session;
    assert.equal(h4SubIdle.billing, 'sub');
    assert.equal(h4SubIdle.costUsd, 0);

    // 3b. If a subscription tier lacks gemini-4-hydrogen, Hybrid mode automatically falls back to Gemini API + local gateway
    fs.writeFileSync(path.join(agyDir, 'fake-no-sub-hydrogen'), '1');
    c.send({ op: 'start', ref: 21, cwd: repo, prompt: 'hydrogen-direct', model: 'gemini-4-hydrogen' });
    const h4Sess = (await c.next((m) => m.ev === 'started' && m.ref === 21)).session;
    const h4FallbackNote = await c.next((m) => m.ev === 'cli' && m.sid === h4Sess.id && m.msg.type === 'bridge' && m.msg.subtype === 'note' && m.msg.message.includes('continuing on Gemini API'));
    assert.match(h4FallbackNote.msg.message, /does not include Gemini 4 Hydrogen — continuing on Gemini API/);
    const h4Reply = await c.next((m) => m.ev === 'cli' && m.sid === h4Sess.id && m.msg.type === 'assistant' && m.msg.message.content.some((b) => b.type === 'text'));
    assert.match(h4Reply.msg.message.content[0].text, /\[via:api:gemini-4-hydrogen\]/);
    assert.match(h4Reply.msg.message.content[0].text, /\[effort: high\]/);
    const h4Idle = (await c.next((m) => m.ev === 'session' && m.session.id === h4Sess.id && m.session.status === 'idle')).session;
    assert.equal(h4Idle.billing, 'api');
    assert.ok(h4Idle.costUsd > 0);
    fs.rmSync(path.join(agyDir, 'fake-no-sub-hydrogen'), { force: true });

    // 4. Hybrid session starts on Google Subscription ($0 marginal cost, no GEMINI_API_KEY leaked)
    c.send({ op: 'start', ref: 3, cwd: repo, prompt: 'hybrid-turn-1', model: 'gemini-4-argon' });
    const hybSess = (await c.next((m) => m.ev === 'started' && m.ref === 3)).session;
    const subReply1 = await c.next((m) => m.ev === 'cli' && m.sid === hybSess.id && m.msg.type === 'assistant' && m.msg.message.content.some((b) => b.type === 'text'));
    assert.match(subReply1.msg.message.content[0].text, /\[via:sub:gemini-4-argon\]/);
    const subIdle1 = (await c.next((m) => m.ev === 'session' && m.session.id === hybSess.id && m.session.status === 'idle')).session;
    assert.equal(subIdle1.billing, 'sub');
    assert.equal(subIdle1.costUsd, 0);

    // 5. Subscription hits 429 -> automatically spills over to Gemini API (Gemini 4 Hydrogen) and finishes turn!
    fs.writeFileSync(path.join(agyDir, 'fake-sub-limit'), '1');
    writeFakeUsage(0.0);
    c.send({ op: 'send', sid: hybSess.id, text: 'hybrid-turn-2' });
    const spillNote = await c.next((m) => m.ev === 'cli' && m.sid === hybSess.id && m.msg.type === 'bridge' && m.msg.subtype === 'note' && m.msg.message.includes('Gemini 4 Hydrogen'));
    assert.match(spillNote.msg.message, /Subscription limit reached — continuing on Gemini API \(Gemini 4 Hydrogen\)/);
    const spillReply = await c.next((m) => m.ev === 'cli' && m.sid === hybSess.id && m.msg.type === 'assistant' && m.msg.message.content.some((b) => b.type === 'text' && b.text.includes('hybrid-turn-2')));
    assert.match(spillReply.msg.message.content[0].text, /\[via:api:gemini-4-hydrogen\]/);
    const spillIdle = (await c.next((m) => m.ev === 'session' && m.session.id === hybSess.id && m.session.status === 'idle')).session;
    assert.equal(spillIdle.billing, 'api');
    assert.equal(spillIdle.effectiveModel, 'gemini-4-hydrogen');
    assert.ok(spillIdle.costUsd > 0);

    // 6. Subscription quota resets -> automatically reverts to Google Subscription on next message!
    fs.rmSync(path.join(agyDir, 'fake-sub-limit'), { force: true });
    writeFakeUsage(0.95);
    c.send({ op: 'usage', ref: 4, days: 7 });
    const midUsage = await c.next((m) => m.ev === 'usage' && m.ref === 4);
    assert.ok(midUsage.todayApiCostUsd > 0);
    assert.ok(midUsage.days.at(-1).apiRequests >= 2);
    assert.ok(midUsage.days.at(-1).output > midUsage.days.at(-1).apiOutput);

    const turn3SentAt = Date.now();
    c.send({ op: 'send', sid: hybSess.id, text: 'hybrid-turn-3' });
    const revertNote = await c.next((m) => m.ev === 'cli' && m.sid === hybSess.id && m.msg.type === 'bridge' && m.msg.subtype === 'note' && m.msg.message.includes('switched back to Google subscription'));
    assert.match(revertNote.msg.message, /Subscription quota reset/);
    const subReply3 = await c.next((m) => m.ev === 'cli' && m.sid === hybSess.id && m.msg.type === 'assistant' && m.msg.message.content.some((b) => b.type === 'text' && b.text.includes('hybrid-turn-3')));
    assert.match(subReply3.msg.message.content[0].text, /\[via:sub:gemini-4-argon\]/);
    const subIdle3 = (await c.next((m) => m.ev === 'session' && m.session.id === hybSess.id && m.session.status === 'idle' && m.session.updatedAt >= turn3SentAt && m.session.running)).session;
    assert.equal(subIdle3.billing, 'sub');

    // 7. Daily API budget cap: once todayApiCostUsd >= dailyApiLimitUsd ($0.02), Hybrid refuses paid spillover and waits in 'limited'
    fs.writeFileSync(path.join(agyDir, 'fake-sub-limit'), '1');
    writeFakeUsage(0.0);
    const turn4SentAt = Date.now();
    c.send({ op: 'send', sid: hybSess.id, text: 'hybrid-turn-4 big-tokens' });
    await c.next((m) => m.ev === 'cli' && m.sid === hybSess.id && m.msg.type === 'assistant' && m.msg.message.content.some((b) => b.type === 'text' && b.text.includes('hybrid-turn-4')));
    await c.next((m) => m.ev === 'session' && m.session.id === hybSess.id && m.session.status === 'idle' && m.session.updatedAt >= turn4SentAt && m.session.billing === 'api');

    c.send({ op: 'send', sid: hybSess.id, text: 'hybrid-turn-5' });
    const capNote = await c.next((m) => m.ev === 'cli' && m.sid === hybSess.id && m.msg.type === 'bridge' && m.msg.subtype === 'note' && m.msg.message.includes('Daily Gemini API cap'));
    assert.match(capNote.msg.message, /Daily Gemini API cap \(\$0\.02\) reached/);
    const limitedSess = (await c.next((m) => m.ev === 'session' && m.session.id === hybSess.id && m.session.status === 'limited')).session;
    assert.equal(limitedSess.status, 'limited');

    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('recovered mid-turn API attempt errors do not fail completed turns, while genuine post-tool failures still report error', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const agyDir = path.join(tmp, 'agy-data');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });

  // Pre-seed a historical session whose last turn had already delivered an assistant answer
  // followed by a stale `API error (attempt 1): ...` result (matching screenshot 1338.jpg)
  const histSid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  fs.writeFileSync(path.join(stateDir, 'sessions', `${histSid}.json`), JSON.stringify({
    id: histSid,
    cwd: repo,
    title: 'Historical Carbon Task',
    model: 'gemini-4-carbon',
    status: 'error',
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 10_000,
    lastActivity: 'API error (attempt 1): doRequest: error sending request',
    started: true,
  }));
  fs.writeFileSync(path.join(stateDir, 'sessions', `${histSid}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Implement Hydrogen' }, local: true }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Verification complete: 26/26 passing.' }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'API error (attempt 1): doRequest: error sending request: Post "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse": http2: timeout awaiting response headers',
      duration_ms: 60246486,
    }),
  ].join('\n') + '\n');

  // Also pre-seed a brain transcript with a recovered mid-turn ERROR_MESSAGE followed by PLANNER_RESPONSE,
  // and a second turn ending in an unrecovered ERROR_MESSAGE
  const brainId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const logDir = path.join(agyDir, 'brain', brainId, '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const nowIso = new Date().toISOString();
  fs.writeFileSync(path.join(agyDir, 'history.jsonl'), JSON.stringify({
    display: 'brain retry test',
    timestamp: Date.now() - 5_000,
    workspace: repo,
    conversationId: brainId,
  }) + '\n');
  fs.writeFileSync(path.join(logDir, 'transcript.jsonl'), [
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: nowIso, content: '<USER_REQUEST>\nturn 1\n</USER_REQUEST>' }),
    JSON.stringify({
      step_index: 1,
      type: 'ERROR_MESSAGE',
      status: 'DONE',
      created_at: nowIso,
      error: 'API error (attempt 1): doRequest: error sending request: Post "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse": http2: timeout awaiting response headers',
    }),
    JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: nowIso, content: 'Recovered on attempt 2!' }),
    JSON.stringify({ step_index: 3, type: 'USER_INPUT', status: 'DONE', created_at: nowIso, content: '<USER_REQUEST>\nturn 2\n</USER_REQUEST>' }),
    JSON.stringify({
      step_index: 4,
      type: 'ERROR_MESSAGE',
      status: 'DONE',
      created_at: nowIso,
      error: 'API error (attempt 3): doRequest: error sending request: Post "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse": http2: timeout awaiting response headers',
    }),
  ].join('\n') + '\n');

  const port = await freePort();
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, {
    CCM_LEGACY_PROTO: '0',
    FAKE_AGY_STREAM: '1',
    CCM_AGY_DIR: agyDir,
  });
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    const initialSessions = (await c.next((m) => m.ev === 'sessions')).sessions;

    // 1. Historical session with recovered attempt-1 error after assistant reply is healed to 'idle'
    const healed = initialSessions.find((s) => s.id === histSid);
    assert.ok(healed);
    assert.equal(healed.status, 'idle');

    // 2. Brain transcript import skips recovered mid-turn ERROR_MESSAGE (step 1) but keeps terminal ERROR_MESSAGE (step 4)
    c.send({ op: 'resume', ref: 1, id: brainId });
    await c.next((m) => m.ev === 'started' && m.ref === 1);
    c.send({ op: 'subscribe', sid: brainId });
    const brainHist = await c.next((m) => m.ev === 'history' && m.sid === brainId);
    const brainResults = brainHist.events.filter((e) => e.type === 'result');
    assert.equal(brainResults.length, 1);
    assert.match(brainResults[0].result, /attempt 3/);

    // 3. Live turn with recovered attempt-1 header timeout + cumulative 60246s duration finishes as clean 'idle' success with clamped duration_ms
    c.send({ op: 'start', ref: 2, cwd: repo, prompt: 'recovered-attempt-1-timeout' });
    const liveSess = (await c.next((m) => m.ev === 'started' && m.ref === 2)).session;
    const recoveredRes = await c.next((m) => m.ev === 'cli' && m.sid === liveSess.id && m.msg.type === 'result');
    assert.equal(recoveredRes.msg.is_error, false);
    assert.equal(recoveredRes.msg.subtype, 'success');
    assert.ok(recoveredRes.msg.duration_ms < 5_000, `expected clamped turn duration_ms < 5000, got ${recoveredRes.msg.duration_ms}`);
    const liveIdle = (await c.next((m) => m.ev === 'session' && m.session.id === liveSess.id && m.session.status === 'idle')).session;
    assert.equal(liveIdle.status, 'idle');

    // 4. Live turn where intermediate text was followed by a tool call and then post-tool retries genuinely failed -> MUST report error!
    c.send({ op: 'send', sid: liveSess.id, text: 'unrecovered-post-tool-timeout' });
    const unrecoveredRes = await c.next((m) => m.ev === 'cli' && m.sid === liveSess.id && m.msg.type === 'result');
    assert.equal(unrecoveredRes.msg.is_error, true);
    assert.equal(unrecoveredRes.msg.subtype, 'error');
    assert.match(unrecoveredRes.msg.result, /timeout awaiting response headers/);
    const liveErr = (await c.next((m) => m.ev === 'session' && m.session.id === liveSess.id && m.session.status === 'error')).session;
    assert.equal(liveErr.status, 'error');

    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('non-exec bash wrapper (like ~/.local/bin/agy) restarts cleanly on effort/model change, classifies agy.bin as claude, preserves pre-init prompt context, and heals stuck working keeper on startup', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-nonexec-wrapper-'));
  const stateDir = path.join(tmp, 'state');
  const agyDir = path.join(tmp, 'agy-data');
  const repo = path.join(tmp, 'repos', 'app');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(agyDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });

  // Build a non-exec bash wrapper + agy.bin script matching Termux's ~/.local/bin/agy layout
  const bashBin = ['/data/data/com.termux/files/usr/bin/bash', '/bin/bash', '/bin/sh'].find((p) => fs.existsSync(p));
  const agyBin = path.join(tmp, 'agy.bin');
  fs.writeFileSync(agyBin, `#!${bashBin}\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`, { mode: 0o755 });
  const wrapper = path.join(tmp, 'agy-wrapper');
  fs.writeFileSync(
    wrapper,
    `#!${bashBin}\ntrap ':' EXIT HUP INT TERM\n"${agyBin}" "$@"\nexit $?\n`,
    { mode: 0o755 },
  );

  // Pre-seed a session that was persisted in 'working' state after queueing a user message into afterExit
  // while its keeper had already finished the previous turn (out ends with result, >10s ago).
  const stuckSid = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
  const sessDir = path.join(stateDir, 'sessions');
  const keepDir = path.join(stateDir, 'keepers', stuckSid);
  fs.mkdirSync(sessDir, { recursive: true });
  fs.mkdirSync(keepDir, { recursive: true });
  const oldTime = Date.now() - 30_000;
  const outContent = JSON.stringify({
    event: 'result',
    result: { conversation_id: 'conv-stuck-1', status: 'SUCCESS', response: 'Done earlier', duration_seconds: 1, num_turns: 1 },
  }) + '\n';
  const keeperJs = path.join(here, '..', 'keeper.mjs');
  execFileSync('mkfifo', ['-m', '600', path.join(keepDir, 'in')]);
  spawn(process.execPath, [keeperJs, keepDir, repo, wrapper, '-p=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'gemini-4-argon', '--effort', 'high'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, FAKE_AGY_STREAM: '1', CCM_AGY_DIR: agyDir },
  }).unref();
  for (let i = 0; i < 40 && (!fs.existsSync(path.join(keepDir, 'keeper.json')) || !fs.existsSync(path.join(keepDir, 'out')) || fs.statSync(path.join(keepDir, 'out')).size === 0); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  fs.appendFileSync(path.join(keepDir, 'out'), outContent);
  const finalOutSize = fs.statSync(path.join(keepDir, 'out')).size;
  fs.writeFileSync(path.join(keepDir, 'read'), String(finalOutSize));
  const oldDate = new Date(oldTime);
  fs.utimesSync(path.join(keepDir, 'out'), oldDate, oldDate);
  fs.writeFileSync(path.join(sessDir, `${stuckSid}.json`), JSON.stringify({
    id: stuckSid,
    cwd: repo,
    title: 'Stuck review session',
    model: 'gemini-4-argon',
    effort: 'medium',
    mode: 'bypassPermissions',
    status: 'working',
    createdAt: oldTime - 60_000,
    updatedAt: oldTime,
    lastActivity: 'Thinking',
    cliSessionId: 'conv-stuck-1',
    started: true,
  }));
  fs.writeFileSync(path.join(sessDir, `${stuckSid}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Review code' }, local: true }),
    JSON.stringify({ type: 'assistant', uuid: 'step-1', message: { role: 'assistant', model: 'gemini-4-argon', content: [{ type: 'text', text: 'Done earlier' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done earlier', duration_ms: 1000, num_turns: 1, total_cost_usd: 0 }),
    JSON.stringify({ type: 'bridge', subtype: 'note', message: 'Reasoning effort: medium' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Help me deploy everything on my phone.' }, local: true }),
  ].join('\n') + '\n');

  const port = await freePort();
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, {
    CCM_LEGACY_PROTO: '0',
    FAKE_AGY_STREAM: '1',
    CCM_AGY_DIR: agyDir,
    CCM_AGY_BIN: wrapper,
  });
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');
    const initialSessions = (await c.next((m) => m.ev === 'sessions')).sessions;

    // 1. Stuck working session with idle keeper is healed to 'idle' on bridge startup
    const healedStuck = initialSessions.find((s) => s.id === stuckSid);
    assert.ok(healedStuck);
    assert.equal(healedStuck.status, 'idle');

    // 2. Start a live session under the non-exec bash wrapper, change effort while idle, and send a follow-up prompt
    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'first turn', model: 'gemini-4-argon', effort: 'high' });
    const s1 = (await c.next((m) => m.ev === 'started' && m.ref === 1)).session;
    c.send({ op: 'subscribe', sid: s1.id });
    await c.next((m) => m.ev === 'session' && m.session.id === s1.id && m.session.status === 'idle');

    // Verify listProcesses classifies agy.bin under the wrapper as 'claude', not 'job'
    c.send({ op: 'processes', ref: 2 });
    const procs = (await c.next((m) => m.ev === 'processes' && m.ref === 2)).processes;
    const jobProcs = procs.filter((p) => p.sid === s1.id && p.role === 'job' && !p.detached);
    assert.equal(jobProcs.length, 0, `expected no non-detached job processes for idle wrapper session, got ${JSON.stringify(jobProcs)}`);

    // Change effort -> triggers restartProcessForNextTurn() against non-exec bash wrapper, then send prompt immediately
    c.send({ op: 'effort', sid: s1.id, effort: 'medium' });
    await c.next((m) => m.ev === 'cli' && m.sid === s1.id && m.msg.type === 'bridge' && /Reasoning effort: medium/.test(m.msg.message));
    c.send({ op: 'send', sid: s1.id, text: 'deploy everything' });
    const deployReply = await c.next((m) => m.ev === 'cli' && m.sid === s1.id && m.msg.type === 'assistant' && m.msg.message?.content?.some((b) => b.type === 'text' && b.text.includes('deploy everything')));
    assert.ok(deployReply);
    await c.next((m) => m.ev === 'session' && m.session.id === s1.id && m.session.status === 'idle');

    // 3. Pre-init failure recovery preserves initial unanswered user prompt when switching models
    c.send({ op: 'start', ref: 3, cwd: repo, prompt: 'Find the reason and fix related bugs.', model: 'gemini-4-hydrogen' });
    const s2 = (await c.next((m) => m.ev === 'started' && m.ref === 3)).session;
    c.send({ op: 'subscribe', sid: s2.id });
    await c.next((m) => m.ev === 'session' && m.session.id === s2.id && m.session.status === 'error');
    c.send({ op: 'model', sid: s2.id, model: 'gemini-4-argon' });
    c.send({ op: 'send', sid: s2.id, text: 'help please' });
    const recoveredReply = await c.next((m) => m.ev === 'cli' && m.sid === s2.id && m.msg.type === 'assistant' && m.msg.message?.content?.some((b) => b.type === 'text'));
    const replyText = recoveredReply.msg.message.content.find((b) => b.type === 'text').text;
    assert.match(replyText, /Find the reason and fix related bugs\./);
    assert.match(replyText, /help please/);

    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AGY 1.5.6 Google OAuth: id_token_email recognition, re-login isolation, auto-select, OSC-8 id link, and TUI exit', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-'));
  const stateDir = path.join(tmp, 'state');
  const agyDir = path.join(tmp, 'agy-data');
  const repo = path.join(tmp, 'repos', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(agyDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // Seed AGY 1.5.6 oauth-token schema (id_token_email without id_token JWT) + hybrid provider
  fs.writeFileSync(path.join(agyDir, 'antigravity-oauth-token'), JSON.stringify({
    token: {
      access_token: 'ya29.first',
      token_type: 'Bearer',
      refresh_token: '1//first',
      expiry: new Date(Date.now() + 3600_000).toISOString(),
      expires_in: 3599,
    },
    auth_method: 'consumer',
    id_token_email: 'first@example.com',
  }));
  fs.writeFileSync(path.join(stateDir, 'gemini-api-key'), 'AIzaSyTestHybrid999\n');
  fs.writeFileSync(path.join(stateDir, 'auth-provider'), 'hybrid\n');

  // Realistic AGY 1.5.6 interactive binary stub:
  // - If $HOME/.gemini/antigravity-cli/antigravity-oauth-token already exists, drops straight into idle TUI (`> `)
  // - Otherwise shows "Select login method:", waits for Enter, calls xdg-open + emits OSC-8 with id=... + wrapped URL,
  //   waits for auth code, writes new token to $HOME/.gemini/antigravity-cli/antigravity-oauth-token, and stays in TUI!
  const fakeAgyTui = path.join(tmp, 'fake-agy-tui.mjs');
  fs.writeFileSync(fakeAgyTui, `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const homeToken = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
if (process.argv.length === 2) {
  if (fs.existsSync(homeToken) || process.env.AGY_ADC_AUTH === '1') {
    process.stdout.write('Antigravity CLI 1.5.6\\r\\nalready-signed-in-or-adc\\r\\n> ');
    setInterval(() => {}, 10000);
  } else {
    process.stdout.write('Welcome to the Antigravity CLI.\\r\\nSelect login method:\\r\\n > 1. Google OAuth\\r\\n   2. Use a Google Cloud project\\r\\n');
    const rl = readline.createInterface({ input: process.stdin });
    let step = 0;
    rl.on('line', (line) => {
      if (step === 0) {
        step = 1;
        const fullUrl = 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-test.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=state_xyz_123';
        try { execFileSync('xdg-open', [fullUrl]); } catch {}
        process.stdout.write(
          'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591\\r\\n' +
          ' -test.apps.googleusercontent.com&state=state_xyz_123\\r\\n' +
          '\\x1b]8;id=jke22ab885;'+ fullUrl + '\\x07Click here to authenticate\\x1b]8;;\\x07\\r\\n' +
          'authorization code...'
        );
      } else if (step === 1) {
        step = 2;
        const user = line.trim();
        fs.mkdirSync(path.dirname(homeToken), { recursive: true });
        fs.writeFileSync(homeToken, JSON.stringify({
          token: { access_token: 'ya29.' + user, refresh_token: '1//' + user, token_type: 'Bearer' },
          auth_method: 'consumer',
          id_token_email: user + '@example.com',
        }));
        // Real agy stays open in the interactive TUI after login instead of exiting!
        process.stdout.write('\\r\\nAntigravity CLI 1.5.6\\r\\n' + user + '@example.com\\r\\n> ');
        setInterval(() => {}, 10000);
      }
    });
  }
} else {
  process.exit(0);
}
`, { mode: 0o755 });
  const sh = ['/bin/sh', '/system/bin/sh'].find((p) => fs.existsSync(p));
  const wrapper = path.join(tmp, 'agy-tui-wrap');
  fs.writeFileSync(wrapper, `#!${sh}\n"${process.execPath}" "${fakeAgyTui}" "$@"\n`, { mode: 0o755 });

  const port = await freePort();
  const proc = spawn(process.execPath, [bridgePath, '--port', String(port), '--roots', path.join(tmp, 'repos'), '--state-dir', stateDir], {
    env: {
      ...process.env,
      CCM_ROOT: '0',
      CCM_LEGACY_PROTO: '0',
      CCM_AGY_DIR: agyDir,
      CCM_AGY_BIN: wrapper,
      AGY_ADC_AUTH: '1', // verify login terminal strips ambient AGY_ADC_AUTH too
      CCM_TERM_SHELL: 'sh',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => proc.stdout.once('data', resolve));
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();

  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');

    // 1. Existing id_token_email is recognized in hybrid mode
    c.send({ op: 'auth', ref: 1 });
    const auth1 = (await c.next((m) => m.ev === 'auth' && m.ref === 1)).auth;
    assert.equal(auth1.loggedIn, true);
    assert.equal(auth1.provider, 'hybrid');
    assert.equal(auth1.authMethod, 'hybrid');
    assert.equal(auth1.email, 'first@example.com');

    // 2. Opening login while already signed in enters OAuth (auto-selects Google OAuth) & cancelling preserves first@example.com
    c.send({ op: 'term_open', ref: 2, cols: 42, rows: 31, kind: 'login', fresh: true });
    const t1 = await c.next((m) => m.ev === 'term_opened' && m.ref === 2);
    const link1 = await c.next((m) => m.ev === 'term_link' && m.id === t1.id);
    assert.equal(link1.local, false);
    assert.match(link1.url, /client_id=1071006060591-test\.apps\.googleusercontent\.com/);
    assert.match(link1.url, /state=state_xyz_123$/);

    c.send({ op: 'term_close', id: t1.id });
    await c.next((m) => m.ev === 'term_exit' && m.id === t1.id);

    c.send({ op: 'auth', ref: 3 });
    const authAfterCancel = (await c.next((m) => m.ev === 'auth' && m.ref === 3)).auth;
    assert.equal(authAfterCancel.email, 'first@example.com');

    // 3. Completing login promotes new token and auto-exits the TUI with code 0
    c.send({ op: 'term_open', ref: 4, cols: 42, rows: 31, kind: 'login', fresh: true });
    const t2 = await c.next((m) => m.ev === 'term_opened' && m.ref === 4);
    await c.next((m) => m.ev === 'term_link' && m.id === t2.id);
    c.send({ op: 'term_input', id: t2.id, data: Buffer.from('second\r').toString('base64') });
    const exitEv = await c.next((m) => m.ev === 'term_exit' && m.id === t2.id, 8000);
    assert.equal(exitEv.code, 0);

    c.send({ op: 'auth', ref: 5 });
    const authAfterSwitch = (await c.next((m) => m.ev === 'auth' && m.ref === 5)).auth;
    assert.equal(authAfterSwitch.loggedIn, true);
    assert.equal(authAfterSwitch.email, 'second@example.com');

    c.end();
  } finally {
    await stopAll(proc, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('background task completion recovers reliably from Doze/HTTP2 wakeup failures, bogus trailing SUCCESS results, and stalled HTTP2 dials', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-bg-wakeup-'));
  const stateDir = path.join(tmp, 'state');
  const agyDir = path.join(tmp, 'agy-data');
  const repo = path.join(tmp, 'repos', 'video');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(agyDir, { recursive: true });
  fs.writeFileSync(path.join(agyDir, 'antigravity-oauth-token'), JSON.stringify({
    token: { access_token: 'ya29.sub', refresh_token: '1//sub' },
    auth_method: 'consumer',
    id_token_email: 'sub@example.com',
  }));

  const port = await freePort();
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, {
    CCM_LEGACY_PROTO: '0',
    FAKE_AGY_STREAM: '1',
    CCM_AGY_DIR: agyDir,
    CCM_WAKEUP_RETRY_MS: '350',
    CCM_UNHANDLED_WAKEUP_STALL_MS: '350',
  });
  const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  try {
    const c = connect(port);
    c.send({ op: 'hello', token });
    await c.next((m) => m.ev === 'hello');

    // Scenario A: Background YouTube download finishes while network is offline (Doze), AGY emits
    // ERROR result + bogus outer SUCCESS result 8ms later, retry #1 hits offline network too, then
    // network recovers and AGY continues automatically without ever dropping to idle/error or duplicating stale text.
    fs.writeFileSync(path.join(agyDir, 'fake-net-offline'), '1');
    c.send({ op: 'start', ref: 1, cwd: repo, prompt: 'bg-wakeup-drop', model: 'gemini-4-hydrogen' });
    const s1 = (await c.next((m) => m.ev === 'started' && m.ref === 1)).session;

    const reconnNote = await c.next((m) => m.ev === 'cli' && m.sid === s1.id && m.msg.type === 'bridge' && m.msg.subtype === 'note' && m.msg.message.includes('waking AGY to continue'));
    assert.ok(reconnNote);

    // Let at least one retry fail while fake-net-offline is still present, then restore network
    await new Promise((r) => setTimeout(r, 550));
    fs.rmSync(path.join(agyDir, 'fake-net-offline'), { force: true });

    const analyzedReply = await c.next((m) => m.ev === 'cli' && m.sid === s1.id && m.msg.type === 'assistant' && m.msg.message?.content?.some((b) => b.type === 'text' && b.text.includes('Analyzed downloaded Veritasium videos')));
    assert.ok(analyzedReply);
    const s1Idle = (await c.next((m) => m.ev === 'session' && m.session.id === s1.id && m.session.status === 'idle')).session;
    assert.equal(s1Idle.status, 'idle');

    // Verify the bogus trailing SUCCESS result never duplicated the interim "Downloading excerpts..." assistant message
    const logLines = fs.readFileSync(path.join(stateDir, 'sessions', `${s1.id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const interimMsgs = logLines.filter((e) => e.type === 'assistant' && e.message?.content?.some((b) => b.type === 'text' && b.text.includes('Downloading excerpts')));
    assert.equal(interimMsgs.length, 1, `expected exactly 1 interim message, got ${interimMsgs.length}`);

    // Scenario B: Background task finishes (SYSTEM_MESSAGE + ERROR_MESSAGE in transcript.jsonl) and AGY
    // hangs silently on a wedged HTTP/2 socket without emitting result -> checkStuckTools() detects and wakes AGY!
    c.send({ op: 'start', ref: 2, cwd: repo, prompt: 'bg-wakeup-stall', model: 'gemini-4-hydrogen' });
    const s2 = (await c.next((m) => m.ev === 'started' && m.ref === 2)).session;
    const s2Analyzed = await c.next((m) => m.ev === 'cli' && m.sid === s2.id && m.msg.type === 'assistant' && m.msg.message?.content?.some((b) => b.type === 'text' && b.text.includes('Analyzed downloaded Veritasium videos')), 8000);
    assert.ok(s2Analyzed);
    const s2Idle = (await c.next((m) => m.ev === 'session' && m.session.id === s2.id && m.session.status === 'idle')).session;
    assert.equal(s2Idle.status, 'idle');

    c.end();
  } finally {
    await stopAll(bridge, stateDir);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
