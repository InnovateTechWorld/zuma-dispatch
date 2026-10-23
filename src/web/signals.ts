import type { Env } from '../env';
import { chord, chordProblem, noticeConfig, noticeStatus } from '../chord/notices';
import { mirrorStatus } from '../sheets/mirror';

/**
 * What needs a person, computed once per board page: the tab badges and Home's alert list both read it.
 * One D1 batch, plus one live Chord call for chats waiting on a person (2 s budget; Chord API reads
 * cost no AI credits). Nothing here is cached, so a badge is never older than the page.
 */
export interface Signals {
  /** Chats held by a person or paused, live from Chord. null when Chord is off or did not answer. */
  waiting: number | null;
  chord: 'ok' | 'off' | 'invalid' | 'unreachable';
  chordDetail: string | null;
  review: number;
  ready: number;
  out: number;
  awaiting: number;
  /** Chats left with a person after a payment notice could not hand back. */
  stuck: number;
  /** Payment notices that failed in the last 24 h. */
  noticeFailed: number;
  sheet: { state: 'off' | 'invalid' | 'never' | 'ok' | 'failed'; detail: string | null; at: number | null };
  /** Agent tool calls in the last 24 h. Faults are our failures; refusals are expected answers (out of area, not found…). */
  tools24h: { calls: number; errors: number; faults: number };
  webhook: boolean;
  /** Links in Zuma's replies that we did not issue, last 24 h (src/chord/watchdog.ts), and the latest chat. */
  foreignLinks: { n: number; thread: string | null };
}

export const DAY_MS = 86_400_000;

/**
 * Tool errors that mean something on our side broke. Every other error code is a business answer the
 * agent explains to the customer (OUT_OF_SERVICE_AREA, JOB_NOT_FOUND, INTERSTATE_NOT_SUPPORTED…).
 */
export const FAULT_CODES = ['INTERNAL_ERROR', 'UNKNOWN_TOOL', 'PAYMENT_PROVIDER_BUSY'];
export const isFault = (code: string | null) => !code || FAULT_CODES.includes(code) || code.endsWith('_UNAVAILABLE');
export const FAULT_SQL = `(error_code IS NULL OR error_code IN (${FAULT_CODES.map((c) => `'${c}'`).join(', ')}) OR error_code LIKE '%\\_UNAVAILABLE' ESCAPE '\\')`;

/** Waits at most `ms` for a promise, resolving to `fallback` after that (never rejects). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

/** The waiting-chat count on every tab is read from Chord at most this often per Worker instance. */
export const WAITING_CACHE_MS = 10_000;

