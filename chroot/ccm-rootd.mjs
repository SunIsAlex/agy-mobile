// ccm-rootd: runs commands as root on Android for the chroot's `su` (chroot/su). ccm-chroot starts
// it as root inside the chroot (Debian's node only runs there), in init's mount namespace; each
// command leaves the chroot through /proc/1/root, so it sees the real Android system: pm, am, cmd,
// settings, dumpsys, screencap and input work as from Termux's `su -c`.
//
//   node ccm-rootd.mjs <socket> <rootfs as Android sees it> <termux home> <uid>
//
// Only <uid> (the chroot's claude user, which is Termux's uid) can open the socket. Protocol: the
// client sends one JSON line {cmd, cwd} (cmd null for a shell reading stdin), then its stdin until
// it half-closes. The server answers with frames [type:1][length:4, big-endian][payload]:
// 1 stdout, 2 stderr, 3 exit ({code, signal} as JSON).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const [sock, rootfs, termuxHome, uid] = process.argv.slice(2);

// Android's own environment (boot class path and so on, which pm and am need), from zygote.
function androidEnv() {
  const env = {
    PATH: '/product/bin:/apex/com.android.runtime/bin:/apex/com.android.art/bin:/system_ext/bin:/system/bin:/system/xbin:/odm/bin:/vendor/bin:/vendor/xbin',
    ANDROID_ROOT: '/system', ANDROID_DATA: '/data', ANDROID_STORAGE: '/storage', EXTERNAL_STORAGE: '/sdcard',
  };
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      if (!/^zygote(64)?$/.test(fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim())) continue;
      for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
        const i = kv.indexOf('=');
        if (i > 0 && !kv.startsWith('ANDROID_SOCKET_')) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      break;
    } catch {}
  }
  return { ...env, HOME: '/data/local/tmp', TMPDIR: '/data/local/tmp', CCM_ROOTFS: rootfs };
}
const env = androidEnv();

/** The chroot's working directory as Android sees it: the Termux home is the same, the rest is under the rootfs. */
function hostPath(p) {
  if (!p || !path.isAbsolute(p)) return '/';
  return p === termuxHome || p.startsWith(termuxHome + '/') ? p : path.join(rootfs, p);
}

/** Runs [args] for /system/bin/sh as root in Android itself, starting in [cwd] if it exists there. */
function androidShell(cwd, args) {
  return spawn('/usr/sbin/chroot', ['/proc/1/root', '/system/bin/sh', '-c', 'cd "$1" 2>/dev/null || cd /; shift; exec /system/bin/sh "$@"', 'sh', cwd, ...args],
    { env, stdio: ['pipe', 'pipe', 'pipe'] });
}

function frame(type, data) {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(data.length, 1);
  return Buffer.concat([head, data]);
}

// Half-open: the client ends its side when its stdin ends, and still needs the output and exit status.
const server = net.createServer({ allowHalfOpen: true }, (c) => {
  let header = Buffer.alloc(0);
  let child = null;
  c.on('error', () => {});
  c.on('data', (chunk) => {
    if (child) { child.stdin.write(chunk); return; }
    header = Buffer.concat([header, chunk]);
    const nl = header.indexOf(10);
    if (nl < 0) return;
    let req;
    try { req = JSON.parse(header.subarray(0, nl).toString('utf8')); } catch { c.destroy(); return; }
    const rest = header.subarray(nl + 1);
    child = androidShell(hostPath(req.cwd), typeof req.cmd === 'string' ? ['-c', req.cmd] : []);
    child.stdin.on('error', () => {});
    if (rest.length) child.stdin.write(rest);
    if (c.readableEnded) child.stdin.end();
    child.stdout.on('data', (d) => c.write(frame(1, d)));
    child.stderr.on('data', (d) => c.write(frame(2, d)));
    child.on('error', (e) => { c.write(frame(2, Buffer.from(`su: ${e.message}\n`))); c.end(frame(3, Buffer.from('{"code":127}'))); });
    child.on('close', (code, signal) => c.end(frame(3, Buffer.from(JSON.stringify({ code, signal })))));
  });
  c.on('end', () => child?.stdin.end());
  // The caller went away (e.g. Claude interrupted): don't leave its command running.
  c.on('close', () => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
});

fs.rmSync(sock, { force: true });
server.listen(sock, () => {
  fs.chownSync(sock, Number(uid), Number(uid));
  fs.chmodSync(sock, 0o600);
  console.log(`ccm-rootd listening on ${sock}`);
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { fs.rmSync(sock, { force: true }); process.exit(0); });
