import type { Config } from '../config';
import { getJob, getPayment, transitionJob, type JobRow, type JobStatus, type PaymentRow } from '../db/repo';
import type { Env } from '../env';
import { normalizeNigerianPhone } from '../lib/phone';
import { formatNaira } from '../lib/money';
import { escapeHtml as h } from '../lib/text';
import { log } from '../lib/log';
import { ToolError, type ToolContext } from '../mcp/tooling';
import { checkPayments } from '../payments/service';
import { resyncAll } from '../sheets/mirror';
import { queueSheetSync } from '../sheets/queue';
import { NOTICE_KIND, noticeStatus, notifyPaymentReceived, queueChatNotice } from '../chord/notices';
import { breakdown, CHART_CSS, lastSevenDays, pct, percentiles, pipelineChart, watDayStart, weekChart, type DayRow } from './charts';
import { page, statusPill, time, topBar } from './layout';
import { backTo } from './flash';
import { handovers } from './handovers';
import { crossSite, safeNext } from './session';
import { SERVICE_STATES, stateOf, type ServiceState } from '../business/states';
import { assignRider, riderById, riderPhone } from '../business/riders';
import { blank, pageHead, shell, subTabs, type BoardSession } from './shell';
import {
  ACTIONS, actionForms, CITY_LABEL, CITY_PARAM, JOB_FROM, JOB_ROW_SQL, JOBS_CSS, jobRow, jobTable, LIST_LIMIT, listHref, listQuery, NOTICE_REASONS, PAID_VIA,
  searchFilter, STATUSES, type BoardRow, type ListQuery,
} from './jobsShared';
import { BY_LABEL, dateConditions, orderBy, resolveRange, SORT_LABEL, TIME_PRESETS, timeLabel, watDay, WHEN_LABEL, type DateBy, type Sort, type When } from './listFilters';
import { home } from './home';
import { paymentsPage, systemPage } from './ops';
export { readFlash } from './flash';
export { jobCity, listHref, listQuery, searchFilter } from './jobsShared';

const stateLabel = (p: { lat: number; lng: number }) => {
  const st = stateOf(p);
  return st ? SERVICE_STATES[st].name : 'Outside our states';
};

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
      body: `${topBar(config.businessName, '<span class="chip">Test mode</span>', null)}
<main class="wrap pay"><h1>${headline}</h1><p class="pay__detail">${detail}</p></main>`,
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
        // Not "it will be there in a minute": on channels that can't show pushed messages (the TSG
        // simulator) the confirmation only comes when the customer writes (FIELD_NOTES #3).
        ? `${formatNaira(job.amount_kobo)} paid. Go back to WhatsApp for your rider and handover code. If you don't see them yet, reply <b>paid</b>.`
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
const LIST_PARAMS = ['status', 'q', 'city', 'when', 'date_from', 'date_to', 'time_from', 'time_to', 'by', 'sort', 'page'];

export async function board(request: Request, url: URL, env: Env, config: Config, execCtx: ExecutionContext, session: BoardSession): Promise<Response> {
  if (url.pathname.startsWith('/board/handovers')) {
    const r = await handovers(request, url, env, config, session);
    if (r) return r;
  }
  if (request.method === 'POST' && url.pathname === '/board/sheet/resync') return sheetResync(request, url, env);
  if (request.method === 'POST') return boardAction(request, url, env, execCtx);
  const path = url.pathname.replace(/\/+$/, '') || '/board';
  const detail = /^\/board\/jobs\/(ZD-[0-9A-Z]{5})$/.exec(path)?.[1];
  if (detail) return jobDetail(detail, url, env, config, session);
  switch (path) {
    case '/board':
      // Links saved before the board had tabs (/board?status=paid, from the sheet or a bookmark) still land on the list.
      if (LIST_PARAMS.some((k) => url.searchParams.has(k))) return Response.redirect(new URL(`/board/deliveries${url.search}`, url.origin).toString(), 302);
      return home(url, env, config, session);
    case '/board/deliveries':
      return deliveries(url, env, config, session);
    case '/board/deliveries/overview':
      return overview(url, env, config, session);
    case '/board/payments':
    case '/board/payments/paystack':
    case '/board/payments/chat':
      return paymentsPage(path, url, env, config, session);
    case '/board/system':
    case '/board/system/tools':
      return systemPage(path, url, env, config, session);
  }
  return shell({
    env, config, session, url, active: null, title: 'Not found', status: 404, noSignals: true,
    body: `${pageHead('Page not found')}${blank('Nothing lives at this address.', `<a href="/board">Go to Home</a> or use the tabs.`)}`,
  });
}

