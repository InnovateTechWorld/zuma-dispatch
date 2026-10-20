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
import { NOTICE_KIND, noticeStatus, notifyPaymentReceived, queueChatNotice, TAKEOVER_REASON } from '../chord/notices';
import {
  breakdown, CHART_CSS, lastSevenDays, pct, percentiles, pipelineChart, STATUS_ORDER, watDayStart, weekChart,
  type DayRow,
} from './charts';
import { footLine, notice, page, statusPill, time, topBar } from './layout';
import { crossSite, safeNext, sha256Hex } from './session';

function toolCtx(env: Env, config: Config, ctx: ExecutionContext, requestId: string, origin: string): ToolContext {
  return { env, config, db: env.DB, requestId, now: () => Date.now(), waitUntil: (p) => ctx.waitUntil(p), publicOrigin: origin, trace: [] };
}

// ------------------------------------------------------------------ /pay/return
const PAY_CSS = `.pay{max-width:40rem;padding-block:clamp(2.5rem,10vh,6rem) clamp(3.5rem,14vh,8rem)}.pay h1{margin-top:var(--space-2xs)}.pay__detail{margin-top:var(--space-sm);font-size:var(--text-md);color:var(--color-ink-2);max-width:56ch}`;

/**
 * Paystack redirects the customer here after checkout (?reference=...). The redirect itself
 * proves nothing, so we verify server-side (same code path as verify_payment) and show the result.
 */
export async function payReturn(url: URL, env: Env, config: Config, ctx: ExecutionContext, requestId: string): Promise<Response> {
  const shell = (title: string, headline: string, detail: string, status = 200) =>
    page({
      title,
      status,
      css: PAY_CSS,
      body: `<header class="bar"><div class="wrap bar__in"><span class="brand"><span class="brand__mark" aria-hidden="true"></span>${h(config.businessName)}</span><span class="chip">Test mode</span></div></header>
<main class="wrap pay"><p class="label">Payment</p><h1>${headline}</h1><p class="pay__detail">${detail}</p></main>`,
    });
  const reference = (url.searchParams.get('reference') ?? url.searchParams.get('trxref') ?? '').slice(0, 40);
  const payment = /^[A-Za-z0-9.=-]+$/.test(reference) ? await getPayment(env.DB, reference) : null;
  if (!payment) return shell('Payment', "We couldn't find that payment", 'Please go back to WhatsApp and message us.', 404);
  const job = await getJob(env.DB, payment.job_id);
  if (!job) return shell('Payment', "We couldn't find that booking", 'Please go back to WhatsApp and message us.', 404);

  let headline: string;
  let detail: string;
  try {
    const check = await checkPayments(toolCtx(env, config, ctx, requestId, url.origin), job, { via: 'return_page' });
    if (check.needsReview) {
      headline = 'We are checking your payment';
      detail = 'A dispatcher will confirm shortly. Please go back to WhatsApp.';
    } else if (check.outcome === 'paid') {
      headline = `Payment received for ${h(job.id)}`;
      detail = noticeStatus(env) === 'enabled'
        ? `${formatNaira(job.amount_kobo)} paid. Go back to WhatsApp: the confirmation and pickup time will be there in a minute.`
        : `${formatNaira(job.amount_kobo)} paid. Go back to WhatsApp and reply <b>paid</b>. We'll confirm your pickup there.`;
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
  return shell(`${config.businessName} payment`, headline, detail);
}

// ------------------------------------------------------------------ /board
const PAID_VIA: Record<string, string> = {
  paystack_webhook: 'Paystack notification',
  return_page: 'Checkout return page',
  verify: 'Customer asked',
  link_request: 'New link request',
  cancel: 'Cancel check',
  dispatcher: 'Dispatcher approval',
};

const ACTIONS: Record<string, { from: JobStatus[]; to: JobStatus; label: string; tone?: 'danger' | 'primary' }> = {
  dispatch: { from: ['paid'], to: 'dispatched', label: 'Mark dispatched', tone: 'primary' },
  deliver: { from: ['dispatched'], to: 'delivered', label: 'Mark delivered', tone: 'primary' },
  approve: { from: ['amount_mismatch'], to: 'paid', label: 'Approve payment' },
  cancel: { from: ['awaiting_payment', 'payment_failed', 'amount_mismatch'], to: 'cancelled', label: 'Cancel', tone: 'danger' },
};

interface BoardRow extends JobRow {
  paid_via: string | null;
  pickup_label: string | null;
  dropoff_label: string | null;
  package_size: string | null;
  approximate: number | null;
  distance_m: number | null;
}

const STATUSES: JobStatus[] = [...STATUS_ORDER];
const LIST_LIMIT = 100;

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

export interface ListQuery { status: string; q: string; live: boolean }

/** Reads the list filters from the URL; an unknown status is ignored rather than matching nothing. */
export function listQuery(url: URL): ListQuery {
  const status = url.searchParams.get('status') ?? '';
  return {
    status: (STATUSES as string[]).includes(status) ? status : '',
    q: (url.searchParams.get('q') ?? '').trim().slice(0, 80),
    live: url.searchParams.get('live') === '1',
  };
}

/** A board URL for these filters; empty values are left out so links stay short and shareable. */
export function listHref(f: Partial<ListQuery>): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.status) p.set('status', f.status);
  if (f.live) p.set('live', '1');
  const s = p.toString();
  return s ? `/board?${s}` : '/board';
}

function actionForms(job: { id: string; status: JobStatus; version: number }, back: string, small: boolean): string {
  return Object.entries(ACTIONS)
    .filter(([, a]) => a.from.includes(job.status))
    .map(
      ([key, a]) =>
        `<form class="inline" method="post" action="/board/jobs/${h(job.id)}"><input type="hidden" name="action" value="${key}"><input type="hidden" name="version" value="${job.version}"><input type="hidden" name="back" value="${h(back)}"><button class="btn${small ? ' btn--sm' : ''}${a.tone === 'danger' || (a.tone && !small) ? ` btn--${a.tone}` : ''}" type="submit">${a.label}</button></form>`,
    )
    .join('');
}

