import type { JobRow, JobStatus } from '../db/repo';
import { formatNaira } from '../lib/money';
import { riderById } from '../business/riders';
import { statusPill, time } from './layout';
import { normalizeNigerianPhone } from '../lib/phone';
import { escapeHtml as h } from '../lib/text';
import { STATUS_ORDER } from './charts';
import { stateOf, type ServiceState } from '../business/states';
import { readDateFilters, SORT_LABEL, type DateBy, type DateFilters, type Sort } from './listFilters';

/** Pieces shared by the Home, Deliveries, Payments and job pages. */

export const PAID_VIA: Record<string, string> = {
  paystack_webhook: 'Paystack notification',
  return_page: 'Checkout return page',
  verify: 'Customer asked',
  link_request: 'New link request',
  cancel: 'Cancel check',
  dispatcher: 'Dispatcher approval',
};

export const ACTIONS: Record<string, { from: JobStatus[]; to: JobStatus; label: string; tone?: 'danger' | 'primary' }> = {
  dispatch: { from: ['paid'], to: 'dispatched', label: 'Mark dispatched', tone: 'primary' },
  deliver: { from: ['dispatched'], to: 'delivered', label: 'Mark delivered', tone: 'primary' },
  approve: { from: ['amount_mismatch'], to: 'paid', label: 'Approve payment' },
  cancel: { from: ['awaiting_payment', 'payment_failed', 'amount_mismatch'], to: 'cancelled', label: 'Cancel', tone: 'danger' },
};

export const CITY_PARAM: Record<string, ServiceState> = { abuja: 'FC', lagos: 'LA' };
export const CITY_LABEL: Record<ServiceState, string> = { FC: 'Abuja', LA: 'Lagos' };

/** A job's city: the pickup's stored state, or (places resolved before migration 0010) its coordinates. */
export function jobCity(j: { pickup_state: ServiceState | null; pickup_lat: number | null; pickup_lng: number | null }): ServiceState | null {
  return j.pickup_state ?? (j.pickup_lat != null && j.pickup_lng != null ? stateOf({ lat: j.pickup_lat, lng: j.pickup_lng }) : null);
}

export const STATUSES: JobStatus[] = [...STATUS_ORDER];
export const LIST_LIMIT = 100;

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

export interface ListQuery extends DateFilters { status: string; q: string; live: boolean; city?: string }

/** Reads the list filters from the URL; an unknown status is ignored rather than matching nothing. */
export function listQuery(url: URL): ListQuery {
  const status = url.searchParams.get('status') ?? '';
  return {
    status: (STATUSES as string[]).includes(status) ? status : '',
    q: (url.searchParams.get('q') ?? '').trim().slice(0, 80),
    live: url.searchParams.get('live') === '1',
    city: Object.hasOwn(CITY_PARAM, url.searchParams.get('city') ?? '') ? url.searchParams.get('city')! : '',
    ...readDateFilters(url),
  };
}

/**
 * A board URL for these filters; empty and default values are left out so links stay short and
 * shareable. `page` is only kept when asked for: any change of filter starts again at page 1.
 */
export function listHref(f: Partial<ListQuery>): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.status) p.set('status', f.status);
  if (f.city) p.set('city', f.city);
  if (f.when) p.set('when', f.when);
  if (f.dateFrom) p.set('date_from', f.dateFrom);
  if (f.dateTo) p.set('date_to', f.dateTo);
  if (f.timeFrom) p.set('time_from', f.timeFrom);
  if (f.timeTo) p.set('time_to', f.timeTo);
  if (f.by && f.by !== 'booked') p.set('by', f.by);
  if (f.sort && f.sort !== 'newest') p.set('sort', f.sort);
  if (f.page && f.page > 1) p.set('page', String(f.page));
  if (f.live) p.set('live', '1');
  const s = p.toString();
  return s ? `/board/deliveries?${s}` : '/board/deliveries';
}

/**
 * The buttons a job's status allows. List rows (`small`) leave out Cancel: it cannot be undone and the
 * board has no script for a confirm step, so cancelling happens on the job page (or the review list).
 */
