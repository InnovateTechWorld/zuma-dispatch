import type { Config } from '../config';
import { getJob, getPayment, transitionJob, type JobRow, type JobStatus } from '../db/repo';
import type { Env } from '../env';
import { normalizeNigerianPhone } from '../lib/phone';
import { formatNaira } from '../lib/money';
import { escapeHtml as h } from '../lib/text';
import { log } from '../lib/log';
import { ToolError, type ToolContext } from '../mcp/tooling';
import { checkPayments } from '../payments/service';

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

export async function board(request: Request, url: URL, env: Env, config: Config): Promise<Response> {
  if (request.method === 'POST') return boardAction(request, url, env);
  const jobs = await env.DB.prepare(
    `SELECT j.*, pu.label AS pickup_label, dr.label AS dropoff_label, q.package_size, q.approximate,
            (SELECT json_extract(e.detail_json, '$.via') FROM job_events e WHERE e.job_id = j.id AND e.to_status = 'paid' ORDER BY e.id DESC LIMIT 1) AS paid_via
       FROM jobs j JOIN quotes q ON q.id = j.quote_id
       LEFT JOIN places pu ON pu.id = q.pickup_place_id LEFT JOIN places dr ON dr.id = q.dropoff_place_id
      ORDER BY j.created_at DESC LIMIT 50`,
  ).all<BoardRow>();
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
  const time = (ms: number) => new Date(ms + 3_600_000).toISOString().slice(5, 16).replace('T', ' ') + ' WAT';
  const flash = url.searchParams.get('msg');

  const rows = jobs.results
    .map((j) => {
      const phone = normalizeNigerianPhone(j.recipient_phone);
      const buttons = Object.entries(ACTIONS)
        .filter(([, a]) => a.from.includes(j.status))
        .map(([key, a]) => `<form method="post" action="/board/jobs/${h(j.id)}"><input type="hidden" name="action" value="${key}"><input type="hidden" name="version" value="${j.version}"><button>${a.label}</button></form>`)
        .join(' ');
      return `<tr><td><code>${h(j.id)}</code><div class="muted">${time(j.created_at)}</div></td>
<td><span class="pill s-${h(j.status)}">${h(j.status.replace('_', ' '))}</span>${j.paid_via ? `<div class="muted">paid via ${h(PAID_VIA[j.paid_via] ?? j.paid_via)}</div>` : ''}</td>
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

  const callHtml = calls.results
    .map((c) => `<tr><td>${time(c.created_at)}</td><td><code>${h(c.tool)}</code></td><td>${c.ok ? 'ok' : h(c.error_code ?? 'error')}</td><td>${c.latency_ms} ms</td><td class="muted"><code>${h(c.detail ?? '')}</code></td></tr>`)
    .join('');

  return page(
    `${config.businessName} board`,
    `<h1>${h(config.businessName)} dispatcher board</h1><p class="muted">Test mode · refreshes every 30 s · statuses here are what the WhatsApp agent reports to customers.</p>
${flash ? `<div class="card">${h(flash)}</div>` : ''}${escalationHtml}${reviewHtml}
<div class="card"><table><tr><th>Job</th><th>Status</th><th>Route</th><th>Size</th><th>Amount</th><th>Sender → recipient</th><th>Actions</th></tr>${rows || '<tr><td colspan="7" class="muted">No jobs yet.</td></tr>'}</table></div>
${noticeHtml}
<div class="card"><h2>Recent tool calls</h2><table><tr><th>When</th><th>Tool</th><th>Result</th><th>Latency</th><th>Provider path</th></tr>${callHtml || '<tr><td colspan="5" class="muted">None yet.</td></tr>'}</table></div>`,
    200,
    30,
  );
}

async function boardAction(request: Request, url: URL, env: Env): Promise<Response> {
  // Basic-auth credentials are sent automatically by the browser, so block cross-site form posts (CSRF).
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  if ((origin && origin !== url.origin) || (site && site !== 'same-origin')) {
    return page('Forbidden', '<h1>Forbidden</h1><p>Cross-site request blocked.</p>', 403);
  }
  const id = /^\/board\/jobs\/(ZD-[0-9A-Z]{5})$/.exec(url.pathname)?.[1];
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
  const msg = ok ? `${id}: ${action.label.toLowerCase()} ✓` : `${id} could not change from ${job.status}.`;
  return Response.redirect(`${url.origin}/board?msg=${encodeURIComponent(msg)}`, 303);
}