const BOARD_CSS = `
.head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:var(--space-sm);padding-block:var(--space-lg) var(--space-md)}
.head__meta{display:flex;flex-wrap:wrap;gap:var(--space-3xs) var(--space-sm);align-items:center;font-size:var(--text-sm);color:var(--color-muted)}
.head__meta a{white-space:nowrap}
.flash{margin-bottom:var(--space-md)}
.attn{list-style:none;margin:0 0 var(--space-lg);padding:0;display:flex;flex-wrap:wrap;gap:var(--space-xs)}
.attn a{display:inline-flex;align-items:center;gap:var(--space-2xs);min-height:var(--control);padding:0 var(--space-sm);border:1px solid var(--color-rule-2);border-radius:var(--radius);background:var(--color-surface);color:var(--color-ink);text-decoration:none;font-size:var(--text-sm);white-space:nowrap}
.attn a:hover{border-color:var(--color-ink-2)}
.attn__n{font:600 var(--text-md)/1 var(--font-display)}
.attn a.is-urgent{border-color:var(--color-bad);background:var(--color-bad-wash)}
.attn__none{color:var(--color-muted);font-size:var(--text-sm);margin-bottom:var(--space-lg)}
.list{padding-block:var(--space-lg)}
.tabs{display:flex;flex-wrap:wrap;gap:var(--space-3xs) var(--space-2xs);margin:0 0 var(--space-sm);padding:0;list-style:none}
.tabs a{display:inline-flex;align-items:center;gap:var(--space-2xs);height:var(--control-sm);padding:0 var(--space-xs);border:1px solid transparent;border-radius:var(--radius);color:var(--color-ink-2);text-decoration:none;font-size:var(--text-sm);white-space:nowrap}
.tabs a:hover{border-color:var(--color-rule-2);color:var(--color-ink)}
.tabs a[aria-current="page"]{border-color:var(--color-ink);color:var(--color-ink);font-weight:600}
.tabs .num{color:var(--color-muted);font-size:var(--text-xs)}
.search{display:flex;gap:var(--space-2xs);align-items:center;margin-bottom:var(--space-xs)}
.search .input{flex:1}
.search label{flex:none}
.result{display:flex;flex-wrap:wrap;gap:var(--space-3xs) var(--space-sm);font-size:var(--text-sm);color:var(--color-muted);margin-bottom:var(--space-sm);min-height:1lh}
.jobs td:first-child{white-space:nowrap}.jobs td:first-child a{font-family:var(--font-mono);font-weight:500}
.jobs .amt{font-weight:600;color:var(--color-ink);white-space:nowrap}
.jobs .route{min-width:14rem}
.jobs td.act{white-space:nowrap}
.panels .section:first-child{border-top:0}
@media (max-width:48rem){
  .head{align-items:flex-start}
  .search{flex-wrap:wrap}.search .input{flex-basis:100%}
  .table-wrap.jobs-wrap{overflow:visible;border:0;background:transparent;border-radius:0}
  .jobs thead{display:none}
  .jobs,.jobs tbody{display:block;width:100%}
  .jobs tr{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--space-2xs) var(--space-sm);padding:var(--space-sm) 0;border-top:1px solid var(--color-rule)}
  .jobs td{display:block;border:0;padding:0;min-width:0}
  .jobs td.route,.jobs td.people,.jobs td.act,.jobs td.empty{grid-column:1/-1}
  .jobs td.act.is-empty{display:none}
  .jobs td[data-label]::before{content:attr(data-label);display:block;font:500 var(--text-2xs)/1.6 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--color-muted)}
  .jobs .route{min-width:0}
  .jobs td.act{white-space:normal;padding-top:var(--space-3xs)}
  .jobs td.act .btn{height:var(--control)}
  tbody tr:hover>td{background:transparent}
}
${CHART_CSS}`;

interface Counted { status: string; n: number }

