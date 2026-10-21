import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { checkReply, controlState, handovers, jobIdIn, MAX_REPLY, OPERATOR_ID, speakerOf } from '../src/web/handovers';

afterEach(() => vi.restoreAllMocks());

const KEY = 'chord_live_' + 'x'.repeat(43);
const T = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ORIGIN = 'https://zuma.example';
const config = { businessName: 'Zuma Dispatch', boardToken: 'b'.repeat(32) } as never;

describe('reading a conversation', () => {
  it('labels who said what (our automated posts are notices, the board is the team)', () => {
    expect(speakerOf({ direction: 'inbound', sender: { kind: 'remote' } })).toBe('customer');
    expect(speakerOf({ direction: 'outbound', sender: { kind: 'agent' } })).toBe('agent');
    expect(speakerOf({ direction: 'outbound', sender: { kind: 'system' } })).toBe('notice');
    expect(speakerOf({ direction: 'outbound', sender: { kind: 'human_operator', operator_user_id: OPERATOR_ID }, content: { text: 'Hi' } })).toBe('team');
    expect(speakerOf({ direction: 'outbound', sender: { kind: 'human_operator' }, content: { text: "You're now connected to the Zuma Dispatch support team. …" } })).toBe('notice');
    expect(speakerOf({ direction: 'outbound', sender: { kind: 'human_operator' }, content: { text: 'Hello from Chord' } })).toBe('team');
  });
  it('validates replies before sending (empty, too long, Windows newlines)', () => {
    expect(checkReply('   ')).toEqual({ ok: false, problem: 'Write a message first.' });
    expect(checkReply('x'.repeat(MAX_REPLY + 1)).ok).toBe(false);
    expect(checkReply(' Hi\r\nthere ')).toEqual({ ok: true, text: 'Hi\nthere' });
  });
  it('finds the job from the handover reason first, else the newest mention', () => {
    expect(jobIdIn([{ content: { text: 'job ZD-AAAAA' } }, { content: { text: 'now ZD-BBBBB' } }], [null])).toBe('ZD-BBBBB');
    expect(jobIdIn([{ content: { text: 'ZD-BBBBB' } }], ['wants to cancel paid job ZD-T30FJ'])).toBe('ZD-T30FJ');
    expect(jobIdIn([], [])).toBeNull();
  });
  it('treats an unexpected control state as unknown', () => {
    expect(controlState('human_active')).toBe('human_active');
    expect(controlState('weird')).toBe('unknown');
  });
});

// ------------------------------------------------------------------ actions against a fake Chord
function fakeDb() {
  const nonces = new Set<string>();
  const updates: unknown[][] = [];
  return {
    updates,
    prepare(sql: string) {
      const bound = (...args: unknown[]) => ({
        async run() {
          if (sql.startsWith('INSERT INTO board_replies')) {
            const n = String(args[0]);
            if (nonces.has(n)) return { meta: { changes: 0 } };
            nonces.add(n);
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE board_replies')) updates.push(args);
          return { meta: { changes: 1 } };
        },
      });
      return { bind: bound };
    },
  } as unknown as D1Database & { updates: unknown[][] };
}

function chordApi(h: { message?: () => Response; handBack?: () => Response; takeOver?: () => Response }) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith('/messages')) return h.message?.() ?? Response.json({ id: 'turn_9', delivery_status: 'sent' }, { status: 201 });
    if (url.endsWith('/hand-back')) return h.handBack?.() ?? Response.json({ id: T, control_state: 'agent_active' });
    if (url.endsWith('/take-over')) return h.takeOver?.() ?? Response.json({ id: T, control_state: 'human_active' });
    return new Response('{}', { status: 404 });
  });
  return calls;
}

const NONCE = '123e4567-e89b-12d3-a456-426614174000-reply';
const env = (db: D1Database, extra: Partial<Env> = {}) => ({ DB: db, CHORD_API_KEY: KEY, CHORD_WORKSPACE_ID: 'ws-1', BOARD_TOKEN: 'b'.repeat(32), PROVIDER_TIMEOUT_MS: '4000', ...extra }) as unknown as Env;
function post(fields: Record<string, string>, headers: Record<string, string> = { 'Sec-Fetch-Site': 'same-origin' }, origin = ORIGIN) {
  const body = new URLSearchParams(fields);
  return { req: new Request(`${origin}/board/handovers/${T}`, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } }), url: new URL(`${origin}/board/handovers/${T}`) };
}
async function run(fields: Record<string, string>, db = fakeDb(), extraEnv: Partial<Env> = {}, headers?: Record<string, string>, origin?: string) {
  const { req, url } = post(fields, headers, origin);
  const res = (await handovers(req, url, env(db, extraEnv), config, { signedIn: true, theme: 'auto' }))!;
  const loc = new URL(res.headers.get('Location')!);
  return { msg: loc.searchParams.get('msg'), error: loc.searchParams.get('tone') === 'error', db };
}

