import { formatNaira } from '../lib/money';
import { escapeHtml as h } from '../lib/text';

/**
 * Server-rendered charts for the board: plain HTML + CSS, no script, no images.
 * Every chart is aria-hidden and paired with a screen-reader table of the same numbers.
 * Only real counts from D1 are drawn; an empty dataset says so instead of drawing zeros.
 */

export const STATUS_ORDER = ['awaiting_payment', 'paid', 'dispatched', 'delivered', 'payment_failed', 'amount_mismatch', 'cancelled'] as const;
export const PAID_STATUSES = ['paid', 'dispatched', 'delivered'];

export const WAT_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Start of the WAT calendar day containing `ms`, as a UTC epoch. */
export function watDayStart(ms: number): number {
  return Math.floor((ms + WAT_MS) / DAY_MS) * DAY_MS - WAT_MS;
}

export interface DayRow { day: number; booked: number; paid: number; revenue: number }

/** Fills in the 7 WAT days ending today, including days with no bookings. `day` is the WAT day number. */
export function lastSevenDays(rows: DayRow[], now: number): DayRow[] {
  const today = Math.floor((now + WAT_MS) / DAY_MS);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: 7 }, (_, i) => {
    const day = today - 6 + i;
    return byDay.get(day) ?? { day, booked: 0, paid: 0, revenue: 0 };
  });
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function dayLabel(day: number): { name: string; date: string } {
  const d = new Date(day * DAY_MS);
  return { name: DAY_NAMES[d.getUTCDay()]!, date: String(d.getUTCDate()) };
}

/** Share of a total as a whole percentage; 0 when there is no total. */
export const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

/** Median and 95th percentile of a list of numbers (nearest-rank). */
export function percentiles(values: number[]): { p50: number; p95: number } | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
  return { p50: rank(0.5), p95: rank(0.95) };
}

// ------------------------------------------------------------------ pipeline (status distribution)
export function pipelineChart(counts: Record<string, number>, hrefFor: (status: string) => string): string {
  const total = STATUS_ORDER.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
  if (!total) return '<p class="viz__empty">No bookings yet. The pipeline fills in as the agent takes them.</p>';
  const present = STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0);
  const bar = present
    .map((s) => `<a class="pipe__seg v-${s}" style="flex-grow:${counts[s]}" href="${h(hrefFor(s))}" tabindex="-1" aria-hidden="true" title="${h(s.replaceAll('_', ' '))}: ${counts[s]}"></a>`)
    .join('');
  const legend = STATUS_ORDER.map((s) => {
    const n = counts[s] ?? 0;
    return `<li><a href="${h(hrefFor(s))}"${n ? '' : ' class="is-zero"'}><span class="swatch v-${s}" aria-hidden="true"></span><span class="legend__name">${h(s.replaceAll('_', ' '))}</span><span class="legend__n num">${n}</span><span class="legend__pct num">${pct(n, total)}%</span></a></li>`;
  }).join('');
  return `<div class="pipe" aria-hidden="true">${bar}</div><ul class="legend" aria-label="Jobs by status (links filter the list)">${legend}</ul>`;
}

// ------------------------------------------------------------------ last 7 days (columns)
export function weekChart(days: DayRow[]): string {
  const booked = days.reduce((s, d) => s + d.booked, 0);
  const paid = days.reduce((s, d) => s + d.paid, 0);
  const revenue = days.reduce((s, d) => s + d.revenue, 0);
  const max = Math.max(1, ...days.map((d) => d.booked));
  const cols = days
    .map((d, i) => {
      const l = dayLabel(d.day);
      const paidH = (d.paid / max) * 100;
      const restH = ((d.booked - d.paid) / max) * 100;
      return `<div class="week__col${i === days.length - 1 ? ' is-today' : ''}"><span class="week__n num">${d.booked || ''}</span>
<div class="week__bar"><span class="week__rest v-awaiting_payment" style="height:${restH.toFixed(1)}%"></span><span class="week__paid v-paid" style="height:${paidH.toFixed(1)}%"></span></div>
<span class="week__day">${l.name}<span class="num"> ${l.date}</span></span></div>`;
    })
    .join('');
  const table = `<div class="sr"><table><caption>Bookings per day, last 7 days (WAT)</caption><tr><th>Day</th><th>Booked</th><th>Paid</th><th>Paid value</th></tr>${days
    .map((d) => {
      const l = dayLabel(d.day);
      return `<tr><td>${l.name} ${l.date}</td><td>${d.booked}</td><td>${d.paid}</td><td>${formatNaira(d.revenue)}</td></tr>`;
    })
    .join('')}</table></div>`;
  const summary = booked
    ? `${booked} booked · ${paid} paid (${pct(paid, booked)}%) · ${formatNaira(revenue)} paid value`
    : 'No bookings in the last 7 days.';
  return `<div class="week" aria-hidden="true">${cols}</div>${table}
<p class="viz__foot"><span class="key"><span class="swatch v-paid" aria-hidden="true"></span>paid or later</span><span class="key"><span class="swatch v-awaiting_payment" aria-hidden="true"></span>not paid</span><span class="num">${h(summary)}</span></p>`;
}

// ------------------------------------------------------------------ horizontal breakdown bars
export interface Part { label: string; n: number }

