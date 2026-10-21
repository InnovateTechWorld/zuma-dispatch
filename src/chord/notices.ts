import { paymentReceivedMessage } from '../business/messages';
import { pickupWindow } from '../business/profile';
import { eventStmt, getJob } from '../db/repo';
import type { Env } from '../env';
import { fetchJson, type HttpResult } from '../lib/http';
import { log } from '../lib/log';

/**
 * "Payment received" pushed into the customer's chat, without the customer writing first.
 *
 * Chord sends no conversation id with MCP tool calls (FIELD_NOTES #9), so we find the conversation
 * the way a person would: the agent always sends the job id ("ZD-H01G4") when it books, so we look
 * through this workspace's recent conversations for the agent turn that contains it. Then we deliver it
 * (route "auto", the default) as a Chord scheduled MESSAGE: through the WhatsApp / Telegram / Slack
 * connector when the chat is on one of those, so nothing changes hands; on any other channel (e.g. the
 * simulator's external chat) as DIRECT_LINE, which lands in Chord's conversation record (the agent then
 * knows it is paid) but is not shown to the customer there. Route "operator" (opt-in) takes the chat
 * over, posts and hands back: it reaches every channel, but Chord also sends the customer
 * "One moment — connecting you with a teammate." on the take-over (FIELD_NOTES #14).
 *
 * Every step fails safe. If anything is unclear (no match, two different customers mention the id,
 * a human holds the chat, the customer is typing right now, outside WhatsApp's 24-hour window, Chord
 * down, key missing a scope), we send nothing and record why. The customer still gets the
 * confirmation the old way, when they next write and the agent calls verify_payment.
 *
 * Docs: docs/FEATURES.md §5a, FIELD_NOTES #14. Chord API: /v1/threads, /v1/threads/{id}/turns,
 * /v1/scheduled-tasks (scopes thread:read, teammate:update).
 */

export const NOTICE_KIND = 'payment_received';
/** How far back to look for the conversation: the job cannot have been booked in a chat older than this. */
const LOOKBACK_MS = 10 * 60_000;
/** Conversations whose turns we read per notice (newest activity first). Bounds subrequests and time. */
const MAX_THREADS_SCANNED = 8;
/** If the customer wrote this recently and the agent has not answered yet, the agent is about to reply
 *  (and will call verify_payment), so a pushed notice would arrive as a duplicate. */
export const CUSTOMER_ACTIVE_MS = 90_000;
/** WhatsApp only allows business-initiated free text within 24 h of the customer's last message. */
export const SERVICE_WINDOW_MS = 23 * 60 * 60_000;
/** A claim stuck in "pending" this long (Worker evicted mid-send) may be taken again. */
const STALE_PENDING_MS = 5 * 60_000;

export type NoticeRoute = 'auto' | 'operator';
export type NoticeConfig = { base: string; key: string; workspaceId: string; teammateId: string | null; route: NoticeRoute };

/** Marks our own take-overs, so the board does not show them as "handed to a human" (Chord fires
 *  conversation.escalated on every agent→human take-over). Matched by prefix in src/web/pages.ts. */
export const TAKEOVER_REASON = 'zuma-dispatch automated notice: payment received (handed back at once)';
/** Hand-back is retried this many times: a chat left human-held would leave the agent silent. */
const HAND_BACK_TRIES = 3;
export type NoticeStatus = 'enabled' | 'not_configured' | 'invalid_config';

export function noticeConfig(env: Env): NoticeConfig | null {
  const key = env.CHORD_API_KEY?.trim() ?? '';
  const workspaceId = env.CHORD_WORKSPACE_ID?.trim() ?? '';
  if (!key || !/^chord_[A-Za-z0-9_-]{20,}$/.test(key) || !workspaceId) return null;
  const base = (env.CHORD_API_BASE?.trim() || 'https://api.chordhq.xyz').replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(base)) return null;
  return { base, key, workspaceId, teammateId: env.CHORD_TEAMMATE_ID?.trim() || null, route: env.CHORD_NOTICE_ROUTE === 'operator' ? 'operator' : 'auto' };
}

/** A local dev server must not post into real customers' chats (it shares the Chord workspace). */
export function sendsAllowed(env: Env, origin: string): boolean {
  let host = '';
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  return !local || env.CHORD_NOTICES_ALLOW_LOCAL === '1';
}