// ------------------------------------------------------------------ Deliveries › List
/** Builds the WHERE clause, leaving out one filter when counting the chips for that filter. */
function listWhere(f: ListQuery, now: number, skip: 'status' | 'city' | null = null): { sql: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.status && skip !== 'status') {
    where.push('j.status = ?');
    binds.push(f.status);
  }
  const sf = searchFilter(f.q);
  if (sf) {
    where.push(sf.sql);
    binds.push(...sf.binds);
  }
  if (f.city && skip !== 'city') {
    where.push('pu.state = ?');
    binds.push(CITY_PARAM[f.city]);
  }
  const d = dateConditions(f, now);
  where.push(...d.sql);
  binds.push(...d.binds);
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', binds };
}

const PAID_STATUSES = "('paid', 'dispatched', 'delivered')";

async function deliveries(url: URL, env: Env, config: Config, session: BoardSession): Promise<Response> {
  const f = listQuery(url);
  const now = Date.now();
  const all = listWhere(f, now);
  const noStatus = listWhere(f, now, 'status');
  const noCity = listWhere(f, now, 'city');
  const offset = (f.page - 1) * LIST_LIMIT;
  const db = env.DB;
  const [jobs, summary, counts, cityCounts] = await db.batch([
    db.prepare(`${JOB_ROW_SQL} ${all.sql} ORDER BY ${orderBy(f.sort, f.by)} LIMIT ${LIST_LIMIT + 1} OFFSET ${offset}`).bind(...all.binds),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(j.amount_kobo), 0) AS total, COALESCE(SUM(CASE WHEN j.status IN ${PAID_STATUSES} THEN j.amount_kobo ELSE 0 END), 0) AS paid,
                       COALESCE(SUM(CASE WHEN j.status IN ${PAID_STATUSES} THEN 1 ELSE 0 END), 0) AS paid_n
                  ${JOB_FROM} ${all.sql}`).bind(...all.binds),
    db.prepare(`SELECT j.status AS status, COUNT(*) AS n ${JOB_FROM} ${noStatus.sql} GROUP BY j.status`).bind(...noStatus.binds),
    db.prepare(`SELECT pu.state AS state, COUNT(*) AS n ${JOB_FROM} ${noCity.sql} GROUP BY pu.state`).bind(...noCity.binds),
  ]);
  const list = (jobs!.results as unknown as BoardRow[]).slice(0, LIST_LIMIT);
  const more = jobs!.results.length > LIST_LIMIT;
  const sum = (summary!.results[0] as { n: number; total: number; paid: number; paid_n: number } | undefined) ?? { n: 0, total: 0, paid: 0, paid_n: 0 };
  const statusCounts: Record<string, number> = Object.fromEntries((counts!.results as unknown as { status: string; n: number }[]).map((c) => [c.status, c.n]));
  const statusTotal = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const byCity: Record<string, number> = Object.fromEntries((cityCounts!.results as unknown as { state: string | null; n: number }[]).map((c) => [c.state ?? '', c.n]));
  const cityTotal = Object.values(byCity).reduce((a, b) => a + b, 0);
  const keep = { ...f, page: 1 };
  const back = listHref(f);
  const rows = list.map((j) => jobRow(j, back, false, f.by)).join('');
  const chip = (href: string, current: boolean, label: string, n?: number) =>
    `<li><a href="${h(href)}"${current ? ' aria-current="page"' : ''}>${h(label)}${n === undefined ? '' : `<span class="num">${n}</span>`}</a></li>`;

  // Status chips: All, then only statuses that have jobs (plus the selected one), so the row stays short.
  // Counts follow every other filter (dates, city, search), so they add up to what the list would show.
  const statusChips = [{ key: '', label: 'All', n: statusTotal }, ...STATUSES.filter((s) => (statusCounts[s] ?? 0) > 0 || s === f.status).map((s) => ({ key: s, label: s.replaceAll('_', ' '), n: statusCounts[s] ?? 0 }))]
    .map((t) => chip(listHref({ ...keep, status: t.key }), t.key === f.status, t.label[0]!.toUpperCase() + t.label.slice(1), t.n))
    .join('');
  const cityChips = [{ key: '', label: 'Both cities', n: cityTotal }, { key: 'abuja', label: 'Abuja', n: byCity.FC ?? 0 }, { key: 'lagos', label: 'Lagos', n: byCity.LA ?? 0 }]
    .map((t) => chip(listHref({ ...keep, city: t.key }), t.key === (f.city ?? ''), t.label, t.n))
    .join('');
  const customDates = Boolean(f.dateFrom || f.dateTo);
  const whenChips = [chip(listHref({ ...keep, when: '', dateFrom: '', dateTo: '' }), !f.when && !customDates, 'Any time')]
    .concat((Object.keys(WHEN_LABEL) as Exclude<When, ''>[]).map((k) => chip(listHref({ ...keep, when: k, dateFrom: '', dateTo: '' }), f.when === k, WHEN_LABEL[k])))
    .concat(customDates ? [chip(listHref(keep), true, 'Custom dates')] : [])
    .join('');
  const timeChips = [chip(listHref({ ...keep, timeFrom: '', timeTo: '' }), !f.timeFrom && !f.timeTo, 'Any time of day')]
    .concat(TIME_PRESETS.map((t) => chip(listHref({ ...keep, timeFrom: t.from, timeTo: t.to }), f.timeFrom === t.from && f.timeTo === t.to, t.label)))
    .join('');

  const range = resolveRange(f, now);
  const tl = timeLabel(f);
  const dated = Boolean(range.label || tl || f.by !== 'booked');
  const filtered = Boolean(f.q || f.status || f.city || dated);
  const describe = [
    dated ? `${BY_LABEL[f.by].toLowerCase()}${range.label ? ` ${range.label}` : ''}${tl ? `, ${tl}` : ''}` : '',
    f.city ? CITY_LABEL[CITY_PARAM[f.city]!] : '',
    f.status ? f.status.replaceAll('_', ' ') : '',
    f.q ? `“${f.q}”` : '',
  ].filter(Boolean);
  const first = sum.n ? offset + 1 : 0;
  const last = offset + list.length;
  const countText = sum.n === 0 ? 'No deliveries' : `${sum.n} deliver${sum.n === 1 ? 'y' : 'ies'}`;
  const money = sum.n ? ` · ${formatNaira(sum.total)} booked · ${formatNaira(sum.paid)} paid (${sum.paid_n} job${sum.paid_n === 1 ? '' : 's'})` : '';
  const resultLine = `<p class="result" role="status"><span>${h(countText)}${describe.length ? ` ${h(describe.join(' · '))}` : ''}${h(money)}</span>${
    sum.n > LIST_LIMIT || f.page > 1 ? `<span>Showing ${first}–${last} · ${h(SORT_LABEL[f.sort].toLowerCase())}</span>` : f.sort !== 'newest' ? `<span>${h(SORT_LABEL[f.sort])}</span>` : ''
  }${filtered || f.sort !== 'newest' ? `<a href="${h(listHref({ live: f.live }))}">Clear filters</a>` : ''}</p>`;
  const notes = f.notes.length
    ? `<div class="notice" role="status"><span class="label">Note</span><span>${f.notes.map(h).join(' ')}</span></div>`
    : '';
  const pager =
    f.page > 1 || more
      ? `<nav class="pager" aria-label="Pages">${f.page > 1 ? `<a class="btn btn--sm" href="${h(listHref({ ...f, page: f.page - 1 }))}" rel="prev">← Previous ${LIST_LIMIT}</a>` : '<span></span>'}<span class="muted">Page ${f.page} of ${Math.max(1, Math.ceil(sum.n / LIST_LIMIT))}</span>${
          more ? `<a class="btn btn--sm" href="${h(listHref({ ...f, page: f.page + 1 }))}" rel="next">Next ${LIST_LIMIT} →</a>` : '<span></span>'
        }</nav>`
      : '';
  const pastEnd = f.page > 1 && list.length === 0;
  const empty = pastEnd
    ? `There are no deliveries on page ${f.page}. <a href="${h(listHref(keep))}">Go to page 1</a>.`
    : filtered
      ? `No deliveries ${h(describe.join(' · ') || 'match')}.${f.by !== 'booked' ? ` Only jobs that were ${f.by} have a ${f.by} date.` : ''} Try another date or search, or <a href="${h(listHref({ live: f.live }))}">clear the filters</a>.`
      : 'No deliveries yet. They appear here as soon as Zuma books one.';
  const refresh = f.live
    ? `<span>Refreshes every 30 s</span><a href="${h(listHref({ ...f, live: false }))}">Stop</a>`
    : `<a href="${h(listHref({ ...f, live: true }))}">Auto-refresh</a>`;
  // Closed by default so the list stays near the top on a phone; the heading says what is set. It opens
  // only when we ignored or corrected something the dispatcher typed, so they see why.
  const advOpen = f.notes.length > 0;
  const advSet = [
    f.by !== 'booked' ? `by ${BY_LABEL[f.by].toLowerCase()} date` : '',
    customDates ? range.label : '',
    tl,
    f.sort !== 'newest' ? SORT_LABEL[f.sort].toLowerCase() : '',
  ].filter(Boolean);
  const hidden = (name: string, v: string | false | undefined) => (v ? `<input type="hidden" name="${name}" value="${h(v)}">` : '');
  const opt = (value: string, label: string, current: string) => `<option value="${h(value)}"${value === current ? ' selected' : ''}>${h(label)}</option>`;
  const today = watDay(now);
  const form = `<form class="dl-form" method="get" action="/board/deliveries" role="search">
<div class="search"><label class="sr" for="q">Search deliveries</label>
<input class="input" id="q" name="q" value="${h(f.q)}" type="search" placeholder="Job id, phone or name" autocomplete="off" maxlength="80">
<button class="btn btn--primary" type="submit">Search</button></div>
${hidden('status', f.status)}${hidden('city', f.city)}${hidden('live', f.live && '1')}${customDates ? '' : hidden('when', f.when)}
<details class="adv"${advOpen ? ' open' : ''}><summary>Dates, time of day and sort <span class="muted">· ${h(advSet.length ? advSet.join(' · ') : 'pick exact days, hours, or the order')}</span></summary>
<div class="adv__grid">
<fieldset><legend>Date</legend>
<div class="adv__row"><label for="by">Date of</label><select class="select" id="by" name="by">${(Object.keys(BY_LABEL) as DateBy[]).map((k) => opt(k, BY_LABEL[k], f.by)).join('')}</select></div>
<div class="adv__row"><label for="date_from">From</label><input class="input" id="date_from" name="date_from" type="date" value="${h(f.dateFrom)}" min="2020-01-01" max="2100-12-31" placeholder="21/10/2026"></div>
<div class="adv__row"><label for="date_to">To</label><input class="input" id="date_to" name="date_to" type="date" value="${h(f.dateTo)}" min="2020-01-01" max="2100-12-31" placeholder="${h(today)}"></div>
<p class="adv__hint">Both days included. Typed dates replace a preset. Days run midnight to midnight, WAT.</p></fieldset>
<fieldset><legend>Time of day</legend>
<div class="adv__row"><label for="time_from">From</label><input class="input" id="time_from" name="time_from" type="time" value="${h(f.timeFrom)}"></div>
<div class="adv__row"><label for="time_to">To</label><input class="input" id="time_to" name="time_to" type="time" value="${h(f.timeTo)}"></div>
<p class="adv__hint">On any day in the range. A start later than the end, like 20:00 to 06:59, means overnight.</p></fieldset>
<fieldset><legend>Order</legend>
<div class="adv__row"><label for="sort">Sort by</label><select class="select" id="sort" name="sort">${(Object.keys(SORT_LABEL) as Sort[]).map((k) => opt(k, SORT_LABEL[k], f.sort)).join('')}</select></div>
<p class="adv__hint">"Newest" and "oldest" follow the date chosen above.</p></fieldset>
</div>
<div class="adv__actions"><button class="btn btn--primary" type="submit">Apply</button><a href="${h(listHref({ q: f.q, status: f.status, city: f.city, live: f.live }))}">Reset dates, time and sort</a></div>
</details>
</form>`;
  const chipRows = `<nav aria-label="Filter by date"><ul class="chips">${whenChips}</ul></nav>
<nav aria-label="Filter by time of day"><ul class="chips">${timeChips}</ul></nav>
<div class="chips-row"><nav aria-label="Filter by city"><ul class="chips">${cityChips}</ul></nav><nav aria-label="Filter by status"><ul class="chips">${statusChips}</ul></nav></div>`;
  const sortHead = {
    current: f.sort,
    href: (s: Sort) => listHref({ ...keep, sort: s }),
  };
  const body = `${pageHead('Deliveries', 'Every booking Zuma took. Filter by day, time or status, and open a job for its payment trail and timeline.', `<span>Updated ${time(now)}</span>${refresh}`)}
${subTabs('Deliveries views', [{ href: listHref({}), label: 'List', current: true }, { href: '/board/deliveries/overview', label: 'Overview', current: false }])}
<div class="filters">
${form}
<div class="d-only filters__chips">${chipRows}</div>
<details class="m-only filt"><summary>Filters <span class="muted">· ${h([range.label ? range.label : 'any time', tl, f.city ? CITY_LABEL[CITY_PARAM[f.city]!] : 'both cities', f.status ? f.status.replaceAll('_', ' ') : 'all statuses'].filter(Boolean).join(' · '))}</span></summary>
<div class="filters__chips">${chipRows.replaceAll('aria-label="Filter by', 'aria-label="(phone) Filter by')}</div></details>
</div>
${notes}
${resultLine}
${jobTable(rows, empty, false, sortHead)}
${pager}`;
  return shell({ env, config, session, url, active: 'deliveries', title: 'Deliveries', css: JOBS_CSS, body, refreshSeconds: f.live ? 30 : undefined });
}

// ------------------------------------------------------------------ Deliveries › Overview
async function overview(url: URL, env: Env, config: Config, session: BoardSession): Promise<Response> {
  const now = Date.now();
  const today = watDayStart(now);
  const db = env.DB;
  const [counts, calls, daily, via, method, paidToday, owed] = await db.batch([
    db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status'),
    db.prepare('SELECT ok, latency_ms FROM tool_calls ORDER BY id DESC LIMIT 200'),
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
  ]);
  const statusCounts: Record<string, number> = Object.fromEntries((counts!.results as unknown as { status: string; n: number }[]).map((c) => [c.status, c.n]));
  const totalJobs = Object.values(statusCounts).reduce((a, b) => a + b, 0);
  const toolRows = calls!.results as unknown as { ok: number; latency_ms: number }[];
  const days = lastSevenDays(daily!.results as unknown as DayRow[], now);
  const todayRow = days[days.length - 1]!;
  const paidNow = paidToday!.results[0] as unknown as { n: number; kobo: number };
  const owedNow = owed!.results[0] as unknown as { n: number; kobo: number };
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
  const body = `${pageHead('Deliveries', `${totalJobs} job${totalJobs === 1 ? '' : 's'} all time. Days are WAT.`, `<span>Updated ${time(now)}</span>`)}
${subTabs('Deliveries views', [{ href: listHref({}), label: 'List', current: false }, { href: '/board/deliveries/overview', label: 'Overview', current: true }])}
<section class="band" aria-label="Overview">
${figures}
<div class="viz-grid">
<figure class="viz viz--wide"><figcaption class="label">Where every job is now</figcaption>${pipelineChart(statusCounts, (s) => listHref({ status: s }))}</figure>
<figure class="viz"><figcaption class="label">Bookings, last 7 days</figcaption>${weekChart(days)}</figure>
<figure class="viz"><figcaption class="label">How payments were confirmed</figcaption>${breakdown('Noticed by', viaParts, 'No paid jobs yet.')}${breakdown('Paid with', methodParts, 'No successful payments yet.')}</figure>
</div></section>`;
  return shell({ env, config, session, url, active: 'deliveries', title: 'Overview', css: `${CHART_CSS}.band{padding:var(--space-lg) clamp(1rem,3vw,2rem);border-radius:var(--radius-lg)}`, body });
}

function safeReason(detailJson: string | null): string {
  try {
    return (JSON.parse(detailJson ?? '{}') as { reason?: string }).reason ?? '';
  } catch {
    return '';
  }
}


function blocked(): Response {
  return page({ title: 'Forbidden', status: 403, body: '<main class="wrap" style="padding-block:var(--space-xl)"><h1>Request blocked</h1><p class="muted" style="margin-top:var(--space-2xs)">This form was submitted from another site. <a href="/board">Open the board directly</a> and try again.</p></main>' });
}


async function sheetResync(request: Request, url: URL, env: Env): Promise<Response> {
  if (crossSite(request, url)) return blocked();
  const r = await resyncAll(env, url.origin);
  return backTo(url, env, '/board/system', r.detail, !r.ok);
}

export async function boardAction(request: Request, url: URL, env: Env, execCtx: ExecutionContext): Promise<Response> {
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
    const text = r.state === 'sent' ? `${id}: Chord reports "Payment received" delivered to the customer's chat.` : r.state === 'queued' ? `${id}: payment notice queued for the customer's chat.` : `${id}: notice not sent. Reason: ${NOTICE_REASONS[r.reason ?? ''] ?? r.reason ?? r.state}.`;
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
  // An approved payment is a paid job: assign a rider, then tell the customer in the chat
  // (they were told "a dispatcher will check").
  if (ok && actionKey === 'approve') {
    await assignRider(env.DB, id, now);
    queueChatNotice(env, (p) => execCtx.waitUntil(p), id, url.origin);
  }
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
.jhead{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-xs) var(--space-sm)}
.jhead h1{font-family:var(--font-mono);font-weight:500;letter-spacing:0}
.steps{list-style:none;margin:0 0 var(--space-lg);padding:0;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);border-top:1px solid var(--color-rule)}
.steps li{position:relative;padding:var(--space-sm) var(--space-xs) 0 0;min-width:0}
.steps li::before{content:"";position:absolute;top:-1px;left:0;right:0;height:3px;background:var(--color-rule)}
.steps li.is-done::before{background:var(--color-accent)}
.steps li.is-current::before{background:linear-gradient(90deg,var(--color-accent) 0 50%,var(--color-rule) 50%)}
.steps li.is-stopped::before{background:var(--color-bad)}
.steps li.is-done .step__name,.steps li.is-current .step__name{color:var(--color-ink)}
.steps li.is-stopped .step__name{color:var(--color-bad)}
.step__name{display:block;font:600 var(--text-sm)/1.3 var(--font-display);color:var(--color-muted)}
.step__at{display:block;font-size:var(--text-xs);color:var(--color-muted)}
.next{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-xs) var(--space-md);padding:var(--space-sm);margin-bottom:var(--space-md);border:1px solid var(--color-rule);border-radius:var(--radius-lg);background:var(--color-surface)}
.next p{font-size:var(--text-sm);color:var(--color-ink-2);max-width:60ch}
.next b{color:var(--color-ink)}
.facts{display:grid;grid-template-columns:minmax(0,9rem) minmax(0,1fr);gap:var(--space-2xs) var(--space-sm);margin:0;font-size:var(--text-sm)}
.facts dt{font:500 var(--text-2xs)/1.9 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--color-muted)}
.facts dd{margin:0;color:var(--color-ink);overflow-wrap:anywhere}
.typed{color:var(--color-muted);font-size:var(--text-sm);margin-top:var(--space-3xs)}
.place h2{margin-bottom:var(--space-3xs)}.place .facts{margin-top:var(--space-sm)}
.total td{font-weight:600;color:var(--color-ink)}
.timeline{list-style:none;margin:0;padding:0}
.timeline li{display:grid;grid-template-columns:minmax(0,9rem) minmax(0,1fr);gap:var(--space-sm);padding:var(--space-xs) 0;border-top:1px solid var(--color-rule);font-size:var(--text-sm)}
.timeline li:first-child{border-top:0}
.timeline .what{color:var(--color-ink);font-weight:500}
.timeline .detail{display:block;color:var(--color-muted);font-size:var(--text-xs);overflow-wrap:anywhere}
.section h2{font-size:var(--text-md)}
.span-2{grid-column:1/-1}
@media (max-width:48rem){
  .steps{grid-auto-flow:row;grid-auto-columns:auto;border-top:0;border-left:1px solid var(--color-rule)}
  .steps li{padding:0 0 var(--space-sm) var(--space-sm)}
  .steps li::before{top:0;bottom:0;left:-1px;right:auto;width:3px;height:auto}
  .steps li.is-current::before{background:linear-gradient(180deg,var(--color-accent) 0 50%,var(--color-rule) 50%)}
  .facts,.timeline li{grid-template-columns:minmax(0,1fr);gap:var(--space-3xs)}
  .facts dd{margin-bottom:var(--space-2xs)}
  .next .actions{width:100%}
}`;

/** What the dispatcher is expected to do next for a job in this status (the job page's action strip). */
const NEXT_STEP: Partial<Record<JobStatus, string>> = {
  awaiting_payment: '<b>Waiting for the customer to pay.</b> Zuma sent the link. Nothing to do unless they ask to cancel.',
  paid: '<b>Paid. A rider is assigned.</b> Mark it dispatched when the rider picks the package up.',
  dispatched: '<b>Out with the rider.</b> Mark it delivered when the recipient gives the handover code.',
  delivered: '<b>Delivered.</b> Nothing left to do.',
  payment_failed: '<b>The payment failed.</b> The customer can pay again from the same chat. Cancel if they no longer want it.',
  amount_mismatch: '<b>Payment needs review.</b> Paystack reported success, but it did not match the quote. Check the Payments view, then approve or cancel.',
  cancelled: '<b>Cancelled.</b> Nothing left to do.',
};

async function jobDetail(id: string, url: URL, env: Env, config: Config, session: BoardSession): Promise<Response> {
  const job = await getJob(env.DB, id);
  if (!job) {
    return shell({
      env, config, session, url, active: 'deliveries', title: 'Not found', status: 404, noSignals: true,
      body: `${pageHead(`No job ${h(id)}`, '', '', '<a class="crumb" href="/board/deliveries">← Deliveries</a>')}${blank('This job id does not exist.', ' Check the id, or <a href="/board/deliveries">search the deliveries</a>.')}`,
    });
  }
  const view = (['payments', 'timeline'] as const).find((v) => v === url.searchParams.get('view')) ?? 'summary';
  const self = `/board/jobs/${job.id}`;
  const quote = await env.DB.prepare('SELECT * FROM quotes WHERE id = ?').bind(job.quote_id).first<{
    package_size: string; distance_m: number; duration_s: number | null; distance_source: string; approximate: number;
    amount_kobo: number; breakdown_json: string; rate_card_version: string; created_at: number; expires_at: number;
    pickup_place_id: string; dropoff_place_id: string;
  }>();
  const place = (pid?: string) => (pid ? env.DB.prepare('SELECT * FROM places WHERE id = ?').bind(pid).first<PlaceDetail>() : Promise.resolve(null));
  const [pickup, dropoff, payments, events, notices, chatNotice, handover] = await Promise.all([
    view === 'summary' ? place(quote?.pickup_place_id) : Promise.resolve(null),
    view === 'summary' ? place(quote?.dropoff_place_id) : Promise.resolve(null),
    env.DB.prepare('SELECT * FROM payments WHERE job_id = ? ORDER BY attempt').bind(id).all<PaymentRow>(),
    env.DB.prepare('SELECT type, from_status, to_status, actor, detail_json, created_at FROM job_events WHERE job_id = ? ORDER BY id').bind(id).all<EventRow>(),
    env.DB.prepare('SELECT event, reference, outcome, ip_trusted, received_at FROM paystack_events WHERE job_id = ? ORDER BY received_at').bind(id).all<{
      event: string; reference: string | null; outcome: string; ip_trusted: number; received_at: number;
    }>(),
    env.DB.prepare('SELECT state, reason, thread_id, task_id, attempts, updated_at FROM chat_notices WHERE job_id = ? AND kind = ?').bind(id, NOTICE_KIND).first<{
      state: string; reason: string | null; thread_id: string | null; task_id: string | null; attempts: number; updated_at: number;
    }>().catch(() => null),
    env.DB.prepare(
      `SELECT thread_id, received_at FROM chord_events WHERE type = 'conversation.escalated' AND thread_id IS NOT NULL AND reason LIKE ? ORDER BY received_at DESC LIMIT 1`,
    ).bind(`%${id}%`).first<{ thread_id: string; received_at: number }>().catch(() => null),
  ]);
  const phone = normalizeNigerianPhone(job.recipient_phone);
  const actions = actionForms(job, self, false);
  const steps = progressSteps(job, events.results)
    .map((s) => `<li class="is-${s.state}"><span class="step__name">${h(s.label)}</span><span class="step__at">${s.state === 'done' ? 'Done' : s.state === 'current' ? 'Waiting' : s.state === 'stopped' ? 'Stopped' : 'Next'}${s.at && s.state !== 'todo' ? ` · ${time(s.at)}` : ''}</span></li>`)
    .join('');
  const head = `${pageHead(
    `${h(job.id)}`,
    `Booked ${time(job.created_at)} · last change ${time(job.updated_at)}${job.cancel_reason ? ` · cancelled: “${h(job.cancel_reason)}”` : ''}`,
    statusPill(job.status),
    '<a class="crumb" href="/board/deliveries">← Deliveries</a>',
  )}
${subTabs('Job views', [
    { href: self, label: 'Summary', current: view === 'summary' },
    { href: `${self}?view=payments`, label: 'Payment', n: payments.results.length, current: view === 'payments' },
    { href: `${self}?view=timeline`, label: 'Timeline', n: events.results.length, current: view === 'timeline' },
  ])}`;

  let body: string;
  if (view === 'summary') {
    const placeBlock = (title: string, p: PlaceDetail | null) =>
      `<section class="section place" aria-label="${title}"><h2>${title}</h2>${
        p
          ? `<p>${h(p.label)}</p><p class="typed">Customer typed “${h(p.query_text)}”</p>
<dl class="facts"><dt>Precision</dt><dd>${h(p.precision)}</dd><dt>Found by</dt><dd>${h(p.provider)} · ${h(p.confidence)} confidence</dd>
<dt>Postcode</dt><dd>${p.postcode ? `${h(p.postcode)} · NIPOST ${h(p.postcode_status ?? '?')}` : '—'}</dd><dt>State</dt><dd>${stateOf(p) ? h(stateLabel(p)) : '<b>Outside Abuja and Lagos</b>'}</dd>
<dt>Map</dt><dd><a href="https://www.google.com/maps/search/?api=1&amp;query=${p.lat},${p.lng}" rel="noopener noreferrer" target="_blank">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</a></dd></dl>`
          : '<p class="muted">Not found.</p>'
      }</section>`;
    const rider = riderById(job.rider_id);
    const side = [(handover ? `<section class="section" aria-labelledby="hv-h"><div class="section__head"><h2 id="hv-h">Handed to a person</h2><p class="muted">Zuma handed this customer to the team ${time(handover.received_at)}.</p></div><a class="btn" href="/board/handovers/${h(handover.thread_id)}">Open the conversation</a></section>` : ''), chatNoticeSection(job, chatNotice, noticeStatus(env) === 'enabled')].join('');
    body = `<ol class="steps" aria-label="Progress">${steps}</ol>
<div class="next"><p>${NEXT_STEP[job.status] ?? ''}</p>${actions ? `<div class="actions">${actions}</div>` : ''}</div>
<div class="grid-2">
<section class="section${side ? '' : ' span-2'}" aria-labelledby="booking-h"><div class="section__head"><h2 id="booking-h">Booking</h2></div>
<dl class="facts"><dt>Sender</dt><dd>${h(job.sender_name)}</dd><dt>Recipient</dt><dd>${h(job.recipient_name)} · ${h(phone.ok ? phone.display : job.recipient_phone)}</dd>
<dt>Package</dt><dd>${h(quote?.package_size ?? '?')}${job.package_note ? ` · “${h(job.package_note)}”` : ''}</dd><dt>Amount</dt><dd><b class="num">${formatNaira(job.amount_kobo)}</b></dd>
<dt>Handover code</dt><dd><span class="mono">${h(job.handover_code)}</span> <span class="muted">(sent to the customer only after payment; the rider asks the recipient for it)</span></dd>
<dt>Rider</dt><dd>${rider ? `${h(rider.name)} · ${h(rider.vehicle)} · <span class="mono">${h(rider.plate)}</span> · <span class="num">${h(riderPhone(rider))}</span>${job.rider_assigned_at ? ` <span class="muted">(assigned ${time(job.rider_assigned_at)})</span>` : ''}` : '<span class="muted">Assigned when paid</span>'}</dd></dl></section>
${side ? `<div>${side}</div>` : ''}
${placeBlock('Pickup', pickup)}${placeBlock('Drop-off', dropoff)}
</div>`;
  } else if (view === 'payments') {
    let lines: { label: string; amount: string }[] = [];
    try {
      lines = quote ? (JSON.parse(quote.breakdown_json) as { label: string; amount: string }[]) : [];
    } catch {
      lines = [];
    }
    const payRows = payments.results
      .map((p) => {
        const where = p.method === 'bank_transfer'
          ? `${h(p.transfer_bank ?? '')} <span class="mono">${h(p.transfer_account_number ?? '')}</span>${p.transfer_expires_at ? `<span class="sub">expires ${time(p.transfer_expires_at)}</span>` : ''}`
          : p.authorization_url ? `<a href="${h(p.authorization_url)}" rel="noopener noreferrer" target="_blank">Checkout link</a>` : '<span class="muted">No link (initialize did not finish)</span>';
        return `<tr><td class="num">#${p.attempt}</td><td>${p.method === 'bank_transfer' ? 'Bank transfer' : 'Link'}</td><td><code>${h(p.reference)}</code></td><td class="num">${formatNaira(p.amount_kobo)}</td><td><b>${h(p.status)}</b>${p.gateway_response ? `<span class="sub">${h(p.gateway_response)}</span>` : ''}</td><td>${h(p.channel ?? '')}</td><td>${where}</td><td>${time(p.created_at)}${p.paid_at ? `<span class="sub">paid ${time(p.paid_at)}</span>` : ''}</td></tr>`;
      })
      .join('');
    const noticeRows = notices.results
      .map((n) => `<tr><td>${time(n.received_at)}</td><td><code>${h(n.event)}</code></td><td><code>${h(n.reference ?? '')}</code></td><td>${h(n.outcome)}</td><td>${n.ip_trusted ? 'yes' : 'no'}</td></tr>`)
      .join('');
    body = `<section class="section" style="border-top:0;padding-top:0" aria-labelledby="quote-h"><div class="section__head"><h2 id="quote-h">Quote <code>${h(job.quote_id)}</code></h2>${
      quote
        ? `<p class="muted">${(quote.distance_m / 1000).toFixed(1)} km by ${h(quote.distance_source)}${quote.approximate ? ' (estimated: route service unavailable)' : ''}${quote.duration_s ? ` · about ${Math.round(quote.duration_s / 60)} min` : ''} · rate card ${h(quote.rate_card_version)} · quoted ${time(quote.created_at)}</p>`
        : ''
    }</div>${
      quote
        ? `<div class="table-wrap"><table><tbody>${lines.map((l) => `<tr><td>${h(l.label)}</td><td class="num">${h(l.amount)}</td></tr>`).join('')}<tr class="total"><td>Total</td><td class="num">${formatNaira(quote.amount_kobo)}</td></tr></tbody></table></div>`
        : '<p class="muted">Quote missing.</p>'
    }</section>
<section class="section" aria-labelledby="pay-h"><div class="section__head"><h2 id="pay-h">Payment attempts</h2></div>${
      payRows
        ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Method</th><th>Reference</th><th>Amount</th><th>Paystack status</th><th>Channel</th><th>Link / account</th><th>When</th></tr></thead><tbody>${payRows}</tbody></table></div>`
        : blank('No payment requested yet.', ' Zuma creates a Paystack link once the customer confirms the booking.')
    }</section>
<section class="section" aria-labelledby="pn-h"><div class="section__head"><h2 id="pn-h">Paystack notifications</h2><p class="muted">Each one is re-checked with Paystack before anything changes.</p></div>${
      noticeRows
        ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Event</th><th>Reference</th><th>Result</th><th>Paystack IP</th></tr></thead><tbody>${noticeRows}</tbody></table></div>`
        : '<p class="muted">None for this job.</p>'
    }</section>`;
  } else {
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
    body = timeline ? `<ol class="timeline" aria-label="Timeline">${timeline}</ol>` : blank('No events yet.', '');
  }
  return shell({ env, config, session, url, active: 'deliveries', title: job.id, css: DETAIL_CSS, body: head + body });
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
        ? `Chord reports it delivered to the customer's chat ${time(n.updated_at)} (conversation <code>${h(n.thread_id ?? '')}</code>).${n.reason ? ` <b>Warning:</b> ${h(reason)}.` : ''}`
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
