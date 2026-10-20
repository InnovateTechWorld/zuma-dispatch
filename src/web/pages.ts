import type { Config } from '../config';
import { getJob, getPayment, transitionJob, type JobRow, type JobStatus, type PaymentRow } from '../db/repo';
import type { Env } from '../env';
import { normalizeNigerianPhone } from '../lib/phone';
import { formatNaira } from '../lib/money';
import { escapeHtml as h } from '../lib/text';
import { log } from '../lib/log';
import { ToolError, type ToolContext } from '../mcp/tooling';
import { checkPayments } from '../payments/service';
import { mirrorStatus, resyncAll } from '../sheets/mirror';
import { queueSheetSync } from '../sheets/queue';

const SECURITY = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function page(title: string, body: string, status = 200, refreshSeconds?: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ''}<title>${h(title)}</title>
<style>
:root{--bg:#f7f6f2;--fg:#1c1b17;--muted:#6b6960;--card:#fff;--line:#e4e1d8;--ok:#1f7a4d;--warn:#a15c00;--bad:#b42318;--accent:#0f5fd7}
@media (prefers-color-scheme:dark){:root{--bg:#141310;--fg:#ecebe6;--muted:#a3a093;--card:#1d1c18;--line:#34322b;--ok:#4cc38a;--warn:#f0a43a;--bad:#ff7b72;--accent:#6ea8ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);white-space:nowrap}.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid currentColor}
.s-paid,.s-delivered{color:var(--ok)}.s-dispatched{color:var(--accent)}.s-awaiting_payment{color:var(--muted)}.s-payment_failed,.s-cancelled{color:var(--warn)}.s-amount_mismatch{color:var(--bad)}
button{font:inherit;padding:4px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}button:hover{border-color:var(--fg)}
form{display:inline}.big{font-size:18px}code{font-family:ui-monospace,Menlo,monospace;font-size:13px}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: SECURITY });
}

function toolCtx(env: Env, config: Config, ctx: ExecutionContext, requestId: string, origin: string): ToolContext {
  return { env, config, db: env.DB, requestId, now: () => Date.now(), waitUntil: (p) => ctx.waitUntil(p), publicOrigin: origin, trace: [] };
}

// ------------------------------------------------------------------ /pay/return
/**
 * Paystack redirects the customer here after checkout (?reference=...). The redirect itself
 * proves nothing, so we verify server-side (same code path as verify_payment) and show the result.
 */
export async function payReturn(url: URL, env: Env, config: Config, ctx: ExecutionContext, requestId: string): Promise<Response> {
  const reference = (url.searchParams.get('reference') ?? url.searchParams.get('trxref') ?? '').slice(0, 40);
  const payment = /^[A-Za-z0-9.=-]+$/.test(reference) ? await getPayment(env.DB, reference) : null;
  if (!payment) return page('Payment', `<h1>We couldn't find that payment</h1><p class="muted">Please go back to WhatsApp and message us.</p>`, 404);
  const job = await getJob(env.DB, payment.job_id);
  if (!job) return page('Payment', `<h1>We couldn't find that booking</h1>`, 404);

  let headline: string;
  let detail: string;
  try {
    const check = await checkPayments(toolCtx(env, config, ctx, requestId, url.origin), job, { via: 'return_page' });
    if (check.needsReview) {
      headline = 'We are checking your payment';
      detail = 'A dispatcher will confirm shortly. Please go back to WhatsApp.';
    } else if (check.outcome === 'paid') {
      headline = `Payment received for ${h(job.id)}`;
      detail = `${formatNaira(job.amount_kobo)} paid. Go back to WhatsApp and reply <b>paid</b>. We'll confirm your pickup there.`;
    } else if (check.outcome === 'in_progress') {
      headline = 'Your payment is still processing';
      detail = 'Complete any OTP or bank step, then go back to WhatsApp.';
    } else if (url.searchParams.get('cancelled')) {
      headline = 'Payment cancelled';
      detail = 'No money was taken. You can pay later from the same link in WhatsApp.';
    } else {
      headline = 'Payment not completed';
      detail = 'No money was taken. You can try again from the link in WhatsApp.';
    }
  } catch (e) {
    log('warn', 'pay_return_check_failed', { request_id: requestId, message: e instanceof ToolError ? e.code : String(e) });
    headline = 'Thanks!';
    detail = 'Go back to WhatsApp and reply <b>paid</b>. We will confirm your payment there.';
  }
  return page(`${config.businessName} payment`, `<p class="muted">${h(config.businessName)} · test mode</p><h1>${headline}</h1><p class="big">${detail}</p>`);
}

