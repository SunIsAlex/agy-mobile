import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startCarbonGateway, CARBON_MODELS, HYDROGEN_MODELS, GATEWAY_MODELS } from '../carbon-gateway.mjs';

test('carbon gateway advertises Hydrogen and Carbon to AGY and needs a key to generate', async () => {
  const gateway = await startCarbonGateway({ getApiKey: () => null });
  try {
    const models = await (await fetch(`${gateway.url}/v1beta/models?pageSize=1000`)).json();
    assert.deepEqual(models.models.map((m) => m.name), GATEWAY_MODELS.map((id) => `models/${id}`));
    for (const id of [...CARBON_MODELS, ...HYDROGEN_MODELS]) {
      assert.ok(models.models.some((m) => m.name === `models/${id}`), `missing ${id}`);
    }
    const carbonEntry = models.models.find((m) => m.name === 'models/gemini-4-carbon');
    const hydrogenEntry = models.models.find((m) => m.name === 'models/gemini-4-hydrogen');
    const hydrogenLowEntry = models.models.find((m) => m.name === 'models/gemini-4-hydrogen-low');
    assert.equal(carbonEntry.displayName, 'Gemini 4 Carbon');
    assert.equal(hydrogenEntry.displayName, 'Gemini 4 Hydrogen');
    assert.equal(hydrogenLowEntry.displayName, 'Gemini 4 Hydrogen (low)');
    assert.ok(hydrogenEntry.supportedGenerationMethods.includes('streamGenerateContent'));

    const singleModel = await (await fetch(`${gateway.url}/v1beta/models/gemini-4-hydrogen`)).json();
    assert.equal(singleModel.displayName, 'Gemini 4 Hydrogen');

    const openai = await (await fetch(`${gateway.url}/v1/models`)).json();
    assert.ok(openai.data.some((m) => m.id === 'gemini-4-carbon'));
    assert.ok(openai.data.some((m) => m.id === 'gemini-4-hydrogen'));
    assert.ok(openai.data.some((m) => m.id === 'gemini-4-hydrogen-high'));

    const generation = await fetch(`${gateway.url}/v1beta/models/gemini-4-hydrogen-high:generateContent`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(generation.status, 500);
    assert.match((await generation.json()).error.message, /API key/);
  } finally {
    gateway.close();
  }
});

test('carbon gateway rewrites thinkingLevel (stripping thinkingBudget) for Hydrogen & Carbon, streams chunks, and handles mid-stream drops', async () => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    received.push({ url: req.url, apiKey: req.headers['x-goog-api-key'], body: bodyText ? JSON.parse(bodyText) : null });

    if (req.url.includes('drop=1')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n');
      setTimeout(() => req.socket.destroy(), 20);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"ok":');
    res.end('true}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const gateway = await startCarbonGateway({ getApiKey: () => 'AIzaMockKey', upstreamBaseUrl: upstreamUrl });

  try {
    // 1. Hydrogen with thinkingBudget present in incoming request -> strips thinkingBudget and sets thinkingLevel
    const hRes = await fetch(`${gateway.url}/v1beta/models/gemini-4-hydrogen-medium:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 8192 } },
      }),
    });
    assert.equal(hRes.status, 200);
    assert.deepEqual(await hRes.json(), { ok: true });
    assert.equal(received[0].url, '/v1beta/models/gemini-4-hydrogen:streamGenerateContent?alt=sse&key=AIzaMockKey');
    assert.equal(received[0].body.generationConfig.thinkingConfig.thinkingLevel, 'medium');
    assert.equal(received[0].body.generationConfig.thinkingConfig.thinkingBudget, undefined);

    // 2. Carbon high variant
    const okRes = await fetch(`${gateway.url}/v1beta/models/gemini-4-carbon-high:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    assert.equal(okRes.status, 200);
    assert.deepEqual(await okRes.json(), { ok: true });
    assert.equal(received[1].url, '/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse&key=AIzaMockKey');
    assert.equal(received[1].body.generationConfig.thinkingConfig.thinkingLevel, 'high');

    // 3. Mid-stream socket drop after headers sent must abort downstream cleanly, not throw ERR_HTTP_HEADERS_SENT
    await assert.rejects(async () => {
      const dropRes = await fetch(`${gateway.url}/v1beta/models/gemini-4-hydrogen-low:streamGenerateContent?drop=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [] }),
      });
      await dropRes.text();
    });

    // Gateway remains alive and responsive after the mid-stream upstream error
    const health = await fetch(`${gateway.url}/v1/models`);
    assert.equal(health.status, 200);
  } finally {
    gateway.close();
    upstream.close();
  }
});

test('carbon gateway retries once on upstream header timeout before sending downstream headers', async () => {
  let attempts = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    attempts++;
    if (req.url.includes('alwaysStall=1') || attempts === 1) {
      // Simulate stalled upstream connection that never sends response headers
      const timer = setTimeout(() => {
        if (!res.writableEnded && !res.destroyed) res.destroy();
      }, 400);
      timer.unref?.();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ recoveredOnAttempt: attempts }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const gateway = await startCarbonGateway({
    getApiKey: () => 'AIzaMockKey',
    upstreamBaseUrl: upstreamUrl,
    headerTimeoutMs: 60,
  });

  try {
    // 1. First attempt stalls -> gateway aborts at 60ms and transparently succeeds on attempt 2
    const okRes = await fetch(`${gateway.url}/v1beta/models/gemini-4-hydrogen-high:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'retry me' }] }] }),
    });
    assert.equal(okRes.status, 200);
    assert.deepEqual(await okRes.json(), { recoveredOnAttempt: 2 });
    assert.equal(attempts, 2);

    // 2. Both attempts stall -> gateway returns 502 with header timeout message
    const failRes = await fetch(`${gateway.url}/v1beta/models/gemini-4-hydrogen-high:streamGenerateContent?alwaysStall=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [] }),
    });
    assert.equal(failRes.status, 502);
    assert.match((await failRes.json()).error.message, /Upstream header timeout/);
  } finally {
    gateway.close();
    upstream.close();
  }
});
