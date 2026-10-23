import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearChordCache } from '../src/chord/notices';
import { decide, foreignLinks, lastExchange, OUR_MAP_LINK, promisedPerson, reasonFor, runWatchdog, runWatchdogLoop, wantsPerson, type WatchTurn } from '../src/chord/watchdog';
import { mapUrl } from '../src/business/tracking';
import { alertsFrom, tabBadges, type Signals } from '../src/web/signals';
import { d1 } from './helpers/sqliteD1';

afterEach(() => {
  vi.restoreAllMocks();
  clearChordCache();
});

const OWN = ['zuma-dispatch.obimz123.workers.dev'];
let ts = 1_000;
const customer = (text: string): WatchTurn => ({ direction: 'inbound', sender: { kind: 'remote' }, content: { text }, timestamp: (ts += 1000) });
const zuma = (text: string): WatchTurn => ({ direction: 'outbound', sender: { kind: 'agent' }, content: { text }, timestamp: (ts += 1000) });
const system = (text: string): WatchTurn => ({ direction: 'outbound', sender: { kind: 'system' }, content: { text }, timestamp: (ts += 1000) });
const team = (text: string): WatchTurn => ({ direction: 'outbound', sender: { kind: 'human_operator', operator_user_id: 'zuma-board' }, content: { text }, timestamp: (ts += 1000) });

describe('what counts as asking for a person', () => {
  it('requests', () => {
    for (const t of ['oh i want a refund.', 'I need my money back', 'refund me abeg', 'can I get a refund for ZD-F74B2', 'let me speak to a person', 'I want to talk to someone', 'customer care please', 'connect me to a human', 'I want to complain'])
      expect(wantsPerson(t), t).toBe(true);
  });
  it('not requests: policy questions and negations', () => {
    for (const t of ['how do refunds work?', 'do you refund if the rider is late?', "no I don't want a refund", 'I dont need a refund thanks', 'where is the rider now', 'i have paid', 'refundable?'])
      expect(wantsPerson(t), t).toBe(false);
  });
});

describe("what counts as Zuma promising a person", () => {
  it('promises', () => {
    for (const t of ["I'm passing your refund request for ZD-F92SC to our team now. A dispatcher will take it from here and follow up with you in this chat.", 'I have forwarded this to our support team.', 'Got it, Ada. A person from our team will take over from here to help with your refund.', "I've passed this to our support team. Someone from the team will reply here shortly.", 'Someone from our team will get back to you shortly.', "I'm connecting you to our support team."])
      expect(promisedPerson(t), t).toBe(true);
  });
  it('not promises', () => {
    for (const t of ['Tunde (rider) will ask for it at drop-off.', 'Our team assigns a rider once payment lands.', 'Payment received: ₦1,950 for ZD-F74B2.'])
      expect(promisedPerson(t), t).toBe(false);
  });
});

describe('links we did not issue', () => {
  it('flags made-up tracking pages, keeps Paystack, Google Maps and our own server', () => {
    expect(foreignLinks('Track live: https://zuma.dispatch/track/ZD-F74B2', OWN)).toEqual(['https://zuma.dispatch/track/ZD-F74B2']);
    expect(foreignLinks('Track live: https://zumadispatch.example/track/ZD-5MHJZ.', OWN)).toHaveLength(1);
    expect(foreignLinks('Pay here:\nhttps://checkout.paystack.com/em37bgt7tmzbf4y', OWN)).toEqual([]);
    expect(foreignLinks(`Live map: ${mapUrl({ lat: 6.59215, lng: 3.37285 })}`, OWN)).toEqual([]); // our own pin link
    expect(OUR_MAP_LINK.test(mapUrl({ lat: -1.5, lng: 103.12345 }))).toBe(true);
    // 23 Oct: Zuma wrote its own Google link with made-up coordinates and an extra parameter.
    expect(foreignLinks('Live map: https://maps.google.com/?q=6.601,3.351&zuma=ZD-F92SC', OWN)).toHaveLength(1);
    expect(foreignLinks('https://www.google.com/maps/search/?api=1&query=6.59,3.35', OWN)).toHaveLength(1); // not our 5-decimal format
    expect(foreignLinks('Receipt: https://zuma-dispatch.obimz123.workers.dev/pay/return?reference=x', OWN)).toEqual([]);
    expect(foreignLinks('https://www.google.com/search?q=zuma', OWN)).toHaveLength(1); // Google, but not Maps
    expect(foreignLinks('no links here', OWN)).toEqual([]);
  });
});

