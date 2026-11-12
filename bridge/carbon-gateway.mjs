// Local model catalog for the Antigravity CLI.
//
// AGY only lists Gemini 4 Carbon for ADC sign-ins, and even then its catalog can omit it. Serving a
// single-model /v1beta/models list from 127.0.0.1 and pointing AGY at it with AGY_LLM_GATEWAY_URL makes
// AGY resolve and run Carbon while keeping its normal ADC-routed model backend. Generation that does
// reach this server (when the CLI has no backend of its own) is forwarded to the Gemini API with the
// configured key, mapping the -low/-medium/-high catalog entries to Vertex's base model.
import http from 'node:http';

export const CARBON_MODELS = [
  'gemini-4-carbon',
  'gemini-4-carbon-low',
  'gemini-4-carbon-medium',
  'gemini-4-carbon-high',
];

const display = (id) => id === 'gemini-4-carbon'
  ? 'Gemini 4 Carbon'
  : `Gemini 4 Carbon (${id.split('-').pop()})`;

/**
 * Starts the catalog server on a random loopback port.
 * @param {{ getApiKey: () => string | null, log?: (msg: string) => void }} opts
 * @returns {Promise<{ url: string, close: () => void }>}
 */
export function startCarbonGateway({ getApiKey, log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (req.method === 'GET' && url.pathname === '/v1beta/models') {
      return send(200, {
        models: CARBON_MODELS.map((id) => ({
          name: `models/${id}`,
          baseModelId: id,
          displayName: display(id),
          description: display(id),
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 65_536,
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
        })),
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return send(200, {
        object: 'list',
        data: CARBON_MODELS.map((id) => ({ id, object: 'model', owned_by: 'google' })),
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
    for await (const chunk of req) body += chunk;
    const variant = (model.match(/^gemini-4-carbon-(low|medium|high)$/) || [])[1];
    const base = variant ? 'gemini-4-carbon' : model;
    if (variant) {
      try {
        const parsed = JSON.parse(body);
        parsed.generationConfig = {
          ...(parsed.generationConfig || {}),
          thinkingConfig: { thinkingLevel: variant, ...(parsed.generationConfig?.thinkingConfig || {}) },
        };
        body = JSON.stringify(parsed);
      } catch {}
    }

    const query = `${url.search ? `${url.search}&` : '?'}key=${encodeURIComponent(key)}`;
    try {
      const upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${base}:${verb}${query}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(180_000),
        },
      );
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-cache',
      });
      if (!upstream.body) return res.end();
      for await (const chunk of upstream.body) res.write(chunk);
      return res.end();
    } catch (e) {
      return send(502, { error: { code: 502, message: String(e.message), status: 'UNAVAILABLE' } });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const gatewayUrl = `http://127.0.0.1:${port}`;
      log(`carbon gateway on ${gatewayUrl}`);
      resolve({ url: gatewayUrl, close: () => server.close() });
    });
  });
}
