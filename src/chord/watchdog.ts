import type { Env } from '../env';
import { log } from '../lib/log';
import { HANDOVER_REASON_PREFIX } from './handover';
import { acknowledgeHandover, chord, chordError, noticeConfig, sendsAllowed, type ThreadRow } from './notices';

/**
 * A safety net for two things the model did in a live run (23 Oct 2026) that no instruction can fully
 * rule out on a model we don't choose:
 *
 * 1. **A promised person who never came.** The customer said "i want a refund"; Zuma replied "A person
 *    from our team will take over" without calling hand_to_team, so the chat never reached the board.
 *    Here, a chat still with Zuma where the customer asked for a refund or a person, or where Zuma
 *    promised one, is handed to the team by the server. If Zuma didn't tell the customer, we do.
 * 2. **A made-up link.** Zuma answered "where is the rider?" without calling get_job_status and sent
 *    "Track live: https://zuma.dispatch/track/ZD-F74B2". A sent message can't be taken back, so any link
 *    in Zuma's replies that we didn't issue is flagged on the board for a person to correct.
 *
 * Runs every minute (cron). Reads only chats whose last message is Zuma's, from the last 15 minutes, and
 * leaves 25 s for hand_to_team's own take-over (it waits up to 20 s for the reply to post). Every action
 * is recorded once per Zuma reply (watchdog_events), so nothing is done twice.
 */
const THREAD_RE = /^[0-9a-f]{24}$/;
const WINDOW_MS = 15 * 60_000;
const GRACE_MS = 25_000;
const MAX_THREADS = 6;

export interface WatchTurn {
  id?: string;
  direction?: string;
  sender?: { kind?: string; operator_user_id?: string };
  content?: { text?: string } | null;
  timestamp?: number;
}