describe('deciding on the latest exchange', () => {
  it('the 23 Oct case: refund asked, a person promised, no handover → hand over, customer already told', () => {
    const a = decide([zuma('Tunde is about 5 minutes away.'), customer('oh i want a refund.'), zuma('Got it, Ada. A person from our team will take over from here to help with your refund. Please hang tight.')], OWN);
    expect(a).toEqual([expect.objectContaining({ kind: 'handover', told: true })]);
  });
  it('refund asked and Zuma answered something else → hand over, and the customer must be told', () => {
    const a = decide([customer('I want a refund'), zuma('Refunds take 3 days.')], OWN);
    expect(a).toEqual([expect.objectContaining({ kind: 'handover', told: false })]);
  });
  it('already handed over (Chord line, team reply or hand-back after it) → nothing to do', () => {
    expect(decide([customer('i want a refund'), zuma("I've passed this to our support team."), system('One moment — connecting you with a teammate.')], OWN)).toEqual([]);
    expect(decide([customer('i want a refund'), zuma("I've passed this to our support team."), team('Hi, this is the team. — Zuma Dispatch team'), team('Thanks for your patience. Zuma, our booking assistant, will help you from here.')], OWN)).toEqual([]);
  });
  it('a later, unrelated message is a new exchange', () => {
    expect(decide([customer('i want a refund'), zuma("I've passed this to our support team."), system('One moment'), customer('where is the rider'), zuma('Tunde is 5 minutes away.')], OWN)).toEqual([]);
  });
  it('a made-up link is flagged on its own', () => {
    const a = decide([customer('where is teh rider now'), zuma('Tunde is about 5 minutes away.\n\nTrack live: https://zuma.dispatch/track/ZD-F74B2')], OWN);
    expect(a).toEqual([expect.objectContaining({ kind: 'foreign_link', urls: ['https://zuma.dispatch/track/ZD-F74B2'] })]);
  });
  it('nothing yet: no reply after the customer, or no customer message', () => {
    expect(decide([customer('i want a refund')], OWN)).toEqual([]);
    expect(decide([zuma('Hello')], OWN)).toEqual([]);
    expect(lastExchange([]).customer).toBeNull();
  });
});

