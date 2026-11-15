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
  const geminiTag = process.env.GEMINI_API_KEY ? ' [gemini-env:present]' : ' [gemini-env:absent]';
  process.stdout.write(`Opening browser to sign in…${geminiTag}\r\nIf the browser didn't open, visit: \x1b]8;;https://claude.test/authorize?code=true\x07https://claude.test/authorize?code=true\x1b]8;;\x07\r\nPaste code here if prompted > `);
  readline.createInterface({ input: process.stdin }).once('line', (code) => {
    const email = `${code.trim()}@example.com`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, email);
    if (process.env.CCM_LEGACY_PROTO === '0' && process.env.CCM_AGY_DIR) {
      fs.mkdirSync(process.env.CCM_AGY_DIR, { recursive: true });
      const claims = Buffer.from(JSON.stringify({ email, name: code.trim() })).toString('base64url');
      fs.writeFileSync(path.join(process.env.CCM_AGY_DIR, 'antigravity-oauth-token'), JSON.stringify({
        token: { access_token: 'ya29.login', refresh_token: '1//login' },
        auth_method: 'consumer',
        id_token: `eyJhbGciOiJSUzI1NiJ9.${claims}.sig`,
      }));
    }
    process.stdout.write('Login successful.\r\n');
    process.exit(0);
  });
});

// Emulate ~/.local/bin/agy wrapper: if GEMINI_API_KEY is unset, ~/.local/bin/agy auto-exports any key left in agyDataDir.
if (!process.env.GEMINI_API_KEY && process.env.CCM_AGY_DIR) {
  const keyFile = path.join(process.env.CCM_AGY_DIR, 'gemini-api-key');
  const settingsFile = path.join(process.env.CCM_AGY_DIR, 'settings.json');
  if (fs.existsSync(keyFile)) {
    const k = fs.readFileSync(keyFile, 'utf8').trim();
    if (k) process.env.GEMINI_API_KEY = k;
  } else if (fs.existsSync(settingsFile)) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (typeof s?.geminiApiKey === 'string' && s.geminiApiKey.trim()) process.env.GEMINI_API_KEY = s.geminiApiKey.trim();
    } catch {}
  }
}

// One-shot slash command: `agy -p /usage --output-format json`
if (process.argv[2] === '-p' && process.argv[3]?.startsWith('/')) {
  const cmd = process.argv[3];
  if (cmd === '/usage' && process.env.FAKE_AGY_USAGE === '1') {
    const customUsage = process.env.CCM_AGY_DIR ? path.join(process.env.CCM_AGY_DIR, 'fake-usage.json') : null;
    if (customUsage && fs.existsSync(customUsage)) {
      process.stdout.write(fs.readFileSync(customUsage, 'utf8').trim() + '\n');
      process.exit(0);
    }
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
      response: 'Available models: gemini-4-hydrogen, gemini-4-carbon, gemini-4-argon, gemini-3.8-flash, gemini-3.7-flash, gemini-3.1-pro',
    }) + '\n');
  }
  process.exit(0);
}

const isAgyStream = process.env.FAKE_AGY_STREAM === '1';
const sidFlag = ['--conversation', '--resume', '--session-id'].find((f) => process.argv.includes(f));
const sid = sidFlag ? process.argv[process.argv.indexOf(sidFlag) + 1] : (process.env.AGY_SESSION_ID ?? 'conv-fake-1');
const out = (o) => process.stdout.write(JSON.stringify(isAgyStream ? o : { session_id: sid, ...o }) + '\n');
const stepCounterFile = isAgyStream && process.env.CCM_AGY_DIR
  ? path.join(process.env.CCM_AGY_DIR, `.fake-step-${sid}`)
  : null;
let n = 0;
if (stepCounterFile && fs.existsSync(stepCounterFile)) {
  try { n = Number(fs.readFileSync(stepCounterFile, 'utf8').trim()) || 0; } catch {}
}
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

