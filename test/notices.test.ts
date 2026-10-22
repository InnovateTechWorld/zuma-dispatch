import { afterEach, describe, expect, it, vi } from 'vitest';
import { paymentReceivedMessage } from '../src/business/messages';
import {
  agentMentioned, CUSTOMER_ACTIVE_MS, noticeStatus, notifyPaymentReceived, pickThread, platformFor, SERVICE_WINDOW_MS, type ThreadRow,
} from '../src/chord/notices';
import type { Env } from '../src/env';

afterEach(() => vi.restoreAllMocks());

const NOW = Date.UTC(2026, 9, 20, 16, 0); // 17:00 WAT, inside rider hours
const KEY = 'chord_live_' + 'x'.repeat(43);
const T1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const T2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const thread = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: T1, channel_id: 'whatsapp', channel_participant_id: '+2348030000001', control_state: 'agent_active',
  last_turn_at: NOW - 10 * 60_000, last_turn_direction: 'outbound', ...over,
});
const agentSays = (text: string, timestamp = NOW - 15 * 60_000) => ({ direction: 'outbound', sender: { kind: 'agent' }, content: { text }, timestamp });
const m = (t: ThreadRow, firstMentionAt = NOW - 15 * 60_000) => ({ thread: t, firstMentionAt });
const customerSays = (text: string) => ({ direction: 'inbound', sender: { kind: 'remote' }, content: { text } });

describe('finding the conversation for a job', () => {
  it('counts only the agent saying the job id, as a whole word', () => {
    expect(agentMentioned([agentSays('Booked, your job id is ZD-H01G4.')], 'ZD-H01G4')).toBe(true);
    expect(agentMentioned([customerSays('status of ZD-H01G4?')], 'ZD-H01G4')).toBe(false); // anyone can type an id
    expect(agentMentioned([agentSays('ZD-H01G45')], 'ZD-H01G4')).toBe(false);
    expect(agentMentioned([{ direction: 'outbound', sender: { kind: 'agent' }, content: null }], 'ZD-H01G4')).toBe(false);
  });

  it('sends to the one matching conversation; the newest when the same customer has several', () => {
    expect(pickThread([m(thread())], NOW)).toEqual({ ok: true, thread: thread() });
    const newer = thread({ id: T2, last_turn_at: NOW - 60_000 });
    expect(pickThread([m(thread()), m(newer, NOW - 2 * 60_000)], NOW)).toEqual({ ok: true, thread: newer });
  });

  it('goes to the person who booked (first agent mention), never to someone who only asked later', () => {
    const booker = thread();
    const asker = thread({ id: T2, channel_participant_id: '+2348099999999', last_turn_at: NOW - 60_000 });
    expect(pickThread([m(asker, NOW - 2 * 60_000), m(booker, NOW - 15 * 60_000)], NOW)).toEqual({ ok: true, thread: booker });
  });

  it('never guesses when two customers were sent the id at the same moment, and sends nothing with no match', () => {
    expect(pickThread([m(thread()), m(thread({ id: T2, channel_participant_id: '+2348099999999' }))], NOW)).toEqual({ ok: false, reason: 'ambiguous_thread' });
    expect(pickThread([], NOW)).toEqual({ ok: false, reason: 'thread_not_found' });
  });

  it('stays quiet while a human holds the chat, while the customer is mid-message, and outside the 24 h window', () => {
    expect(pickThread([m(thread({ control_state: 'human_active' }))], NOW)).toMatchObject({ ok: false, reason: 'human_handling', thread: { id: T1 } });
    expect(pickThread([m(thread({ control_state: 'paused' }))], NOW)).toMatchObject({ ok: false, reason: 'human_handling' });
    expect(pickThread([m(thread({ last_turn_direction: 'inbound', last_turn_at: NOW - CUSTOMER_ACTIVE_MS + 1000 }))], NOW)).toMatchObject({ ok: false, reason: 'customer_mid_conversation' });
    expect(pickThread([m(thread({ last_turn_direction: 'inbound', last_turn_at: NOW - CUSTOMER_ACTIVE_MS - 1000 }))], NOW).ok).toBe(true);
    expect(pickThread([m(thread({ last_turn_at: NOW - SERVICE_WINDOW_MS - 1 }))], NOW)).toMatchObject({ ok: false, reason: 'outside_24h_window' });
  });

  it('scheduled route uses the channel connector where Chord has one', () => {
    expect(platformFor(thread())).toBe('WHATSAPP');
    expect(platformFor(thread({ channel_id: 'external_chat' }))).toBe('DIRECT_LINE');
  });

  it('a local dev server never posts into real chats unless explicitly allowed', async () => {
    const { sendsAllowed } = await import('../src/chord/notices');
    const e = { DB: {} as D1Database } as unknown as Env;
    expect(sendsAllowed(e, 'http://127.0.0.1:8787')).toBe(false);
    expect(sendsAllowed(e, 'http://localhost:8787')).toBe(false);
    expect(sendsAllowed({ ...e, CHORD_NOTICES_ALLOW_LOCAL: '1' }, 'http://127.0.0.1:8787')).toBe(true);
    expect(sendsAllowed(e, 'https://zuma-dispatch.obimz123.workers.dev')).toBe(true);
  });

  it('is off without a key and flags a malformed one', () => {
    const base = { DB: {} as D1Database } as unknown as Env;
    expect(noticeStatus(base)).toBe('not_configured');
    expect(noticeStatus({ ...base, CHORD_API_KEY: 'nope', CHORD_WORKSPACE_ID: 'ws-1' })).toBe('invalid_config');
    expect(noticeStatus({ ...base, CHORD_API_KEY: KEY })).toBe('invalid_config'); // no workspace
    expect(noticeStatus({ ...base, CHORD_API_KEY: KEY, CHORD_WORKSPACE_ID: 'ws-1' })).toBe('enabled');
  });
});

