import type { Config } from '../config';
import type { Env } from '../env';
import { formatNaira } from '../lib/money';
import { escapeHtml as h } from '../lib/text';
import { watDayStart } from './charts';
import { announcement, announcementText, longDate, time } from './layout';
import { JOB_ROW_SQL, JOBS_CSS, jobRow, jobTable, type BoardRow } from './jobsShared';
import { blank, pageHead, shell, type BoardSession } from './shell';
import { alertsFrom, readSignals, type Alert, type Tone } from './signals';

const TONE_LABEL: Record<Tone, string> = { urgent: 'Urgent', warn: 'Check', action: 'To do', info: 'For info' };

const HOME_CSS = `
.home-sec{margin-bottom:var(--space-xl)}
.home-sec__head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:var(--space-3xs) var(--space-sm);margin-bottom:var(--space-sm)}
.home-sec__head a{font-size:var(--text-sm);white-space:nowrap}
.alerts{list-style:none;margin:0;padding:0;border:1px solid var(--color-rule);border-radius:var(--radius-lg);background:var(--color-surface);overflow:hidden}
.alerts li+li{border-top:1px solid var(--color-rule)}
.alert{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-2xs) var(--space-md);align-items:center;padding:var(--space-sm);color:var(--color-ink-2);text-decoration:none;transition:background-color var(--dur) var(--ease-out)}
.alert:hover{background:var(--color-paper-2);color:var(--color-ink-2)}
.alert--urgent{background:var(--color-bad-wash)}
.alert--urgent:hover{background:var(--color-bad-wash)}
.alert__title{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-3xs) var(--space-xs);font:600 var(--text-md)/1.3 var(--font-display);color:var(--color-ink);overflow-wrap:anywhere}
.tone{display:inline-flex;align-items:center;gap:var(--space-3xs);height:1.375rem;padding:0 var(--space-2xs);border:1px solid currentColor;border-radius:999px;font:500 var(--text-xs)/1 var(--font-body);white-space:nowrap}
.tone::before{content:"";width:.375rem;height:.375rem;border-radius:50%;background:currentColor}
.tone--urgent{color:var(--color-bad)}.tone--warn{color:var(--color-warn)}.tone--action{color:var(--color-accent-text)}.tone--info{color:var(--color-muted)}
.alert__detail{display:block;margin-top:var(--space-3xs);font-size:var(--text-sm);color:var(--color-ink-2);max-width:70ch}
.alert__cta{font-size:var(--text-sm);font-weight:500;color:var(--color-accent-text);white-space:nowrap}
.alert:hover .alert__cta{text-decoration:underline;text-underline-offset:2px}
.clear{display:flex;gap:var(--space-sm);align-items:flex-start;padding:var(--space-md) var(--space-sm);border:1px solid var(--color-rule);border-radius:var(--radius-lg);background:var(--color-surface)}
.clear__mark{width:.625rem;height:.625rem;margin-top:.4rem;border-radius:50%;background:var(--color-ok);flex:none}
.clear b{display:block;font:600 var(--text-md)/1.3 var(--font-display);color:var(--color-ink)}
.clear span{font-size:var(--text-sm);color:var(--color-muted)}
.today{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;border:1px solid var(--color-rule);border-radius:var(--radius-lg);background:var(--color-surface)}
.today>div{padding:var(--space-sm);min-width:0}
.today>div+div{border-left:1px solid var(--color-rule)}
.today dt{font-size:var(--text-sm);color:var(--color-muted)}
.today dd{margin:0}
.today__v{font:600 var(--text-lg)/1.2 var(--font-display);letter-spacing:-0.01em;color:var(--color-ink);font-variant-numeric:tabular-nums;overflow-wrap:anywhere;margin-top:var(--space-3xs)!important}
.today__sub{font-size:var(--text-xs);color:var(--color-muted)}
.today a{color:inherit;text-decoration:none}
.today a:hover .today__v{color:var(--color-accent-text)}
@media (max-width:48rem){
  .alert{grid-template-columns:minmax(0,1fr);gap:var(--space-3xs)}
  .alert__cta{margin-top:var(--space-3xs)}
  .today{grid-template-columns:repeat(2,minmax(0,1fr))}
  .today>div+div{border-left:0}
  .today>div:nth-child(even){border-left:1px solid var(--color-rule)}
  .today>div:nth-child(n+3){border-top:1px solid var(--color-rule)}
}
${JOBS_CSS}`;