export function noticeStatus(env: Env): NoticeStatus {
  if (!env.CHORD_API_KEY?.trim()) return 'not_configured';
  return noticeConfig(env) ? 'enabled' : 'invalid_config';
}

// ------------------------------------------------------------------ choosing the conversation (pure)
export interface ThreadRow {
  id: string;
  channel_id?: string;
  channel_participant_id?: string;
  control_state?: string;
  last_turn_at?: number;
  last_turn_direction?: string;
}
export interface Turn { direction?: string; sender?: { kind?: string }; content?: { text?: string } | null; timestamp?: number }

export type Pick =
  | { ok: true; thread: ThreadRow }
  | { ok: false; reason: 'thread_not_found' | 'ambiguous_thread' | 'human_handling' | 'customer_mid_conversation' | 'outside_24h_window'; thread?: ThreadRow };

/** Did the agent itself send this job id in this conversation? (Customer text does not count.) */
export function agentMentioned(turns: Turn[], jobId: string): boolean {
  return firstAgentMention(turns, jobId) !== null;
}

/** When the agent first sent this job id here (ms), or null. Turns without a timestamp count as 0. */
export function firstAgentMention(turns: Turn[], jobId: string): number | null {
  const re = new RegExp(`\\b${jobId}\\b`);
  const times = turns
    .filter((t) => t.direction === 'outbound' && t.sender?.kind === 'agent' && re.test(t.content?.text ?? ''))
    .map((t) => t.timestamp ?? 0);
  return times.length ? Math.min(...times) : null;
}

export interface Match { thread: ThreadRow; firstMentionAt: number }

/**
 * Picks the one conversation to notify.
 * - The person who booked is the one in the conversation where the agent FIRST sent the job id
 *   (the booking message). The notice goes to them, never to someone who only asked about the job later.
 * - If that customer has several conversations mentioning it (same channel identity: on WhatsApp, the
 *   same phone), the most recently active one wins, since that is where they are now.
 * - If two different customers' conversations share the earliest mention, nothing is guessed.
 */
export function pickThread(matches: Match[], now: number): Pick {
  if (matches.length === 0) return { ok: false, reason: 'thread_not_found' };
  const who = (t: ThreadRow) => t.channel_participant_id ?? `?${t.id}`;
  const earliest = Math.min(...matches.map((m) => m.firstMentionAt));
  const bookers = new Set(matches.filter((m) => m.firstMentionAt === earliest).map((m) => who(m.thread)));
  if (bookers.size > 1) return { ok: false, reason: 'ambiguous_thread' };
  const booker = [...bookers][0]!;
  const thread = matches
    .filter((m) => who(m.thread) === booker)
    .map((m) => m.thread)
    .sort((a, b) => (b.last_turn_at ?? 0) - (a.last_turn_at ?? 0))[0]!;
  if (thread.control_state && thread.control_state !== 'agent_active') return { ok: false, reason: 'human_handling', thread };
  const last = thread.last_turn_at ?? 0;
  if (thread.last_turn_direction === 'inbound' && now - last < CUSTOMER_ACTIVE_MS) return { ok: false, reason: 'customer_mid_conversation', thread };
  if (now - last > SERVICE_WINDOW_MS) return { ok: false, reason: 'outside_24h_window', thread };
  return { ok: true, thread };
}

/** Platform for a scheduled MESSAGE: the channel's own connector where Chord has one, else DIRECT_LINE. */
export function platformFor(thread: ThreadRow): string {
  const c = (thread.channel_id ?? '').toLowerCase();
  return c === 'whatsapp' ? 'WHATSAPP' : c === 'telegram' ? 'TELEGRAM' : c === 'slack' ? 'SLACK' : 'DIRECT_LINE';
}

// ------------------------------------------------------------------ Chord API
export function chordError(r: HttpResult<unknown>): string {
  if (r.ok) return '';
  if (r.failure !== 'http') return `chord_${r.failure}`;
  let msg = '';
  try {
    msg = (JSON.parse(r.body ?? '{}') as { error?: { message?: string } }).error?.message ?? '';
  } catch {
    msg = '';
  }
  return `chord_http_${r.status}${msg ? `: ${msg.slice(0, 120)}` : ''}`;
}

export async function chord<T>(cfg: NoticeConfig, path: string, timeoutMs: number, body?: unknown): Promise<HttpResult<T>> {
  // POSTs here always carry a JSON body (Chord's transition endpoints accept {} as "no options").
  return fetchJson<T>(`${cfg.base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${cfg.key}` },
    body,
    timeoutMs,
  });
}

