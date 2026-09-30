#!/usr/bin/env node
// Stand-in for `claude -p --input-format stream-json ...` used by the bridge tests.
// Each user message makes it ask permission for one Bash command, then report the answer.
import readline from 'node:readline';

const sid = process.argv[process.argv.indexOf(process.argv.includes('--resume') ? '--resume' : '--session-id') + 1];
const out = (o) => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\n');
let n = 0;
let mode = process.argv[process.argv.indexOf('--permission-mode') + 1];
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
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Looking at: ${said}${mcp}` }] } });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${n}`, name: 'Bash', input: { command: 'touch x' } }] } });
    if (mode === 'bypassPermissions') {
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: 'ran without asking' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.01 });
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
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.01 });
  } else if (msg.type === 'control_request' && msg.request.subtype === 'interrupt') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted', total_cost_usd: 0 });
  }
});
rl.on('close', () => process.exit(0));
