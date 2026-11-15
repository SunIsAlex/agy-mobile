#!/usr/bin/env node
// Keeps one Claude Code process running independently of ccm-bridge, so restarting the bridge
// doesn't stop a task or the background jobs Claude started. The bridge starts it detached and
// talks to it through files in its folder:
//
//   in           named pipe; bytes written to it go to claude's stdin
//   out          claude's stdout, appended; the bridge reads it from an offset (see KeeperLink)
//   err          claude's stderr
//   keeper.json  {pid, claudePid, startedAt}
//   exit.json    {code, signal}, written once claude has exited and `out` is complete
//
//   keeper.mjs <dir> <cwd> <command> [args...]     (SIGTERM is passed on to claude)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const [dir, cwd, command, ...args] = process.argv.slice(2);
const file = (name) => path.join(dir, name);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
if (!fs.existsSync(file('in'))) execFileSync('mkfifo', ['-m', '600', file('in')]);
const out = fs.createWriteStream(file('out'), { flags: 'a', mode: 0o600 });
const err = fs.createWriteStream(file('err'), { flags: 'a', mode: 0o600 });

let done = false;
function finish(code, signal) {
  if (done) return;
  done = true;
  out.end(() => {
    fs.writeFileSync(file('exit.json'), JSON.stringify({ code, signal }));
    fs.rmSync(file('in'), { force: true });
    process.exit(0);
  });
}

const child = spawn(command, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
child.on('error', (e) => { err.write(`Could not start ${command}: ${e.message}\n`); finish(127, null); });
// 'close' comes after stdout has ended, so `out` is complete when exit.json appears.
child.on('close', (code, signal) => finish(code, signal));
fs.writeFileSync(file('keeper.json'), JSON.stringify({ pid: process.pid, claudePid: child.pid, startedAt: Date.now() }));

// Opened read-write so the pipe never reads as ended when a bridge closes its end, and
// non-blocking through a socket: a blocking read would hold a thread that keeps Node from exiting.
const input = fs.openSync(file('in'), fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
const inputSocket = new net.Socket({ fd: input, readable: true, writable: false });
inputSocket.pipe(child.stdin);
inputSocket.on('error', () => {});
child.stdin.on('error', () => {});
child.stdout.pipe(out, { end: false });
child.stderr.pipe(err);

let shuttingDown = false;
function stopChild() {
  if (shuttingDown || done) return;
  shuttingDown = true;
  try { inputSocket.destroy(); } catch {}
  try { child.stdin.end(); } catch {}
  // Signal the child's whole process group so wrapper scripts (e.g. ~/.local/bin/agy bash -> agy.bin)
  // terminate immediately instead of bash deferring SIGTERM while waiting on agy.bin.
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  }
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    if (done) return;
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    try { child.kill('SIGKILL'); } catch {}
  }, 3000).unref();
}

process.on('SIGHUP', () => {});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, stopChild);