export async function board(request: Request, url: URL, env: Env, config: Config, execCtx: ExecutionContext, session: { signedIn: boolean }): Promise<Response> {
  if (request.method === 'POST' && url.pathname === '/board/sheet/resync') return sheetResync(request, url, env);
  if (request.method === 'POST') return boardAction(request, url, env, execCtx);
  const detail = /^\/board\/jobs\/(ZD-[0-9A-Z]{5})$/.exec(url.pathname)?.[1];
  if (detail) return jobDetail(detail, url, env, config, session);
  if (url.pathname !== '/board') {
    return page({ title: 'Not found', status: 404, body: `${bar(config, session)}<main class="wrap head"><div><h1>Not found</h1><p class="muted"><a href="/board">Back to the board</a></p></div></main>` });
  }

  const f = listQuery(url);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.status) {
    where.push('j.status = ?');
    binds.push(f.status);
  }
  const sf = searchFilter(f.q);
  if (sf) {
    where.push(sf.sql);
    binds.push(...sf.binds);
  }
  const now = Date.now();
  const today = watDayStart(now);
  const db = env.DB;
  const mirror = mirrorStatus(env);
  // One round trip to D1 for everything on the page.
  const [jobs, counts, reviews, notices, escalations, calls, daily, via, method, paidToday, owed, sheetState, noticeRows2] = await db.batch([
    db.prepare(
      `SELECT j.*, pu.label AS pickup_label, dr.label AS dropoff_label, q.package_size, q.approximate, q.distance_m,
              (SELECT json_extract(e.detail_json, '$.via') FROM job_events e WHERE e.job_id = j.id AND e.to_status = 'paid' ORDER BY e.id DESC LIMIT 1) AS paid_via
         FROM jobs j JOIN quotes q ON q.id = j.quote_id
         LEFT JOIN places pu ON pu.id = q.pickup_place_id LEFT JOIN places dr ON dr.id = q.dropoff_place_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY j.created_at DESC LIMIT ${LIST_LIMIT + 1}`,
    ).bind(...binds),
    db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status'),
    db.prepare(`SELECT job_id, detail_json, created_at FROM job_events WHERE type = 'needs_review' ORDER BY id DESC LIMIT 10`),
    db.prepare('SELECT event, reference, job_id, outcome, ip_trusted, received_at FROM paystack_events ORDER BY received_at DESC LIMIT 8'),
    // Our own momentary take-overs (to post "payment received") also fire conversation.escalated; they are
    // not real handovers. Recognised by our reason text, or by a chat notice on that thread at that moment.
    db.prepare(
      `SELECT thread_id, initiator, reason, received_at FROM chord_events c
        WHERE type = 'conversation.escalated' AND COALESCE(reason, '') NOT LIKE ?
          AND NOT EXISTS (SELECT 1 FROM chat_notices n WHERE n.thread_id = c.thread_id AND n.state IN ('sent', 'failed', 'pending')
                           AND abs(n.updated_at - c.received_at) < 120000)
        ORDER BY received_at DESC LIMIT 10`,
    ).bind(`${TAKEOVER_REASON.slice(0, 40)}%`),
    db.prepare('SELECT tool, ok, error_code, latency_ms, detail, created_at FROM tool_calls ORDER BY id DESC LIMIT 200'),
    db.prepare(
      `SELECT (created_at + 3600000) / 86400000 AS day, COUNT(*) AS booked,
              SUM(CASE WHEN status IN ('paid','dispatched','delivered') THEN 1 ELSE 0 END) AS paid,
              SUM(CASE WHEN status IN ('paid','dispatched','delivered') THEN amount_kobo ELSE 0 END) AS revenue
         FROM jobs WHERE created_at >= ? GROUP BY day`,
    ).bind(today - 6 * 86_400_000),
    db.prepare(
      `SELECT COALESCE(json_extract(e.detail_json, '$.via'), e.actor) AS via, COUNT(DISTINCT e.job_id) AS n
         FROM job_events e JOIN jobs j ON j.id = e.job_id
        WHERE e.to_status = 'paid' AND j.status IN ('paid','dispatched','delivered') GROUP BY 1`,
    ),
    db.prepare(
      `SELECT p.method, COUNT(DISTINCT p.job_id) AS n FROM payments p JOIN jobs j ON j.id = p.job_id
        WHERE p.status = 'success' AND j.status IN ('paid','dispatched','delivered') GROUP BY p.method`,
    ),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_kobo), 0) AS kobo FROM jobs WHERE paid_at >= ? AND status IN ('paid','dispatched','delivered')`).bind(today),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_kobo), 0) AS kobo FROM jobs WHERE status IN ('awaiting_payment','payment_failed')`),
    db.prepare("SELECT ok, detail, updated_at FROM sheet_state WHERE key = 'last'"),
    db.prepare("SELECT CASE WHEN reason = 'hand_back_failed' THEN 'stuck' ELSE state END AS state, COUNT(*) AS n FROM chat_notices GROUP BY 1"),
  ]);
  const list = (jobs!.results as unknown as BoardRow[]).slice(0, LIST_LIMIT);
  const more = jobs!.results.length > LIST_LIMIT;
  const statusCounts: Record<string, number> = Object.fromEntries((counts!.results as unknown as Counted[]).map((c) => [c.status, c.n]));
  const totalJobs = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const toolRows = calls!.results as unknown as { tool: string; ok: number; error_code: string | null; latency_ms: number; detail: string | null; created_at: number }[];
  const reviewRows = reviews!.results as unknown as { job_id: string; detail_json: string | null; created_at: number }[];
  const escalationRows = escalations!.results as unknown as { thread_id: string | null; initiator: string | null; reason: string | null; received_at: number }[];
  const noticeRows = notices!.results as unknown as { event: string; reference: string | null; job_id: string | null; outcome: string; ip_trusted: number; received_at: number }[];
  const days = lastSevenDays(daily!.results as unknown as DayRow[], now);
  const todayRow = days[days.length - 1]!;
  const paidNow = paidToday!.results[0] as unknown as { n: number; kobo: number };
  const owedNow = owed!.results[0] as unknown as { n: number; kobo: number };
  const sheet = mirror === 'enabled' ? ((sheetState!.results[0] as unknown as { ok: number; detail: string; updated_at: number } | undefined) ?? null) : null;

  const noticeCounts = (noticeRows2?.results ?? []) as unknown as { state: string; n: number }[];
  // ---- what needs a person
  const recentEscalations = escalationRows.filter((e) => now - e.received_at < 86_400_000).length;
  const attention = [
    { n: statusCounts.paid ?? 0, label: 'paid, ready to dispatch', href: listHref({ status: 'paid', live: f.live }), urgent: false },
    { n: statusCounts.dispatched ?? 0, label: 'out for delivery', href: listHref({ status: 'dispatched', live: f.live }), urgent: false },
    { n: statusCounts.amount_mismatch ?? 0, label: 'amount mismatch to review', href: listHref({ status: 'amount_mismatch', live: f.live }), urgent: true },
    { n: recentEscalations, label: 'handed to a human today', href: '#handovers', urgent: true },
    { n: noticeCounts.find((c) => c.state === 'stuck')?.n ?? 0, label: 'chat left with a human after a payment notice (hand it back in Chord)', href: '#cnp-h', urgent: true },
  ].filter((a) => a.n > 0);
  const attentionHtml = attention.length
    ? `<ul class="attn" aria-label="Waiting on the dispatcher">${attention.map((a) => `<li><a href="${h(a.href)}"${a.urgent ? ' class="is-urgent"' : ''}><span class="attn__n num">${a.n}</span>${h(a.label)}</a></li>`).join('')}</ul>`
    : '<p class="attn__none">Nothing is waiting on you right now.</p>';

  // ---- overview band
  const okCalls = toolRows.filter((c) => c.ok).length;
  const lat = percentiles(toolRows.map((c) => c.latency_ms));
  const figures = `<dl class="figures">
<div class="figure"><dt class="label">Booked today</dt><dd class="figure__v num">${todayRow.booked}</dd><dd class="figure__sub">${todayRow.paid} of them paid</dd></div>
<div class="figure"><dt class="label">Paid today</dt><dd class="figure__v num">${formatNaira(paidNow.kobo)}</dd><dd class="figure__sub">${paidNow.n} job${paidNow.n === 1 ? '' : 's'}, any booking day</dd></div>
<div class="figure"><dt class="label">Waiting for payment</dt><dd class="figure__v num">${formatNaira(owedNow.kobo)}</dd><dd class="figure__sub">${owedNow.n} job${owedNow.n === 1 ? '' : 's'} awaiting or failed</dd></div>
<div class="figure"><dt class="label">Agent tool calls</dt><dd class="figure__v num">${toolRows.length ? `${pct(okCalls, toolRows.length)}% ok` : '—'}</dd><dd class="figure__sub">${lat ? `median ${lat.p50} ms · p95 ${lat.p95} ms · last ${toolRows.length}` : 'no calls yet'}</dd></div>
</dl>`;
  const viaParts = (via!.results as unknown as { via: string; n: number }[]).map((v) => ({ label: PAID_VIA[v.via] ?? v.via, n: v.n }));
  const methodParts = (method!.results as unknown as { method: string; n: number }[]).map((m) => ({ label: m.method === 'bank_transfer' ? 'Bank transfer' : 'Checkout link', n: m.n }));
  const band = `<section class="band" aria-labelledby="overview-h"><div class="wrap">
<div class="band__head"><h2 id="overview-h">Overview</h2><p class="label">${totalJobs} job${totalJobs === 1 ? '' : 's'} all time · days in WAT</p></div>
${figures}
<div class="viz-grid">
<figure class="viz viz--wide"><figcaption class="label">Where every job is now</figcaption>${pipelineChart(statusCounts, (s) => listHref({ status: s, live: f.live }))}</figure>
<figure class="viz"><figcaption class="label">Bookings, last 7 days</figcaption>${weekChart(days)}</figure>
<figure class="viz"><figcaption class="label">How payments were confirmed</figcaption>${breakdown('Noticed by', viaParts, 'No paid jobs yet.')}${breakdown('Paid with', methodParts, 'No successful payments yet.')}</figure>
</div></div></section>`;

  // ---- jobs list
  const back = listHref(f);
  const rows = list
    .map((j) => {
      const phone = normalizeNigerianPhone(j.recipient_phone);
      const km = j.distance_m ? `${(j.distance_m / 1000).toFixed(1)} km${j.approximate ? ' (est.)' : ''}` : '';
      const actions = actionForms(j, back, true);
      return `<tr>
<td data-label="Job"><a href="/board/jobs/${h(j.id)}">${h(j.id)}</a><span class="sub">${time(j.created_at)}</span></td>
<td data-label="Status">${statusPill(j.status)}${j.paid_via ? `<span class="sub">via ${h((PAID_VIA[j.paid_via] ?? j.paid_via).toLowerCase())}</span>` : ''}</td>
<td data-label="Route" class="route">${h(j.pickup_label ?? '?')}<span class="sub">→ ${h(j.dropoff_label ?? '?')}</span></td>
<td data-label="Package">${h(j.package_size ?? '')}${km ? `<span class="sub num">${km}</span>` : ''}</td>
<td data-label="Amount" class="amt num">${formatNaira(j.amount_kobo)}</td>
<td data-label="Sender → recipient" class="people">${h(j.sender_name)} → ${h(j.recipient_name)}<span class="sub">${h(phone.ok ? phone.display : j.recipient_phone)} · code <span class="mono">${h(j.handover_code)}</span></span></td>
<td class="act${actions ? '' : ' is-empty'}"><div class="actions">${actions || '<span class="muted">—</span>'}</div></td></tr>`;
    })
    .join('');
  const tabs = [{ key: '', label: 'All', n: totalJobs }, ...STATUSES.map((s) => ({ key: s, label: s.replaceAll('_', ' '), n: statusCounts[s] ?? 0 }))]
    .map((t) => `<li><a href="${h(listHref({ ...f, status: t.key }))}"${t.key === f.status ? ' aria-current="page"' : ''}>${h(t.label[0]!.toUpperCase() + t.label.slice(1))}<span class="num">${t.n}</span></a></li>`)
    .join('');
  const filtered = Boolean(f.q || f.status);
  const resultLine = `<p class="result" role="status"><span>${filtered ? `${list.length}${more ? '+' : ''} matching` : `${list.length}${more ? '+' : ''} most recent`}${f.status ? ` · ${h(f.status.replaceAll('_', ' '))}` : ''}${f.q ? ` · “${h(f.q)}”` : ''}</span>${more ? `<span>Showing the latest ${LIST_LIMIT}. Search to find older ones.</span>` : ''}${filtered ? `<a href="${h(listHref({ live: f.live }))}">Clear filters</a>` : ''}</p>`;
  const listHtml = `<section class="wrap list" aria-labelledby="jobs-h">
<div class="section__head"><h2 id="jobs-h">Deliveries</h2></div>
<nav aria-label="Filter by status"><ul class="tabs">${tabs}</ul></nav>
<form class="search" method="get" action="/board" role="search">
<label class="sr" for="q">Search deliveries</label>
<input class="input" id="q" name="q" value="${h(f.q)}" placeholder="Job id, phone, name or address" autocomplete="off" maxlength="80">
${f.status ? `<input type="hidden" name="status" value="${h(f.status)}">` : ''}${f.live ? '<input type="hidden" name="live" value="1">' : ''}
<button class="btn btn--primary" type="submit">Search</button>
</form>
${resultLine}
<div class="table-wrap jobs-wrap"><table class="jobs"><thead><tr><th>Job</th><th>Status</th><th>Route</th><th>Package</th><th>Amount</th><th>Sender → recipient</th><th>Actions</th></tr></thead>
<tbody>${rows || `<tr><td colspan="7" class="empty">${filtered ? 'No deliveries match. Try a job id like ZD-AB12C, a phone number, or part of a name.' : 'No deliveries yet. They appear here as soon as the agent books one.'}</td></tr>`}</tbody></table></div>
</section>`;

  // ---- secondary panels
  const panelTable = (head: string[], body: string) =>
    `<div class="table-wrap"><table><thead><tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
  const handoverHtml = `<section class="section" id="handovers" aria-labelledby="handovers-h"><div class="section__head"><h3 id="handovers-h">Handed to a human</h3><p class="muted">From Chord's webhook. Reply in Chord → Teammates → Zuma → Escalated.</p></div>${
    escalationRows.length
      ? panelTable(['When', 'Thread', 'By', 'Reason'], escalationRows.map((e) => `<tr><td>${time(e.received_at)}</td><td><code>${h(e.thread_id ?? '?')}</code></td><td>${h(e.initiator ?? '')}</td><td>${h(e.reason ?? '')}</td></tr>`).join(''))
      : `<p class="muted">${env.CHORD_WEBHOOK_SECRET ? 'No handovers yet.' : 'Chord webhook not configured (CHORD_WEBHOOK_SECRET).'}</p>`
  }</section>`;
  const reviewHtml = `<section class="section" aria-labelledby="review-h"><div class="section__head"><h3 id="review-h">Payments needing review</h3><p class="muted">Paystack said success but the amount, currency or reference did not match.</p></div>${
    reviewRows.length
      ? panelTable(['Job', 'Reason', 'When'], reviewRows.map((r) => `<tr><td><a class="mono" href="/board/jobs/${h(r.job_id)}">${h(r.job_id)}</a></td><td>${h(safeReason(r.detail_json))}</td><td>${time(r.created_at)}</td></tr>`).join(''))
      : '<p class="muted">None.</p>'
  }</section>`;
  const noticeHtml = `<section class="section" aria-labelledby="notices-h"><div class="section__head"><h3 id="notices-h">Paystack notifications</h3><p class="muted">Each one is re-checked with Paystack before anything changes.</p></div>${
    noticeRows.length
      ? panelTable(['When', 'Event', 'Job', 'Result', 'Paystack IP'], noticeRows.map((n) => `<tr><td>${time(n.received_at)}</td><td><code>${h(n.event)}</code></td><td>${n.job_id ? `<a class="mono" href="/board/jobs/${h(n.job_id)}">${h(n.job_id)}</a>` : '—'}</td><td>${h(n.outcome)}</td><td>${n.ip_trusted ? 'yes' : 'no'}</td></tr>`).join(''))
      : '<p class="muted">None received yet.</p>'
  }</section>`;
  const sheetHtml = `<section class="section" aria-labelledby="sheet-h"><div class="section__head"><h3 id="sheet-h">Google Sheet mirror</h3><p class="muted">A read-only copy for the owner, updated after every change.</p></div>${
    mirror === 'enabled'
      ? `<p>${sheet ? `Last sync ${time(sheet.updated_at)}: ${sheet.ok ? 'ok' : `<b>failed</b> (${h(sheet.detail)})`}.` : 'No sync yet.'}</p>
<div class="actions" style="margin-top:var(--space-xs)"><a class="btn" href="https://docs.google.com/spreadsheets/d/${h(env.GOOGLE_SHEET_ID!.trim())}" rel="noopener noreferrer" target="_blank">Open the sheet</a><form class="inline" method="post" action="/board/sheet/resync"><button class="btn" type="submit">Resync all</button></form></div>`
      : mirror === 'invalid_config'
        ? '<p><b>Misconfigured:</b> GOOGLE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT_JSON is invalid. See docs/FEATURES.md §12.</p>'
        : '<p class="muted">Not configured (optional). See docs/FEATURES.md §12.</p>'
  }</section>`;
  const noticeState = noticeStatus(env);
  const chatNoticesHtml = `<section class="section" aria-labelledby="cnp-h"><div class="section__head"><h3 id="cnp-h">Payment notices in the chat</h3><p class="muted">After Paystack confirms a payment, the customer gets "Payment received" in their conversation without writing first.</p></div>${
    noticeState === 'enabled'
      ? `<p>${noticeCounts.map((c) => `${c.n} ${h(c.state === 'sent' ? 'delivered' : c.state === 'queued' ? 'queued' : c.state === 'skipped' ? 'not sent (by design)' : c.state === 'stuck' ? 'left human-held (hand back in Chord)' : c.state)}`).join(' · ') || 'None yet.'}</p>`
      : noticeState === 'invalid_config'
        ? '<p><b>Misconfigured:</b> CHORD_API_KEY or CHORD_WORKSPACE_ID is invalid. See docs/FEATURES.md §5a.</p>'
        : '<p class="muted">Off: CHORD_API_KEY is not set (optional). See docs/FEATURES.md §5a.</p>'
  }</section>`;
  const callHtml = `<section class="section" aria-labelledby="calls-h"><details><summary><h3 id="calls-h">Recent tool calls</h3><span class="muted">${toolRows.length ? `${toolRows.length - okCalls} errors in the last ${toolRows.length}` : 'none yet'}</span></summary>${
    toolRows.length
      ? panelTable(['When', 'Tool', 'Result', 'Latency', 'Provider path'], toolRows.slice(0, 25).map((c) => `<tr><td>${time(c.created_at)}</td><td><code>${h(c.tool)}</code></td><td>${c.ok ? 'ok' : `<b>${h(c.error_code ?? 'error')}</b>`}</td><td class="num">${c.latency_ms} ms</td><td class="muted"><code>${h(c.detail ?? '')}</code></td></tr>`).join(''))
      : '<p class="muted">None yet.</p>'
  }</details></section>`;

  const flash = await readFlash(url, config.boardToken);
  const head = `<div class="wrap head"><div><p class="label">Dispatcher board</p><h1>${h(config.businessName)}</h1></div>