// ------------------------------------------------------------------ /board
const PAID_VIA: Record<string, string> = {
  paystack_webhook: 'Paystack notification',
  return_page: 'checkout return page',
  verify: 'customer check',
  link_request: 'link request',
  cancel: 'cancel check',
};

const ACTIONS: Record<string, { from: JobStatus[]; to: JobStatus; label: string }> = {
  dispatch: { from: ['paid'], to: 'dispatched', label: 'Mark dispatched' },
  deliver: { from: ['dispatched'], to: 'delivered', label: 'Mark delivered' },
  approve: { from: ['amount_mismatch'], to: 'paid', label: 'Approve payment' },
  cancel: { from: ['awaiting_payment', 'payment_failed', 'amount_mismatch'], to: 'cancelled', label: 'Cancel' },
};

interface BoardRow extends JobRow {
  paid_via: string | null;
  pickup_label: string | null;
  dropoff_label: string | null;
  package_size: string | null;
  approximate: number | null;
}

const STATUSES: JobStatus[] = ['awaiting_payment', 'paid', 'dispatched', 'delivered', 'payment_failed', 'amount_mismatch', 'cancelled'];
const time = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(5, 16).replace('T', ' ') + ' WAT';

/** Turns the search box into SQL conditions: a job id, a phone number, or part of a name or address. */
export function searchFilter(raw: string): { sql: string; binds: unknown[] } | null {
  const q = raw.trim().slice(0, 80);
  if (!q) return null;
  const id = /^zd-?[0-9a-z]{5}$/i.test(q) ? `ZD-${q.replace(/^zd-?/i, '').toUpperCase()}` : null;
  if (id) return { sql: 'j.id = ?', binds: [id] };
  const phone = normalizeNigerianPhone(q);
  if (phone.ok) return { sql: 'j.recipient_phone = ?', binds: [phone.e164] };
  const like = `%${q.toLowerCase().replace(/[%_\\]/g, '')}%`;
  return {
    sql: '(lower(j.sender_name) LIKE ? OR lower(j.recipient_name) LIKE ? OR lower(pu.label) LIKE ? OR lower(dr.label) LIKE ?)',
    binds: [like, like, like, like],
  };
}