export function actionForms(job: { id: string; status: JobStatus; version: number }, back: string, small: boolean, allowCancel = !small): string {
  return Object.entries(ACTIONS)
    .filter(([key, a]) => a.from.includes(job.status) && (allowCancel || key !== 'cancel'))
    .map(
      ([key, a]) =>
        `<form class="inline" method="post" action="/board/jobs/${h(job.id)}"><input type="hidden" name="action" value="${key}"><input type="hidden" name="version" value="${job.version}"><input type="hidden" name="back" value="${h(back)}"><button class="btn${small ? ' btn--sm' : ''}${a.tone === 'danger' || (a.tone && !small) ? ` btn--${a.tone}` : ''}" type="submit">${a.label}</button></form>`,
    )
    .join('');
}

/** Plain-English meaning of each chat-notice outcome, for the job page and flash messages. */
export const NOTICE_REASONS: Record<string, string> = {
  not_configured: 'chat notices are off: CHORD_API_KEY is not set',
  job_not_paid: 'the job is not paid',
  already_handled: 'a notice was already sent or is being sent',
  thread_not_found: "no recent conversation where the agent sent this job id",
  ambiguous_thread: 'two different customers were sent this job id at the same moment, so none was guessed',
  human_handling: 'a person has taken over that conversation',
  customer_mid_conversation: 'the customer was writing at that moment; the agent confirms in its reply',
  outside_24h_window: "the customer's last message is older than WhatsApp's 24-hour window",
  local_server: 'this is a local test server (set CHORD_NOTICES_ALLOW_LOCAL=1 to allow)',
  channel_cannot_show: "this chat's channel (e.g. the test simulator) cannot show pushed messages, so none was posted; Zuma confirms in its reply when the customer writes",
  agent_confirmed: 'Zuma confirmed the payment in its own reply first, so no separate notice was sent',
  record_only: "this channel (e.g. the test simulator) cannot show pushed messages; it is in the Chord conversation, so the agent knows the job is paid",
  hand_back_failed: 'Zuma could not hand the chat back to the agent. Open it in Chord and press "Hand back to AI", or the agent stays silent there',
  direct_line_not_delivered: "Chord's scheduled message only reached Chord's record, not the customer's chat (route since replaced)",
};

export interface BoardRow extends JobRow {
  paid_via: string | null;
  pickup_label: string | null;
  dropoff_label: string | null;
  package_size: string | null;
  approximate: number | null;
  distance_m: number | null;
  pickup_state: ServiceState | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  delivered_at: number | null;
}

/** The joins every Deliveries query shares (search and city filters read the place labels and state). */
export const JOB_FROM = `FROM jobs j JOIN quotes q ON q.id = j.quote_id
         LEFT JOIN places pu ON pu.id = q.pickup_place_id LEFT JOIN places dr ON dr.id = q.dropoff_place_id`;

/** The rows the Deliveries list and Home's "latest" list both show. */
export const JOB_ROW_SQL = `SELECT j.*, pu.label AS pickup_label, dr.label AS dropoff_label, q.package_size, q.approximate, q.distance_m,
              pu.state AS pickup_state, pu.lat AS pickup_lat, pu.lng AS pickup_lng,
              (SELECT json_extract(e.detail_json, '$.via') FROM job_events e WHERE e.job_id = j.id AND e.to_status = 'paid' ORDER BY e.id DESC LIMIT 1) AS paid_via,
              (SELECT MAX(e.created_at) FROM job_events e WHERE e.job_id = j.id AND e.to_status = 'delivered') AS delivered_at
         ${JOB_FROM}`;