/** The customer asks for money back or for a person (refunds always go to the team). */
export function wantsPerson(text: string): boolean {
  const t = text.toLowerCase().replace(/[’]/g, "'");
  if (/\b(no|don'?t|do not|dont|never)\s+(need|want)\s+(a\s+|my\s+)?(refund|person|human|money back)/.test(t)) return false;
  return (
    // A request, not a question about policy ("how do refunds work?" is answered from the FAQ).
    /\b(want|need|would like|i'?d like|get|give me|request|asking for|demand)\b[^.?!]{0,25}\b(refund|money back)\b/.test(t) ||
    /\brefund (me|my)\b/.test(t) ||
    /\b(speak|talk|chat) (to|with) (a |an |the |your )?(person|human|agent|someone|somebody|manager|team|support|staff)\b/.test(t) ||
    /\b(i want|i need|get me|connect me (to|with)) (a |an |to a |to an )?(person|human|agent|manager|real person)\b/.test(t) ||
    /\bcustomer (care|service)\b/.test(t) ||
    /\bi (want to|wanna|would like to) (make a )?complain/.test(t)
  );
}

/** Zuma's reply says a person or the team will help (so the customer is waiting for one). */
export function promisedPerson(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /passed (this|it|your [a-z]+) (on )?to (our|the) (support )?team/.test(t) ||
    /\b(person|someone|somebody|teammate|team member|human|agent|dispatcher|support team|our team)\b[^.]{0,60}\b(will|is going to|'ll|shall)\b[^.]{0,30}\b(take over|reply|respond|help|contact|reach out|get back|be with you|join)/.test(t) ||
    /\b(connecting|transferring|handing) you (to|over to)\b/.test(t)
  );
}

/** Links we issue: Paystack checkout, Google Maps pins, and this server. Anything else was made up. */
export function foreignLinks(text: string, ownHosts: string[]): string[] {
  const urls = text.match(/https?:\/\/[^\s)<>"']+/gi) ?? [];
  return urls.filter((u) => {
    let host = '';
    let path = '';
    try {
      const p = new URL(u.replace(/[.,;:!?]+$/, ''));
      host = p.hostname.toLowerCase();
      path = p.pathname;
    } catch {
      return true; // not even a valid URL
    }
    if (host === 'checkout.paystack.com' || host === 'paystack.com' || host === 'paystack.shop') return false;
    if ((host === 'www.google.com' || host === 'google.com') && path.startsWith('/maps')) return false;
    if (host === 'maps.google.com' || host === 'maps.app.goo.gl') return false;
    return !ownHosts.includes(host);
  });
}

const isCustomer = (t: WatchTurn) => t.direction === 'inbound' || t.sender?.kind === 'remote';
const isAgent = (t: WatchTurn) => !isCustomer(t) && t.sender?.kind !== 'system' && t.sender?.kind !== 'human_operator';

/**
 * The latest exchange: the customer's last message, Zuma's replies after it, and whether a person or
 * Chord's system already stepped in after it (a take-over line, a team reply or a hand-back), in which
 * case the handover has happened.
 */
export function lastExchange(turns: WatchTurn[]): { customer: WatchTurn | null; replies: WatchTurn[]; handled: boolean } {
  const sorted = [...turns].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  let i = sorted.length - 1;
  while (i >= 0 && !isCustomer(sorted[i]!)) i--;
  if (i < 0) return { customer: null, replies: [], handled: false };
  const after = sorted.slice(i + 1);
  return { customer: sorted[i]!, replies: after.filter(isAgent), handled: after.some((t) => !isAgent(t)) };
}

export type WatchAction =
  | { kind: 'handover'; told: boolean; why: string; customerText: string; replyTs: number }
  | { kind: 'foreign_link'; urls: string[]; replyTs: number };

/** What to do about one chat's latest exchange. Pure. */
export function decide(turns: WatchTurn[], ownHosts: string[]): WatchAction[] {
  const { customer, replies, handled } = lastExchange(turns);
  if (!customer || replies.length === 0) return [];
  const reply = replies.map((r) => r.content?.text ?? '').join('\n');
  const replyTs = replies[replies.length - 1]!.timestamp ?? 0;
  const out: WatchAction[] = [];
  const asked = wantsPerson(customer.content?.text ?? '');
  const told = promisedPerson(reply);
  if ((asked || told) && !handled) {
    out.push({
      kind: 'handover',
      told,
      why: told ? 'Zuma told the customer a person would help but did not hand over' : 'the customer asked for a refund or a person and Zuma did not hand over',
      customerText: (customer.content?.text ?? '').slice(0, 160),
      replyTs,
    });
  }
  const links = foreignLinks(reply, ownHosts);
  if (links.length) out.push({ kind: 'foreign_link', urls: links.slice(0, 3), replyTs });
  return out;
}

async function once(db: D1Database, threadId: string, replyTs: number, kind: string, detail: string, now: number): Promise<boolean> {
  const r = await db
    .prepare('INSERT INTO watchdog_events (thread_id, reply_ts, kind, detail, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
    .bind(threadId, replyTs, kind, detail.slice(0, 500), now)
    .run();
  return r.meta.changes === 1;
}

export async function runWatchdog(env: Env, now = Date.now()): Promise<{ checked: number; actions: string[] }> {
  const cfg = noticeConfig(env);
  if (!cfg) return { checked: 0, actions: ['skipped: CHORD_API_KEY not set'] };
  const origin = env.PUBLIC_ORIGIN?.trim() || 'https://zuma-dispatch.obimz123.workers.dev';
  // A local server must never take over real chats (23 Oct: a local test run did). Local .env sets
  // PUBLIC_ORIGIN=http://127.0.0.1:8787; CHORD_NOTICES_ALLOW_LOCAL=1 opts in, as for payment notices.
  if (!sendsAllowed(env, origin)) return { checked: 0, actions: ['skipped: local server'] };
  const ownHosts = [new URL(origin).hostname];
  const q = new URLSearchParams({ workspace_id: cfg.workspaceId, control_state: 'agent_active', limit: '25' });
  const list = await chord<{ threads?: ThreadRow[] }>(cfg, `/v1/threads?${q}`, 5000);
  if (!list.ok) return { checked: 0, actions: [`list failed: ${chordError(list)}`] };
  const recent = (list.data.threads ?? [])
    .filter((t) => THREAD_RE.test(t.id) && t.last_turn_direction === 'outbound' && t.last_turn_at && now - t.last_turn_at < WINDOW_MS && now - t.last_turn_at > GRACE_MS)
    .slice(0, MAX_THREADS);
  const actions: string[] = [];
  for (const t of recent) {
    const turns = await chord<{ turns?: WatchTurn[] }>(cfg, `/v1/threads/${t.id}/turns?limit=12`, 5000);
    if (!turns.ok) {
      actions.push(`${t.id}: turns failed ${chordError(turns)}`);
      continue;
    }
    for (const a of decide(turns.data.turns ?? [], ownHosts)) {
      if (a.kind === 'foreign_link') {
        if (await once(env.DB, t.id, a.replyTs, 'foreign_link', a.urls.join(' '), now)) {
          log('warn', 'watchdog_foreign_link', { thread_id: t.id, urls: a.urls.join(' ') });
          actions.push(`${t.id}: flagged link ${a.urls[0]}`);
        }
        continue;
      }
      // hand_to_team ran for this chat a moment ago: its own take-over is on the way.
      const recentHandover = await env.DB.prepare("SELECT 1 FROM tool_calls WHERE tool = 'hand_to_team' AND detail LIKE ? AND created_at > ?")
        .bind(`%${t.id}%`, now - 3 * 60_000)
        .first();
      if (recentHandover) continue;
      if (!(await once(env.DB, t.id, a.replyTs, 'handover', a.why, now))) continue;
      const reason = `${HANDOVER_REASON_PREFIX}safety net: ${a.why}. Customer said: "${a.customerText}"`.slice(0, 300);
      const take = await chord<ThreadRow>(cfg, `/v1/threads/${t.id}/take-over`, 6000, { reason });
      if (!take.ok) {
        const outcome = take.failure === 'http' && take.status === 409 ? 'already with a person' : `take-over failed: ${chordError(take)}`;
        await env.DB.prepare("UPDATE watchdog_events SET detail = detail || ' | ' || ? WHERE thread_id = ? AND reply_ts = ? AND kind = 'handover'").bind(outcome, t.id, a.replyTs).run();
        actions.push(`${t.id}: ${outcome}`);
        continue;
      }
      // Zuma didn't tell the customer, so we do (the chat is human-held now, so the message is allowed).
      const ack = a.told ? 'customer already told by Zuma' : await acknowledgeHandover(env, t.id, origin, now);
      await env.DB.prepare("UPDATE watchdog_events SET detail = detail || ' | taken over; ' || ? WHERE thread_id = ? AND reply_ts = ? AND kind = 'handover'").bind(ack, t.id, a.replyTs).run();
      log('warn', 'watchdog_handover', { thread_id: t.id, told: a.told, ack });
      actions.push(`${t.id}: handed over (${ack})`);
    }
  }
  return { checked: recent.length, actions };
}
