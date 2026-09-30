// Tests phone-mcp.mjs over stdio with a fake `su` that logs commands and returns canned output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const UI = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.deskclock" clickable="false" enabled="true" bounds="[0,0][1000,2000]">
<node index="0" text="" resource-id="com.android.deskclock:id/fab" class="android.view.View" clickable="true" enabled="true" bounds="[400,1700][600,1900]">
<node index="0" text="" content-desc="Add alarm" class="android.widget.ImageView" clickable="false" enabled="true" bounds="[450,1750][550,1850]" /></node>
<node index="1" text="7:30 AM &amp; later" class="android.widget.TextView" clickable="false" enabled="true" bounds="[0,100][500,200]" />
<node index="2" text="" class="android.widget.Switch" checkable="true" checked="true" clickable="true" enabled="true" bounds="[800,100][1000,200]" />
<node index="3" text="" class="android.widget.FrameLayout" clickable="false" enabled="true" bounds="[0,300][1000,400]" />
</node></hierarchy>`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-'));
  const sh = ['/bin/sh', '/system/bin/sh'].find((p) => fs.existsSync(p));
  fs.writeFileSync(path.join(dir, 'ui.xml'), UI);
  const su = path.join(dir, 'su');
  fs.writeFileSync(su, `#!${sh}
printf '%s\\n' "$2" >> "${dir}/log"
case "$2" in
  "wm size") echo "Physical size: 1000x2000" ;;
  *uiautomator*) cat "${dir}/ui.xml" ;;
  *"dumpsys window"*) echo "  mCurrentFocus=Window{1a2b u0 com.android.deskclock/com.android.deskclock.DeskClock}" ;;
  *) ;;
esac
`, { mode: 0o755 });
  const proc = spawn(process.execPath, [path.join(here, '..', 'phone-mcp.mjs')], { env: { ...process.env, CCM_SU: su }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  readline.createInterface({ input: proc.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    waiting.set(++id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => (await call('tools/call', { name, arguments: args })).result;
  const log = () => fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n');
  return { call, tool, log, done: () => { proc.stdin.end(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('phone MCP server lists tools and turns calls into root shell commands', async () => {
  const { call, tool, log, done } = setup();
  try {
    assert.equal((await call('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'phone');
    const names = (await call('tools/list')).result.tools.map((t) => t.name);
    assert.ok(names.includes('set_alarm') && names.includes('screen_elements'));

    const listing = (await tool('screen_elements')).content[0].text;
    assert.equal(listing, [
      'Foreground: com.android.deskclock/com.android.deskclock.DeskClock; screen 1000×2000 px',
      '[0] View "Add alarm" id=fab at (500,1800) clickable',
      '[1] ImageView "Add alarm" at (500,1800)',
      '[2] TextView "7:30 AM & later" at (250,150)',
      '[3] Switch at (900,150) clickable checked',
    ].join('\n'));

    assert.equal((await tool('tap', { text: 'add alarm' })).content[0].text, 'Tapped View "Add alarm" at (500,1800)');
    assert.equal((await tool('tap', { index: 3 })).content[0].text, 'Tapped Switch at (900,150)');
    await tool('swipe', { direction: 'up' });
    await tool('type_text', { text: "it's 5 o'clock", submit: true });
    assert.equal((await tool('type_text', { text: 'café' })).isError, true);
    assert.equal((await tool('tap', { text: 'nothing like this' })).isError, true);
    await tool('set_alarm', { hour: 7, minute: 5, label: "Mum's call", days: [2, 3] });
    await tool('key', { key: 'back' });

    const cmds = log().filter((c) => c.startsWith('input') || c.startsWith('am'));
    assert.deepEqual(cmds, [
      'input tap 500 1800',
      'input tap 900 150',
      'input swipe 500 1500 500 500 300',
      "input text 'it'\\''s%s5%so'\\''clock'",
      'input keyevent KEYCODE_ENTER',
      "am start -a android.intent.action.SET_ALARM --ei android.intent.extra.alarm.HOUR 7 --ei android.intent.extra.alarm.MINUTES 5 --ez android.intent.extra.alarm.SKIP_UI true --es android.intent.extra.alarm.MESSAGE 'Mum'\\''s call' --eial android.intent.extra.alarm.DAYS 2,3 2>&1",
      'input keyevent KEYCODE_BACK',
    ]);
  } finally {
    done();
  }
});