// ------------------------------------------------------------------ the whole send, against fakes
const JOB = { id: 'ZD-H01G4', status: 'paid', amount_kobo: 195000, handover_code: '8960', created_at: NOW - 20 * 60_000 };

/** D1 stand-in: the claim succeeds once (like the real UPSERT), everything else is recorded. */
function fakeDb(opts: { job?: typeof JOB | null; claimed?: boolean } = {}) {
  let claimed = opts.claimed ?? false;
  const writes: string[] = [];
  const stmt = (sql: string) => {
    const bound = () => ({
      async first() {
        if (sql.startsWith('SELECT * FROM jobs')) return opts.job === undefined ? JOB : opts.job;
        if (sql.startsWith('INSERT INTO chat_notices')) {
          if (claimed) return null;
          claimed = true;
          return { attempts: 1 };
        }
        return null;
      },
      async run() { writes.push(sql.slice(0, 30)); return { meta: { changes: 1 } }; },
      sql,
    });
    return Object.assign(bound(), { bind: bound });
  };
  return {
    writes,
    prepare: stmt,
    async batch(list: { sql: string }[]) { list.forEach((s) => writes.push(s.sql.slice(0, 30))); return list.map(() => ({ meta: { changes: 1 } })); },
  } as unknown as D1Database & { writes: string[] };
}

function chordApi(handlers: {
  threads?: ThreadRow[]; turns?: Record<string, unknown[]>; task?: () => Response; list?: () => Response;
  takeOver?: () => Response; message?: () => Response; handBack?: () => Response;
}) {
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/v1/threads?')) return handlers.list?.() ?? Response.json({ threads: handlers.threads ?? [] });
    const m = /\/v1\/threads\/([0-9a-f]{24})\/turns/.exec(url);
    if (m) return Response.json({ turns: handlers.turns?.[m[1]!] ?? [] });
    if (url.endsWith('/v1/scheduled-tasks')) return handlers.task?.() ?? Response.json({ id: 'task_abc123' }, { status: 201 });
    if (url.endsWith('/take-over')) return handlers.takeOver?.() ?? Response.json({ id: T1, control_state: 'human_active' });
    if (url.endsWith('/messages')) return handlers.message?.() ?? Response.json({ id: 'turn_1', delivery_status: 'sent' }, { status: 201 });
    if (url.endsWith('/hand-back')) return handlers.handBack?.() ?? Response.json({ id: T1, control_state: 'agent_active' });
    return new Response('not found', { status: 404 });
  });
  return calls;
}

const env = (db: D1Database): Env => ({ DB: db, CHORD_API_KEY: KEY, CHORD_WORKSPACE_ID: 'ws-1', CHORD_TEAMMATE_ID: 'tm-1', PROVIDER_TIMEOUT_MS: '4000' }) as Env;
const opEnv = (db: D1Database): Env => ({ ...env(db), CHORD_NOTICE_ROUTE: 'operator' }) as Env;