describe('replying and handing back', () => {
  it('signs replies (unless already signed) so the customer and the AI know a person wrote them', async () => {
    const { signed } = await import('../src/web/handovers');
    expect(signed('Hi')).toBe('Hi\n— Zuma Dispatch team');
    expect(signed('Hi, this is Shola from the Zuma Dispatch team.')).toBe('Hi, this is Shola from the Zuma Dispatch team.');
  });
  it('sends the reply as the board operator and reports it', async () => {
    const calls = chordApi({});
    const r = await run({ action: 'reply', nonce: NONCE, text: ' Hi, this is the team ' });
    expect(r).toMatchObject({ msg: 'Sent to the customer.', error: false });
    expect(calls[0]!.body).toEqual({ text: 'Hi, this is the team\n— Zuma Dispatch team', operator_user_id: OPERATOR_ID });
  });
  it('a double click or refresh never sends twice', async () => {
    const calls = chordApi({});
    const db = fakeDb();
    await run({ action: 'reply', nonce: NONCE, text: 'Hi' }, db);
    const second = await run({ action: 'reply', nonce: NONCE, text: 'Hi' }, db);
    expect(second.msg).toMatch(/submitted twice/);
    expect(calls.filter((c) => c.url.endsWith('/messages'))).toHaveLength(1);
  });
  it('Zuma still holds the chat (409): explains that a take-over is needed', async () => {
    chordApi({ message: () => Response.json({ error: { code: 'INVALID_STATE' } }, { status: 409 }) });
    expect(await run({ action: 'reply', nonce: NONCE, text: 'Hi' })).toMatchObject({ error: true, msg: expect.stringMatching(/Take it over first/) });
  });
  it('the channel refused the message: says it was not delivered', async () => {
    chordApi({ message: () => Response.json({ id: 'turn_1', delivery_status: 'failed', delivery_error: 'outside 24h window' }, { status: 201 }) });
    expect(await run({ action: 'reply', nonce: NONCE, text: 'Hi' })).toMatchObject({ error: true, msg: expect.stringMatching(/outside 24h window/) });
  });
  it('send and hand back: both happen, in that order; a failed send never hands back', async () => {
    const calls = chordApi({});
    expect((await run({ action: 'reply_handback', nonce: NONCE, text: 'Done' })).msg).toBe('Sent, and handed back to Zuma.');
    // reply, closing line, hand-back
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['messages', 'messages', 'hand-back']);
    expect(calls[1]!.body!.text).toMatch(/^Thanks for your patience\. Zuma, our booking assistant/);
    const calls2 = chordApi({ message: () => new Response('{}', { status: 502 }) });
    await run({ action: 'reply_handback', nonce: NONCE.replace('reply', 'reply'), text: 'Done' }, fakeDb());
    expect(calls2.some((c) => c.url.endsWith('/hand-back'))).toBe(false);
  });
  it('empty reply, unknown action, stale form: nothing sent', async () => {
    const calls = chordApi({});
    expect((await run({ action: 'reply', nonce: NONCE, text: '  ' })).msg).toBe('Write a message first.');
    expect((await run({ action: 'explode', nonce: NONCE })).msg).toBe('Unknown action.');
    expect((await run({ action: 'reply', nonce: 'nope', text: 'Hi' })).msg).toMatch(/out of date/);
    expect(calls).toHaveLength(0);
  });
  it('blocks cross-site posts and local servers', async () => {
    const calls = chordApi({});
    expect((await run({ action: 'reply', nonce: NONCE, text: 'Hi' }, fakeDb(), {}, { 'Sec-Fetch-Site': 'cross-site' })).msg).toMatch(/another site/);
    expect((await run({ action: 'reply', nonce: NONCE, text: 'Hi' }, fakeDb(), {}, undefined, 'http://127.0.0.1:8787')).msg).toMatch(/local test server/);
    expect(calls).toHaveLength(0);
  });
  it('take over and hand back report the new state; already handed back is explained', async () => {
    chordApi({ handBack: () => Response.json({ error: { code: 'INVALID_STATE' } }, { status: 409 }) });
    expect((await run({ action: 'takeover', nonce: NONCE.replace('reply', 'takeover') })).msg).toMatch(/You hold this chat now/);
    expect((await run({ action: 'handback', nonce: NONCE.replace('reply', 'handback') })).msg).toMatch(/already handed back/);
  });
});

describe('inbox labels', () => {
  it('cuts previews at a word and marks the cut', async () => {
    const { clip } = await import('../src/web/handovers');
    expect(clip("You're now connected to the Zuma Dispatch support team. A team member has your back", 60)).toBe("You're now connected to the Zuma Dispatch support team. A…");
    expect(clip('short', 80)).toBe('short');
    expect(clip('x'.repeat(100), 10)).toBe('xxxxxxxxxx…');
  });
  it('names earlier handovers by job, else by chat id', async () => {
    const { earlierTitle } = await import('../src/web/handovers');
    expect(earlierTitle('aaaaaaaaaaaaaaaaaabc1234', 'wants to cancel paid job ZD-T30FJ')).toBe('Chat about ZD-T30FJ');
    expect(earlierTitle('aaaaaaaaaaaaaaaaaabc1234', null)).toBe('Chat …bc1234');
  });
});

describe('earlier handover names from Chord', () => {
  it('prefers the customer name, then the contact, then the job, then the id', async () => {
    const { earlierTitle } = await import('../src/web/handovers');
    const id = 'aaaaaaaaaaaaaaaaaabc1234';
    expect(earlierTitle(id, 'refund ZD-T30FJ', { id, remote_participant_metadata: { display_name: 'Ada Obi' } } as never)).toBe('Ada Obi · ZD-T30FJ');
    expect(earlierTitle(id, null, { id, channel_id: 'external_chat' } as never)).toBe('Test chat (simulator)');
  });
});
describe('earlier handover that Chord no longer has', () => {
  it('says so instead of a bare id', async () => {
    const { earlierTitle } = await import('../src/web/handovers');
    expect(earlierTitle('aaaaaaaaaaaaaaaaaabc1234', null, 'gone')).toBe('Chat no longer in Chord (…bc1234)');
  });
});
