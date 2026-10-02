#!/usr/bin/env node
// Stand-in for `claude -p --input-format stream-json ...` used by the bridge tests.
// Each user message makes it ask permission for one Bash command, then report the answer.
import readline from 'node:readline';

const sid = process.argv[process.argv.indexOf(process.argv.includes('--resume') ? '--resume' : '--session-id') + 1];
const out = (o) => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\n');
let n = 0;
// Like Claude Code, total_cost_usd is the session's running total, not the turn's cost.
let cost = 0;
let mode = process.argv[process.argv.indexOf('--permission-mode') + 1];
let effort = process.argv.includes('--effort') ? process.argv[process.argv.indexOf('--effort') + 1] : null;
const canBypass = process.argv.includes('--allow-dangerously-skip-permissions');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request' && msg.request.subtype === 'initialize') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { commands: [] } } });
    out({ type: 'system', subtype: 'init', model: 'fake-model', cwd: process.cwd(), permissionMode: 'default', tools: ['Bash'] });
  } else if (msg.type === 'control_request' && msg.request.subtype === 'set_permission_mode') {
    if (msg.request.mode === 'bypassPermissions' && !canBypass) {
      out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'bypass_not_launched' } });
    } else {
      mode = msg.request.mode;
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { mode } } });
    }
  } else if (msg.type === 'user') {
    n++;
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Look' } } });
    const c = msg.message.content;
    const said = typeof c === 'string' ? c : c.map((b) => (b.type === 'text' ? b.text : `[${b.type} ${b.source.media_type}]`)).join(' ');
    const mcp = process.argv.includes('--mcp-config') ? ` [mcp: ${Object.keys(JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]).mcpServers)}]` : '';
    const eff = effort ? ` [effort: ${effort}]` : '';
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Looking at: ${said}${mcp}${eff}` }] } });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${n}`, name: 'Bash', input: { command: 'touch x' } }] } });
    if (said.includes('hit the limit')) {
      // What Claude Code prints when a plan limit stops a turn.
      const resetsAt = Math.ceil(Date.now() / 1000) + 2;
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt }, seven_day: { utilization: 0.4, resetsAt: resetsAt + 86400 } } } });
      out({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }] }, error: 'rate_limit' });
      out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit", total_cost_usd: 0 });
      return;
    }
    if (said.includes('in the background')) {
      // Like Bash with run_in_background: the turn ends, and Claude wakes up when the job is done.
      const task = { task_id: 'bg-1', task_type: 'local_bash', description: 'Encode the film' };
      out({ type: 'system', subtype: 'background_tasks_changed', tasks: [task] });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'started', total_cost_usd: cost });
      const ms = Number(said.match(/(\d+) ms/)?.[1] ?? 1000);
      setTimeout(() => {
        out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
        out({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed' });
        out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The encode finished.' }] } });
        out({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: cost });
      }, ms);
      return;
    }
    if (said.includes('screenshot')) {
      // Like Read on an image: the result carries base64 data, and tool_use_result repeats it.
      const data = Buffer.alloc(300_000, 7).toString('base64');
      const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: [image] }] }, tool_use_result: { file: { base64: data } } });
    }
    if (mode === 'bypassPermissions') {
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: 'ran without asking' }] } });
      out({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', resetsAt: 2000000000, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.07, resetsAt: 2000000000 }, seven_day: { utilization: 0.85, resetsAt: 2000500000 } } },
      });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: (cost = Math.round((cost + 0.01) * 100) / 100) });
      return;
    }
    out({
      type: 'control_request', request_id: `perm-${n}`,
      request: {
        subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: 'touch x' },
        permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch x' }], behavior: 'allow', destination: 'localSettings' }],
      },
    });
  } else if (msg.type === 'control_response') {
    const r = msg.response.response;
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: `${r.behavior}${r.updatedPermissions ? ' always' : ''}`, is_error: r.behavior !== 'allow' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: (cost = Math.round((cost + 0.01) * 100) / 100) });
  } else if (msg.type === 'control_request' && msg.request.subtype === 'apply_flag_settings') {
    if ('effortLevel' in msg.request.settings) effort = msg.request.settings.effortLevel;
  } else if (msg.type === 'control_request' && msg.request.subtype === 'interrupt') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted', total_cost_usd: 0 });
  }
});
rl.on('close', () => process.exit(0));