export const JOBS_CSS = `
.filters{display:grid;gap:var(--space-xs);margin-bottom:var(--space-sm)}
.chips{display:flex;flex-wrap:wrap;gap:var(--space-3xs) var(--space-2xs);margin:0;padding:0;list-style:none}
.chips a{display:inline-flex;align-items:center;gap:var(--space-2xs);height:var(--control-sm);padding:0 var(--space-xs);border:1px solid var(--color-rule);border-radius:999px;color:var(--color-ink-2);text-decoration:none;font-size:var(--text-sm);white-space:nowrap;transition:border-color var(--dur) var(--ease-out),color var(--dur) var(--ease-out)}
.chips a:hover{border-color:var(--color-rule-2);color:var(--color-ink)}
.chips a[aria-current="page"]{border-color:var(--color-ink);background:var(--color-surface);color:var(--color-ink);font-weight:600}
.chips .num{color:var(--color-muted);font-size:var(--text-xs)}
.chips-row{display:flex;flex-wrap:wrap;gap:var(--space-2xs) var(--space-md);align-items:center}
.chips-row .label{flex:none}
.m-only{display:none}
.filt>summary{font-size:var(--text-sm);color:var(--color-ink);min-height:var(--control-sm)}
.filt .chips-row{padding-top:var(--space-2xs)}
.search{display:flex;gap:var(--space-2xs);align-items:center}
.filters__chips{display:grid;gap:var(--space-2xs)}
.adv{border:1px solid var(--color-rule);border-radius:var(--radius-lg);background:var(--color-surface);margin-top:var(--space-2xs)}
.adv>summary{padding:var(--space-2xs) var(--space-sm);font-size:var(--text-sm);color:var(--color-ink);cursor:pointer;min-height:var(--control-sm);display:flex;align-items:center;gap:var(--space-2xs)}
.adv[open]>summary{border-bottom:1px solid var(--color-rule)}
.adv__grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr));gap:var(--space-sm) var(--space-md);padding:var(--space-sm)}
.adv fieldset{border:0;margin:0;padding:0;min-width:0;display:grid;gap:var(--space-2xs);align-content:start}
.adv legend{font-size:var(--text-xs);font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--color-muted);padding:0;margin-bottom:var(--space-3xs)}
.adv__row{display:grid;grid-template-columns:4.5rem minmax(0,1fr);align-items:center;gap:var(--space-2xs)}
.adv__row label{font-size:var(--text-sm);color:var(--color-ink-2)}
.adv__hint{font-size:var(--text-xs);color:var(--color-muted);margin:0;max-width:40ch}
.adv__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-xs) var(--space-sm);padding:0 var(--space-sm) var(--space-sm)}
.adv__actions a{font-size:var(--text-sm)}
.adv>summary,.filt>summary{display:block;line-height:1.45;padding-top:var(--space-2xs);padding-bottom:var(--space-2xs)}
.adv>summary::before,.filt>summary::before{display:inline-block;margin-right:var(--space-2xs)}
.jobs td.empty{white-space:normal}
.th-sort{color:inherit;text-decoration:none;white-space:nowrap}.th-sort:hover{text-decoration:underline}
th[aria-sort] .th-sort{color:var(--color-ink)}
.pager{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:var(--space-xs);margin-top:var(--space-sm);font-size:var(--text-sm)}
.pager>a:last-child{justify-self:end}
.search .input{flex:1}
.result{display:flex;flex-wrap:wrap;gap:var(--space-3xs) var(--space-sm);font-size:var(--text-sm);color:var(--color-muted);margin-bottom:var(--space-sm);min-height:1lh}
.jobs td:first-child{white-space:nowrap}.jobs td:first-child a{font-family:var(--font-mono);font-weight:500}
.jobs .amt{font-weight:600;color:var(--color-ink);white-space:nowrap}
.jobs .route{min-width:14rem}
.jobs td.act{white-space:nowrap}
@media (max-width:48rem){
  .d-only{display:none}.m-only{display:block}
  .search .btn{padding:0 var(--space-sm)}
  .table-wrap.jobs-wrap{overflow:visible;border:0;background:transparent;border-radius:0}
  .jobs thead{display:none}
  .jobs,.jobs tbody{display:block;width:100%}
  /* Phones: one compact card per job (id · status · amount, then the route); people, package and city live on the job page. */
  .jobs tr{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:var(--space-3xs) var(--space-xs);padding:var(--space-xs) 0;border-top:1px solid var(--color-rule)}
  .jobs td{display:block;border:0;padding:0;min-width:0}
  .jobs td.c-city,.jobs td.c-pkg,.jobs td.people,.jobs td .sub.c-hide{display:none}
  .jobs td.route,.jobs td.act,.jobs td.empty{grid-column:1/-1}
  .jobs td.act.is-empty{display:none}
  .jobs td:first-child .sub{font-size:var(--text-xs)}
  .jobs .route{min-width:0;font-size:var(--text-sm)}
  .jobs td:first-child{grid-row:1;grid-column:1}.jobs td[data-label="Status"]{grid-row:1;grid-column:2}.jobs td.amt{grid-row:1;grid-column:3;text-align:right}
  .jobs td.route{grid-row:2}.jobs td.act{grid-row:3}
  .jobs td.empty:first-child{grid-row:1;grid-column:1/-1;white-space:normal}
  .jobs td.act{white-space:normal;padding-top:var(--space-3xs)}
  .jobs td.act .btn{height:var(--control)}
  tbody tr:hover>td{background:transparent}
}`;

