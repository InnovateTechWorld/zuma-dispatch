import { loadConfig } from './config';
import type { Env } from './env';
import { basicPassword, bearerToken, secretsMatch } from './lib/auth';
import { log } from './lib/log';
import { handleMcp, SERVER_VERSION } from './mcp/server';
import { chordWebhook } from './web/chordWebhook';
import { paystackWebhook } from './web/paystackWebhook';
import { mirrorStatus } from './sheets/mirror';
import { board, payReturn } from './web/pages';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get('X-Request-ID')?.slice(0, 64) || crypto.randomUUID();
    const started = Date.now();
    let response: Response;
    try {
      response = await route(request, url, env, ctx, requestId);
    } catch (e) {
      log('error', 'unhandled_request_error', { path: url.pathname, request_id: requestId, message: e instanceof Error ? e.message : String(e) });
      response = json({ error: 'internal_error', request_id: requestId }, 500);
    }
    log('info', 'http_request', {
      method: request.method,
      path: url.pathname,
      status: response.status,
      latency_ms: Date.now() - started,
      request_id: requestId,
    });
    const headers = new Headers(response.headers);
    headers.set('X-Request-ID', requestId);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, url: URL, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
  const cfg = loadConfig(env);

  if (url.pathname === '/' && request.method === 'GET') {
    return json({ service: 'zuma-dispatch', version: SERVER_VERSION, mcp_endpoint: '/mcp', health: '/health' });
  }

  if (url.pathname === '/health' && request.method === 'GET') {
    let db: 'ok' | 'error' = 'ok';
    try {
      await env.DB.prepare('SELECT 1 AS ok').first();
    } catch {
      db = 'error';
    }
    const healthy = cfg.ok && db === 'ok';
    return json(
      {
        status: healthy ? 'ok' : 'degraded',
        version: SERVER_VERSION,
        config: cfg.ok ? 'ok' : { problems: cfg.problems },
        database: db,
        geocoder_chain: cfg.ok ? cfg.config.geocoderChain : undefined,
        geocoder_mode: cfg.ok ? cfg.config.geocoderMode : undefined,
        router_chain: cfg.ok ? cfg.config.routerChain : undefined,
        sheet_mirror: mirrorStatus(env),
        paystack_webhook: '/hooks/paystack',
        chord_webhook: env.CHORD_WEBHOOK_SECRET ? 'configured' : 'not_configured',
      },
      healthy ? 200 : 503,
    );
  }

  if (url.pathname === '/mcp') {
    if (!cfg.ok) {
      log('error', 'config_invalid', { problems: cfg.problems.join(' | '), request_id: requestId });
      return json({ error: 'server_misconfigured', detail: 'See /health for which settings are missing.' }, 503);
    }
    // MCP spec (transports): servers MUST validate Origin to prevent DNS rebinding.
    // Chord calls server-to-server and sends no Origin, so any browser-originated
    // request is refused before auth is even considered.
    const origin = request.headers.get('Origin');
    if (origin !== null) {
      log('warn', 'mcp_origin_rejected', { request_id: requestId, origin: origin.slice(0, 100) });
      return json({ error: 'origin_not_allowed', detail: 'This MCP endpoint only accepts server-to-server calls.' }, 403);
    }
    const token = bearerToken(request);
    if (!token || !(await secretsMatch(token, cfg.config.mcpBearerToken))) {
      log('warn', 'mcp_auth_failed', { request_id: requestId, had_token: Boolean(token) });
      return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer realm="zuma-dispatch"' });
    }
    if (request.method !== 'POST') {
      // Stateless server: no standalone SSE stream (GET) and no sessions to delete (DELETE).
      return json({ error: 'method_not_allowed', detail: 'This MCP server is stateless; send JSON-RPC over POST.' }, 405, { Allow: 'POST' });
    }
    return handleMcp(request, env, cfg.config, ctx, requestId);
  }

  if (url.pathname === '/board' || url.pathname.startsWith('/board/')) {
    if (!cfg.ok) return json({ error: 'server_misconfigured' }, 503);
    const password = basicPassword(request);
    if (!password || !(await secretsMatch(password, cfg.config.boardToken))) {
      return new Response('Dispatcher login required.', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Zuma Dispatch board", charset="UTF-8"', ...SECURITY_HEADERS },
      });
    }
    return board(request, url, env, cfg.config, ctx);
  }

  if (url.pathname === '/hooks/paystack' && request.method === 'POST') {
    if (!cfg.ok) return json({ error: 'server_misconfigured' }, 503); // Paystack retries
    return paystackWebhook(request, env, cfg.config, ctx, requestId);
  }

  if (url.pathname === '/hooks/chord' && request.method === 'POST') {
    return chordWebhook(request, env.DB, env.CHORD_WEBHOOK_SECRET?.trim() || null, requestId);
  }

  if (url.pathname === '/pay/return' && request.method === 'GET') {
    if (!cfg.ok) return json({ error: 'server_misconfigured' }, 503);
    return payReturn(url, env, cfg.config, ctx, requestId);
  }

  return json({ error: 'not_found' }, 404);
}
