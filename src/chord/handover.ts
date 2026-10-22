import type { Env } from '../env';
import { pickupWindow } from '../business/profile';
import { log } from '../lib/log';
import { chord, chordError, firstAgentMention, noticeConfig, sendsAllowed, type NoticeConfig, type ThreadRow, type Turn } from './notices';

/**
 * Our own handover (the `hand_to_team` tool), instead of Chord's built-in one.
 *
 * Why: Chord's built-in handover ends the AI's turn, so Zuma never writes anything itself. The customer
 * gets only Chord's system line ("One moment — connecting you with a teammate.") and our operator
 * acknowledgement. On WhatsApp that is fine, but the TSG simulator shows neither (it shows only customer
 * and AI turns), so a tester saw no reply at all (6 of 6 handovers checked, FIELD_NOTES_FULL #22).
 *
 * How: the tool finds the conversation, answers at once with the line Zuma should send, and in the
 * background waits until that reply has been posted, then takes the chat over through the operator API.
 * Chord's own "connecting you" line follows. The webhook sees initiator `human_operator` and our reason,
 * so the board lists it as a handover by Zuma and no second acknowledgement is sent.
 */
export const HANDOVER_REASON_PREFIX = 'Zuma handover: ';
const RECENT_MS = 3 * 60_000;
const POLL_MS = 2_000;
const MAX_WAIT_MS = 20_000;

export interface ListedThread extends ThreadRow { last_turn_preview?: string }

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Chord passes tools no conversation id, so the conversation is the one whose customer just wrote this
 * message: still with the AI, last turn inbound, within the last 3 minutes, preview matching the text.
 * Exactly one match, or none (two customers typing the same words at once are not guessed between).
 */
export function matchThread(threads: ListedThread[], customerMessage: string, now: number): { ok: true; thread: ListedThread } | { ok: false; reason: 'thread_not_found' | 'ambiguous_thread' } {
  const want = norm(customerMessage).slice(0, 40);
  if (!want) return { ok: false, reason: 'thread_not_found' };
  const hits = threads.filter((t) => {
    if (t.control_state && t.control_state !== 'agent_active') return false;
    if (t.last_turn_direction !== 'inbound' || !t.last_turn_at || now - t.last_turn_at > RECENT_MS) return false;
    const have = norm(t.last_turn_preview ?? '');
    return Boolean(have) && (have.startsWith(want) || want.startsWith(have.slice(0, 40)));
  });
  if (hits.length === 1) return { ok: true, thread: hits[0]! };
  return { ok: false, reason: hits.length ? 'ambiguous_thread' : 'thread_not_found' };
}

/** The line Zuma sends: who will answer, and when (dispatchers keep rider hours). */
export function handToTeamMessage(now: number): string {
  return pickupWindow(now).now
    ? "I've passed this to our support team. Someone from the team will reply here shortly, and they'll have your booking details."
    : "I've passed this to our support team. We're closed right now, so someone from the team will reply here from 7am (Monday to Saturday). They'll have your booking details.";
}

export type FindResult = { ok: true; threadId: string } | { ok: false; reason: string };

export async function findHandoverThread(cfg: NoticeConfig, args: { customer_message: string; job_id?: string | null }, now: number, timeoutMs: number): Promise<FindResult> {
  const q = new URLSearchParams({ workspace_id: cfg.workspaceId, control_state: 'agent_active', limit: '30' });
  const list = await chord<{ threads?: ListedThread[] }>(cfg, `/v1/threads?${q}`, timeoutMs);
  if (!list.ok) return { ok: false, reason: chordError(list) };
  const byText = matchThread((list.data.threads ?? []).filter((t) => /^[0-9a-f]{24}$/.test(t.id)), args.customer_message, now);
  if (byText.ok) return { ok: true, threadId: byText.thread.id };
  // Fall back to the recent conversation (still with the AI) where Zuma itself sent this job id.
  const jobId = args.job_id ? /^ZD-?([0-9A-Z]{5})$/i.exec(args.job_id.trim()) : null;
  if (jobId) {
    const id = `ZD-${jobId[1]!.toUpperCase()}`;
    const recent = (list.data.threads ?? []).filter((t) => /^[0-9a-f]{24}$/.test(t.id) && t.last_turn_at && now - t.last_turn_at < RECENT_MS).slice(0, 5);
    const found: string[] = [];
    for (const t of recent) {
      const turns = await chord<{ turns?: Turn[] }>(cfg, `/v1/threads/${t.id}/turns?limit=50`, timeoutMs);
      if (turns.ok && firstAgentMention(turns.data.turns ?? [], id) !== null) found.push(t.id);
    }
    if (found.length === 1) return { ok: true, threadId: found[0]! };
  }
  return { ok: false, reason: byText.reason };
}

/**
 * Waits until Zuma's reply is in the conversation (last turn outbound, after the tool call), then takes
 * the chat over. Taking over earlier could cut the reply off. Gives up waiting after 20 s and takes
 * over anyway, so the customer is never left with the AI after asking for a person.
 */
export async function takeOverAfterReply(cfg: NoticeConfig, threadId: string, reason: string, calledAt: number, timeoutMs: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<string> {
  const deadline = calledAt + MAX_WAIT_MS;
  let replied = false;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const t = await chord<ThreadRow>(cfg, `/v1/threads/${threadId}`, timeoutMs);
    if (t.ok && t.data.control_state && t.data.control_state !== 'agent_active') return 'already_with_a_person';
    if (t.ok && t.data.last_turn_direction === 'outbound' && (t.data.last_turn_at ?? 0) > calledAt) {
      replied = true;
      break;
    }
  }
  const body = { reason: `${HANDOVER_REASON_PREFIX}${reason}`.slice(0, 300) };
  let take = await chord<ThreadRow>(cfg, `/v1/threads/${threadId}/take-over`, timeoutMs, body);
  if (!take.ok && take.failure === 'http' && take.status === 409) {
    await sleep(3_000);
    take = await chord<ThreadRow>(cfg, `/v1/threads/${threadId}/take-over`, timeoutMs, body);
  }
  const outcome = take.ok ? (replied ? 'taken_over' : 'taken_over_without_seeing_reply') : `take_over_failed: ${chordError(take)}`;
  log(take.ok ? 'info' : 'warn', 'hand_to_team', { thread_id: threadId, outcome });
  return outcome;
}

export function handoverConfig(env: Env, origin: string): { cfg: NoticeConfig } | { error: 'not_configured' | 'local_server' } {
  const cfg = noticeConfig(env);
  if (!cfg) return { error: 'not_configured' };
  if (!sendsAllowed(env, origin)) return { error: 'local_server' };
  return { cfg };
}
