// Local Gemini model catalog and API proxy for the Antigravity CLI.
//
// AGY's built-in catalog omits Gemini 4 Hydrogen (and only lists Gemini 4 Carbon on some ADC tiers).
// Serving /v1beta/models from 127.0.0.1 and pointing AGY at it with AGY_LLM_GATEWAY_URL (plus
// GOOGLE_GEMINI_BASE_URL when routing to the Gemini API) lets AGY resolve and run Hydrogen, Carbon,
// and standard Gemini models seamlessly, mapping -(low|medium|high) variants to the upstream base
// model with generationConfig.thinkingConfig.thinkingLevel.
import dns from 'node:dns';
import http from 'node:http';

dns.setDefaultResultOrder('ipv4first');

export const CARBON_MODELS = [
  'gemini-4-carbon',
  'gemini-4-carbon-low',
  'gemini-4-carbon-medium',
  'gemini-4-carbon-high',
];

export const HYDROGEN_MODELS = [
  'gemini-4-hydrogen',
  'gemini-4-hydrogen-low',
  'gemini-4-hydrogen-medium',
  'gemini-4-hydrogen-high',
];

const EXTRA_GEMINI_MODELS = [
  'gemini-4-argon',
  'gemini-4-argon-low',
  'gemini-4-argon-medium',
  'gemini-4-argon-high',
  'gemini-3.8-flash',
  'gemini-3.8-flash-low',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-high',
  'gemini-3.7-flash',
  'gemini-3.7-flash-low',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-high',
  'gemini-3.1-pro',
  'gemini-3.1-pro-low',
  'gemini-3.1-pro-high',
];

export const GATEWAY_MODELS = [
  ...CARBON_MODELS,
  ...HYDROGEN_MODELS,
  ...EXTRA_GEMINI_MODELS,
];

function display(id) {
  const variantMatch = id.match(/^(.*)-(low|medium|high)$/);
  const base = variantMatch ? variantMatch[1] : id;
  const variant = variantMatch ? variantMatch[2] : null;
  const names = {
    'gemini-4-carbon': 'Gemini 4 Carbon',
    'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
    'gemini-4-argon': 'Gemini 4 Argon',
    'gemini-3.8-flash': 'Gemini 3.8 Flash',
    'gemini-3.7-flash': 'Gemini 3.7 Flash',
    'gemini-3.1-pro': 'Gemini 3.1 Pro',
  };
  const baseTitle = names[base] ?? base;
  return variant ? `${baseTitle} (${variant})` : baseTitle;
}

function modelDescriptor(id) {
  return {
    name: `models/${id}`,
    baseModelId: id,
    displayName: display(id),
    description: display(id),
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
  };
}

/**
 * Starts the catalog & proxy server on a loopback port (or a specific preferred port, falling back to ephemeral if busy).
 * @param {{ getApiKey: () => string | null, upstreamBaseUrl?: string, headerTimeoutMs?: number, streamTimeoutMs?: number, port?: number, log?: (msg: string) => void }} opts
 * @returns {Promise<{ url: string, port: number, close: () => void }>}
 */