<p class="head__meta"><span>Updated ${time(now)}</span>${
    f.live
      ? `<span>Auto-refresh every 30 s</span><a href="${h(listHref({ ...f, live: false }))}">Turn off</a>`
      : `<a href="${h(listHref({ ...f, live: true }))}">Turn on auto-refresh</a>`
  }<a href="${h(listHref(f))}">Refresh</a></p></div>`;

  return page({
    title: `${config.businessName} board`,
    refreshSeconds: f.live ? 30 : undefined,
    css: BOARD_CSS,
    body: `${bar(config, session)}
${head}
<div class="wrap">${flash ? `<div class="flash">${notice(flash.msg, flash.error ? 'error' : 'info')}</div>` : ''}${attentionHtml}</div>
${band}
${listHtml}
<div class="wrap panels"><div class="grid-2">${handoverHtml}${reviewHtml}${noticeHtml}${sheetHtml}${chatNoticesHtml}</div>${callHtml}</div>
${footLine(`${h(config.businessName)} · test mode · times in WAT (UTC+1) · statuses here are what the WhatsApp agent tells customers`)}`,
  });
}

function safeReason(detailJson: string | null): string {
  try {
    return (JSON.parse(detailJson ?? '{}') as { reason?: string }).reason ?? '';
  } catch {
    return '';
  }
}

function bar(config: Config, session: { signedIn: boolean }): string {
  return topBar(
    config.businessName,
    `<span class="chip hide-sm">Test mode</span>${
      session.signedIn ? '<form class="inline" method="post" action="/board/logout"><button class="btn btn--sm btn--ghost" type="submit">Sign out</button></form>' : ''
    }`,
  );
}

function blocked(): Response {
  return page({ title: 'Forbidden', status: 403, body: '<main class="wrap head"><div><h1>Request blocked</h1><p class="muted">This form was submitted from another site. Open the board directly and try again.</p></div></main>' });
}

/**
 * The one-line message shown after an action travels in the redirect URL, signed with a key derived
 * from BOARD_TOKEN. A crafted link (?msg=Approved…) therefore cannot put words on the signed-in board.
 */
async function flashSig(secret: string, msg: string, error: boolean): Promise<string> {
  return (await sha256Hex(`zuma-board-flash:${secret}:${error ? 'e' : 'i'}:${msg}`)).slice(0, 24);
}

/** The verified flash message for this page, or null if absent or unsigned. */
export async function readFlash(url: URL, secret: string): Promise<{ msg: string; error: boolean } | null> {
  const msg = url.searchParams.get('msg');
  const sig = url.searchParams.get('sig');
  if (!msg || !sig || msg.length > 300) return null;
  const error = url.searchParams.get('tone') === 'error';
  return sig === (await flashSig(secret, msg, error)) ? { msg, error } : null;
}

async function backTo(url: URL, env: Env, path: string, msg: string, error: boolean): Promise<Response> {
  const target = new URL(path, url.origin);
  const text = msg.slice(0, 300);
  target.searchParams.set('msg', text);
  if (error) target.searchParams.set('tone', 'error');
  target.searchParams.set('sig', await flashSig(env.BOARD_TOKEN?.trim() ?? '', text, error));
  return Response.redirect(target.toString(), 303);
}

async function sheetResync(request: Request, url: URL, env: Env): Promise<Response> {
  if (crossSite(request, url)) return blocked();
  const r = await resyncAll(env, url.origin);
  return backTo(url, env, '/board', r.detail, !r.ok);
}

/** Plain-English meaning of each chat-notice outcome, for the job page and flash messages. */
const NOTICE_REASONS: Record<string, string> = {
  not_configured: 'chat notices are off: CHORD_API_KEY is not set',
  job_not_paid: 'the job is not paid',
  already_handled: 'a notice was already sent or is being sent',
  thread_not_found: "no recent conversation where the agent sent this job id",
  ambiguous_thread: 'two different customers were sent this job id at the same moment, so none was guessed',
  human_handling: 'a person has taken over that conversation',
  customer_mid_conversation: 'the customer was writing at that moment; the agent confirms in its reply',
  outside_24h_window: "the customer's last message is older than WhatsApp's 24-hour window",
  local_server: 'this is a local test server (set CHORD_NOTICES_ALLOW_LOCAL=1 to allow)',
  record_only: "this channel (e.g. the test simulator) cannot show pushed messages; it is in the Chord conversation, so the agent knows the job is paid",
  hand_back_failed: 'Zuma could not hand the chat back to the agent. Open it in Chord and press "Hand back to AI", or the agent stays silent there',
  direct_line_not_delivered: "Chord's scheduled message only reached Chord's record, not the customer's chat (route since replaced)",
};

async function boardAction(request: Request, url: URL, env: Env, execCtx: ExecutionContext): Promise<Response> {
  if (crossSite(request, url)) return blocked();
  const id = /^\/board\/jobs\/(ZD-[0-9A-Z]{5})$/.exec(url.pathname)?.[1];
  const form = await request.formData().catch(() => new FormData());
  // Where to return: the filtered list or the job page the button was on. Old forms used ?from=detail.
  const back = url.searchParams.get('from') === 'detail' && id ? `/board/jobs/${id}` : safeNext(String(form.get('back') ?? ''));
  const actionKey = String(form.get('action'));
  if (actionKey === 'notify' && id) {
    // "Send again" on the job page: retries a skipped or failed chat notice, synchronously so the
    // dispatcher sees the result. A notice that was already queued is never sent twice.
    const r = await notifyPaymentReceived(env, id, { manual: true, origin: url.origin });
    const text = r.state === 'sent' ? `${id}: "Payment received" delivered to the customer's chat.` : r.state === 'queued' ? `${id}: payment notice queued for the customer's chat.` : `${id}: notice not sent. Reason: ${NOTICE_REASONS[r.reason ?? ''] ?? r.reason ?? r.state}.`;
    return backTo(url, env, `/board/jobs/${id}`, text, !(r.state === 'queued' || r.state === 'sent') || Boolean(r.reason));
  }
  const action = Object.hasOwn(ACTIONS, actionKey) ? ACTIONS[actionKey] : undefined;
  const version = Number(form.get('version'));
  if (!id || !action) return backTo(url, env, back, 'Unknown action.', true);
  const job = await getJob(env.DB, id);
  if (!job) return backTo(url, env, back, `No job ${id}.`, true);
  if (job.version !== version) {
    return backTo(url, env, back, `${id} changed since you loaded the page (now ${job.status.replaceAll('_', ' ')}). Check it and try again.`, true);
  }
  const now = Date.now();
  // Approving a reviewed payment is a payment confirmation: record when and how, like checkPayments does.
  const ok = actionKey === 'approve'
    ? await transitionJob(env.DB, id, action.from, action.to, 'dispatcher', now, { action: actionKey, via: 'dispatcher' }, ', paid_at = COALESCE(paid_at, ?)', [now])
    : await transitionJob(env.DB, id, action.from, action.to, 'dispatcher', now, { action: actionKey });
  if (ok) queueSheetSync(env, (p) => execCtx.waitUntil(p), url.origin, id);
  // The customer was told "a dispatcher will check"; tell them in the chat once it is approved.
  if (ok && actionKey === 'approve') queueChatNotice(env, (p) => execCtx.waitUntil(p), id, url.origin);
  return ok
    ? backTo(url, env, back, `${id}: ${action.label.toLowerCase()}.`, false)
    : backTo(url, env, back, `${id} could not change from ${job.status.replaceAll('_', ' ')}.`, true);
}

// ------------------------------------------------------------------ /board/jobs/:id
interface PlaceDetail {
  label: string; lat: number; lng: number; precision: string; provider: string; confidence: string;
  postcode: string | null; postcode_status: string | null; in_service_area: number; query_text: string;
}

interface EventRow { type: string; from_status: string | null; to_status: string | null; actor: string; detail_json: string | null; created_at: number }

export interface Step { key: string; label: string; at: number | null; state: 'done' | 'current' | 'todo' | 'stopped' }

/** The delivery's progress for the stepper: booked → paid → dispatched → delivered (or where it stopped). */
export function progressSteps(job: { status: JobStatus; created_at: number; paid_at: number | null; updated_at: number }, events: { to_status: string | null; created_at: number }[]): Step[] {
  const reached = (s: string) => events.find((e) => e.to_status === s)?.created_at ?? null;
  const happy = ['awaiting_payment', 'paid', 'dispatched', 'delivered'];
  const labels = ['Booked', 'Paid', 'Dispatched', 'Delivered'];
  const at = [job.created_at, job.paid_at ?? reached('paid'), reached('dispatched'), reached('delivered')];
  const pos = happy.indexOf(job.status);
  if (pos >= 0) {
    // On the happy path: everything up to the current status is done, the next step is what we wait for.
    return happy.map((key, i) => ({ key, label: labels[i]!, at: i <= pos ? at[i] ?? null : null, state: i <= pos ? 'done' : i === pos + 1 ? 'current' : 'todo' }));
  }
  // Off the happy path (payment_failed, amount_mismatch, cancelled): show what happened, then where it stopped.
  const steps: Step[] = happy.map((key, i) => ({ key, label: labels[i]!, at: at[i] ?? null, state: at[i] ? 'done' : 'todo' }));
  const done = steps.filter((s) => s.state === 'done').length;
  const label = ({ payment_failed: 'Payment failed', amount_mismatch: 'Amount mismatch', cancelled: 'Cancelled' } as Record<string, string>)[job.status] ?? job.status;
  const stopped: Step = { key: job.status, label, at: reached(job.status) ?? job.updated_at, state: 'stopped' };
  // A cancelled job has no next steps; a failed or mismatched payment can still be paid.
  return job.status === 'cancelled' ? [...steps.slice(0, done), stopped] : [...steps.slice(0, done), stopped, ...steps.slice(done)];
}

const DETAIL_CSS = `
.crumb{padding-top:var(--space-md);font-size:var(--text-sm)}
.crumb a{white-space:nowrap}
.jhead{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-xs) var(--space-sm);padding-block:var(--space-2xs) var(--space-3xs)}
.jhead h1{font-family:var(--font-mono);font-weight:500;letter-spacing:0}
.jmeta{font-size:var(--text-sm);color:var(--color-muted);margin-bottom:var(--space-md)}
.steps{list-style:none;margin:0 0 var(--space-lg);padding:0;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);border-top:1px solid var(--color-rule)}
.steps li{position:relative;padding:var(--space-sm) var(--space-xs) 0 0;min-width:0}
.steps li::before{content:"";position:absolute;top:-1px;left:0;right:0;height:3px;background:var(--color-rule)}
.steps li.is-done::before{background:var(--color-accent)}
.steps li.is-current::before{background:linear-gradient(90deg,var(--color-accent) 0 50%,var(--color-rule) 50%)}
.steps li.is-stopped::before{background:var(--color-bad)}
.steps .label{display:block;margin-bottom:var(--space-3xs)}
.steps li.is-done .step__name,.steps li.is-current .step__name{color:var(--color-ink)}
.steps li.is-stopped .step__name{color:var(--color-bad)}
.step__name{font:600 var(--text-sm)/1.3 var(--font-display);color:var(--color-muted)}
.step__at{display:block;font-size:var(--text-xs);color:var(--color-muted)}
.facts{display:grid;grid-template-columns:minmax(0,9rem) minmax(0,1fr);gap:var(--space-2xs) var(--space-sm);margin:0;font-size:var(--text-sm)}
.facts dt{font:500 var(--text-2xs)/1.9 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--color-muted)}
.facts dd{margin:0;color:var(--color-ink);overflow-wrap:anywhere}
.typed{color:var(--color-muted);font-size:var(--text-sm);margin-top:var(--space-3xs)}
.place h3{margin-bottom:var(--space-3xs)}.place .facts{margin-top:var(--space-sm)}
.total td{font-weight:600;color:var(--color-ink)}
.timeline{list-style:none;margin:0;padding:0}
.timeline li{display:grid;grid-template-columns:minmax(0,9rem) minmax(0,1fr);gap:var(--space-sm);padding:var(--space-xs) 0;border-top:1px solid var(--color-rule);font-size:var(--text-sm)}
.timeline li:first-child{border-top:0}
.timeline .what{color:var(--color-ink);font-weight:500}
.timeline .detail{display:block;color:var(--color-muted);font-size:var(--text-xs);overflow-wrap:anywhere}
@media (max-width:48rem){
  .steps{grid-auto-flow:row;grid-auto-columns:auto;border-top:0;border-left:1px solid var(--color-rule)}
  .steps li{padding:0 0 var(--space-sm) var(--space-sm)}
  .steps li::before{top:0;bottom:0;left:-1px;right:auto;width:3px;height:auto}
  .steps li.is-current::before{background:linear-gradient(180deg,var(--color-accent) 0 50%,var(--color-rule) 50%)}
  .facts,.timeline li{grid-template-columns:minmax(0,1fr);gap:var(--space-3xs)}
  .facts dd{margin-bottom:var(--space-2xs)}
}`;

async function jobDetail(id: string, url: URL, env: Env, config: Config, session: { signedIn: boolean }): Promise<Response> {
  const job = await getJob(env.DB, id);
  if (!job) {
    return page({ title: 'Not found', status: 404, body: `${bar(config, session)}<main class="wrap head"><div><h1>No job ${h(id)}</h1><p class="muted"><a href="/board">Back to the board</a></p></div></main>` });
  }
  const quote = await env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(job.quote_id).first<{
    package_size: string; distance_m: number; duration_s: number | null; distance_source: string; approximate: number;
    amount_kobo: number; breakdown_json: string; rate_card_version: string; created_at: number; expires_at: number;
    pickup_place_id: string; dropoff_place_id: string;
  }>();
  const place = (pid?: string) => (pid ? env.DB.prepare('SELECT * FROM places WHERE id = ?').bind(pid).first<PlaceDetail>() : Promise.resolve(null));
  const [pickup, dropoff, payments, events, notices, chatNotice] = await Promise.all([
    place(quote?.pickup_place_id),
    place(quote?.dropoff_place_id),
    env.DB.prepare('SELECT * FROM payments WHERE job_id = ? ORDER BY attempt').bind(id).all<PaymentRow>(),
    env.DB.prepare('SELECT type, from_status, to_status, actor, detail_json, created_at FROM job_events WHERE job_id = ? ORDER BY id').bind(id).all<EventRow>(),
    env.DB.prepare('SELECT event, reference, outcome, ip_trusted, received_at FROM paystack_events WHERE job_id = ? ORDER BY received_at').bind(id).all<{
      event: string; reference: string | null; outcome: string; ip_trusted: number; received_at: number;
    }>(),
    env.DB.prepare('SELECT state, reason, thread_id, task_id, attempts, updated_at FROM chat_notices WHERE job_id = ? AND kind = ?').bind(id, NOTICE_KIND).first<{
      state: string; reason: string | null; thread_id: string | null; task_id: string | null; attempts: number; updated_at: number;
    }>().catch(() => null),
  ]);
  const phone = normalizeNigerianPhone(job.recipient_phone);
  const flash = await readFlash(url, config.boardToken);
  const self = `/board/jobs/${job.id}`;
  const actions = actionForms(job, self, false);

  const steps = progressSteps(job, events.results)
    .map((s) => `<li class="is-${s.state}"><span class="label">${s.state === 'done' ? 'Done' : s.state === 'current' ? 'Waiting' : s.state === 'stopped' ? 'Stopped' : 'Next'}</span><span class="step__name">${h(s.label)}</span><span class="step__at">${s.at && s.state !== 'todo' ? time(s.at) : '—'}</span></li>`)
    .join('');

  const placeBlock = (title: string, p: PlaceDetail | null) =>
    `<section class="section place" aria-label="${title}"><h3>${title}</h3>${
      p
        ? `<p>${h(p.label)}</p><p class="typed">Customer typed “${h(p.query_text)}”</p>
<dl class="facts"><dt>Precision</dt><dd>${h(p.precision)}</dd><dt>Found by</dt><dd>${h(p.provider)} · ${h(p.confidence)} confidence</dd>
<dt>Postcode</dt><dd>${p.postcode ? `${h(p.postcode)} · NIPOST ${h(p.postcode_status ?? '?')}` : '—'}</dd><dt>Service area</dt><dd>${p.in_service_area ? 'Inside' : '<b>Outside</b>'}</dd>
<dt>Map</dt><dd><a href="https://www.openstreetmap.org/?mlat=${p.lat}&amp;mlon=${p.lng}#map=17/${p.lat}/${p.lng}" rel="noopener noreferrer" target="_blank">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</a></dd></dl>`
        : '<p class="muted">Not found.</p>'
    }</section>`;

  let lines: { label: string; amount: string }[] = [];
  try {
    lines = quote ? (JSON.parse(quote.breakdown_json) as { label: string; amount: string }[]) : [];
  } catch {
    lines = [];
  }
  const quoteHtml = `<section class="section" aria-labelledby="quote-h"><div class="section__head"><h3 id="quote-h">Quote <code>${h(job.quote_id)}</code></h3>${
    quote
      ? `<p class="muted">${(quote.distance_m / 1000).toFixed(1)} km by ${h(quote.distance_source)}${quote.approximate ? ' (estimated: route service unavailable)' : ''}${quote.duration_s ? ` · about ${Math.round(quote.duration_s / 60)} min` : ''} · rate card ${h(quote.rate_card_version)} · quoted ${time(quote.created_at)}</p>`
      : ''
  }</div>${
    quote
      ? `<div class="table-wrap"><table><tbody>${lines.map((l) => `<tr><td>${h(l.label)}</td><td class="num">${h(l.amount)}</td></tr>`).join('')}<tr class="total"><td>Total</td><td class="num">${formatNaira(quote.amount_kobo)}</td></tr></tbody></table></div>`
      : '<p class="muted">Quote missing.</p>'
  }</section>`;

  const payRows = payments.results
    .map((p) => {
      const where = p.method === 'bank_transfer'
        ? `${h(p.transfer_bank ?? '')} <span class="mono">${h(p.transfer_account_number ?? '')}</span>${p.transfer_expires_at ? `<span class="sub">expires ${time(p.transfer_expires_at)}</span>` : ''}`
        : p.authorization_url ? `<a href="${h(p.authorization_url)}" rel="noopener noreferrer" target="_blank">Checkout link</a>` : '<span class="muted">No link (initialize did not finish)</span>';
      return `<tr><td class="num">#${p.attempt}</td><td>${p.method === 'bank_transfer' ? 'Bank transfer' : 'Link'}</td><td><code>${h(p.reference)}</code></td><td class="num">${formatNaira(p.amount_kobo)}</td><td><b>${h(p.status)}</b>${p.gateway_response ? `<span class="sub">${h(p.gateway_response)}</span>` : ''}</td><td>${h(p.channel ?? '')}</td><td>${where}</td><td>${time(p.created_at)}${p.paid_at ? `<span class="sub">paid ${time(p.paid_at)}</span>` : ''}</td></tr>`;
    })
    .join('');
  const timeline = events.results
    .map((e) => {
      let detail = '';
      try {
        const d = e.detail_json ? (JSON.parse(e.detail_json) as Record<string, unknown>) : {};
        detail = Object.entries(d).map(([k, v]) => `${k}: ${String(v)}`).join(' · ');
      } catch {
        detail = e.detail_json ?? '';
      }
      const change = e.from_status || e.to_status ? ` · ${h((e.from_status ?? '').replaceAll('_', ' '))} → ${h((e.to_status ?? '').replaceAll('_', ' '))}` : '';
      return `<li><span class="muted">${time(e.created_at)}</span><span><span class="what">${h(e.type.replaceAll('_', ' '))}</span><span class="muted">${change} · by ${h(e.actor)}</span>${detail ? `<span class="detail">${h(detail)}</span>` : ''}</span></li>`;
    })
    .join('');
  const noticeRows = notices.results
    .map((n) => `<tr><td>${time(n.received_at)}</td><td><code>${h(n.event)}</code></td><td><code>${h(n.reference ?? '')}</code></td><td>${h(n.outcome)}</td><td>${n.ip_trusted ? 'yes' : 'no'}</td></tr>`)
    .join('');

  return page({
    title: `${job.id} · ${config.businessName}`,
    css: DETAIL_CSS,
    body: `${bar(config, session)}
<main class="wrap">
<p class="crumb"><a href="/board">← All deliveries</a></p>
<div class="jhead"><h1>${h(job.id)}</h1>${statusPill(job.status)}</div>
<p class="jmeta">Booked ${time(job.created_at)} · last change ${time(job.updated_at)}${job.cancel_reason ? ` · cancelled: “${h(job.cancel_reason)}”` : ''}</p>
${flash ? `<div class="flash" style="margin-bottom:var(--space-md)">${notice(flash.msg, flash.error ? 'error' : 'info')}</div>` : ''}
<ol class="steps" aria-label="Progress">${steps}</ol>
<div class="grid-2">
<section class="section" aria-labelledby="booking-h"><div class="section__head"><h3 id="booking-h">Booking</h3></div>
<dl class="facts"><dt>Sender</dt><dd>${h(job.sender_name)}</dd><dt>Recipient</dt><dd>${h(job.recipient_name)} · ${h(phone.ok ? phone.display : job.recipient_phone)}</dd>
<dt>Package</dt><dd>${h(quote?.package_size ?? '?')}${job.package_note ? ` · “${h(job.package_note)}”` : ''}</dd><dt>Amount</dt><dd><b class="num">${formatNaira(job.amount_kobo)}</b></dd>
<dt>Handover code</dt><dd><span class="mono">${h(job.handover_code)}</span> <span class="muted">(rider asks the recipient for it)</span></dd></dl>
<div class="actions" style="margin-top:var(--space-md)">${actions || '<span class="muted">No dispatcher actions for this status.</span>'}</div></section>
${quoteHtml}
${placeBlock('Pickup', pickup)}${placeBlock('Drop-off', dropoff)}
</div>
${chatNoticeSection(job, chatNotice, noticeStatus(env) === 'enabled')}
<section class="section" aria-labelledby="pay-h"><div class="section__head"><h3 id="pay-h">Payment attempts</h3></div>${
      payRows
        ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Method</th><th>Reference</th><th>Amount</th><th>Paystack status</th><th>Channel</th><th>Link / account</th><th>When</th></tr></thead><tbody>${payRows}</tbody></table></div>`
        : '<p class="muted">No payment requested yet.</p>'
    }</section>
${noticeRows ? `<section class="section" aria-labelledby="pn-h"><div class="section__head"><h3 id="pn-h">Paystack notifications</h3></div><div class="table-wrap"><table><thead><tr><th>When</th><th>Event</th><th>Reference</th><th>Result</th><th>Paystack IP</th></tr></thead><tbody>${noticeRows}</tbody></table></div></section>` : ''}
<section class="section" aria-labelledby="tl-h"><div class="section__head"><h3 id="tl-h">Timeline</h3></div><ol class="timeline">${timeline}</ol></section>
</main>
${footLine(`${h(config.businessName)} · test mode · times in WAT (UTC+1)`)}`,
  });
}

function chatNoticeSection(
  job: { id: string; status: JobStatus },
  n: { state: string; reason: string | null; thread_id: string | null; task_id: string | null; attempts: number; updated_at: number } | null,
  enabled: boolean,
): string {
  const paid = ['paid', 'dispatched', 'delivered'].includes(job.status);
  if (!paid && !n) return '';
  const reason = n?.reason ? NOTICE_REASONS[n.reason] ?? n.reason : '';
  const line = !enabled && !n
    ? 'Chat notices are off (CHORD_API_KEY not set). The customer is confirmed when they next write.'
    : !n
      ? 'No notice sent. One goes out when Paystack\'s notification, the checkout return page or a dispatcher approval confirms the payment; when the customer asked in the chat, the agent confirmed it there itself.'
      : n.state === 'sent'
        ? `Delivered to the customer's chat ${time(n.updated_at)} (conversation <code>${h(n.thread_id ?? '')}</code>).${n.reason ? ` <b>Warning:</b> ${h(reason)}.` : ''}`
        : n.state === 'queued'
        ? `Queued in Chord ${time(n.updated_at)} (conversation <code>${h(n.thread_id ?? '')}</code>, task <code>${h(n.task_id ?? '')}</code>).${n.reason ? ` Note: ${h(reason)}.` : ''}`
        : n.state === 'pending'
          ? 'Being sent now.'
          : `${n.state === 'failed' ? '<b>Failed</b>' : 'Not sent'} ${time(n.updated_at)}: ${h(reason)}.`;
  const canRetry = enabled && paid && (!n || n.state === 'failed' || n.state === 'skipped');
  return `<section class="section" aria-labelledby="cn-h"><div class="section__head"><h3 id="cn-h">"Payment received" in the chat</h3></div><p>${line}</p>${
    canRetry
      ? `<form class="inline" method="post" action="/board/jobs/${h(job.id)}" style="display:block;margin-top:var(--space-xs)"><input type="hidden" name="action" value="notify"><button class="btn" type="submit">${n ? 'Send again' : 'Send now'}</button></form>`
      : ''
  }</section>`;
}
