#!/usr/bin/env node
// Stand-in for `agy -p= --input-format stream-json ...` (and legacy `claude -p`) used by the bridge tests.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

// `agy` interactive login (no args) or `claude auth status|login`.
if (process.argv.length === 2 || process.argv[2] === 'auth') await new Promise(() => {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'fake-login');
  if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
    const email = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    process.stdout.write(JSON.stringify({ loggedIn: !!email, authMethod: email ? 'claude.ai' : 'none', ...(email && { email }) }, null, 2) + '\n');
    process.exit(email ? 0 : 1);
  }
  execFileSync(process.env.BROWSER, ['https://claude.test/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A4000%2Fcallback']);
  process.stdout.write('Opening browser to sign in…\r\nIf the browser didn\'t open, visit: \x1b]8;;https://claude.test/authorize?code=true\x07https://claude.test/authorize?code=true\x1b]8;;\x07\r\nPaste code here if prompted > ');
  readline.createInterface({ input: process.stdin }).once('line', (code) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${code.trim()}@example.com`);
    process.stdout.write('Login successful.\r\n');
    process.exit(0);
  });
});

// One-shot slash command: `agy -p /usage --output-format json`
if (process.argv[2] === '-p' && process.argv[3]?.startsWith('/')) {
  const cmd = process.argv[3];
  if (cmd === '/usage' && process.env.FAKE_AGY_USAGE === '1') {
    process.stdout.write(JSON.stringify({
      status: 'SUCCESS',
      response: 'Usage limits',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              buckets: [
                { id: 'gemini-5h', remaining_fraction: 0.93, reset_time: new Date(2000000000000).toISOString() },
                { id: 'gemini-weekly', remaining_fraction: 0.15, reset_time: new Date(2000500000000).toISOString() },
              ],
            },
          ],
        },
      },
    }) + '\n');
  } else if (cmd === '/models') {
    process.stdout.write(JSON.stringify({
      status: 'SUCCESS',
      response: 'Available models: gemini-4-carbon, gemini-4-argon, gemini-3.8-flash, gemini-3.7-flash, gemini-3.1-pro',
    }) + '\n');
  }
  process.exit(0);
}

const isAgyStream = process.env.FAKE_AGY_STREAM === '1';
const sidFlag = ['--conversation', '--resume', '--session-id'].find((f) => process.argv.includes(f));
const sid = sidFlag ? process.argv[process.argv.indexOf(sidFlag) + 1] : (process.env.AGY_SESSION_ID ?? 'conv-fake-1');
const out = (o) => process.stdout.write(JSON.stringify(isAgyStream ? o : { session_id: sid, ...o }) + '\n');
let n = 0;
let cost = 0;
let mode = process.argv.includes('--permission-mode')
  ? process.argv[process.argv.indexOf('--permission-mode') + 1]
  : process.argv.includes('--dangerously-skip-permissions')
    ? 'bypassPermissions'
    : process.argv.includes('--mode')
      ? (process.argv[process.argv.indexOf('--mode') + 1] === 'accept-edits' ? 'acceptEdits' : process.argv[process.argv.indexOf('--mode') + 1])
      : 'default';
let effort = process.argv.includes('--effort') ? process.argv[process.argv.indexOf('--effort') + 1] : null;
const canBypass = process.argv.includes('--allow-dangerously-skip-permissions') || process.argv.includes('--dangerously-skip-permissions');

if (isAgyStream) {
  const modelArg = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : null;
  // The real CLI only knows Gemini 4 Carbon when signed in with Application Default Credentials.
  if (modelArg === 'gemini-4-carbon') {
    process.stderr.write('error: invalid model selection (--model "gemini-4-carbon" --effort ""): model gemini-4-carbon is not recognized as a known model or custom model in settings\n');
    process.exit(1);
  }
  if (modelArg && !modelArg.startsWith('gpt-oss') && !/-(low|medium|high)$/.test(modelArg) && !effort) {
    process.stderr.write(`error: invalid model selection (--model "${modelArg}" --effort ""): --model ${modelArg} requires --effort (available: low, medium, high)\n`);
    process.exit(1);
  }
  out({
    event: 'init',
    conversation_id: sid,
    init: {
      model: modelArg || 'gemini-4-argon',
      cwd: process.cwd(),
      tools: ['run_command', 'view_file', 'replace_file_content'],
      permission_mode: mode === 'bypassPermissions' ? 'always-proceed' : mode,
    },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (isAgyStream && msg.event === 'user') {
    n++;
    const c = msg.message.content;
    const said = typeof c === 'string' ? c : c.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ');
    const eff = effort ? ` [effort: ${effort}]` : '';
    const stepTool = n * 2;
    const stepResp = n * 2 + 1;
    if (said.includes('test-stuck-tool')) {
      const child = spawn('sleep', ['100'], { stdio: 'ignore' });
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { name: 'run_command', parameters: { CommandLine: 'sleep 100' } },
        },
      });
      const transcriptFile = path.join(process.env.CCM_AGY_DIR ?? path.join(os.homedir(), '.gemini', 'antigravity-cli'), 'brain', sid, '.system_generated', 'logs', 'transcript.jsonl');
      fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
      fs.appendFileSync(transcriptFile, JSON.stringify({ step_index: stepResp, type: 'PLANNER_RESPONSE', status: 'DONE' }) + '\n');
      child.on('close', () => {
        out({
          event: 'step_update',
          step_update: {
            conversation_id: sid,
            step_index: stepTool,
            state: 'DONE',
            step_type: 'tool',
            tool_name: 'run_command',
            duration_seconds: 1.0,
            tool_info: { name: 'run_command', parameters: { CommandLine: 'sleep 100' }, error: { message: 'context canceled' } },
          },
        });
        out({
          event: 'result',
          result: { conversation_id: sid, status: 'SUCCESS', response: 'Unblocked successfully!' },
        });
      });
      return;
    }
    out({
      event: 'step_update',
      step_update: {
        conversation_id: sid,
        step_index: stepTool,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } },
      },
    });
    out({
      event: 'step_update',
      step_update: {
        conversation_id: sid,
        step_index: stepTool,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        duration_seconds: 0.05,
        usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 5, cache_read_tokens: 50, total_tokens: 165 },
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi\n' },
      },
    });
    const fullText = `AGY reply to: ${said}${eff}`;
    out({
      event: 'step_update',
      step_update: {
        conversation_id: sid,
        step_index: stepResp,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: fullText.slice(0, 10),
      },
    });
    out({
      event: 'step_update',
      step_update: {
        conversation_id: sid,
        step_index: stepResp,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: fullText.slice(10),
      },
    });
    out({
      event: 'step_update',
      step_update: {
        conversation_id: sid,
        step_index: stepResp,
        state: 'DONE',
        step_type: 'agent_response',
        duration_seconds: 0.1,
        usage: { input_tokens: 120, output_tokens: 20, thinking_tokens: 10, cache_read_tokens: 60, total_tokens: 210 },
      },
    });
    const isStreamInterrupted = said.includes('stream-interrupted-after-response');
    const staleError = said.includes('stale-quota-error')
      ? 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 146h37m35s.'
      : isStreamInterrupted
      ? 'The stream was interrupted. Please continue the task you were working on.'
      : undefined;
    out({
      event: 'result',
      result: {
        conversation_id: sid,
        status: (said.includes('stale-quota-status-error') || isStreamInterrupted) ? 'ERROR' : 'SUCCESS',
        ...(staleError ? { error: staleError } : {}),
        response: fullText,
        duration_seconds: 0.2,
        num_turns: 1,
        usage: { input_tokens: 220, output_tokens: 30, thinking_tokens: 15, cache_read_tokens: 110, total_tokens: 375 },
      },
    });
    return;
  }

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
  } else if (msg.type === 'user' || msg.event === 'user') {
    n++;
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Look' } } });
    const c = msg.message.content;
    const said = typeof c === 'string' ? c : c.map((b) => (b.type === 'text' ? b.text : `[${b.type} ${b.source?.media_type ?? ''}]`)).join(' ');
    const mcp = process.argv.includes('--mcp-config') ? ` [mcp: ${Object.keys(JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]).mcpServers)}]` : '';
    const eff = effort ? ` [effort: ${effort}]` : '';
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Looking at: ${said}${mcp}${eff}` }] } });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${n}`, name: 'Bash', input: { command: 'touch x' } }] } });
    if (said.includes('ask me')) {
      const input = { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] }] };
      out({ type: 'control_request', request_id: `ask-${n}`, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input } });
      return;
    }
    if (said.includes('hit the limit')) {
      const resetsAt = Math.ceil(Date.now() / 1000) + 2;
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt }, seven_day: { utilization: 0.4, resetsAt: resetsAt + 86400 } } } });
      out({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }] }, error: 'rate_limit' });
      out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit", total_cost_usd: 0 });
      return;
    }
    if (said.includes('in the background')) {
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
    if (r.updatedInput?.answers) {
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: `answered ${JSON.stringify(r.updatedInput.answers)}` }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: cost });
      return;
    }
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: `${r.behavior}${r.updatedPermissions ? ' always' : ''}`, is_error: r.behavior !== 'allow' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: (cost = Math.round((cost + 0.01) * 100) / 100) });
  } else if (msg.type === 'control_request' && msg.request.subtype === 'apply_flag_settings') {
    if ('effortLevel' in msg.request.settings) effort = msg.request.settings.effortLevel;
  } else if (msg.type === 'control_request' && msg.request.subtype === 'interrupt') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted', total_cost_usd: 0 });
  }
});
rl.on('close', () => process.exit(0));