async function findThread(cfg: NoticeConfig, jobId: string, since: number, now: number, timeoutMs: number): Promise<Pick | { ok: false; reason: string; thread?: ThreadRow }> {
  // Workspace-wide on purpose: the job-id match below is what selects the conversation, and filtering
  // by teammate would silently find nothing if Chord's agent id format differs from the dashboard id.
  const q = new URLSearchParams({ workspace_id: cfg.workspaceId, from: String(since), limit: '20' });
  const list = await chord<{ threads?: ThreadRow[] }>(cfg, `/v1/threads?${q}`, timeoutMs);
  if (!list.ok) return { ok: false, reason: chordError(list) };
  const threads = (list.data.threads ?? []).filter((t) => /^[0-9a-f]{24}$/.test(t.id)).slice(0, MAX_THREADS_SCANNED);
  const matches: Match[] = [];
  // Sequential on purpose: usually the first (newest) conversation is the one, and it keeps us far
  // below Chord's rate limit and the Worker's subrequest budget.
  for (const t of threads) {
    const turns = await chord<{ turns?: Turn[] }>(cfg, `/v1/threads/${t.id}/turns?limit=50`, timeoutMs);
    if (!turns.ok) return { ok: false, reason: chordError(turns) };
    const first = firstAgentMention(turns.data.turns ?? [], jobId);
    if (first !== null) matches.push({ thread: t, firstMentionAt: first });
  }
  return pickThread(matches, now);
}

// ------------------------------------------------------------------ delivery
export type NoticeResult = { state: 'queued' | 'sent' | 'skipped' | 'failed' | 'not_sent'; reason?: string; thread_id?: string; task_id?: string };

interface OperatorTurn { id?: string; delivery_status?: string; delivery_error?: string | null }

/**
 * Operator route: take over → post → hand back. The message goes down the conversation's own channel
 * (WhatsApp, Telegram, the simulator's external chat) and Chord reports delivery in the response.
 * - Take-over refused with 409 (a person grabbed the chat a moment ago): skipped, nothing posted.
 * - Hand-back is attempted whatever happened to the message, and retried; if it still fails the
 *   result says so loudly, because the agent stays silent in that chat until someone hands it back.
 */
async function sendAsOperator(cfg: NoticeConfig, thread: ThreadRow, body: string, timeoutMs: number): Promise<NoticeResult> {
  const base = { thread_id: thread.id };
  const take = await chord<ThreadRow>(cfg, `/v1/threads/${thread.id}/take-over`, timeoutMs, { reason: TAKEOVER_REASON });
  if (!take.ok) {
    return take.failure === 'http' && take.status === 409 ? { ...base, state: 'skipped', reason: 'human_handling' } : { ...base, state: 'failed', reason: `take_over: ${chordError(take)}` };
  }
  let result: NoticeResult;
  const msg = await chord<OperatorTurn>(cfg, `/v1/threads/${thread.id}/messages`, timeoutMs, { text: body });
  if (!msg.ok) result = { ...base, state: 'failed', reason: `message: ${chordError(msg)}` };
  else if (msg.data.delivery_status === 'failed') result = { ...base, state: 'failed', reason: `undelivered: ${(msg.data.delivery_error ?? 'channel refused').slice(0, 120)}`, task_id: msg.data.id };
  else result = { ...base, state: 'sent', task_id: msg.data.id ?? '' };

  let handedBack = false;
  for (let i = 0; i < HAND_BACK_TRIES && !handedBack; i++) {
    const back = await chord<ThreadRow>(cfg, `/v1/threads/${thread.id}/hand-back`, timeoutMs, { reason: TAKEOVER_REASON });
    // 409 means it is no longer human-held (someone handed it back already): fine.
    handedBack = back.ok || (back.failure === 'http' && back.status === 409);
  }
  if (!handedBack) {
    log('error', 'chat_notice_hand_back_failed', { thread_id: thread.id });
    return { ...result, state: result.state === 'sent' ? 'sent' : 'failed', reason: 'hand_back_failed' };
  }
  return result;
}