const agyModelArg = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : null;

if (isAgyStream) {
  // The real CLI only knows Gemini 4 Carbon when signed in with Application Default Credentials or via the gateway + API key.
  if (agyModelArg === 'gemini-4-carbon' && !process.env.GEMINI_API_KEY && process.env.AGY_ADC_AUTH !== '1') {
    process.stderr.write('error: invalid model selection (--model "gemini-4-carbon" --effort ""): model gemini-4-carbon is not recognized as a known model or custom model in settings\n');
    process.exit(1);
  }
  if (agyModelArg?.startsWith('gemini-4-hydrogen')) {
    let modelProviderInSettings = null;
    let hasOAuthToken = false;
    let subHydrogenUnsupported = false;
    if (process.env.CCM_AGY_DIR) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(process.env.CCM_AGY_DIR, 'settings.json'), 'utf8'));
        modelProviderInSettings = s?.modelProvider ?? null;
      } catch {}
      hasOAuthToken = fs.existsSync(path.join(process.env.CCM_AGY_DIR, 'antigravity-oauth-token'));
      subHydrogenUnsupported = fs.existsSync(path.join(process.env.CCM_AGY_DIR, 'fake-no-sub-hydrogen'));
    }
    if (process.env.GEMINI_API_KEY) {
      const gw = process.env.AGY_LLM_GATEWAY_URL;
      const base = process.env.GOOGLE_GEMINI_BASE_URL;
      if (!gw || !base || modelProviderInSettings === 'gemini') {
        process.stderr.write(`error: invalid model selection (--model "${agyModelArg}" --effort ""): model ${agyModelArg} is not recognized as a known model or custom model in settings\n`);
        process.exit(1);
      }
      const res = await fetch(`${gw}/v1beta/models/gemini-4-hydrogen`).catch(() => null);
      if (!res || !res.ok) {
        process.stderr.write(`error: invalid model selection (--model "${agyModelArg}" --effort ""): model ${agyModelArg} is not recognized as a known model or custom model in settings\n`);
        process.exit(1);
      }
    } else if (!hasOAuthToken || subHydrogenUnsupported) {
      process.stderr.write(`error: invalid model selection (--model "${agyModelArg}" --effort ""): model ${agyModelArg} is not recognized as a known model or custom model in settings\n`);
      process.exit(1);
    }
  }
  if (agyModelArg && !agyModelArg.startsWith('gpt-oss') && !/-(low|medium|high|xhigh)$/.test(agyModelArg) && !effort) {
    process.stderr.write(`error: invalid model selection (--model "${agyModelArg}" --effort ""): --model ${agyModelArg} requires --effort (available: low, medium, high)\n`);
    process.exit(1);
  }
  out({
    event: 'init',
    conversation_id: sid,
    init: {
      model: agyModelArg || 'gemini-4-argon',
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
    if (stepCounterFile) {
      try { fs.mkdirSync(path.dirname(stepCounterFile), { recursive: true }); fs.writeFileSync(stepCounterFile, String(n)); } catch {}
    }
    const c = msg.message.content;
    const said = typeof c === 'string' ? c : c.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ');
    const eff = effort ? ` [effort: ${effort}]` : '';
    const stepTool = n * 10;
    const stepResp = n * 10 + 5;
    const subLimitFile = process.env.CCM_AGY_DIR ? path.join(process.env.CCM_AGY_DIR, 'fake-sub-limit') : null;
    if (!process.env.GEMINI_API_KEY && (said.includes('trigger-sub-limit') || (subLimitFile && fs.existsSync(subLimitFile)))) {
      out({
        event: 'result',
        result: {
          conversation_id: sid,
          status: 'ERROR',
          error: '429 Too Many Requests: RESOURCE_EXHAUSTED: Individual quota reached. Resets in 2h0m0s.',
          duration_seconds: 0.05,
          num_turns: 1,
        },
      });
      return;
    }
    if (said.includes('slow-tool')) {
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { name: 'run_command', parameters: { CommandLine: 'sleep 60' } },
        },
      });
      return;
    }
    const readImgMatch = /read-image:\s*([^\n]+)/.exec(said);
    if (readImgMatch) {
      const imgPath = readImgMatch[1].trim();
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'read_file',
          tool_info: { name: 'read_file', parameters: { Path: imgPath } },
        },
      });
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'read_file',
          duration_seconds: 0.02,
          tool_info: { name: 'read_file', parameters: { Path: imgPath }, output: 'Read image file' },
        },
      });
      const text = `Viewed ${path.basename(imgPath)}`;
      out({
        event: 'step_update',
        step_update: { conversation_id: sid, step_index: stepResp, state: 'ACTIVE', step_type: 'agent_response', text_delta: text },
      });
      out({
        event: 'step_update',
        step_update: { conversation_id: sid, step_index: stepResp, state: 'DONE', step_type: 'agent_response', duration_seconds: 0.05 },
      });
      out({
        event: 'result',
        result: { conversation_id: sid, status: 'SUCCESS', response: text, duration_seconds: 0.1, num_turns: 1 },
      });
      return;
    }
    if (said.includes('edit-and-write')) {
      const helloPath = path.join(process.cwd(), 'hello.txt');
      const createdPath = path.join(process.cwd(), 'created.txt');
      const obsoletePath = path.join(process.cwd(), 'obsolete.txt');
      const existing = fs.existsSync(helloPath) ? fs.readFileSync(helloPath, 'utf8') : 'old line\n';
      fs.writeFileSync(helloPath, existing.replace('old line', 'new line 1\nnew line 2'));
      fs.writeFileSync(createdPath, 'created by agy\n');
      if (fs.existsSync(obsoletePath)) fs.unlinkSync(obsoletePath);
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'edit_file',
          tool_info: { name: 'edit_file', parameters: { Path: helloPath, Target: 'old line', Replacement: 'new line 1\nnew line 2' } },
        },
      });
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'edit_file',
          duration_seconds: 0.02,
          tool_info: { name: 'edit_file', parameters: { Path: helloPath, Target: 'old line', Replacement: 'new line 1\nnew line 2' }, output: 'Made 1 replacement' },
        },
      });
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool + 1,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'write_file',
          tool_info: { name: 'write_file', parameters: { Path: createdPath, Content: 'created by agy\n' } },
        },
      });
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool + 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'write_file',
          duration_seconds: 0.02,
          tool_info: { name: 'write_file', parameters: { Path: createdPath, Content: 'created by agy\n' }, output: 'Wrote file' },
        },
      });
      const text = 'Updated hello.txt and wrote created.txt';
      out({
        event: 'step_update',
        step_update: { conversation_id: sid, step_index: stepResp, state: 'ACTIVE', step_type: 'agent_response', text_delta: text },
      });
      out({
        event: 'step_update',
        step_update: { conversation_id: sid, step_index: stepResp, state: 'DONE', step_type: 'agent_response', duration_seconds: 0.05 },
      });
      out({
        event: 'result',
        result: { conversation_id: sid, status: 'SUCCESS', response: text, duration_seconds: 0.1, num_turns: 1 },
      });
      return;
    }
    if (said.includes('fallback-response-only')) {
      const u = { input_tokens: 100, output_tokens: 40, thinking_tokens: 10, cache_read_tokens: 50, total_tokens: 200 };
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { name: 'run_command', parameters: { CommandLine: 'true' } },
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
          duration_seconds: 0.01,
          usage: u,
          tool_info: { name: 'run_command', parameters: { CommandLine: 'true' }, output: '' },
        },
      });
      out({
        event: 'result',
        result: {
          conversation_id: sid,
          status: 'SUCCESS',
          response: 'Fallback summary only',
          duration_seconds: 0.1,
          num_turns: 1,
          usage: u,
        },
      });
      return;
    }
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
    if (said.includes('bg-wakeup-drop') || said.includes('bg-wakeup-stall')) {
      const isStall = said.includes('bg-wakeup-stall');
      const transcriptFile = path.join(process.env.CCM_AGY_DIR ?? path.join(os.homedir(), '.gemini', 'antigravity-cli'), 'brain', sid, '.system_generated', 'logs', 'transcript.jsonl');
      fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { name: 'run_command', parameters: { CommandLine: 'yt-dlp elec.mp4 quantum.mp4' } },
        },
      });
      const interimText = 'Downloading excerpts from two Veritasium physics videos...';
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool + 1,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: interimText,
        },
      });
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool + 1,
          state: 'DONE',
          step_type: 'agent_response',
          duration_seconds: 0.05,
        },
      });
      const oldIso = new Date(Date.now() - 2_000).toISOString();
      fs.appendFileSync(transcriptFile, [
        JSON.stringify({ step_index: stepTool, type: 'GENERIC', status: 'RUNNING', created_at: oldIso, content: `Tool is running as a background task with task id: ${sid}/task-${stepTool}` }),
        JSON.stringify({ step_index: stepTool + 1, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: oldIso, content: interimText }),
        JSON.stringify({
          step_index: stepTool + 2,
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          created_at: oldIso,
          content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=${oldIso} sender=${sid}/task-${stepTool} priority=MESSAGE_PRIORITY_HIGH content=Task id "${sid}/task-${stepTool}" finished with result:\nCommand exited with code 0.\n\nCommand output:\nelec.mp4\nquantum.mp4\n</SYSTEM_MESSAGE>`,
        }),
        JSON.stringify({
          step_index: stepTool + 3,
          type: 'ERROR_MESSAGE',
          status: 'DONE',
          created_at: oldIso,
          error: 'API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": unexpected EOF',
        }),
      ].join('\n') + '\n');
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'run_command',
          duration_seconds: 1.2,
          tool_info: { name: 'run_command', parameters: { CommandLine: 'yt-dlp elec.mp4 quantum.mp4' }, output: 'elec.mp4\nquantum.mp4\n' },
        },
      });
      if (isStall) {
        // Simulate AGY hanging indefinitely on a dead HTTP/2 dial after writing SYSTEM_MESSAGE + ERROR_MESSAGE
        return;
      }
      setTimeout(() => {
        out({
          event: 'result',
          result: {
            conversation_id: sid,
            status: 'ERROR',
            error: 'agent executor error: generating and executing: request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": http2: client conn could not be established',
            duration_seconds: 1459.3,
            num_turns: 3,
          },
        });
        // 8ms later, AGY's outer turn wrapper emits a bogus SUCCESS result echoing stale pre-download text
        setTimeout(() => {
          out({
            event: 'result',
            result: {
              conversation_id: sid,
              status: 'SUCCESS',
              response: interimText,
              duration_seconds: 4455.7,
              num_turns: 3,
            },
          });
        }, 8);
      }, 40);
      return;
    }
    if (said.includes('Background task finished — review its output above and continue.')) {
      const transcriptFile = path.join(process.env.CCM_AGY_DIR ?? path.join(os.homedir(), '.gemini', 'antigravity-cli'), 'brain', sid, '.system_generated', 'logs', 'transcript.jsonl');
      const netOfflineFile = process.env.CCM_AGY_DIR ? path.join(process.env.CCM_AGY_DIR, 'fake-net-offline') : null;
      const nowIso = new Date().toISOString();
      fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
      if (netOfflineFile && fs.existsSync(netOfflineFile)) {
        fs.appendFileSync(transcriptFile, [
          JSON.stringify({ step_index: stepTool + 50, type: 'USER_INPUT', status: 'DONE', created_at: nowIso, content: said }),
          JSON.stringify({ step_index: stepTool + 51, type: 'ERROR_MESSAGE', status: 'DONE', created_at: nowIso, error: 'http2: client conn could not be established' }),
        ].join('\n') + '\n');
        out({
          event: 'result',
          result: {
            conversation_id: sid,
            status: 'ERROR',
            error: 'agent executor error: generating and executing: request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": http2: client conn could not be established',
            duration_seconds: 0.1,
            num_turns: 1,
          },
        });
        return;
      }
      const recoveredText = 'Analyzed downloaded Veritasium videos (elec.mp4, quantum.mp4) and extracted frames!';
      fs.appendFileSync(transcriptFile, [
        JSON.stringify({ step_index: stepTool + 60, type: 'USER_INPUT', status: 'DONE', created_at: nowIso, content: said }),
        JSON.stringify({ step_index: stepTool + 61, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: nowIso, content: recoveredText }),
      ].join('\n') + '\n');
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool + 61,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: recoveredText,
        },
      });
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool + 61,
          state: 'DONE',
          step_type: 'agent_response',
          duration_seconds: 0.05,
        },
      });
      out({
        event: 'result',
        result: {
          conversation_id: sid,
          status: 'SUCCESS',
          response: recoveredText,
          duration_seconds: 0.1,
          num_turns: 1,
        },
      });
      return;
    }
    if (said.includes('unrecovered-post-tool-timeout')) {
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool - 1,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: 'Checking repository status first...',
        },
      });
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool - 1,
          state: 'DONE',
          step_type: 'agent_response',
          duration_seconds: 0.02,
        },
      });
      out({
        event: 'step_update',
        step_update: {
          conversation_id: sid,
          step_index: stepTool,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { name: 'run_command', parameters: { CommandLine: 'git status --short' } },
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
          duration_seconds: 0.02,
          tool_info: { name: 'run_command', parameters: { CommandLine: 'git status --short' }, output: '' },
        },
      });
      out({
        event: 'result',
        result: {
          conversation_id: sid,
          status: 'ERROR',
          error: 'API error (attempt 3): doRequest: error sending request: Post "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse": http2: timeout awaiting response headers',
          response: '',
          duration_seconds: 0.2,
          num_turns: 1,
        },
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
    const viaTag = said.includes('hybrid-') || said.includes('hydrogen-')
      ? ` [via:${process.env.GEMINI_API_KEY ? 'api' : 'sub'}:${agyModelArg || 'default'}]`
      : '';
    const fullText = `AGY reply to: ${said}${eff}${viaTag}`;
    const respOutTokens = said.includes('big-tokens') ? 10000 : 20;
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
        usage: { input_tokens: 120, output_tokens: respOutTokens, thinking_tokens: 10, cache_read_tokens: 60, total_tokens: 190 + respOutTokens },
      },
    });
    const isStreamInterrupted = said.includes('stream-interrupted-after-response');
    const isRecoveredAttemptTimeout = said.includes('recovered-attempt-1-timeout');
    const staleError = said.includes('stale-quota-error')
      ? 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 146h37m35s.'
      : isStreamInterrupted
      ? 'The stream was interrupted. Please continue the task you were working on.'
      : isRecoveredAttemptTimeout
      ? 'API error (attempt 1): doRequest: error sending request: Post "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse": http2: timeout awaiting response headers'
      : undefined;
    out({
      event: 'result',
      result: {
        conversation_id: sid,
        status: (said.includes('stale-quota-status-error') || isStreamInterrupted || isRecoveredAttemptTimeout) ? 'ERROR' : 'SUCCESS',
        ...(staleError ? { error: staleError } : {}),
        response: fullText,
        duration_seconds: isRecoveredAttemptTimeout ? 60246.486 : 0.2,
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
    if (stepCounterFile) {
      try { fs.mkdirSync(path.dirname(stepCounterFile), { recursive: true }); fs.writeFileSync(stepCounterFile, String(n)); } catch {}
    }
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