export async function board(request: Request, url: URL, env: Env, config: Config, execCtx: ExecutionContext): Promise<Response> {
  if (request.method === 'POST' && url.pathname === '/board/sheet/resync') return sheetResync(request, url, env);
  if (request.method === 'POST') return boardAction(request, url, env, execCtx);
  const detail = /^\/board\/jobs\/(ZD-[0-9A-Z]{5})$/.exec(url.pathname)?.[1];
  if (detail) return jobDetail(detail, url, env, config);
  if (url.pathname !== '/board') return page('Not found', '<h1>Not found</h1><p><a href="/board">Back to the board</a></p>', 404);

  const statusFilter = url.searchParams.get('status') ?? '';
  const search = url.searchParams.get('q') ?? '';
  const where: string[] = [];
  const binds: unknown[] = [];
  if ((STATUSES as string[]).includes(statusFilter)) {
    where.push('j.status = ?');
    binds.push(statusFilter);
  }
  const sf = searchFilter(search);
  if (sf) {
    where.push(sf.sql);
    binds.push(...sf.binds);
  }
  const jobs = await env.DB.prepare(
    `SELECT j.*, pu.label AS pickup_label, dr.label AS dropoff_label, q.package_size, q.approximate,
            (SELECT json_extract(e.detail_json, '$.via') FROM job_events e WHERE e.job_id = j.id AND e.to_status = 'paid' ORDER BY e.id DESC LIMIT 1) AS paid_via
       FROM jobs j JOIN quotes q ON q.id = j.quote_id
       LEFT JOIN places pu ON pu.id = q.pickup_place_id LEFT JOIN places dr ON dr.id = q.dropoff_place_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY j.created_at DESC LIMIT 100`,
  )
    .bind(...binds)
    .all<BoardRow>();
  const counts = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all<{ status: string; n: number }>();
  const reviews = await env.DB.prepare(
    `SELECT job_id, detail_json, created_at FROM job_events WHERE type = 'needs_review' ORDER BY id DESC LIMIT 10`,
  ).all<{ job_id: string; detail_json: string | null; created_at: number }>();
  const notices = await env.DB.prepare(
    'SELECT event, reference, job_id, outcome, ip_trusted, received_at FROM paystack_events ORDER BY received_at DESC LIMIT 8',
  ).all<{ event: string; reference: string | null; job_id: string | null; outcome: string; ip_trusted: number; received_at: number }>();
  const escalations = await env.DB.prepare(
    `SELECT thread_id, initiator, reason, received_at FROM chord_events WHERE type = 'conversation.escalated' ORDER BY received_at DESC LIMIT 10`,
  ).all<{ thread_id: string | null; initiator: string | null; reason: string | null; received_at: number }>();
  const calls = await env.DB.prepare('SELECT tool, ok, error_code, latency_ms, detail, created_at FROM tool_calls ORDER BY id DESC LIMIT 15').all<{
    tool: string; ok: number; error_code: string | null; latency_ms: number; detail: string | null; created_at: number;
  }>();
  const flash = url.searchParams.get('msg');

  const rows = jobs.results
    .map((j) => {
      const phone = normalizeNigerianPhone(j.recipient_phone);
      const buttons = Object.entries(ACTIONS)
        .filter(([, a]) => a.from.includes(j.status))
        .map(([key, a]) => `<form method="post" action="/board/jobs/${h(j.id)}"><input type="hidden" name="action" value="${key}"><input type="hidden" name="version" value="${j.version}"><button>${a.label}</button></form>`)
        .join(' ');
      return `<tr><td><a href="/board/jobs/${h(j.id)}"><code>${h(j.id)}</code></a><div class="muted">${time(j.created_at)}</div></td>
<td><span class="pill s-${h(j.status)}">${h(j.status.replaceAll('_', ' '))}</span>${j.paid_via ? `<div class="muted">paid via ${h(PAID_VIA[j.paid_via] ?? j.paid_via)}</div>` : ''}</td>
<td>${h(j.pickup_label ?? '?')}<div class="muted">→ ${h(j.dropoff_label ?? '?')}</div></td>
<td>${h(j.package_size ?? '')}${j.approximate ? ' <span class="muted">(est. distance)</span>' : ''}</td>
<td><b>${formatNaira(j.amount_kobo)}</b></td>
<td>${h(j.sender_name)} → ${h(j.recipient_name)}<div class="muted">${h(phone.ok ? phone.display : j.recipient_phone)} · code ${h(j.handover_code)}</div></td>
<td>${buttons}</td></tr>`;
    })
    .join('');

  const reviewHtml = reviews.results.length
    ? `<div class="card"><h2>Needs review</h2><table><tr><th>Job</th><th>Reason</th><th>When</th></tr>${reviews.results
        .map((r) => `<tr><td><code>${h(r.job_id)}</code></td><td>${h((JSON.parse(r.detail_json ?? '{}') as { reason?: string }).reason ?? '')}</td><td>${time(r.created_at)}</td></tr>`)
        .join('')}</table></div>`
    : '';

  const escalationHtml = escalations.results.length
    ? `<div class="card"><h2>Handed to a human (from Chord)</h2><p class="muted">Open these in Chord → Teammates → Zuma → Escalated and reply as the operator.</p><table><tr><th>When</th><th>Thread</th><th>By</th><th>Reason</th></tr>${escalations.results
        .map((e) => `<tr><td>${time(e.received_at)}</td><td><code>${h(e.thread_id ?? '?')}</code></td><td>${h(e.initiator ?? '')}</td><td>${h(e.reason ?? '')}</td></tr>`)
        .join('')}</table></div>`
    : '';

  const noticeHtml = notices.results.length
    ? `<div class="card"><h2>Payment notifications (Paystack webhook)</h2><table><tr><th>When</th><th>Event</th><th>Reference</th><th>Job</th><th>Result</th><th>From Paystack IP</th></tr>${notices.results
        .map((n) => `<tr><td>${time(n.received_at)}</td><td><code>${h(n.event)}</code></td><td><code>${h(n.reference ?? '')}</code></td><td><code>${h(n.job_id ?? '')}</code></td><td>${h(n.outcome)}</td><td>${n.ip_trusted ? 'yes' : 'no'}</td></tr>`)
        .join('')}</table></div>`
    : '';

  const mirror = mirrorStatus(env);
  const sheetState = mirror === 'enabled'
    ? await env.DB.prepare("SELECT ok, detail, updated_at FROM sheet_state WHERE key = 'last'").first<{ ok: number; detail: string; updated_at: number }>().catch(() => null)
    : null;
  const sheetHtml = `<div class="card"><h2>Google Sheet mirror</h2>${
    mirror === 'enabled'
      ? `<p><a href="https://docs.google.com/spreadsheets/d/${h(env.GOOGLE_SHEET_ID!.trim())}" rel="noopener noreferrer" target="_blank">Open the sheet</a> · read-only copy, updated after every change.
${sheetState ? ` Last sync ${time(sheetState.updated_at)}: ${sheetState.ok ? 'ok' : `<b>failed</b> (${h(sheetState.detail)})`}.` : ' No sync yet.'}</p>
<form method="post" action="/board/sheet/resync"><button>Resync all</button></form>`
      : mirror === 'invalid_config'
        ? '<p><b>Misconfigured:</b> GOOGLE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT_JSON is invalid. See docs/FEATURES.md §12.</p>'
        : '<p class="muted">Not configured (optional). See docs/FEATURES.md §12.</p>'
  }</div>`;

  const callHtml = calls.results
    .map((c) => `<tr><td>${time(c.created_at)}</td><td><code>${h(c.tool)}</code></td><td>${c.ok ? 'ok' : h(c.error_code ?? 'error')}</td><td>${c.latency_ms} ms</td><td class="muted"><code>${h(c.detail ?? '')}</code></td></tr>`)
    .join('');

  return page(
    `${config.businessName} board`,
    `<h1>${h(config.businessName)} dispatcher board</h1><p class="muted">Test mode · refreshes every 30 s · statuses here are what the WhatsApp agent reports to customers.</p>
${flash ? `<div class="card">${h(flash)}</div>` : ''}${escalationHtml}${reviewHtml}
<div class="card"><form method="get" action="/board" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
<input name="q" value="${h(search)}" placeholder="Job id, phone, name or address" style="flex:1;min-width:220px;font:inherit;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)">
<select name="status" style="font:inherit;padding:6px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)"><option value="">All statuses</option>${STATUSES.map((st) => `<option value="${st}"${st === statusFilter ? ' selected' : ''}>${st.replaceAll('_', ' ')} (${counts.results.find((c) => c.status === st)?.n ?? 0})</option>`).join('')}</select>
<button>Filter</button>${search || statusFilter ? ' <a href="/board">Clear</a>' : ''}</form>
<p class="muted">${jobs.results.length} job(s)${jobs.results.length === 100 ? ' (latest 100; narrow the search to see older ones)' : ''}. Click a job id for everything about it.</p>
<table><tr><th>Job</th><th>Status</th><th>Route</th><th>Size</th><th>Amount</th><th>Sender → recipient</th><th>Actions</th></tr>${rows || `<tr><td colspan="7" class="muted">${search || statusFilter ? 'No jobs match this filter.' : 'No jobs yet.'}</td></tr>`}</table></div>
${noticeHtml}${sheetHtml}
<div class="card"><h2>Recent tool calls</h2><table><tr><th>When</th><th>Tool</th><th>Result</th><th>Latency</th><th>Provider path</th></tr>${callHtml || '<tr><td colspan="5" class="muted">None yet.</td></tr>'}</table></div>`,
    200,
    30,
  );
}