/** Default route: a scheduled MESSAGE, no control change, delivered by Chord's queue in about 30 s. */
async function sendScheduled(cfg: NoticeConfig, thread: ThreadRow, body: string, now: number, timeoutMs: number): Promise<NoticeResult> {
  const platform = platformFor(thread);
  const task = await chord<{ id?: string }>(cfg, '/v1/scheduled-tasks', timeoutMs, {
    task_type: 'MESSAGE',
    scheduled_at: new Date(now + 5_000).toISOString(), // must be in the future
    workspace_id: cfg.workspaceId,
    ...(cfg.teammateId ? { teammate_id: cfg.teammateId } : {}),
    max_retries: 2,
    payload: { platform, conversation_id: thread.id, body },
  });
  if (!task.ok) return { state: 'failed', reason: chordError(task), thread_id: thread.id };
  // DIRECT_LINE into a chat that lives on another surface (e.g. external_chat) is recorded in Chord's
  // conversation but not shown to the customer there: say so instead of claiming it was delivered.
  const recordOnly = platform === 'DIRECT_LINE' && (thread.channel_id ?? 'direct_line') !== 'direct_line';
  return { state: 'queued', thread_id: thread.id, task_id: task.data.id ?? '', ...(recordOnly ? { reason: 'record_only' } : {}) };
}

// ------------------------------------------------------------------ the notice

/**
 * Takes the one-per-job claim. Automatic triggers only claim a fresh row (or a stale "pending" one);
 * a dispatcher's "Send again" may also retry a failed or skipped notice, never a queued one.
 */
async function claim(db: D1Database, jobId: string, now: number, manual: boolean): Promise<boolean> {
  const retryable = manual ? "state IN ('failed', 'skipped') OR " : ''; // never 'queued' / 'sent'
  const row = await db
    .prepare(
      `INSERT INTO chat_notices (job_id, kind, state, created_at, updated_at) VALUES (?1, ?2, 'pending', ?3, ?3)
       ON CONFLICT (job_id, kind) DO UPDATE SET state = 'pending', reason = NULL, attempts = attempts + 1, updated_at = ?3
         WHERE ${retryable}(state = 'pending' AND updated_at < ?4)
       RETURNING attempts`,
    )
    .bind(jobId, NOTICE_KIND, now, now - STALE_PENDING_MS)
    .first<{ attempts: number }>();
  return Boolean(row);
}

async function finish(db: D1Database, jobId: string, r: NoticeResult, now: number): Promise<void> {
  await db.batch([
    db
      .prepare('UPDATE chat_notices SET state = ?, reason = ?, thread_id = ?, task_id = ?, updated_at = ? WHERE job_id = ? AND kind = ?')
      .bind(r.state, r.reason ?? null, r.thread_id ?? null, r.task_id ?? null, now, jobId, NOTICE_KIND),
    eventStmt(db, {
      jobId,
      type: r.state === 'queued' || r.state === 'sent' ? 'customer_notified' : 'customer_notice_not_sent',
      actor: 'system',
      detail: r.state === 'queued' || r.state === 'sent' ? { thread_id: r.thread_id, id: r.task_id, ...(r.reason ? { warning: r.reason } : {}) } : { reason: r.reason },
      at: now,
    }),
  ]);
}

/**
 * Sends "payment received" into the customer's conversation, at most once per job. Never throws:
 * it runs in the background after Paystack's webhook has already been answered.
 */
export async function notifyPaymentReceived(env: Env, jobId: string, opts: { manual?: boolean; now?: number; origin?: string } = {}): Promise<NoticeResult> {
  const cfg = noticeConfig(env);
  if (!cfg) return { state: 'not_sent', reason: 'not_configured' };
  if (opts.origin && !sendsAllowed(env, opts.origin)) return { state: 'not_sent', reason: 'local_server' };
  const now = opts.now ?? Date.now();
  const timeoutMs = Math.min(Number(env.PROVIDER_TIMEOUT_MS) || 4000, 6000);
  try {
    const job = await getJob(env.DB, jobId);
    if (!job || !['paid', 'dispatched', 'delivered'].includes(job.status)) return { state: 'not_sent', reason: 'job_not_paid' };
    if (!(await claim(env.DB, jobId, now, opts.manual === true))) return { state: 'not_sent', reason: 'already_handled' };

    let result: NoticeResult;
    const pick = await findThread(cfg, jobId, job.created_at - LOOKBACK_MS, now, timeoutMs);
    if (!pick.ok) {
      result = { state: pick.reason.startsWith('chord_') ? 'failed' : 'skipped', reason: pick.reason, thread_id: pick.thread?.id };
    } else {
      const body = paymentReceivedMessage(job, now);
      result = cfg.route === 'operator' ? await sendAsOperator(cfg, pick.thread, body, timeoutMs) : await sendScheduled(cfg, pick.thread, body, now, timeoutMs);
    }
    await finish(env.DB, jobId, result, Date.now());
    log(result.state === 'failed' ? 'warn' : 'info', 'chat_notice', { job_id: jobId, state: result.state, reason: result.reason ?? null, thread_id: result.thread_id ?? null });
    return result;
  } catch (e) {
    const reason = `error: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`;
    log('error', 'chat_notice_error', { job_id: jobId, message: reason });
    await finish(env.DB, jobId, { state: 'failed', reason }, Date.now()).catch(() => undefined);
    return { state: 'failed', reason };
  }
}

