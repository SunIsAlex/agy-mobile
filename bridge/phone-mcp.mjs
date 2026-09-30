// phone-mcp: an MCP server (stdio, JSON-RPC 2.0) that lets Claude operate the Android phone it runs on.
// Every action is a root shell command (`su -c ...`): screencap, uiautomator, input, am, pm.
// ccm-bridge passes it to `claude --mcp-config` for tasks started with "Phone" on.

import { execFile } from 'node:child_process';
import readline from 'node:readline';

const SU = process.env.CCM_SU ?? 'su';
const UI_DUMP = '/data/local/tmp/ccm-ui.xml';

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function sh(cmd, { binary = false, timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(SU, ['-c', cmd], { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 32 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd.split(' ')[0]} failed: ${String(stderr).trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

let screenSize;
async function getScreenSize() {
  if (!screenSize) {
    const out = await sh('wm size');
    const m = out.match(/Override size: (\d+)x(\d+)/) ?? out.match(/Physical size: (\d+)x(\d+)/);
    screenSize = m ? { w: +m[1], h: +m[2] } : { w: 0, h: 0 };
  }
  return screenSize;
}

async function foregroundApp() {
  const out = await sh('dumpsys window | grep mCurrentFocus').catch(() => '');
  return out.match(/ ([\w.]+\/[\w.$]+)\}/)?.[1] ?? out.match(/ ([\w.]+)\}/)?.[1] ?? 'unknown';
}

// ---------- UI hierarchy ----------

const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (_, e) =>
  ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e] ?? String.fromCharCode(Number(e.slice(1))));

export function parseUi(xml) {
  const nodes = [];
  for (const [, attrs] of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const n = {};
    for (const [, k, v] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) n[k] = decode(v);
    const b = n.bounds?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    if (x2 <= x1 || y2 <= y1) continue;
    const label = (n.text || n['content-desc'] || '').trim();
    const editable = /EditText/.test(n.class ?? '');
    const flag = (k) => n[k] === 'true';
    if (!label && !flag('clickable') && !flag('scrollable') && !flag('checkable') && !editable) continue;
    nodes.push({
      label, editable, box: [x1, y1, x2, y2],
      cls: (n.class ?? '').split('.').pop(),
      id: (n['resource-id'] ?? '').replace(/^.*:id\//, ''),
      x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2),
      clickable: flag('clickable'), longClickable: flag('long-clickable'), scrollable: flag('scrollable'),
      checkable: flag('checkable'), checked: flag('checked'), enabled: n.enabled !== 'false',
      focused: flag('focused'), selected: flag('selected'),
    });
  }
  // Compose and many views put the label on a child of the clickable container; lend it to the container.
  for (const n of nodes) {
    if (n.label || !(n.clickable || n.editable)) continue;
    const inner = nodes.filter((m) => m !== n && m.label && m.box[0] >= n.box[0] && m.box[1] >= n.box[1] && m.box[2] <= n.box[2] && m.box[3] <= n.box[3]);
    n.label = inner.slice(0, 3).map((m) => m.label).join(' · ');
  }
  return nodes;
}

function describe(n, i) {
  const parts = [`[${i}]`, n.cls];
  if (n.label) parts.push(JSON.stringify(n.label.length > 80 ? n.label.slice(0, 79) + '…' : n.label));
  if (n.id) parts.push(`id=${n.id}`);
  parts.push(`at (${n.x},${n.y})`);
  for (const f of ['clickable', 'scrollable', 'editable', 'focused', 'selected']) if (n[f]) parts.push(f);
  if (n.checkable) parts.push(n.checked ? 'checked' : 'unchecked');
  if (!n.enabled) parts.push('disabled');
  return parts.join(' ');
}

let lastElements = [];
async function dumpUi() {
  let xml = '';
  for (let attempt = 0; attempt < 2 && !xml.includes('<node'); attempt++) {
    xml = await sh(`uiautomator dump ${UI_DUMP} >/dev/null 2>&1; cat ${UI_DUMP}; rm -f ${UI_DUMP}`, { timeout: 30_000 }).catch(() => '');
  }
  if (!xml.includes('<node')) throw new Error('Could not read the screen layout (the screen may be off, or animating). Try again, or take a screenshot.');
  lastElements = parseUi(xml);
  return lastElements;
}

