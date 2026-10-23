import { loadConfig } from './config';
import { cleanupTestRun } from './admin/testCleanup';
import { runWatchdogLoop } from './chord/watchdog';
import type { Env } from './env';
import { bearerToken, secretsMatch } from './lib/auth';
import { log } from './lib/log';
import { handleMcp, SERVER_VERSION } from './mcp/server';
import { chordWebhook } from './web/chordWebhook';
import { paystackWebhook } from './web/paystackWebhook';
import { mirrorStatus } from './sheets/mirror';
import { noticeStatus } from './chord/notices';
import { boardGate } from './web/login';
import { payReturn } from './web/pages';

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
  /** Every minute (wrangler.jsonc triggers): hand over chats where a person was promised, flag made-up links. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const beat = (ok: boolean, detail: string) =>
      env.DB.prepare('INSERT INTO cron_runs (name, ran_at, ok, detail) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET ran_at = excluded.ran_at, ok = excluded.ok, detail = excluded.detail')
        .bind('watchdog', Date.now(), ok ? 1 : 0, detail.slice(0, 500))
        .run()
        .catch(() => undefined);
    ctx.waitUntil(
      runWatchdogLoop(env)
        .then(async (r) => {
          if (r.actions.length) log('info', 'watchdog', { checked: r.checked, actions: r.actions.join(' ; ').slice(0, 900) });
          const failed = r.actions.some((x) => /^list failed/.test(x)) || r.actions.includes('skipped: CHORD_API_KEY not set');
          await beat(!failed, `checked ${r.checked} chat(s)${r.actions.length ? `; ${r.actions.join(' ; ')}` : ''}`);
        })
        .catch(async (e: unknown) => {
          log('error', 'watchdog_failed', { message: e instanceof Error ? e.message : String(e) });
          await beat(false, e instanceof Error ? e.message : String(e));
        }),
    );
  },
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
        chat_payment_notices: noticeStatus(env),
        paystack_webhook: '/hooks/paystack',
        chord_webhook: env.CHORD_WEBHOOK_SECRET ? 'configured' : 'not_configured',
      },
      healthy ? 200 : 503,
    );
  }

  if (url.pathname === '/mcp' || url.pathname === '/mcp/test-cleanup') {
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
    if (url.pathname === '/mcp/test-cleanup') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
      const body = (await request.json().catch(() => null)) as { run?: unknown } | null;
      const r = await cleanupTestRun(env, typeof body?.run === 'string' ? body.run : '', Date.now(), url.origin);
      return r.ok ? json(r.result) : json({ error: r.error }, r.status);
    }
    if (request.method !== 'POST') {
      // Stateless server: no standalone SSE stream (GET) and no sessions to delete (DELETE).
      return json({ error: 'method_not_allowed', detail: 'This MCP server is stateless; send JSON-RPC over POST.' }, 405, { Allow: 'POST' });
    }
    return handleMcp(request, env, cfg.config, ctx, requestId);
  }

  if (url.pathname === '/board' || url.pathname.startsWith('/board/')) {
    if (!cfg.ok) return json({ error: 'server_misconfigured' }, 503);
    return boardGate(request, url, env, cfg.config, ctx, requestId);
  }

  if (url.pathname === '/hooks/paystack' && request.method === 'POST') {
    if (!cfg.ok) return json({ error: 'server_misconfigured' }, 503); // Paystack retries
    return paystackWebhook(request, env, cfg.config, ctx, requestId);
  }

  if (url.pathname === '/hooks/chord' && request.method === 'POST') {
    return chordWebhook(request, env.DB, env.CHORD_WEBHOOK_SECRET?.trim() || null, requestId, { env, waitUntil: (p) => ctx.waitUntil(p), origin: url.origin });
  }

  if (url.pathname === '/pay/return' && request.method === 'GET') {
    if (!cfg.ok) return json({ error: 'server_misconfigured' }, 503);
    return payReturn(url, env, cfg.config, ctx, requestId);
  }

  return json({ error: 'not_found' }, 404);
}