function crossSite(request: Request, url: URL): boolean {
  // Basic-auth credentials are sent automatically by the browser, so block cross-site form posts (CSRF).
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  return Boolean((origin && origin !== url.origin) || (site && site !== 'same-origin'));
}

async function sheetResync(request: Request, url: URL, env: Env): Promise<Response> {
  if (crossSite(request, url)) return page('Forbidden', '<h1>Forbidden</h1><p>Cross-site request blocked.</p>', 403);
  const r = await resyncAll(env, url.origin);
  return Response.redirect(`${url.origin}/board?msg=${encodeURIComponent(r.detail)}`, 303);
}

async function boardAction(request: Request, url: URL, env: Env, execCtx: ExecutionContext): Promise<Response> {
  if (crossSite(request, url)) {
    return page('Forbidden', '<h1>Forbidden</h1><p>Cross-site request blocked.</p>', 403);
  }
  const id = /^\/board\/jobs\/(ZD-[0-9A-Z]{5})$/.exec(url.pathname)?.[1];
  const back = url.searchParams.get('from') === 'detail' && id ? `/board/jobs/${id}` : '/board';
  const form = await request.formData();
  const action = ACTIONS[String(form.get('action'))];
  const version = Number(form.get('version'));
  if (!id || !action) return Response.redirect(`${url.origin}/board?msg=${encodeURIComponent('Unknown action.')}`, 303);
  const job = await getJob(env.DB, id);
  if (!job) return Response.redirect(`${url.origin}/board?msg=${encodeURIComponent(`No job ${id}.`)}`, 303);
  if (job.version !== version) {
    return Response.redirect(`${url.origin}/board?msg=${encodeURIComponent(`${id} changed since you loaded the page (now ${job.status}). Check and try again.`)}`, 303);
  }
  const ok = await transitionJob(env.DB, id, action.from, action.to, 'dispatcher', Date.now(), { action: String(form.get('action')) });
  if (ok) queueSheetSync(env, (p) => execCtx.waitUntil(p), url.origin, id);
  const msg = ok ? `${id}: ${action.label.toLowerCase()} ✓` : `${id} could not change from ${job.status}.`;
  return Response.redirect(`${url.origin}${back}?msg=${encodeURIComponent(msg)}`, 303);
}