/** Finds the element to act on: [index] from the last listing, or text/description/id match on a fresh dump. */
async function findTarget({ index, text }) {
  if (index !== undefined) {
    const n = lastElements[index];
    if (!n) throw new Error(`No element [${index}] in the last screen_elements listing; list them again.`);
    return n;
  }
  const want = String(text).toLowerCase();
  const nodes = await dumpUi();
  const score = (n) => {
    const l = n.label.toLowerCase();
    if (l === want || n.id.toLowerCase() === want) return 3;
    if (l.includes(want)) return 2;
    if (n.id.toLowerCase().includes(want)) return 1;
    return 0;
  };
  const best = nodes.map((n) => [score(n) + (n.clickable ? 0.5 : 0), n]).filter(([s]) => s >= 1).sort((a, b) => b[0] - a[0]);
  if (!best.length) throw new Error(`Nothing on screen matches "${text}". Use screen_elements to see what's there.`);
  return best[0][1];
}

async function point(args) {
  if (args.x !== undefined && args.y !== undefined) return { x: Math.round(args.x), y: Math.round(args.y), what: `(${Math.round(args.x)},${Math.round(args.y)})` };
  if (args.index === undefined && args.text === undefined) throw new Error('Give x and y, an element index, or text to match.');
  const n = await findTarget(args);
  return { x: n.x, y: n.y, what: `${n.cls}${n.label ? ` "${n.label}"` : ''} at (${n.x},${n.y})` };
}

// ---------- tools ----------

const target = {
  x: { type: 'number', description: 'Screen x in pixels' },
  y: { type: 'number', description: 'Screen y in pixels' },
  index: { type: 'integer', description: 'Element number from the last screen_elements listing' },
  text: { type: 'string', description: 'Visible text, content description or resource id of the element (a fresh match is made)' },
};

