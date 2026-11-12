import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCarbonGateway, CARBON_MODELS } from '../carbon-gateway.mjs';

test('carbon gateway advertises Carbon to AGY and needs a key to generate', async () => {
  const gateway = await startCarbonGateway({ getApiKey: () => null });
  try {
    const models = await (await fetch(`${gateway.url}/v1beta/models?pageSize=1000`)).json();
    assert.deepEqual(models.models.map((m) => m.name), CARBON_MODELS.map((id) => `models/${id}`));
    assert.equal(models.models[0].displayName, 'Gemini 4 Carbon');
    assert.ok(models.models[0].supportedGenerationMethods.includes('streamGenerateContent'));

    const openai = await (await fetch(`${gateway.url}/v1/models`)).json();
    assert.ok(openai.data.some((m) => m.id === 'gemini-4-carbon'));
    assert.ok(openai.data.some((m) => m.id === 'gemini-4-carbon-high'));

    const generation = await fetch(`${gateway.url}/v1beta/models/gemini-4-carbon-high:generateContent`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(generation.status, 500);
    assert.match((await generation.json()).error.message, /API key/);
  } finally {
    gateway.close();
  }
});