// ------------------------------------------------------------------ /board/jobs/:id
interface PlaceDetail {
  label: string; lat: number; lng: number; precision: string; provider: string; confidence: string;
  postcode: string | null; postcode_status: string | null; in_service_area: number; query_text: string;
}

async function jobDetail(id: string, url: URL, env: Env, config: Config): Promise<Response> {
  const job = await getJob(env.DB, id);
  if (!job) return page('Not found', `<h1>No job ${h(id)}</h1><p><a href="/board">Back to the board</a></p>`, 404);
  const quote = await env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(job.quote_id).first<{
    package_size: string; distance_m: number; duration_s: number | null; distance_source: string; approximate: number;
    amount_kobo: number; breakdown_json: string; rate_card_version: string; created_at: number; expires_at: number;
    pickup_place_id: string; dropoff_place_id: string;
  }>();
  const place = (pid?: string) => (pid ? env.DB.prepare('SELECT * FROM places WHERE id = ?').bind(pid).first<PlaceDetail>() : Promise.resolve(null));
  const [pickup, dropoff, payments, events, notices] = await Promise.all([
    place(quote?.pickup_place_id),
    place(quote?.dropoff_place_id),
    env.DB.prepare('SELECT * FROM payments WHERE job_id = ? ORDER BY attempt').bind(id).all<PaymentRow>(),
    env.DB.prepare('SELECT type, from_status, to_status, actor, detail_json, created_at FROM job_events WHERE job_id = ? ORDER BY id').bind(id).all<{
      type: string; from_status: string | null; to_status: string | null; actor: string; detail_json: string | null; created_at: number;
    }>(),
    env.DB.prepare('SELECT event, reference, outcome, ip_trusted, received_at FROM paystack_events WHERE job_id = ? ORDER BY received_at').bind(id).all<{
      event: string; reference: string | null; outcome: string; ip_trusted: number; received_at: number;
    }>(),
  ]);
  const phone = normalizeNigerianPhone(job.recipient_phone);
  const flash = url.searchParams.get('msg');
  const placeCard = (title: string, p: PlaceDetail | null) =>
    p
      ? `<h3>${title}</h3><p><b>${h(p.label)}</b><br><span class="muted">Customer typed: "${h(p.query_text)}"</span></p>
<table><tr><th>Precision</th><td>${h(p.precision)}</td><th>Found by</th><td>${h(p.provider)} (${h(p.confidence)} confidence)</td></tr>
<tr><th>Postcode</th><td>${p.postcode ? `${h(p.postcode)} · NIPOST: ${h(p.postcode_status ?? '?')}` : '—'}</td><th>Service area</th><td>${p.in_service_area ? 'inside' : 'outside'}</td></tr>
<tr><th>Map</th><td colspan="3"><a href="https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=17/${p.lat}/${p.lng}" rel="noopener noreferrer" target="_blank">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</a></td></tr></table>`
      : `<h3>${title}</h3><p class="muted">Not found.</p>`;
  const buttons = Object.entries(ACTIONS)
    .filter(([, a]) => a.from.includes(job.status))
    .map(([key, a]) => `<form method="post" action="/board/jobs/${h(job.id)}?from=detail"><input type="hidden" name="action" value="${key}"><input type="hidden" name="version" value="${job.version}"><button>${a.label}</button></form>`)
    .join(' ');
  const lines = quote ? (JSON.parse(quote.breakdown_json) as { label: string; amount: string }[]) : [];
  const payRows = payments.results
    .map((p) => {
      const where = p.method === 'bank_transfer'
        ? `${h(p.transfer_bank ?? '')} ${h(p.transfer_account_number ?? '')}${p.transfer_expires_at ? `<div class="muted">expires ${time(p.transfer_expires_at)}</div>` : ''}`
        : p.authorization_url ? `<a href="${h(p.authorization_url)}" rel="noopener noreferrer" target="_blank">checkout link</a>` : '<span class="muted">no link (initialize did not finish)</span>';
      return `<tr><td>#${p.attempt}</td><td>${p.method === 'bank_transfer' ? 'bank transfer' : 'link'}</td><td><code>${h(p.reference)}</code></td><td>${formatNaira(p.amount_kobo)}</td><td><b>${h(p.status)}</b>${p.gateway_response ? `<div class="muted">${h(p.gateway_response)}</div>` : ''}</td><td>${h(p.channel ?? '')}</td><td>${where}</td><td>${time(p.created_at)}${p.paid_at ? `<div class="muted">paid ${time(p.paid_at)}</div>` : ''}</td></tr>`;
    })
    .join('');
  const eventRows = events.results
    .map((e) => {
      let detail = '';
      try {
        const d = e.detail_json ? (JSON.parse(e.detail_json) as Record<string, unknown>) : {};
        detail = Object.entries(d).map(([k, v]) => `${k}: ${String(v)}`).join(' · ');
      } catch {
        detail = e.detail_json ?? '';
      }
      return `<tr><td>${time(e.created_at)}</td><td>${h(e.type.replaceAll('_', ' '))}</td><td>${e.from_status || e.to_status ? `${h(e.from_status ?? '')} → ${h(e.to_status ?? '')}` : ''}</td><td>${h(e.actor)}</td><td class="muted">${h(detail)}</td></tr>`;
    })
    .join('');
  const noticeRows = notices.results
    .map((n) => `<tr><td>${time(n.received_at)}</td><td><code>${h(n.event)}</code></td><td><code>${h(n.reference ?? '')}</code></td><td>${h(n.outcome)}</td><td>${n.ip_trusted ? 'yes' : 'no'}</td></tr>`)
    .join('');

  return page(
    `${job.id} · ${config.businessName}`,
    `<p><a href="/board">← All jobs</a></p>
<h1>${h(job.id)} <span class="pill s-${h(job.status)}">${h(job.status.replaceAll('_', ' '))}</span></h1>
<p class="muted">Booked ${time(job.created_at)} · last change ${time(job.updated_at)}${job.paid_at ? ` · paid ${time(job.paid_at)}` : ''}${job.cancel_reason ? ` · cancelled: "${h(job.cancel_reason)}"` : ''}</p>
${flash ? `<div class="card">${h(flash)}</div>` : ''}
<div class="card"><table>
<tr><th>Sender</th><td>${h(job.sender_name)}</td><th>Recipient</th><td>${h(job.recipient_name)} · ${h(phone.ok ? phone.display : job.recipient_phone)}</td></tr>
<tr><th>Amount</th><td><b>${formatNaira(job.amount_kobo)}</b></td><th>Handover code</th><td><code>${h(job.handover_code)}</code></td></tr>
<tr><th>Package</th><td>${h(quote?.package_size ?? '?')}${job.package_note ? ` · "${h(job.package_note)}"` : ''}</td><th>Actions</th><td>${buttons || '<span class="muted">none for this status</span>'}</td></tr>
</table></div>
<div class="card">${placeCard('Pickup', pickup)}${placeCard('Drop-off', dropoff)}</div>
<div class="card"><h3>Quote <code>${h(job.quote_id)}</code></h3>${quote ? `<p>${(quote.distance_m / 1000).toFixed(1)} km by ${h(quote.distance_source)}${quote.approximate ? ' (estimated: route service unavailable)' : ''}${quote.duration_s ? ` · about ${Math.round(quote.duration_s / 60)} min` : ''} · rate card ${h(quote.rate_card_version)} · quoted ${time(quote.created_at)}</p>
<table>${lines.map((l) => `<tr><td>${h(l.label)}</td><td>${h(l.amount)}</td></tr>`).join('')}<tr><th>Total</th><th>${formatNaira(quote.amount_kobo)}</th></tr></table>` : '<p class="muted">Quote missing.</p>'}</div>
<div class="card"><h3>Payment attempts</h3><table><tr><th>#</th><th>Method</th><th>Reference</th><th>Amount</th><th>Paystack status</th><th>Channel</th><th>Link / account</th><th>When</th></tr>${payRows || '<tr><td colspan="8" class="muted">No payment requested yet.</td></tr>'}</table></div>
${noticeRows ? `<div class="card"><h3>Paystack notifications</h3><table><tr><th>When</th><th>Event</th><th>Reference</th><th>Result</th><th>From Paystack IP</th></tr>${noticeRows}</table></div>` : ''}
<div class="card"><h3>Timeline</h3><table><tr><th>When</th><th>What</th><th>Status</th><th>By</th><th>Detail</th></tr>${eventRows}</table></div>`,
  );
}