describe('notifyPaymentReceived', () => {
  it('default route: finds the booking conversation and queues one MESSAGE via its WhatsApp connector, no take-over', async () => {
    const db = fakeDb();
    const calls = chordApi({
      threads: [thread({ id: T2, channel_participant_id: '+2348099999999' }), thread()],
      // T2 (another customer) asked about the job later; T1 is where it was booked.
      turns: { [T1]: [agentSays('Booked, Tolu. Your job id is ZD-H01G4.')], [T2]: [agentSays('Your job ZD-H01G4 is paid.', NOW - 2 * 60_000)] },
    });
    expect(await notifyPaymentReceived(env(db), 'ZD-H01G4', { now: NOW })).toEqual({ state: 'queued', thread_id: T1, task_id: 'task_abc123' });
    const task = calls.find((c) => c.url.endsWith('/v1/scheduled-tasks'))!;
    expect(task.body).toMatchObject({ task_type: 'MESSAGE', workspace_id: 'ws-1', teammate_id: 'tm-1', payload: { platform: 'WHATSAPP', conversation_id: T1, body: paymentReceivedMessage(JOB, NOW) } });
    expect(Date.parse(String(task.body!.scheduled_at))).toBeGreaterThan(NOW); // Chord rejects past instants
    expect(calls.some((c) => c.url.endsWith('/take-over'))).toBe(false);
    expect(calls[0]!.url).toContain('workspace_id=ws-1');
    expect(db.writes.some((w) => w.startsWith('UPDATE chat_notices'))).toBe(true);
    expect(db.writes.some((w) => w.startsWith('INSERT INTO job_events'))).toBe(true);
  });

  it('on a channel that cannot show pushed messages (simulator) nothing is posted', async () => {
    const calls = chordApi({ threads: [thread({ channel_id: 'external_chat' })], turns: { [T1]: [agentSays('job ZD-H01G4')] } });
    expect(await notifyPaymentReceived(env(fakeDb()), 'ZD-H01G4', { now: NOW })).toMatchObject({ state: 'skipped', reason: 'channel_cannot_show' });
    expect(calls.some((c) => c.url.endsWith('/v1/scheduled-tasks'))).toBe(false);
  });

  it('operator route (opt-in): take over, post, hand back', async () => {
    const db = fakeDb();
    const calls = chordApi({
      threads: [thread({ id: T2, channel_participant_id: '+2348099999999' }), thread()],
      // T2 (another customer) asked about the job later; T1 is where it was booked.
      turns: { [T1]: [agentSays('Booked, Tolu. Your job id is ZD-H01G4.')], [T2]: [agentSays('Your job ZD-H01G4 is paid.', NOW - 2 * 60_000)] },
    });
    const r = await notifyPaymentReceived(opEnv(db), 'ZD-H01G4', { now: NOW });
    expect(r).toEqual({ state: 'sent', thread_id: T1, task_id: 'turn_1' });
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.url.replace(/.*\/v1\//, ''));
    expect(posts).toEqual([`threads/${T1}/take-over`, `threads/${T1}/messages`, `threads/${T1}/hand-back`]);
    expect(calls.find((c) => c.url.endsWith('/messages'))!.body).toEqual({ text: paymentReceivedMessage(JOB, NOW) });
    expect(String(calls.find((c) => c.url.endsWith('/take-over'))!.body!.reason)).toMatch(/^zuma-dispatch automated notice/);
  });

  it('a person grabbed the chat a moment ago (take-over 409): nothing posted', async () => {
    const calls = chordApi({ threads: [thread()], turns: { [T1]: [agentSays('job ZD-H01G4')] }, takeOver: () => Response.json({ error: { code: 'INVALID_STATE', message: 'already human_active' } }, { status: 409 }) });
    expect(await notifyPaymentReceived(opEnv(fakeDb()), 'ZD-H01G4', { now: NOW })).toMatchObject({ state: 'skipped', reason: 'human_handling' });
    expect(calls.some((c) => c.url.endsWith('/messages'))).toBe(false);
  });

  it('channel refused the message: failed, and the chat is still handed back', async () => {
    const calls = chordApi({ threads: [thread()], turns: { [T1]: [agentSays('job ZD-H01G4')] }, message: () => Response.json({ id: 'turn_2', delivery_status: 'failed', delivery_error: 'outside 24h window' }, { status: 201 }) });
    expect(await notifyPaymentReceived(opEnv(fakeDb()), 'ZD-H01G4', { now: NOW })).toMatchObject({ state: 'failed', reason: 'undelivered: outside 24h window' });
    expect(calls.some((c) => c.url.endsWith('/hand-back'))).toBe(true);
  });

  it('hand-back keeps failing: retried 3 times, then flagged so a dispatcher hands it back', async () => {
    const calls = chordApi({ threads: [thread()], turns: { [T1]: [agentSays('job ZD-H01G4')] }, handBack: () => new Response('{}', { status: 503 }) });
    expect(await notifyPaymentReceived(opEnv(fakeDb()), 'ZD-H01G4', { now: NOW })).toMatchObject({ state: 'sent', reason: 'hand_back_failed' });
    expect(calls.filter((c) => c.url.endsWith('/hand-back'))).toHaveLength(3);
  });

  it('sends at most once: a second trigger (Paystack retry, return page) does nothing', async () => {
    const calls = chordApi({ threads: [thread()], turns: { [T1]: [agentSays('job ZD-H01G4')] } });
    expect(await notifyPaymentReceived(env(fakeDb({ claimed: true })), 'ZD-H01G4', { now: NOW })).toEqual({ state: 'not_sent', reason: 'already_handled' });
    expect(calls).toHaveLength(0);
  });

  it('records a skip (no message) when no conversation matches', async () => {
    const calls = chordApi({ threads: [thread()], turns: { [T1]: [agentSays('job ZD-OTHER')] } });
    expect(await notifyPaymentReceived(env(fakeDb()), 'ZD-H01G4', { now: NOW })).toMatchObject({ state: 'skipped', reason: 'thread_not_found' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('records a failure with Chord\'s reason when the key lacks a scope, and never throws', async () => {
    chordApi({ list: () => Response.json({ error: { code: 'FORBIDDEN', message: 'Missing required permission: thread:read' } }, { status: 403 }) });
    const r = await notifyPaymentReceived(env(fakeDb()), 'ZD-H01G4', { now: NOW });
    expect(r.state).toBe('failed');
    expect(r.reason).toBe('chord_http_403: Missing required permission: thread:read');
  });

  it('fails safe when queuing the message fails', async () => {
    chordApi({ threads: [thread()], turns: { [T1]: [agentSays('job ZD-H01G4')] }, task: () => new Response('{}', { status: 502 }) });
    expect(await notifyPaymentReceived(env(fakeDb()), 'ZD-H01G4', { now: NOW })).toMatchObject({ state: 'failed', reason: 'chord_http_502', thread_id: T1 });
  });

  it('operator route fails safe when Chord is down at take-over', async () => {
    chordApi({ threads: [thread()], turns: { [T1]: [agentSays('job ZD-H01G4')] }, takeOver: () => new Response('{}', { status: 502 }) });
    expect(await notifyPaymentReceived(opEnv(fakeDb()), 'ZD-H01G4', { now: NOW })).toMatchObject({ state: 'failed', reason: 'take_over: chord_http_502', thread_id: T1 });
  });

  it('does nothing for unpaid jobs or when switched off', async () => {
    const calls = chordApi({});
    expect(await notifyPaymentReceived(env(fakeDb({ job: { ...JOB, status: 'awaiting_payment' } })), 'ZD-H01G4', { now: NOW })).toEqual({ state: 'not_sent', reason: 'job_not_paid' });
    expect(await notifyPaymentReceived({ DB: fakeDb() } as unknown as Env, 'ZD-H01G4', { now: NOW })).toEqual({ state: 'not_sent', reason: 'not_configured' });
    expect(calls).toHaveLength(0);
  });
});

describe('the message itself', async () => {
  const { RIDERS, chooseRider, riderLine } = await import('../src/business/riders');
  const { handoverMessage } = await import('../src/chord/notices');
  const tunde = RIDERS.find((r) => r.id === 'R-LA1')!;

  it('after payment: amount, job, the rider, timing, and (only now) the handover code', () => {
    expect(paymentReceivedMessage({ ...JOB, rider_id: 'R-LA1' }, NOW)).toBe(
      'Payment received: ₦1,950 for ZD-H01G4. Thank you!\n\nTunde (motorbike, LSD 553 XA) is on the way to the pickup now. Pickup is usually within 45 minutes.\nTunde (rider): 0800 000 0104\n\nHandover code: 8960\nShare it with the recipient; Tunde (rider) will ask for it at drop-off.',
    );
    expect(paymentReceivedMessage(JOB, NOW)).toContain('A dispatcher is assigning a rider now');
    // With the recipient's name, the message uses it.
    expect(paymentReceivedMessage({ ...JOB, rider_id: 'R-LA1', recipient_name: 'micheal okafor' }, NOW)).toContain('Share it with Micheal (recipient); Tunde (rider) will ask for it at drop-off.');
  });
  it('stays true when re-sent after dispatch or delivery', () => {
    expect(paymentReceivedMessage({ ...JOB, status: 'dispatched', rider_id: 'R-LA1' }, NOW)).toBe(
      `Payment received: ₦1,950 for ZD-H01G4. Thank you!\n\n${riderLine(tunde)} has the package.\nTunde (rider): 0800 000 0104\n\nHandover code: 8960\nShare it with the recipient; Tunde (rider) will ask for it at drop-off.`,
    );
    expect(paymentReceivedMessage({ ...JOB, status: 'delivered' }, NOW)).toBe('Payment received: ₦1,950 for ZD-H01G4. Thank you!\n\nIt has been delivered.');
  });
  it('picks a rider in the right state and vehicle, the least busy first', () => {
    expect(chooseRider('LA', 'small', [])?.id).toBe('R-LA1');
    expect(chooseRider('LA', 'large', [])?.vehicle).toBe('car');
    expect(chooseRider('FC', 'medium', [])?.state).toBe('FC');
    expect(chooseRider('LA', 'small', [{ rider_id: 'R-LA1', active: 2, last_assigned: 5 }])?.id).toBe('R-LA2');
    expect(chooseRider('LA', 'small', [{ rider_id: 'R-LA1', active: 1, last_assigned: 9 }, { rider_id: 'R-LA2', active: 1, last_assigned: 3 }])?.id).toBe('R-LA2');
  });
  it('tells a handed-over customer who will answer, and when (closed: from 7am)', () => {
    expect(handoverMessage(NOW)).toContain('will reply here shortly');
    expect(handoverMessage(Date.UTC(2026, 9, 25, 10, 0))).toContain('from 7am'); // a Sunday
  });
});

describe('the agent confirms first: no duplicate notice', () => {
  const db = (row: { state: string; reason: string | null } | null) => {
    const runs: string[] = [];
    return {
      runs,
      prepare(sql: string) {
        return { bind: () => ({ first: async () => row, run: async () => { runs.push(sql); return { meta: { changes: 1 } }; } }) };
      },
    } as unknown as D1Database & { runs: string[] };
  };
  it('no notice yet: claims it as agent_confirmed so the push is skipped', async () => {
    const { noteAgentConfirmed } = await import('../src/chord/notices');
    const d = db(null);
    expect(await noteAgentConfirmed(d, 'ZD-AAAAA', 1)).toBe('agent_tells');
    expect(d.runs[0]).toContain("'agent_confirmed'");
  });
  it('notice already shown on a real channel: the agent sends the short follow-up', async () => {
    const { noteAgentConfirmed } = await import('../src/chord/notices');
    expect(await noteAgentConfirmed(db({ state: 'sent', reason: null }), 'ZD-AAAAA', 1)).toBe('customer_already_told');
    expect(await noteAgentConfirmed(db({ state: 'queued', reason: null }), 'ZD-AAAAA', 1)).toBe('customer_already_told');
  });
  it('notice only recorded (simulator cannot show it): the agent still sends the full message', async () => {
    const { noteAgentConfirmed } = await import('../src/chord/notices');
    expect(await noteAgentConfirmed(db({ state: 'sent', reason: 'record_only' }), 'ZD-AAAAA', 1)).toBe('agent_tells');
  });
  it('the follow-up keeps the rider and the code', async () => {
    const { paidFollowUp } = await import('../src/business/messages');
    const m = paidFollowUp({ ...JOB, status: 'paid', rider_id: 'R-LA1' }, NOW);
    expect(m).toContain('Yes, your payment is confirmed.');
    expect(m).toContain('8960');
  });
});
