import type { Config } from '../config';
import type { Env } from '../env';
import { NOTICE_KIND, noticeStatus } from '../chord/notices';
import { formatNaira } from '../lib/money';
import { escapeHtml as h } from '../lib/text';
import { percentiles, pct } from './charts';
import { time } from './layout';
import { actionForms, NOTICE_REASONS } from './jobsShared';
import { blank, pageHead, shell, subTabs, type BoardSession } from './shell';
import { DAY_MS, isFault, readSignals, type Signals } from './signals';

const OPS_CSS = `
.svc{list-style:none;margin:0;padding:0;border:1px solid var(--color-rule);border-radius:var(--radius-lg);background:var(--color-surface)}
.svc li{display:grid;grid-template-columns:minmax(0,13rem) 7.5rem minmax(0,1fr) auto;gap:var(--space-2xs) var(--space-md);align-items:center;padding:var(--space-sm)}
.svc li+li{border-top:1px solid var(--color-rule)}
.svc__name{font:600 var(--text-base)/1.3 var(--font-display);color:var(--color-ink)}
.svc__name span{display:block;font:400 var(--text-xs)/1.4 var(--font-body);color:var(--color-muted)}
.svc__detail{font-size:var(--text-sm);color:var(--color-ink-2);overflow-wrap:anywhere}
.lead{font-size:var(--text-sm);color:var(--color-muted);margin-bottom:var(--space-sm);max-width:72ch}
.tally{display:flex;flex-wrap:wrap;gap:var(--space-2xs);margin-bottom:var(--space-sm)}
td .why{display:block;max-width:44ch;color:var(--color-ink-2);overflow-wrap:anywhere}
@media (max-width:48rem){.svc li{grid-template-columns:minmax(0,1fr);gap:var(--space-3xs)}}
`;

