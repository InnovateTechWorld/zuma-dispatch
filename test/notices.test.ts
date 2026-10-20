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
const agentSays = (text: string) => ({ direction: 'outbound', sender: { kind: 'agent' }, content: { text } });
const customerSays = (text: string) => ({ direction: 'inbound', sender: { kind: 'remote' }, content: { text } });

describe('finding the conversation for a job', () => {
  it('counts only the agent saying the job id, as a whole word', () => {
    expect(agentMentioned([agentSays('Booked, your job id is ZD-H01G4.')], 'ZD-H01G4')).toBe(true);
    expect(agentMentioned([customerSays('status of ZD-H01G4?')], 'ZD-H01G4')).toBe(false); // anyone can type an id
    expect(agentMentioned([agentSays('ZD-H01G45')], 'ZD-H01G4')).toBe(false);
    expect(agentMentioned([{ direction: 'outbound', sender: { kind: 'agent' }, content: null }], 'ZD-H01G4')).toBe(false);
  });

  it('sends to the one matching conversation; the newest when the same customer has several', () => {
    expect(pickThread([thread()], NOW)).toEqual({ ok: true, thread: thread() });
    const newer = thread({ id: T2, last_turn_at: NOW - 60_000 });
    expect(pickThread([thread(), newer], NOW)).toEqual({ ok: true, thread: newer });
  });

  it('never guesses between different customers, and sends nothing when there is no match', () => {
    expect(pickThread([thread(), thread({ id: T2, channel_participant_id: '+2348099999999' })], NOW)).toEqual({ ok: false, reason: 'ambiguous_thread' });
    expect(pickThread([], NOW)).toEqual({ ok: false, reason: 'thread_not_found' });
  });

  it('stays quiet while a human holds the chat, while the customer is mid-message, and outside the 24 h window', () => {
    expect(pickThread([thread({ control_state: 'human_active' })], NOW)).toEqual({ ok: false, reason: 'human_handling' });
    expect(pickThread([thread({ control_state: 'paused' })], NOW)).toEqual({ ok: false, reason: 'human_handling' });
    expect(pickThread([thread({ last_turn_direction: 'inbound', last_turn_at: NOW - CUSTOMER_ACTIVE_MS + 1000 })], NOW)).toEqual({ ok: false, reason: 'customer_mid_conversation' });
    expect(pickThread([thread({ last_turn_direction: 'inbound', last_turn_at: NOW - CUSTOMER_ACTIVE_MS - 1000 })], NOW).ok).toBe(true);
    expect(pickThread([thread({ last_turn_at: NOW - SERVICE_WINDOW_MS - 1 })], NOW)).toEqual({ ok: false, reason: 'outside_24h_window' });
  });

  it('routes through the Chord thread by default, or the channel connector when configured', () => {
    expect(platformFor(thread(), 'direct_line')).toBe('DIRECT_LINE');
    expect(platformFor(thread(), 'channel')).toBe('WHATSAPP');
    expect(platformFor(thread({ channel_id: 'partner-chat' }), 'channel')).toBe('DIRECT_LINE');
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

function chordApi(handlers: { threads?: ThreadRow[]; turns?: Record<string, unknown[]>; task?: () => Response; list?: () => Response }) {
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/v1/threads?')) return handlers.list?.() ?? Response.json({ threads: handlers.threads ?? [] });
    const m = /\/v1\/threads\/([0-9a-f]{24})\/turns/.exec(url);
    if (m) return Response.json({ turns: handlers.turns?.[m[1]!] ?? [] });
    if (url.endsWith('/v1/scheduled-tasks')) return handlers.task?.() ?? Response.json({ id: 'task_abc123' }, { status: 201 });
    return new Response('not found', { status: 404 });
  });
  return calls;
}

const env = (db: D1Database): Env => ({ DB: db, CHORD_API_KEY: KEY, CHORD_WORKSPACE_ID: 'ws-1', CHORD_TEAMMATE_ID: 'tm-1', PROVIDER_TIMEOUT_MS: '4000' }) as Env;

describe('notifyPaymentReceived', () => {
  it('finds the conversation by the job id the agent sent and queues one MESSAGE into it', async () => {
    const db = fakeDb();
    const calls = chordApi({
      threads: [thread({ id: T2, channel_participant_id: '+2348099999999' }), thread()],
      turns: { [T1]: [agentSays('Booked, Tolu. Your job id is ZD-H01G4.')], [T2]: [agentSays('Your job ZD-AAAAA is on the way.')] },
    });
    const r = await notifyPaymentReceived(env(db), 'ZD-H01G4', { now: NOW });
    expect(r).toEqual({ state: 'queued', thread_id: T1, task_id: 'task_abc123' });
    const task = calls.find((c) => c.method === 'POST')!;
    expect(task.body).toMatchObject({
      task_type: 'MESSAGE', workspace_id: 'ws-1', teammate_id: 'tm-1',
      payload: { platform: 'DIRECT_LINE', conversation_id: T1, body: paymentReceivedMessage(JOB, NOW) },
    });
    expect(Date.parse(String(task.body!.scheduled_at))).toBeGreaterThan(NOW); // Chord rejects past instants
    expect(calls[0]!.url).toContain('workspace_id=ws-1');
    expect(db.writes.some((w) => w.startsWith('UPDATE chat_notices'))).toBe(true);
    expect(db.writes.some((w) => w.startsWith('INSERT INTO job_events'))).toBe(true);
  });

  it('sends at most once: a second trigger (Paystack retry, return page) does nothing', async () => {
    const calls = chordApi({ threads: [thread()], turns: { [T1]: [agentSays('job ZD-H01G4')] } });
    expect(await notifyPaymentReceived(env(fakeDb({ claimed: true })), 'ZD-H01G4', { now: NOW })).toEqual({ state: 'not_sent', reason: 'already_handled' });
    expect(calls).toHaveLength(0);
  });

  it('records a skip (no message) when no conversation matches', async () => {
    const calls = chordApi({ threads: [thread()], turns: { [T1]: [agentSays('job ZD-OTHER')] } });
    expect(await notifyPaymentReceived(env(fakeDb()), 'ZD-H01G4', { now: NOW })).toEqual({ state: 'skipped', reason: 'thread_not_found' });
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

  it('does nothing for unpaid jobs or when switched off', async () => {
    const calls = chordApi({});
    expect(await notifyPaymentReceived(env(fakeDb({ job: { ...JOB, status: 'awaiting_payment' } })), 'ZD-H01G4', { now: NOW })).toEqual({ state: 'not_sent', reason: 'job_not_paid' });
    expect(await notifyPaymentReceived({ DB: fakeDb() } as unknown as Env, 'ZD-H01G4', { now: NOW })).toEqual({ state: 'not_sent', reason: 'not_configured' });
    expect(calls).toHaveLength(0);
  });
});

describe('the message itself', () => {
  it('confirms the amount and job, gives the pickup timing and the handover code', () => {
    expect(paymentReceivedMessage(JOB, NOW)).toBe(
      'Payment received: ₦1,950 for ZD-H01G4. A dispatcher is assigning a rider now; pickup is usually within 45 minutes. The recipient gives the rider code 8960.',
    );
  });
});