function alertItem(a: Alert): string {
  return `<li><a class="alert alert--${a.tone}" href="${h(a.href)}"><span><span class="alert__title"><span>${h(a.title)}</span><span class="tone tone--${a.tone}">${TONE_LABEL[a.tone]}</span></span><span class="alert__detail">${h(a.detail)}</span></span><span class="alert__cta">${h(a.cta)} →</span></a></li>`;
}

/** GET /board — what needs a person first, then today in four numbers, then the latest deliveries. */
export async function home(url: URL, env: Env, config: Config, session: BoardSession): Promise<Response> {
  const now = Date.now();
  const today = watDayStart(now);
  const live = url.searchParams.get('live') === '1';
  const db = env.DB;
  const [sig, batch] = await Promise.all([
    readSignals(env, now),
    db.batch([
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status IN ('paid','dispatched','delivered') THEN 1 ELSE 0 END), 0) AS paid FROM jobs WHERE created_at >= ?`).bind(today),
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_kobo), 0) AS kobo FROM jobs WHERE paid_at >= ? AND status IN ('paid','dispatched','delivered')`).bind(today),
      db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_kobo), 0) AS kobo FROM jobs WHERE status IN ('awaiting_payment','payment_failed')`),
      db.prepare(`${JOB_ROW_SQL} ORDER BY j.created_at DESC LIMIT 5`),
    ]),
  ]);
  const [booked, paid, owed, latest] = batch;
  const b = booked!.results[0] as { n: number; paid: number };
  const p = paid!.results[0] as { n: number; kobo: number };
  const o = owed!.results[0] as { n: number; kobo: number };
  const alerts = alertsFrom(sig);
  const urgent = alerts.filter((a) => a.tone === 'urgent').length;

  const needs = alerts.length
    ? `<ul class="alerts">${alerts.map(alertItem).join('')}</ul>`
    : `<div class="clear" role="status"><span class="clear__mark" aria-hidden="true"></span><div><b>Nothing needs you right now.</b><span>This list fills in when a chat waits for a person, a payment needs review, a job is ready to dispatch, or an integration fails.</span></div></div>`;
  const s = (n: number) => (n === 1 ? '' : 's');
  const figures = `<dl class="today">
<div><a href="/board/deliveries?when=today"><dt>Booked today</dt><dd class="today__v">${b.n}</dd><dd class="today__sub">${b.paid} of them paid (WAT day)</dd></a></div>
<div><dt>Paid today</dt><dd class="today__v">${formatNaira(p.kobo)}</dd><dd class="today__sub">${p.n} job${s(p.n)}, any booking day</dd></div>
<div><a href="/board/deliveries?status=awaiting_payment"><dt>Awaiting payment now</dt><dd class="today__v">${formatNaira(o.kobo)}</dd><dd class="today__sub">${o.n} open job${s(o.n)}, any booking day</dd></a></div>
<div><a href="/board/deliveries?status=dispatched"><dt>Out with riders now</dt><dd class="today__v">${sig.out}</dd><dd class="today__sub">${sig.ready} more ready to dispatch</dd></a></div>
</dl>`;
  const rows = (latest!.results as unknown as BoardRow[]).map((j) => jobRow(j, '/board', true)).join('');
  const refresh = live ? `<span>Refreshes every 30 s</span><a href="/board">Stop</a>` : `<a href="/board?live=1">Auto-refresh</a>`;
  const body = `${pageHead('Today', `${longDate(now)} · updated ${time(now).slice(6)}`, refresh)}
${announcement(announcementText(env.BOARD_ANNOUNCEMENT))}
<section class="home-sec" aria-labelledby="needs-h"><div class="home-sec__head"><h2 id="needs-h">Needs you${alerts.length ? ` <span class="muted num">(${alerts.length})</span>` : ''}</h2>${urgent ? `<span class="muted" style="font-size:var(--text-sm)">${urgent} urgent</span>` : ''}</div>${needs}</section>
<section class="home-sec" aria-labelledby="today-h"><div class="home-sec__head"><h2 id="today-h">At a glance</h2><a href="/board/deliveries/overview">Overview →</a></div>${figures}</section>
<section class="home-sec" aria-labelledby="latest-h"><div class="home-sec__head"><h2 id="latest-h">Latest deliveries</h2><a href="/board/deliveries">All deliveries →</a></div>${
    rows ? jobTable(rows, '', true) : blank('No deliveries yet.', ' They appear here as soon as Zuma books one on WhatsApp.')
  }</section>`;
  return shell({ env, config, session, url, active: 'home', title: 'Home', css: HOME_CSS, body, signals: sig, refreshSeconds: live ? 30 : undefined });
}