export function breakdown(title: string, parts: Part[], emptyText: string): string {
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (!total) return `<div class="bars"><p class="bars__title">${h(title)}</p><p class="viz__empty">${h(emptyText)}</p></div>`;
  const max = Math.max(...parts.map((p) => p.n));
  const rows = [...parts]
    .sort((a, b) => b.n - a.n)
    .map((p) => `<li><span class="bars__label">${h(p.label)}</span><span class="bars__track" aria-hidden="true"><span class="bars__fill" style="width:${((p.n / max) * 100).toFixed(1)}%"></span></span><span class="bars__n num">${p.n}<span class="sr"> of ${total}</span></span></li>`)
    .join('');
  return `<div class="bars"><p class="bars__title">${h(title)}</p><ul>${rows}</ul></div>`;
}

export const CHART_CSS = `
.band{background:var(--color-graphite);color:var(--color-graphite-ink);padding-block:var(--space-lg) var(--space-xl)}
.band h2{color:var(--color-graphite-ink)}
.band .label,.band .muted{color:var(--color-graphite-muted)}
.band a{color:var(--color-graphite-ink)}
.band a:focus-visible{outline-color:var(--color-graphite-ink)}
.band__head{display:flex;flex-direction:column;gap:var(--space-3xs);margin-bottom:var(--space-md)}
.figures{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-md);margin:0 0 var(--space-lg);padding:0 0 var(--space-lg);border-bottom:1px solid var(--color-graphite-rule)}
.figure{display:flex;flex-direction:column;gap:var(--space-3xs);min-width:0;margin:0}
.figure dd{margin:0}
.figure__v{font:600 var(--text-xl)/1.1 var(--font-display);letter-spacing:-0.02em;color:var(--color-graphite-ink);overflow-wrap:anywhere}
.figure__sub{font-size:var(--text-xs);color:var(--color-graphite-muted)}
.viz-grid{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:var(--space-lg) var(--space-xl)}
.viz{margin:0;min-width:0}
.viz--wide{grid-column:1/-1}
.viz figcaption{margin-bottom:var(--space-xs)}
.viz__empty{color:var(--color-graphite-muted);font-size:var(--text-sm)}
.viz__foot{display:flex;flex-wrap:wrap;gap:var(--space-2xs) var(--space-sm);align-items:center;margin-top:var(--space-xs);font-size:var(--text-xs);color:var(--color-graphite-muted)}
.key{display:inline-flex;align-items:center;gap:var(--space-3xs)}
.swatch{display:inline-block;width:.625rem;height:.625rem;border-radius:2px;flex:none}
.pipe{display:flex;gap:2px;height:.875rem;border-radius:3px;overflow:hidden;background:var(--viz-track)}
.pipe__seg{display:block;min-width:4px}
.legend{list-style:none;margin:var(--space-sm) 0 0;padding:0;display:flex;flex-wrap:wrap;gap:var(--space-3xs) var(--space-md)}
.legend a{display:inline-flex;align-items:center;gap:var(--space-2xs);min-height:2rem;text-decoration:none;font-size:var(--text-sm);white-space:nowrap}
.legend a:hover .legend__name{text-decoration:underline;text-underline-offset:2px}
.legend a.is-zero{color:var(--color-graphite-muted)}
.legend__n{font-weight:600}
.legend__pct{color:var(--color-graphite-muted);font-size:var(--text-xs)}
.week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:var(--space-2xs);align-items:end}
.week__col{display:flex;flex-direction:column;align-items:stretch;gap:var(--space-3xs);min-width:0}
.week__n{min-height:1lh;text-align:center;font-size:var(--text-xs);color:var(--color-graphite-ink)}
.week__bar{height:7rem;display:flex;flex-direction:column;justify-content:flex-end;border-bottom:1px solid var(--color-graphite-rule)}
.week__bar>span:first-child{border-radius:3px 3px 0 0}
.week__bar>span{display:block;width:100%}
.week__day{text-align:center;font:500 var(--text-2xs)/1.3 var(--font-mono);letter-spacing:.04em;text-transform:uppercase;color:var(--color-graphite-muted);white-space:nowrap}
.week__col.is-today .week__day{color:var(--color-graphite-ink)}
.bars+.bars{margin-top:var(--space-md)}
.bars__title{font:500 var(--text-2xs)/1.2 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--color-graphite-muted);margin-bottom:var(--space-2xs)}
.bars ul{list-style:none;margin:0;padding:0;display:grid;gap:var(--space-2xs)}
.bars li{display:grid;grid-template-columns:minmax(0,10rem) minmax(0,1fr) 2.5rem;gap:var(--space-xs);align-items:center;font-size:var(--text-sm)}
.bars__label{overflow-wrap:anywhere}
.bars__track{height:.5rem;border-radius:2px;background:var(--viz-track);overflow:hidden}
.bars__fill{display:block;height:100%;background:var(--viz-paid)}
.bars__n{text-align:right;font-weight:600}
@media (max-width:64rem){.viz-grid{grid-template-columns:minmax(0,1fr)}}
@media (max-width:48rem){
  .figures{grid-template-columns:repeat(2,minmax(0,1fr))}
  .bars li{grid-template-columns:minmax(0,7.5rem) minmax(0,1fr) 2rem}
  .week__bar{height:5rem}
}
`;