describe('runWatchdog against Chord (mocked) and SQLite', () => {
  const T = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const NOW = 10_000_000;
  function chordApi(turns: WatchTurn[], opts: { lastAt?: number; takeOver?: () => Response } = {}) {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input); const m = init?.method ?? 'GET';
      calls.push(`${m} ${url.replace('https://chord.test', '')}`);
      if (url.includes('/v1/threads?')) return Response.json({ threads: [{ id: T, control_state: 'agent_active', last_turn_direction: 'outbound', last_turn_at: opts.lastAt ?? NOW - 60_000 }] });
      if (url.endsWith('/turns?limit=12')) return Response.json({ turns });
      if (url.endsWith('/take-over')) return opts.takeOver ? opts.takeOver() : Response.json({ id: T, control_state: 'human_active' });
      if (url.endsWith('/messages')) return Response.json({ id: 't', delivery_status: 'sent' }, { status: 201 });
      return new Response('{}', { status: 404 });
    });
    return calls;
  }
  const envWith = (env: ReturnType<typeof d1>['env']) => ({ ...env, CHORD_API_KEY: 'chord_live_' + 'x'.repeat(43), CHORD_API_BASE: 'https://chord.test', CHORD_WORKSPACE_ID: 'ws-1', PUBLIC_ORIGIN: 'https://zuma-dispatch.obimz123.workers.dev' }) as never;

  it('hands over once, with our reason, and does not post a second message when Zuma already told them', async () => {
    const { env, db } = d1();
    const calls = chordApi([customer('oh i want a refund.'), zuma('Got it, Ada. A person from our team will take over from here.')]);
    const r = await runWatchdog(envWith(env), NOW);
    expect(r.actions[0]).toMatch(/handed over \(customer already told by Zuma\)/);
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([`POST /v1/threads/${T}/take-over`]);
    const again = await runWatchdog(envWith(env), NOW + 60_000); // the next minute: same reply, nothing repeated
    expect(again.actions).toEqual([]);
    expect((db.prepare("SELECT detail FROM watchdog_events WHERE kind = 'handover'").get() as { detail: string }).detail).toMatch(/taken over/);
  });
  it('tells the customer when Zuma did not', async () => {
    const { env } = d1();
    const calls = chordApi([customer('I want a refund'), zuma('Refunds take 3 days.')]);
    await runWatchdog(envWith(env), NOW);
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([`POST /v1/threads/${T}/take-over`, `POST /v1/threads/${T}/messages`]);
  });
  it("leaves hand_to_team's own take-over alone", async () => {
    const { env, db } = d1();
    db.prepare("INSERT INTO tool_calls (request_id, tool, ok, latency_ms, detail, created_at) VALUES ('r', 'hand_to_team', 1, 5, ?, ?)").run(`hand_to_team:${T}`, NOW - 30_000);
    const calls = chordApi([customer('i want a refund'), zuma("I've passed this to our support team.")]);
    await runWatchdog(envWith(env), NOW);
    expect(calls.some((c) => c.includes('take-over'))).toBe(false);
  });
  it('waits 8 s after the reply (hand_to_team may still be taking over)', async () => {
    const { env } = d1();
    const calls = chordApi([customer('i want a refund'), zuma('A person will take over.')], { lastAt: NOW - 5_000 });
    await runWatchdog(envWith(env), NOW);
    expect(calls.filter((c) => c.includes('/turns'))).toEqual([]);
  });
  it('a person grabbed it first (409): recorded, not retried', async () => {
    const { env } = d1();
    chordApi([customer('i want a refund'), zuma('A person will take over.')], { takeOver: () => Response.json({ error: { message: 'already human_active' } }, { status: 409 }) });
    const r = await runWatchdog(envWith(env), NOW);
    expect(r.actions[0]).toMatch(/already with a person/);
  });
  it('flags a made-up link once, and the board shows it', async () => {
    const { env } = d1();
    chordApi([customer('where is the rider now'), zuma('Track live: https://zuma.dispatch/track/ZD-F74B2')]);
    const r = await runWatchdog(envWith(env), NOW);
    expect(r.actions).toEqual([`${T}: flagged link https://zuma.dispatch/track/ZD-F74B2`]);
    expect((await runWatchdog(envWith(env), NOW + 60_000)).actions).toEqual([]);
    const s = { waiting: 0, chord: 'ok', chordDetail: null, review: 0, ready: 0, out: 0, awaiting: 0, stuck: 0, noticeFailed: 0, sheet: { state: 'ok', detail: null, at: 1 }, tools24h: { calls: 1, errors: 0, faults: 0 }, webhook: true, foreignLinks: { n: 1, thread: T } } as Signals;
    expect(alertsFrom(s)[0]).toMatchObject({ key: 'links', tone: 'urgent', href: `/board/handovers/${T}` });
    expect(tabBadges(s).system.n).toBe(1);
  });
  it('without a Chord key it does nothing', async () => {
    const { env } = d1();
    expect((await runWatchdog(env, NOW)).actions).toEqual(['skipped: CHORD_API_KEY not set']);
  });
});