export function startCarbonGateway({
  getApiKey,
  upstreamBaseUrl = 'https://generativelanguage.googleapis.com',
  headerTimeoutMs = 45_000,
  streamTimeoutMs = 300_000,
  port = 0,
  log = () => {},
}) {
  const server = http.createServer(async (req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, obj) => {
      if (res.headersSent || res.writableEnded) { res.destroy(); return; }
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (req.method === 'GET' && url.pathname === '/v1beta/models') {
      return send(200, {
        models: GATEWAY_MODELS.map(modelDescriptor),
      });
    }
    const getModelMatch = req.method === 'GET' && url.pathname.match(/^\/v1beta\/models\/([^/:]+)$/);
    if (getModelMatch) {
      const id = getModelMatch[1];
      return send(200, modelDescriptor(id));
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return send(200, {
        object: 'list',
        data: GATEWAY_MODELS.map((id) => ({ id, object: 'model', owned_by: 'google' })),
      });
    }

    const match = url.pathname.match(/^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/);
    if (req.method !== 'POST' || !match) {
      return send(404, { error: { code: 404, message: 'not found', status: 'NOT_FOUND' } });
    }

    const [, model, verb] = match;
    const key = getApiKey();
    if (!key) {
      return send(500, { error: { code: 500, message: 'Gemini API key is not configured', status: 'FAILED_PRECONDITION' } });
    }

    let body = '';
    try {
      for await (const chunk of req) body += chunk;
    } catch (e) {
      return send(400, { error: { code: 400, message: String(e.message), status: 'INVALID_ARGUMENT' } });
    }
    const variantMatch = model.match(/^(gemini-.+)-(low|medium|high)$/);
    const base = variantMatch ? variantMatch[1] : model;
    const variant = variantMatch ? variantMatch[2] : null;
    if (body) {
      try {
        const parsed = JSON.parse(body);
        const existingTc = parsed.generationConfig?.thinkingConfig;
        if (variant || (existingTc?.thinkingLevel && (existingTc.thinkingBudget !== undefined || existingTc.thinking_budget !== undefined))) {
          const tc = { ...(existingTc || {}) };
          delete tc.thinkingBudget;
          delete tc.thinking_budget;
          if (variant && !tc.thinkingLevel) tc.thinkingLevel = variant;
          parsed.generationConfig = {
            ...(parsed.generationConfig || {}),
            thinkingConfig: tc,
          };
          body = JSON.stringify(parsed);
        }
      } catch {}
    }

    const query = `${url.search ? `${url.search}&` : '?'}key=${encodeURIComponent(key)}`;
    const targetUrl = `${upstreamBaseUrl.replace(/\/$/, '')}/v1beta/models/${base}:${verb}${query}`;
    let totalTimer = null;
    try {
      let upstream = null;
      let streamController = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const controller = new AbortController();
        let timedOutHeaders = false;
        const headerTimer = setTimeout(() => {
          timedOutHeaders = true;
          controller.abort(new Error(`Upstream header timeout after ${headerTimeoutMs}ms`));
        }, headerTimeoutMs);
        headerTimer.unref?.();
        try {
          const candidate = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: controller.signal,
          });
          clearTimeout(headerTimer);
          if (attempt === 1 && (candidate.status === 502 || candidate.status === 503 || candidate.status === 504) && !res.destroyed) {
            try { await candidate.body?.cancel(); } catch {}
            log(`carbon gateway retrying upstream ${candidate.status} (attempt 1)`);
            continue;
          }
          upstream = candidate;
          streamController = controller;
          break;
        } catch (err) {
          clearTimeout(headerTimer);
          const wrapped = timedOutHeaders ? new Error(`Upstream header timeout after ${headerTimeoutMs}ms`) : err;
          if (attempt < 2 && !res.destroyed && !res.writableEnded) {
            log(`carbon gateway retrying upstream request (attempt 1 failed: ${wrapped.message})`);
            continue;
          }
          throw wrapped;
        }
      }
      totalTimer = setTimeout(() => {
        streamController?.abort(new Error('Upstream stream timeout'));
      }, streamTimeoutMs);
      totalTimer.unref?.();
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-cache',
      });
      if (!upstream.body) return res.end();
      for await (const chunk of upstream.body) {
        if (res.writableEnded || res.destroyed) {
          try { await upstream.body.cancel(); } catch {}
          break;
        }
        res.write(chunk);
      }
      if (!res.writableEnded && !res.destroyed) res.end();
    } catch (e) {
      if (res.headersSent || res.writableEnded) {
        log(`carbon gateway stream aborted: ${e.message}`);
        res.destroy();
        return;
      }
      return send(502, { error: { code: 502, message: String(e.message), status: 'UNAVAILABLE' } });
    } finally {
      if (totalTimer) clearTimeout(totalTimer);
    }
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (port && err?.code === 'EADDRINUSE') {
        port = 0;
        server.listen(0, '127.0.0.1');
        return;
      }
      reject(err);
    };
    server.on('error', onError);
    server.listen(port || 0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      const { port: boundPort } = server.address();
      const gatewayUrl = `http://127.0.0.1:${boundPort}`;
      log(`carbon gateway on ${gatewayUrl}`);
      resolve({ url: gatewayUrl, port: boundPort, close: () => server.close() });
    });
  });
}