/**
 * The agent is confirming the payment in its own reply (verify_payment). Returns whether the customer
 * already saw our automatic notice on a channel that shows it; if not, the notice is claimed as
 * "agent_confirmed" so it is not pushed a few seconds later as a duplicate. A notice that is already
 * pending (being sent right now) is left alone.
 */
export async function noteAgentConfirmed(db: D1Database, jobId: string, now: number): Promise<'customer_already_told' | 'agent_tells'> {
  try {
    const row = await db.prepare('SELECT state, reason FROM chat_notices WHERE job_id = ? AND kind = ?').bind(jobId, NOTICE_KIND).first<{ state: string; reason: string | null }>();
    if (row && (row.state === 'sent' || row.state === 'queued') && row.reason !== 'record_only') return 'customer_already_told';
    if (!row) {
      await db
        .prepare(`INSERT INTO chat_notices (job_id, kind, state, reason, created_at, updated_at) VALUES (?1, ?2, 'skipped', 'agent_confirmed', ?3, ?3) ON CONFLICT (job_id, kind) DO NOTHING`)
        .bind(jobId, NOTICE_KIND, now)
        .run();
    }
  } catch (e) {
    log('warn', 'note_agent_confirmed_failed', { job_id: jobId, message: String(e) });
  }
  return 'agent_tells';
}

/** Fire-and-forget hook used after a payment is confirmed outside the conversation. No-op when off. */
export function queueChatNotice(env: Env, waitUntil: (p: Promise<unknown>) => void, jobId: string, origin: string): void {
  if (noticeStatus(env) !== 'enabled' || !sendsAllowed(env, origin)) return;
  waitUntil(notifyPaymentReceived(env, jobId, { origin }));
}

// ------------------------------------------------------------------ handover acknowledgement
/** What the customer reads when the agent hands them to a person (Chord's own notice may not reach them). */
export function handoverMessage(now: number): string {
  const open = pickupWindow(now).now; // dispatchers work rider hours: 7am–8pm, Monday to Saturday
  return open
    ? "You're now connected to the Zuma Dispatch support team. A team member has your booking details and will reply here shortly."
    : "You're now connected to the Zuma Dispatch support team. We're closed right now; a team member has your booking details and will reply here from 7am (Monday to Saturday).";
}

/**
 * After Chord's conversation.escalated webhook (the agent handed over), post the message above into the
 * chat. The thread is human-held at that point, so an operator message needs no take-over and Chord sends
 * it down the chat's own channel. Returns what happened, for chord_events.ack. Never throws.
 */
export async function acknowledgeHandover(env: Env, threadId: string, origin: string, now = Date.now()): Promise<string> {
  const cfg = noticeConfig(env);
  if (!cfg) return 'skipped: CHORD_API_KEY not set';
  if (!sendsAllowed(env, origin)) return 'skipped: local server';
  if (!/^[0-9a-f]{24}$/.test(threadId)) return 'skipped: no thread id';
  try {
    const r = await chord<{ delivery_status?: string; delivery_error?: string | null }>(cfg, `/v1/threads/${threadId}/messages`, 6000, { text: handoverMessage(now) });
    if (!r.ok) return r.failure === 'http' && r.status === 409 ? 'skipped: no longer human-held' : `failed: ${chordError(r)}`;
    return r.data.delivery_status === 'failed' ? `failed: undelivered ${(r.data.delivery_error ?? '').slice(0, 80)}` : 'sent';
  } catch (e) {
    return `failed: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`;
  }
}