/** The date under the job id: when it was booked, or (filtering by paid or delivered) that moment. */
function rowDate(j: BoardRow, by: DateBy): string {
  const at = by === 'paid' ? j.paid_at : by === 'delivered' ? j.delivered_at : null;
  return by === 'booked' || at == null ? time(j.created_at) : `${by} ${time(at)}`;
}

/** One delivery as a table row (Deliveries list) — `compact` drops the people and package columns (Home). */
export function jobRow(j: BoardRow, back: string, compact = false, by: DateBy = 'booked'): string {
  const phone = normalizeNigerianPhone(j.recipient_phone);
  const city = jobCity(j);
  const km = j.distance_m ? `${(j.distance_m / 1000).toFixed(1)} km${j.approximate ? ' (est.)' : ''}` : '';
  const actions = actionForms(j, back, true);
  const rider = riderById(j.rider_id);
  return `<tr>
<td data-label="Job"><a href="/board/jobs/${h(j.id)}">${h(j.id)}</a><span class="sub">${rowDate(j, by)}</span></td>
<td data-label="Status">${statusPill(j.status)}${!compact && j.paid_via ? `<span class="sub c-hide">via ${h((PAID_VIA[j.paid_via] ?? j.paid_via).toLowerCase())}</span>` : ''}${rider ? `<span class="sub c-hide">rider ${h(rider.name)}</span>` : ''}</td>
<td data-label="City" class="c-city">${h(city ? CITY_LABEL[city] : '—')}</td>
<td data-label="Route" class="route">${h(j.pickup_label ?? '?')}<span class="sub">→ ${h(j.dropoff_label ?? '?')}</span></td>
${compact ? '' : `<td data-label="Package" class="c-pkg">${h(j.package_size ?? '')}${km ? `<span class="sub num">${km}</span>` : ''}</td>`}
<td data-label="Amount" class="amt num">${formatNaira(j.amount_kobo)}</td>
${compact ? '' : `<td data-label="Sender → recipient" class="people">${h(j.sender_name)} → ${h(j.recipient_name)}<span class="sub">${h(phone.ok ? phone.display : j.recipient_phone)} · code <span class="mono">${h(j.handover_code)}</span></span></td>`}
<td class="act${actions ? '' : ' is-empty'}"><div class="actions">${actions || '<span class="muted">—</span>'}</div></td></tr>`;
}

export interface SortHead {
  current: Sort;
  href: (s: Sort) => string;
}

/**
 * A column header that sorts the list. A plain link (the board has no scripts): clicking the sorted
 * column again flips it. aria-sort tells screen readers which column the list is sorted by.
 */
function sortTh(label: string, sort: SortHead | undefined, desc: Sort, asc: Sort | null): string {
  if (!sort) return `<th>${label}</th>`;
  const on = sort.current === desc ? 'descending' : asc && sort.current === asc ? 'ascending' : null;
  const next = sort.current === desc && asc ? asc : desc;
  const arrow = on === 'descending' ? ' ↓' : on === 'ascending' ? ' ↑' : '';
  const what = SORT_LABEL[next].toLowerCase();
  return `<th${on ? ` aria-sort="${on}"` : ''}><a class="th-sort" href="${h(sort.href(next))}" title="Sort: ${h(what)}">${label}<span aria-hidden="true">${arrow}</span><span class="sr"> (sort ${h(what)})</span></a></th>`;
}

export function jobTable(rows: string, empty: string, compact = false, sort?: SortHead): string {
  const head = compact
    ? '<th>Job</th><th>Status</th><th>City</th><th>Route</th><th>Amount</th><th>Actions</th>'
    : `${sortTh('Job', sort, 'newest', 'oldest')}<th>Status</th><th>City</th><th>Route</th>${sortTh('Package', sort, 'distance_desc', null)}${sortTh('Amount', sort, 'amount_desc', 'amount_asc')}<th>Sender → recipient</th><th>Actions</th>`;
  return `<div class="table-wrap jobs-wrap"><table class="jobs"><thead><tr>${head}</tr></thead>
<tbody>${rows || `<tr><td colspan="${compact ? 6 : 8}" class="empty">${empty}</td></tr>`}</tbody></table></div>`;
}