export async function readSignals(env: Env, now: number): Promise<Signals> {
  const cfg = noticeConfig(env);
  const live = cfg
    ? within(
        chord<{ threads?: { id: string }[] }>(cfg, `/v1/threads?${new URLSearchParams({ workspace_id: cfg.workspaceId, control_state: 'human_active,paused', limit: '50' })}`, 2000, undefined, { cacheMs: WAITING_CACHE_MS }),
        2500,
        null,
      )
    : Promise.resolve(null);
  const db = env.DB;
  const [batch, liveRes] = await Promise.all([
    db.batch([
      db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status'),
      db.prepare("SELECT COUNT(*) AS n FROM chat_notices WHERE reason = 'hand_back_failed'"),
      db.prepare("SELECT COUNT(*) AS n FROM chat_notices WHERE state = 'failed' AND COALESCE(reason, '') != 'hand_back_failed' AND updated_at >= ?").bind(now - DAY_MS),
      db.prepare("SELECT ok, detail, updated_at FROM sheet_state WHERE key = 'last'"),
      db.prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
                COALESCE(SUM(CASE WHEN ok = 0 AND ${FAULT_SQL} THEN 1 ELSE 0 END), 0) AS faults
           FROM tool_calls WHERE created_at >= ?`,
      ).bind(now - DAY_MS),
      db.prepare("SELECT COUNT(*) AS n, (SELECT thread_id FROM watchdog_events WHERE kind = 'foreign_link' AND created_at >= ?1 ORDER BY created_at DESC LIMIT 1) AS thread FROM watchdog_events WHERE kind = 'foreign_link' AND created_at >= ?1").bind(now - DAY_MS),
    ]),
    live,
  ]);
  const [counts, stuck, failed, sheetRow, tools, links] = batch;
  const linkRow = (links?.results[0] as { n: number; thread: string | null } | undefined) ?? { n: 0, thread: null };
  const by: Record<string, number> = Object.fromEntries((counts!.results as { status: string; n: number }[]).map((c) => [c.status, c.n]));
  const n = (r: D1Result | undefined) => Number((r?.results[0] as { n?: number } | undefined)?.n ?? 0);
  const mirror = mirrorStatus(env);
  const last = sheetRow?.results[0] as { ok: number; detail: string; updated_at: number } | undefined;
  const t = (tools?.results[0] as { calls: number; errors: number; faults: number } | undefined) ?? { calls: 0, errors: 0, faults: 0 };
  const nstate = noticeStatus(env);
  return {
    waiting: liveRes?.ok ? (liveRes.data.threads ?? []).length : null,
    chord: nstate === 'not_configured' ? 'off' : nstate === 'invalid_config' ? 'invalid' : liveRes?.ok ? 'ok' : 'unreachable',
    chordDetail: liveRes && !liveRes.ok ? chordProblem(liveRes) : cfg && !liveRes ? 'no answer within 2.5 s' : null,
    review: by.amount_mismatch ?? 0,
    ready: by.paid ?? 0,
    out: by.dispatched ?? 0,
    awaiting: (by.awaiting_payment ?? 0) + (by.payment_failed ?? 0),
    stuck: n(stuck),
    noticeFailed: n(failed),
    sheet: mirror === 'not_configured'
      ? { state: 'off', detail: null, at: null }
      : mirror === 'invalid_config'
        ? { state: 'invalid', detail: null, at: null }
        : last
          ? { state: last.ok ? 'ok' : 'failed', detail: last.detail, at: last.updated_at }
          : { state: 'never', detail: null, at: null },
    tools24h: { calls: Number(t.calls), errors: Number(t.errors), faults: Number(t.faults) },
    webhook: Boolean(env.CHORD_WEBHOOK_SECRET?.trim()),
    foreignLinks: { n: Number(linkRow.n), thread: linkRow.thread },
  };
}

export type Tone = 'urgent' | 'warn' | 'action' | 'info';
export interface Alert { key: string; tone: Tone; title: string; detail: string; href: string; cta: string }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Home's "Needs you" list, most urgent first. Pure: built only from the signals. */
export function alertsFrom(s: Signals): Alert[] {
  const a: Alert[] = [];
  if (s.waiting) {
    a.push({ key: 'waiting', tone: 'urgent', title: `${plural(s.waiting, 'chat is', 'chats are')} waiting for a person`, detail: 'Zuma handed these customers to the team. Zuma stays silent there until someone replies and hands back.', href: '/board/handovers', cta: 'Open handovers' });
  }
  if (s.foreignLinks.n > 0) {
    a.push({ key: 'links', tone: 'urgent', title: `Zuma sent ${plural(s.foreignLinks.n, 'link', 'links')} we didn't issue`, detail: 'A made-up link reached a customer in the last 24 h. Open the chat, take it over and send the right details.', href: s.foreignLinks.thread ? `/board/handovers/${s.foreignLinks.thread}` : '/board/handovers', cta: 'Open the chat' });
  }
  if (s.review) {
    a.push({ key: 'review', tone: 'urgent', title: `${plural(s.review, 'payment needs', 'payments need')} review`, detail: 'Paystack said success, but the amount, currency or reference did not match. Approve or cancel.', href: '/board/payments', cta: 'Review payments' });
  }
  if (s.stuck) {
    a.push({ key: 'stuck', tone: 'urgent', title: `${plural(s.stuck, 'chat was', 'chats were')} left with a person after a payment notice`, detail: 'Zuma could not hand the chat back, so the AI stays silent there. Hand it back from Handovers.', href: '/board/payments/chat', cta: 'See which' });
  }
  if (s.sheet.state === 'failed') {
    a.push({ key: 'sheet', tone: 'warn', title: 'Google Sheet sync failed', detail: s.sheet.detail ? `Last attempt: ${s.sheet.detail}` : 'The owner’s copy may be out of date.', href: '/board/system', cta: 'Check and resync' });
  }
  if (s.chord === 'unreachable') {
    a.push({ key: 'chord', tone: 'warn', title: 'Could not reach Chord', detail: `Waiting chats could not be counted (${s.chordDetail ?? 'no answer'}). Handovers may still be waiting.`, href: '/board/system', cta: 'See status' });
  }
  if (s.chord === 'invalid' || s.sheet.state === 'invalid') {
    a.push({ key: 'config', tone: 'warn', title: 'A setting is misconfigured', detail: [s.chord === 'invalid' ? 'CHORD_API_KEY or CHORD_WORKSPACE_ID' : '', s.sheet.state === 'invalid' ? 'GOOGLE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT_JSON' : ''].filter(Boolean).join(' and ') + ' is not valid.', href: '/board/system', cta: 'See status' });
  }
  if (s.noticeFailed) {
    a.push({ key: 'notices', tone: 'warn', title: `${plural(s.noticeFailed, '“Payment received” notice', '“Payment received” notices')} failed today`, detail: 'The customer was not told in the chat. Zuma still confirms when they next write; you can send it again.', href: '/board/payments/chat', cta: 'See notices' });
  }
  if (s.tools24h.faults) {
    a.push({ key: 'tools', tone: 'warn', title: `${plural(s.tools24h.faults, 'agent tool call', 'agent tool calls')} broke in the last 24 h`, detail: `Out of ${s.tools24h.calls}: an internal error or a provider (maps, routing, Paystack) did not answer. Zuma apologised to the customer.`, href: '/board/system/tools', cta: 'See tool calls' });
  }
  if (s.ready) {
    a.push({ key: 'ready', tone: 'action', title: `${plural(s.ready, 'paid job is', 'paid jobs are')} ready to dispatch`, detail: 'A rider is assigned. Mark each one dispatched when the rider picks it up.', href: '/board/deliveries?status=paid', cta: 'Dispatch' });
  }
  if (s.out) {
    a.push({ key: 'out', tone: 'info', title: `${plural(s.out, 'delivery is', 'deliveries are')} out with a rider`, detail: 'Mark each one delivered when the recipient gives the handover code.', href: '/board/deliveries?status=dispatched', cta: 'View' });
  }
  return a;
}

/** Badge counts per tab: urgent ones are red. */
export function tabBadges(s: Signals): Record<string, { n: number; urgent: boolean }> {
  const system = (s.foreignLinks.n > 0 ? 1 : 0) + (s.sheet.state === 'failed' ? 1 : 0) + (s.chord === 'unreachable' || s.chord === 'invalid' ? 1 : 0) + (s.sheet.state === 'invalid' ? 1 : 0) + (s.tools24h.faults ? 1 : 0);
  return {
    deliveries: { n: s.ready, urgent: false },
    handovers: { n: s.waiting ?? 0, urgent: true },
    payments: { n: s.review + s.stuck + s.noticeFailed, urgent: s.review + s.stuck > 0 },
    system: { n: system, urgent: false },
  };
}