const table = (head: string[], body: string) =>
  `<div class="table-wrap"><table><thead><tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;

function safeReason(detailJson: string | null): string {
  try {
    return (JSON.parse(detailJson ?? '{}') as { reason?: string }).reason ?? '';
  } catch {
    return '';
  }
}

const chip = (tone: 'ok' | 'bad' | 'warn' | '', text: string) => `<span class="chip${tone ? ` chip--${tone}` : ''}">${h(text)}</span>`;

// ------------------------------------------------------------------ Payments
const NOTICE_STATE: Record<string, string> = { sent: 'Delivered', queued: 'Queued', pending: 'Sending', skipped: 'Not sent', failed: 'Failed', stuck: 'Left with a person' };

export async function paymentsPage(path: string, url: URL, env: Env, config: Config, session: BoardSession): Promise<Response> {
  const view = path.endsWith('/paystack') ? 'paystack' : path.endsWith('/chat') ? 'chat' : 'review';
  const db = env.DB;
  const now = Date.now();
  const [review, paystack, notices, noticeCounts, paystack24] = await db.batch([
    db.prepare(
      `SELECT j.id, j.status, j.version, j.amount_kobo, j.sender_name, j.updated_at,
              (SELECT e.detail_json FROM job_events e WHERE e.job_id = j.id AND e.type = 'needs_review' ORDER BY e.id DESC LIMIT 1) AS detail_json
         FROM jobs j WHERE j.status = 'amount_mismatch' ORDER BY j.updated_at DESC LIMIT 50`,
    ),
    db.prepare('SELECT event, reference, job_id, outcome, ip_trusted, received_at FROM paystack_events ORDER BY received_at DESC LIMIT 50'),
    db.prepare('SELECT job_id, state, reason, thread_id, attempts, updated_at FROM chat_notices WHERE kind = ? ORDER BY updated_at DESC LIMIT 40').bind(NOTICE_KIND),
    db.prepare("SELECT CASE WHEN reason = 'hand_back_failed' THEN 'stuck' ELSE state END AS state, COUNT(*) AS n FROM chat_notices GROUP BY 1"),
    db.prepare('SELECT COUNT(*) AS n FROM paystack_events WHERE received_at >= ?').bind(now - DAY_MS),
  ]);
  const reviewRows = review!.results as unknown as { id: string; status: 'amount_mismatch'; version: number; amount_kobo: number; sender_name: string; updated_at: number; detail_json: string | null }[];
  const counts = Object.fromEntries((noticeCounts!.results as unknown as { state: string; n: number }[]).map((c) => [c.state, c.n])) as Record<string, number>;
  const problems = (counts.stuck ?? 0) + (counts.failed ?? 0);
  const tabs = subTabs('Payments views', [
    { href: '/board/payments', label: 'To review', n: reviewRows.length, current: view === 'review' },
    { href: '/board/payments/paystack', label: 'Paystack notifications', current: view === 'paystack' },
    { href: '/board/payments/chat', label: 'Chat notices', n: problems, current: view === 'chat' },
  ]);

  let body: string;
  if (view === 'review') {
    body = `<p class="lead">Paystack said a payment succeeded, but the amount, currency or reference did not match the quote. Nothing moves until you decide. Approving marks the job paid, assigns a rider and tells the customer in the chat.</p>${
      reviewRows.length
        ? table(
            ['Job', 'Customer', 'Quoted', 'What did not match', 'Since', 'Decide'],
            reviewRows
              .map((r) => `<tr><td><a class="mono" href="/board/jobs/${h(r.id)}?view=payments">${h(r.id)}</a></td><td>${h(r.sender_name)}</td><td class="num">${formatNaira(r.amount_kobo)}</td><td><span class="why">${h(safeReason(r.detail_json) || 'See the job’s payment view.')}</span></td><td>${time(r.updated_at)}</td><td><div class="actions">${actionForms(r, '/board/payments', true, true)}</div></td></tr>`)
              .join(''),
          )
        : blank('Nothing to review.', ' A payment lands here only when Paystack’s numbers disagree with the quote.')
    }`;
  } else if (view === 'paystack') {
    const rows = paystack!.results as unknown as { event: string; reference: string | null; job_id: string | null; outcome: string; ip_trusted: number; received_at: number }[];
    const n24 = Number((paystack24!.results[0] as { n: number }).n);
    body = `<p class="lead">Every notification Paystack sent, newest first (${n24} in the last 24 h). Each one is re-checked with Paystack’s API before a job changes, so a forged notification changes nothing.</p>${
      rows.length
        ? table(
            ['When', 'Event', 'Job', 'Result', 'From a Paystack IP'],
            rows.map((n) => `<tr><td>${time(n.received_at)}</td><td><code>${h(n.event)}</code></td><td>${n.job_id ? `<a class="mono" href="/board/jobs/${h(n.job_id)}?view=payments">${h(n.job_id)}</a>` : '—'}</td><td>${h(n.outcome)}</td><td>${n.ip_trusted ? 'yes' : '<b>no</b>'}</td></tr>`).join(''),
          )
        : blank('No notifications yet.', ' They arrive at /webhooks/paystack after a customer pays a link or transfer.')
    }`;
  } else {
    const state = noticeStatus(env);
    const rows = notices!.results as unknown as { job_id: string; state: string; reason: string | null; thread_id: string | null; attempts: number; updated_at: number }[];
    const tally = Object.entries(counts).map(([k, n]) => chip(k === 'sent' ? 'ok' : k === 'stuck' || k === 'failed' ? 'bad' : '', `${n} ${NOTICE_STATE[k] ?? k}`)).join('');
    body = `<p class="lead">After a payment is confirmed, the customer gets “Payment received” with their rider and handover code in the chat, without having to write first.${
      state === 'enabled' ? '' : state === 'invalid_config' ? ' <b>Misconfigured:</b> CHORD_API_KEY or CHORD_WORKSPACE_ID is not valid (docs/FEATURES.md §5a).' : ' <b>Off:</b> CHORD_API_KEY is not set, so Zuma confirms when the customer next writes.'
    }</p>${tally ? `<div class="tally">${tally}</div>` : ''}${
      rows.length
        ? table(
            ['Job', 'Result', 'Why', 'When', 'Chat'],
            rows
              .map((n) => {
                const stuck = n.reason === 'hand_back_failed';
                return `<tr><td><a class="mono" href="/board/jobs/${h(n.job_id)}">${h(n.job_id)}</a></td><td>${stuck ? '<b>Left with a person</b>' : n.state === 'failed' ? '<b>Failed</b>' : h(NOTICE_STATE[n.state] ?? n.state)}</td><td><span class="why">${h(n.reason ? NOTICE_REASONS[n.reason] ?? n.reason : '—')}</span></td><td>${time(n.updated_at)}</td><td>${
                  n.thread_id ? `<a href="/board/handovers/${h(n.thread_id)}">${stuck ? 'Hand back' : 'Open'}</a>` : '—'
                }</td></tr>`;
              })
              .join(''),
          )
        : blank('No chat notices yet.', ' One is recorded when Paystack’s notification, the checkout return page or a dispatcher approval confirms a payment. When the customer confirms by asking in the chat, Zuma tells them there and no notice is needed. A local test server never sends them.')
    }`;
  }
  return shell({
    env, config, session, url, active: 'payments', title: 'Payments', css: OPS_CSS,
    body: `${pageHead('Payments', 'What Paystack told us, what needs your decision, and what the customer was told.')}${tabs}${body}`,
  });
}

// ------------------------------------------------------------------ System
export async function systemPage(path: string, url: URL, env: Env, config: Config, session: BoardSession): Promise<Response> {
  const view = path.endsWith('/tools') ? 'tools' : 'status';
  const db = env.DB;
  const now = Date.now();
  const [sig, batch] = await Promise.all([
    readSignals(env, now),
    db.batch([
      db.prepare("SELECT MAX(received_at) AS at, COUNT(*) AS n FROM chord_events"),
      db.prepare('SELECT MAX(received_at) AS at FROM paystack_events'),
      db.prepare('SELECT tool, ok, error_code, latency_ms, detail, created_at FROM tool_calls ORDER BY id DESC LIMIT 200'),
      db.prepare("SELECT ran_at, ok, detail FROM cron_runs WHERE name = 'watchdog'"),
      db.prepare("SELECT COALESCE(SUM(kind = 'handover'), 0) AS handovers, COALESCE(SUM(kind = 'foreign_link'), 0) AS links FROM watchdog_events WHERE created_at >= ?").bind(now - DAY_MS),
    ]),
  ]);
  const [chordEv, payEv, calls, wdRun, wdEv] = batch;
  const wd = {
    run: (wdRun?.results[0] as { ran_at: number; ok: number; detail: string | null } | undefined) ?? null,
    ev: (wdEv?.results[0] as { handovers: number; links: number } | undefined) ?? { handovers: 0, links: 0 },
  };
  const ce = chordEv!.results[0] as { at: number | null; n: number };
  const pe = payEv!.results[0] as { at: number | null };
  const toolRows = calls!.results as unknown as { tool: string; ok: number; error_code: string | null; latency_ms: number; detail: string | null; created_at: number }[];
  const lat = percentiles(toolRows.map((c) => c.latency_ms));
  const okCalls = toolRows.filter((c) => c.ok).length;
  const tabs = subTabs('System views', [
    { href: '/board/system', label: 'Status', current: view === 'status' },
    { href: '/board/system/tools', label: 'Agent tool calls', n: sig.tools24h.faults, current: view === 'tools' },
  ]);

  let body: string;
  if (view === 'status') {
    body = `<ul class="svc">${services(env, sig, ce, pe, wd, now, toolRows.length ? `${pct(okCalls, toolRows.length)}% ok over the last ${toolRows.length}${lat ? ` · median ${lat.p50} ms · p95 ${lat.p95} ms` : ''}` : 'No calls yet.')}</ul>`;
  } else {
    body = `<p class="lead">Every MCP tool call Zuma made, newest first. In the last 24 h: ${sig.tools24h.calls} calls, ${sig.tools24h.faults} broke, ${sig.tools24h.errors - sig.tools24h.faults} were refusals Zuma explained to the customer (out of area, not found, between states…).${lat ? ` Over the last ${toolRows.length}: median ${lat.p50} ms, p95 ${lat.p95} ms.` : ''}</p>${
      toolRows.length
        ? table(
            ['When', 'Tool', 'Result', 'Latency', 'Provider path'],
            toolRows.slice(0, 50).map((c) => `<tr><td>${time(c.created_at)}</td><td><code>${h(c.tool)}</code></td><td>${c.ok ? 'ok' : isFault(c.error_code) ? `<b>${h(c.error_code ?? 'error')}</b> <span class="chip chip--bad">broke</span>` : `${h(c.error_code ?? '')} <span class="muted">· refusal</span>`}</td><td class="num">${c.latency_ms} ms</td><td class="muted"><code>${h(c.detail ?? '')}</code></td></tr>`).join(''),
          )
        : blank('No tool calls yet.', ' They appear when Zuma quotes, books or checks a payment.')
    }`;
  }
  return shell({
    env, config, session, url, active: 'system', title: 'System', css: OPS_CSS, signals: sig,
    body: `${pageHead('System', 'Whether each connection is working, checked when this page loaded.', `<span>Checked ${time(now)}</span><a href="${h(url.pathname)}">Check again</a>`)}${tabs}${body}`,
  });
}

type Watchdog = { run: { ran_at: number; ok: number; detail: string | null } | null; ev: { handovers: number; links: number } };

function services(env: Env, s: Signals, ce: { at: number | null; n: number }, pe: { at: number | null }, wd: Watchdog, now: number, tools: string): string {
  const row = (name: string, sub: string, status: string, detail: string, action = '') =>
    `<li><span class="svc__name">${name}<span>${sub}</span></span><span>${status}</span><span class="svc__detail">${detail}</span>${action ? `<span class="actions">${action}</span>` : '<span></span>'}</li>`;
  const chordStatus = s.chord === 'ok' ? chip('ok', 'Working') : s.chord === 'off' ? chip('', 'Off') : s.chord === 'invalid' ? chip('bad', 'Misconfigured') : chip('warn', 'Unreachable');
  const chordDetail = s.chord === 'ok'
    ? `Answered just now. ${s.waiting ?? 0} chat${s.waiting === 1 ? '' : 's'} with a person.`
    : s.chord === 'off' ? 'CHORD_API_KEY is not set. Handover replies and chat notices are off.' : s.chord === 'invalid' ? 'CHORD_API_KEY or CHORD_WORKSPACE_ID is not valid.' : `No answer (${h(s.chordDetail ?? 'timeout')}). Try again in a minute.`;
  const notices = noticeStatus(env);
  const sheetStatus = { off: chip('', 'Off'), invalid: chip('bad', 'Misconfigured'), never: chip('', 'No sync yet'), ok: chip('ok', 'Working'), failed: chip('bad', 'Failed') }[s.sheet.state];
  const sheetDetail = s.sheet.state === 'off'
    ? 'Optional. Not configured (docs/FEATURES.md §12).'
    : s.sheet.state === 'invalid' ? 'GOOGLE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT_JSON is not valid.' : s.sheet.at ? `Last sync ${time(s.sheet.at)}${s.sheet.state === 'failed' ? `: ${h(s.sheet.detail ?? 'failed')}` : '.'}` : 'Nothing has changed since it was set up.';
  const sheetAction = s.sheet.state === 'off' || s.sheet.state === 'invalid'
    ? ''
    : `<a class="btn btn--sm" href="https://docs.google.com/spreadsheets/d/${h(env.GOOGLE_SHEET_ID?.trim() ?? '')}" rel="noopener noreferrer" target="_blank">Open</a><form class="inline" method="post" action="/board/sheet/resync"><button class="btn btn--sm" type="submit">Resync all</button></form>`;
  return [
    row('Chord API', 'handover inbox and replies', chordStatus, chordDetail, s.chord === 'ok' ? '<a class="btn btn--sm" href="/board/handovers">Handovers</a>' : ''),
    row('Chord webhook', 'handover log and acknowledgement', s.webhook ? (ce.at ? chip('ok', 'Receiving') : chip('', 'Nothing yet')) : chip('', 'Off'), s.webhook ? (ce.at ? `Last event ${time(ce.at)} · ${ce.n} stored.` : 'Set up, but no event has arrived yet.') : 'CHORD_WEBHOOK_SECRET is not set.'),
    row('Paystack', 'payment notifications', pe.at ? chip('ok', 'Receiving') : chip('', 'Nothing yet'), pe.at ? `Last notification ${time(pe.at)}. Test keys only.` : 'No notification has arrived yet. Test keys only.', '<a class="btn btn--sm" href="/board/payments/paystack">View</a>'),
    row('Payment notices', '“Payment received” in the chat', notices === 'enabled' ? (s.noticeFailed || s.stuck ? chip('warn', 'Needs a look') : chip('ok', 'On')) : notices === 'invalid_config' ? chip('bad', 'Misconfigured') : chip('', 'Off'), notices === 'enabled' ? `${s.noticeFailed} failed in the last 24 h · ${s.stuck} left with a person.` : notices === 'invalid_config' ? 'CHORD_API_KEY or CHORD_WORKSPACE_ID is not valid.' : 'CHORD_API_KEY is not set; Zuma confirms when the customer writes.', '<a class="btn btn--sm" href="/board/payments/chat">View</a>'),
    row('Google Sheet', 'owner’s read-only copy', sheetStatus, sheetDetail, sheetAction),
    safetyNet(wd, now, s, row),
    row('Agent tools', 'MCP calls from Zuma', s.tools24h.faults ? chip('warn', `${s.tools24h.faults} broke today`) : s.tools24h.calls ? chip('ok', 'Working') : chip('', 'Quiet'), h(tools), '<a class="btn btn--sm" href="/board/system/tools">View</a>'),
  ].join('');
}

/**
 * The every-minute safety net (src/chord/watchdog.ts): hands over chats where a person was promised or
 * asked for but Zuma didn't hand over, and flags links Zuma made up. A heartbeat older than 3 minutes
 * means the scheduled job isn't running (cron missing, or the Worker failing).
 */
function safetyNet(wd: Watchdog, now: number, s: Signals, row: (name: string, sub: string, status: string, detail: string, action?: string) => string): string {
  const late = !wd.run || now - wd.run.ran_at > 3 * 60_000;
  const status = s.chord === 'off' ? chip('', 'Off') : !wd.run ? chip('warn', 'Not run yet') : late ? chip('warn', 'Late') : wd.run.ok ? chip('ok', 'Running') : chip('bad', 'Failing');
  const ev = `${wd.ev.handovers} handover${wd.ev.handovers === 1 ? '' : 's'} and ${wd.ev.links} made-up link${wd.ev.links === 1 ? '' : 's'} caught in the last 24 h.`;
  const detail = s.chord === 'off'
    ? 'Needs CHORD_API_KEY.'
    : !wd.run
      ? 'Checks every minute once deployed with the cron trigger (wrangler.jsonc).'
      : `Last check ${time(wd.run.ran_at)}${wd.run.ok ? '' : `: ${h(wd.run.detail ?? 'failed')}`}. ${ev}`;
  return row('Safety net', 'promised handovers, made-up links', status, detail, '<a class="btn btn--sm" href="/board/handovers">Handovers</a>');
}