it('a local server never touches real chats', async () => {
  const { env } = d1();
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (i) => (calls.push(String(i)), Response.json({ threads: [] })));
  const local = { ...env, CHORD_API_KEY: 'chord_live_' + 'x'.repeat(43), CHORD_API_BASE: 'https://chord.test', CHORD_WORKSPACE_ID: 'ws-1', PUBLIC_ORIGIN: 'http://127.0.0.1:8787' } as never;
  expect(await runWatchdog(local, 10_000_000)).toEqual({ checked: 0, actions: ['skipped: local server'] });
  expect(calls).toEqual([]);
});

describe('the reason a dispatcher reads', () => {
  it('plain words: what, which job, their words, and that the server handed it over', () => {
    const turns = [zuma('Payment received: ₦1,950 for ZD-F92SC. Thank you!'), customer('i want a refund'), zuma("I'm passing your refund request for ZD-F92SC to our team now.")];
    expect(reasonFor('i want a refund', turns, true)).toBe('Refund request for ZD-F92SC. Customer said: "i want a refund". Handed over automatically because Zuma didn\'t (the customer was told a person will reply).');
    expect(reasonFor('let me talk to a person', [customer('let me talk to a person')], false)).toBe('Customer asked for a person. Customer said: "let me talk to a person". Handed over automatically because Zuma didn\'t.');
    expect(reasonFor('I want to complain about the rider', [], false)).toMatch(/^Complaint\./);
  });
});

describe('checking every 12 s within a minute', () => {
  const T = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  it('re-reads a chat only when it has a new message, and acts once', async () => {
    const { env } = d1();
    const lastAt = { v: 9_990_000 };
    const turns: WatchTurn[] = [customer('hello')];
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input); calls.push(url.replace('https://chord.test', ''));
      if (url.includes('/v1/threads?')) return Response.json({ threads: [{ id: T, control_state: 'agent_active', last_turn_direction: 'outbound', last_turn_at: lastAt.v }] });
      if (url.endsWith('/turns?limit=12')) return Response.json({ turns });
      if (url.endsWith('/take-over')) return Response.json({ id: T, control_state: 'human_active' });
      return Response.json({ id: 't', delivery_status: 'sent' }, { status: 201 });
    });
    let t = 10_000_000; let round = 0;
    const env2 = { ...env, CHORD_API_KEY: 'chord_live_' + 'x'.repeat(43), CHORD_API_BASE: 'https://chord.test', CHORD_WORKSPACE_ID: 'ws-1', PUBLIC_ORIGIN: 'https://zuma-dispatch.obimz123.workers.dev' } as never;
    const r = await runWatchdogLoop(env2, {
      rounds: 4, everyMs: 12_000, clock: () => t,
      sleep: async (ms) => {
        t += ms; round++;
        if (round === 2) { turns.push(customer('i want a refund'), zuma('Refunds take a few days.')); lastAt.v = t - 9_000; } // new reply arrives
      },
    });
    expect(calls.filter((c) => c.includes('/v1/threads?'))).toHaveLength(4);
    expect(calls.filter((c) => c.endsWith('/turns?limit=12'))).toHaveLength(2); // round 1 (first look) and round 3 (new message)
    expect(calls.filter((c) => c.endsWith('/take-over'))).toHaveLength(1);
    expect(r.actions).toEqual([`${T}: handed over (sent)`]);
  });
  it('stops early on a local server', async () => {
    const { env } = d1();
    let slept = 0;
    const r = await runWatchdogLoop({ ...env, CHORD_API_KEY: 'chord_live_' + 'x'.repeat(43), CHORD_WORKSPACE_ID: 'ws-1', PUBLIC_ORIGIN: 'http://127.0.0.1:8787' } as never, { sleep: async () => { slept++; } });
    expect(r.actions).toEqual(['skipped: local server']);
    expect(slept).toBe(0);
  });
});