const KEYS = ['HOME', 'BACK', 'APP_SWITCH', 'ENTER', 'DEL', 'TAB', 'ESCAPE', 'SEARCH', 'MENU', 'POWER', 'WAKEUP', 'SLEEP',
  'VOLUME_UP', 'VOLUME_DOWN', 'VOLUME_MUTE', 'MEDIA_PLAY_PAUSE', 'MEDIA_NEXT', 'MEDIA_PREVIOUS', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT', 'CAMERA'];

const text = (t) => ({ content: [{ type: 'text', text: t }] });

export const tools = {
  screenshot: {
    description: 'Capture the phone screen as an image. Prefer screen_elements for finding things to tap; use this to check visual state.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const [png, { w, h }, app] = await Promise.all([sh('screencap -p', { binary: true }), getScreenSize(), foregroundApp()]);
      if (!png.length) throw new Error('screencap returned nothing (is the screen off? press WAKEUP).');
      return { content: [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: `Screen ${w}×${h} px; foreground: ${app}. tap/swipe take coordinates in these screen pixels.` },
      ] };
    },
  },
  screen_elements: {
    description: 'List the visible UI elements (text, id, centre coordinates, flags) of the foreground app, from the accessibility tree. Numbers can be passed to tap as index.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const [nodes, { w, h }, app] = await Promise.all([dumpUi(), getScreenSize(), foregroundApp()]);
      const lines = nodes.map(describe);
      return text(`Foreground: ${app}; screen ${w}×${h} px\n${lines.join('\n') || '(no labelled or interactive elements; try a screenshot)'}`);
    },
  },
  tap: {
    description: 'Tap an element (by index or text) or a screen point.',
    inputSchema: { type: 'object', properties: target },
    async run(args) {
      const p = await point(args);
      await sh(`input tap ${p.x} ${p.y}`);
      return text(`Tapped ${p.what}`);
    },
  },
  long_press: {
    description: 'Long-press an element (by index or text) or a screen point.',
    inputSchema: { type: 'object', properties: { ...target, duration_ms: { type: 'integer', default: 800 } } },
    async run(args) {
      const p = await point(args);
      await sh(`input swipe ${p.x} ${p.y} ${p.x} ${p.y} ${Math.round(args.duration_ms ?? 800)}`);
      return text(`Long-pressed ${p.what}`);
    },
  },
  swipe: {
    description: 'Swipe between two points, or scroll the screen with direction (up = reveal content below).',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction; used when x1..y2 are not given' },
        x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
        duration_ms: { type: 'integer', default: 300 },
      },
    },
    async run(args) {
      let { x1, y1, x2, y2 } = args;
      if ([x1, y1, x2, y2].some((v) => v === undefined)) {
        const { w, h } = await getScreenSize();
        const d = { up: [0.5, 0.75, 0.5, 0.25], down: [0.5, 0.25, 0.5, 0.75], left: [0.85, 0.5, 0.15, 0.5], right: [0.15, 0.5, 0.85, 0.5] }[args.direction];
        if (!d) throw new Error('Give x1, y1, x2, y2 or a direction.');
        [x1, y1, x2, y2] = [d[0] * w, d[1] * h, d[2] * w, d[3] * h];
      }
      const c = [x1, y1, x2, y2].map(Math.round);
      await sh(`input swipe ${c.join(' ')} ${Math.round(args.duration_ms ?? 300)}`);
      return text(`Swiped (${c[0]},${c[1]}) → (${c[2]},${c[3]})`);
    },
  },
  type_text: {
    description: 'Type text into the focused field (tap the field first). ASCII only: Android\'s input command cannot type other characters. submit presses Enter afterwards.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, submit: { type: 'boolean', default: false } }, required: ['text'] },
    async run({ text: t, submit }) {
      if (/[^\x20-\x7e\n]/.test(t)) throw new Error('Only printable ASCII can be typed. For other text, ask the user, or put it in the app another way (e.g. a share intent with open_uri).');
      const lines = String(t).split('\n');
      for (const [i, line] of lines.entries()) {
        if (line) await sh(`input text ${q(line.replace(/ /g, '%s'))}`);
        if (i < lines.length - 1) await sh('input keyevent KEYCODE_ENTER');
      }
      if (submit) await sh('input keyevent KEYCODE_ENTER');
      return text(`Typed ${t.length} characters${submit ? ' and pressed Enter' : ''}`);
    },
  },
  key: {
    description: `Press a key: ${KEYS.join(', ')}, or any KEYCODE_* name. NOTIFICATIONS / QUICK_SETTINGS open those panels.`,
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    async run({ key }) {
      const k = String(key).toUpperCase().replace(/^KEYCODE_/, '');
      if (k === 'NOTIFICATIONS') await sh('cmd statusbar expand-notifications');
      else if (k === 'QUICK_SETTINGS') await sh('cmd statusbar expand-settings');
      else if (/^[A-Z0-9_]+$/.test(k)) await sh(`input keyevent KEYCODE_${k}`);
      else throw new Error(`Unknown key: ${key}`);
      return text(`Pressed ${k}`);
    },
  },
  list_apps: {
    description: 'List installed app package names, optionally filtered by a substring (e.g. "clock", "maps").',
    inputSchema: { type: 'object', properties: { filter: { type: 'string' }, include_system: { type: 'boolean', default: false } } },
    async run({ filter, include_system }) {
      const out = await sh(`pm list packages ${include_system || filter ? '' : '-3'}`);
      const pkgs = out.split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean)
        .filter((p) => !filter || p.toLowerCase().includes(String(filter).toLowerCase())).sort();
      return text(pkgs.join('\n') || 'No matching packages');
    },
  },
  open_app: {
    description: 'Launch an app by package name (see list_apps).',
    inputSchema: { type: 'object', properties: { package: { type: 'string' } }, required: ['package'] },
    async run({ package: pkg }) {
      if (!/^[\w.]+$/.test(pkg)) throw new Error(`Not a package name: ${pkg}`);
      const out = await sh(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 2>&1`);
      if (/No activities found|monkey aborted/i.test(out)) throw new Error(`${pkg} has no launcher activity (or isn't installed).`);
      return text(`Opened ${pkg}`);
    },
  },
  open_uri: {
    description: 'Open a URI with its default handler: https:// pages, geo:0,0?q=place, tel:, mailto:, sms:, market://, app deep links.',
    inputSchema: { type: 'object', properties: { uri: { type: 'string' }, package: { type: 'string', description: 'Optional app to open it in' } }, required: ['uri'] },
    async run({ uri, package: pkg }) {
      const out = await sh(`am start -a android.intent.action.VIEW -d ${q(uri)}${pkg ? ` -p ${q(pkg)}` : ''} 2>&1`);
      if (/Error:/.test(out)) throw new Error(out.trim());
      return text(`Opened ${uri}`);
    },
  },
  set_alarm: {
    description: 'Create an alarm in the default clock app (AlarmClock.ACTION_SET_ALARM). days uses 1=Sunday … 7=Saturday for repeating alarms.',
    inputSchema: {
      type: 'object',
      properties: {
        hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59 },
        label: { type: 'string' }, days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 } },
        vibrate: { type: 'boolean' }, skip_ui: { type: 'boolean', default: true, description: 'Create it without showing the clock app' },
      },
      required: ['hour', 'minute'],
    },
    async run({ hour, minute, label, days, vibrate, skip_ui = true }) {
      const extras = [`--ei android.intent.extra.alarm.HOUR ${hour | 0}`, `--ei android.intent.extra.alarm.MINUTES ${minute | 0}`, `--ez android.intent.extra.alarm.SKIP_UI ${!!skip_ui}`];
      if (label) extras.push(`--es android.intent.extra.alarm.MESSAGE ${q(label)}`);
      if (days?.length) extras.push(`--eial android.intent.extra.alarm.DAYS ${days.map((d) => d | 0).join(',')}`);
      if (vibrate !== undefined) extras.push(`--ez android.intent.extra.alarm.VIBRATE ${!!vibrate}`);
      const out = await sh(`am start -a android.intent.action.SET_ALARM ${extras.join(' ')} 2>&1`);
      if (/Error:/.test(out)) throw new Error(out.trim());
      const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      return text(`Asked the clock app to set an alarm for ${hhmm}${label ? ` (${label})` : ''}${days?.length ? ` on days ${days.join(',')}` : ''}. Check with a screenshot or screen_elements if it needs confirming.`);
    },
  },
  set_timer: {
    description: 'Start a countdown timer in the default clock app (AlarmClock.ACTION_SET_TIMER).',
    inputSchema: { type: 'object', properties: { seconds: { type: 'integer', minimum: 1 }, label: { type: 'string' }, skip_ui: { type: 'boolean', default: true } }, required: ['seconds'] },
    async run({ seconds, label, skip_ui = true }) {
      const extras = [`--ei android.intent.extra.alarm.LENGTH ${seconds | 0}`, `--ez android.intent.extra.alarm.SKIP_UI ${!!skip_ui}`];
      if (label) extras.push(`--es android.intent.extra.alarm.MESSAGE ${q(label)}`);
      const out = await sh(`am start -a android.intent.action.SET_TIMER ${extras.join(' ')} 2>&1`);
      if (/Error:/.test(out)) throw new Error(out.trim());
      return text(`Started a ${seconds}s timer${label ? ` (${label})` : ''}`);
    },
  },
};

/** Tools that only look at the phone; the bridge lets these run without asking. */
export const READ_ONLY = ['screenshot', 'screen_elements', 'list_apps'];

// ---------- JSON-RPC over stdio ----------

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function fail(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

async function onMessage(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled)
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'phone', version: '1.0.0' },
      });
    case 'ping': return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call': {
      const tool = tools[params?.name];
      if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
      try { return reply(id, await tool.run(params.arguments ?? {})); }
      catch (e) { return reply(id, { ...text(String(e?.message ?? e)), isError: true }); }
    }
    default: return fail(id, -32601, `Method not found: ${method}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const inflight = new Set();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
    const p = onMessage(msg).catch((e) => fail(msg.id ?? null, -32603, String(e?.message ?? e)));
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  });
  rl.on('close', () => Promise.allSettled([...inflight]).then(() => process.exit(0)));
}
