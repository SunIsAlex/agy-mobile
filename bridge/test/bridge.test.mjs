// End-to-end test of ccm-bridge against fake-claude. Run: node --test bridge/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(here, '..', 'ccm-bridge.mjs');
const fakeClaude = path.join(here, 'fake-claude.mjs');

// A wrapper script, because shebangs like /usr/bin/env don't exist everywhere (e.g. Termux).
function fakeClaudeWrapper(dir) {
  const sh = ['/bin/sh', '/system/bin/sh'].find((p) => fs.existsSync(p));
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!${sh}\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`, { mode: 0o755 });
  return file;
}

function startBridge(stateDir, repoRoot, port, env = {}) {
  const proc = spawn(process.execPath, [bridgePath, '--port', String(port), '--roots', repoRoot, '--state-dir', stateDir], {
    env: { ...process.env, CCM_ROOT: '0', ...env, CCM_CLAUDE_BIN: fakeClaudeWrapper(path.dirname(stateDir)), CLAUDE_CONFIG_DIR: path.join(path.dirname(stateDir), 'claude-config') },
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

    c.send({ op: 'start', ref: 2, cwd: repo, prompt: 'fix the bug' });
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

    // Sending continues the same Claude Code session with --resume.
    c.send({ op: 'send', sid: id, text: 'thanks' });
    const init = await c.next((m) => m.ev === 'cli' && m.msg.type === 'system' && m.msg.subtype === 'init');
    assert.equal(init.msg.session_id, id);
    await c.next((m) => m.ev === 'approval');

    c.send({ op: 'resume', ref: 4, id: 'no-such-session' });
    assert.match((await c.next((m) => m.ev === 'error' && m.ref === 4)).message, /No Claude Code session/);
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
    assert.match(reply, /^Looking at: what is this\?\n\nAttached files.*\n- .*shot\.png \(image\/png, 9 B, image included below\)\n- .*notes\.txt.* \[image image\/png\]$/s);
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
    assert.match(note.msg.message, /Background work stopped with Claude's process: Encode the film/);
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
  const bridge = await startBridge(stateDir, path.join(tmp, 'repos'), port, { CCM_PORTS_CHECK_MS: '200' });
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
