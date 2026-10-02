#!/usr/bin/env node
// Restarts a running ccm-bridge once none of its tasks is working or waiting for approval, so a
// task that asked for the restart (e.g. Claude shipping a bridge change) can finish its reply.
// Keeps the old bridge's arguments (minus --pair), environment and folder; logs to bridge.log.
//
//   setsid nohup node bridge/restart-when-idle.mjs <bridge pid> >/dev/null 2>&1 </dev/null &
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const pid = Number(process.argv[2]);
if (!pid) { console.error('Usage: restart-when-idle.mjs <bridge pid>'); process.exit(2); }
const proc = (file) => fs.readFileSync(`/proc/${pid}/${file}`, 'utf8').split('\0').filter(Boolean);
const [node, ...args] = proc('cmdline');
const env = Object.fromEntries(proc('environ').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
const i = args.indexOf('--state-dir');
const state = i >= 0 ? path.resolve(cwd, args[i + 1]) : path.join(env.XDG_STATE_HOME ?? path.join(env.HOME, '.local', 'state'), 'ccm-bridge');

const log = fs.openSync(path.join(state, 'bridge.log'), 'a');
const say = (m) => fs.writeSync(log, `[restart ${new Date().toISOString()}] ${m}\n`);
const busy = () => fs.readdirSync(path.join(state, 'sessions')).filter((f) => f.endsWith('.json')).some((f) => {
  try { return ['working', 'needs_approval'].includes(JSON.parse(fs.readFileSync(path.join(state, 'sessions', f), 'utf8')).status); } catch { return false; }
});
const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(5000);
while (busy()) await sleep(3000);
say(`all tasks idle; stopping bridge ${pid}`);
process.kill(pid, 'SIGTERM');
while (alive()) await sleep(500);
const child = spawn(node, args.filter((a) => a !== '--pair'), { cwd, env, detached: true, stdio: ['ignore', log, log] });
child.unref();
say(`started bridge ${child.pid}: ${args.filter((a) => a !== '--pair').join(' ')}`);
