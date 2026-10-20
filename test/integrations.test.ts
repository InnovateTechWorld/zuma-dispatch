import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config';
import { geocode, SECOND_OPINION_GRACE_MS } from '../src/geocode/chain';
import { GEOCODERS, type Candidate } from '../src/geocode/providers';
import { initializeTransaction, verifyTransaction } from '../src/payments/paystack';
import { bodySignature, chordWebhook } from '../src/web/chordWebhook';
import { fakeD1 } from './fakes';

const config = {
  paystackSecretKey: 'sk_test_x',
  providerTimeoutMs: 4000,
  geocoderChain: ['nominatim', 'photon', 'ors'],
  geocoderMode: 'crosscheck',
  orsApiKey: 'k',
  googleMapsApiKey: null,
} as unknown as Config;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ------------------------------------------------------------------ Chord webhook receiver
describe('Chord webhook signature (docs: Webhooks -> Verify a body signature)', () => {
  const secret = 'whsec_a_long_random_string';
  const body = '{"id":"9f1c2f7e-4a1b-4d21-9a45-1f0e6bb0c111","type":"chat.completed","timestamp":1800000000000,"data":{"session_id":"sess_42","teammate_id":"tm_support"}}';
  const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

  it("matches Chord's published test vector", async () => {
    expect(await bodySignature(secret, enc(body))).toBe('sha256=3e77061fd99ee2f98a54f25aaa298098ffdaf55f8706ace0a24c52dde9bdfcb8');
  });

  const post = (headers: Record<string, string>, payload = body) =>
    new Request('https://x/hooks/chord', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: payload });

  it('rejects a missing or wrong signature, and the timestamped scheme', async () => {
    const db = fakeD1();
    expect((await chordWebhook(post({}), db, secret, 'r')).status).toBe(401);
    expect((await chordWebhook(post({ 'X-Chord-Signature': 'sha256=00' }), db, secret, 'r')).status).toBe(401);
    expect((await chordWebhook(post({ 'X-Chord-Timestamp': '1', 'X-Chord-Signature': 'sha256=00' }), db, secret, 'r')).status).toBe(400);
    expect((await chordWebhook(post({}), db, null, 'r')).status).toBe(503);
  });

  it('accepts a valid delivery once and treats a retry as a duplicate', async () => {
    const db = fakeD1();
    const sig = await bodySignature(secret, enc(body));
    const h = { 'X-Chord-Signature': sig, 'X-Chord-Delivery-Id': 'del-1' };
    expect((await chordWebhook(post(h), db, secret, 'r')).status).toBe(204);
    expect((await chordWebhook(post(h), db, secret, 'r')).status).toBe(204); // retry: still 2xx, no second row
    const inserts = db.statements.filter((s) => s.sql.startsWith('INSERT INTO chord_events'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.args[0]).toBe('del-1');
  });

  it('rejects a body that was changed after signing', async () => {
    const sig = await bodySignature(secret, enc(body));
    const tampered = body.replace('sess_42', 'sess_43');
    expect((await chordWebhook(post({ 'X-Chord-Signature': sig }, tampered), fakeD1(), secret, 'r')).status).toBe(401);
  });
});

// ------------------------------------------------------------------ Paystack client
describe('Paystack client failure handling', () => {
  const input = { email: 'zd-x@example.com', amountKobo: 195000, reference: 'ZD-AAAAA-1', callbackUrl: 'https://x/pay/return', metadata: {} };
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status, headers }));

  it('reports a timeout as a value, not an exception (caller retries with the same reference)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    expect(await initializeTransaction(input, config, [])).toEqual({ kind: 'timeout' });
  });

  it('recognises "Duplicate Transaction Reference"', async () => {
    reply(400, { status: false, message: 'Duplicate Transaction Reference', code: 'duplicate_reference' });
    expect(await initializeTransaction(input, config, [])).toEqual({ kind: 'duplicate_reference' });
  });

  it('turns 429 into an agent-readable "busy, do not loop" error', async () => {
    reply(429, { status: false }, { 'x-ratelimit-reset': '12' });
    await expect(verifyTransaction('ZD-AAAAA-1', config, [])).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_BUSY', retryable: true });
  });

  it('treats an unknown reference as not found, and 5xx as unavailable', async () => {
    reply(400, { status: false, message: 'Transaction reference not found' });
    expect(await verifyTransaction('ZD-AAAAA-9', config, [])).toEqual({ kind: 'not_found' });
    reply(502, 'bad gateway');
    await expect(verifyTransaction('ZD-AAAAA-1', config, [])).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' });
  });
});

// ------------------------------------------------------------------ geocoder chain timing
describe('geocoder cross-check timing', () => {
  const at = (lat: number, lng: number, provider: Candidate['provider']): Candidate => ({ label: provider, lat, lng, precision: 'exact', provider });
  const ok = (name: Exclude<Candidate['provider'], 'nipost'>, candidates: Candidate[], delayMs = 0) =>
    vi.spyOn(GEOCODERS[name], 'search').mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ provider: name, outcome: 'ok', candidates, trace: `${name}:ok` }), delayMs)),
    );

  it('answers from the first provider when the second is late, and finishes the late one in the background', async () => {
    vi.useFakeTimers();
    ok('nominatim', [at(9.0685, 7.4659, 'nominatim')], 300);
    ok('photon', [at(9.0686, 7.4658, 'photon')], 4000);
    const background: Promise<unknown>[] = [];
    const run = geocode('Wuse Market', config, fakeD1(), Date.now(), [], (p) => background.push(p));
    await vi.advanceTimersByTimeAsync(300 + SECOND_OPINION_GRACE_MS + 10);
    const out = await run;
    expect(out).toMatchObject({ confidence: 'medium', ambiguous: false });
    expect(background).toHaveLength(1);
  });

  it('two agreeing answers in time -> high confidence; disagreeing -> ambiguous', async () => {
    ok('nominatim', [at(9.0685, 7.4659, 'nominatim')]);
    ok('photon', [at(9.0686, 7.4658, 'photon')]);
    expect((await geocode('a', config, fakeD1(), Date.now(), [])).confidence).toBe('high');
    vi.restoreAllMocks();
    ok('nominatim', [at(8.98, 7.37, 'nominatim')]);
    ok('photon', [at(9.0755, 7.425, 'photon')]);
    expect((await geocode('b', config, fakeD1(), Date.now(), [])).ambiguous).toBe(true);
  });

  it('both empty -> asks the next provider; everything erroring -> allFailed', async () => {
    ok('nominatim', []);
    ok('photon', []);
    const ors = ok('ors', [at(9.07, 7.42, 'ors')]);
    expect((await geocode('c', config, fakeD1(), Date.now(), [])).candidates).toHaveLength(1);
    expect(ors).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
    for (const n of ['nominatim', 'photon', 'ors'] as const) {
      vi.spyOn(GEOCODERS[n], 'search').mockResolvedValue({ provider: n, outcome: 'error', candidates: [], trace: `${n}:timeout` });
    }
    expect((await geocode('d', config, fakeD1(), Date.now(), [])).allFailed).toBe(true);
  });
});

// ------------------------------------------------------------------ Paystack webhook receiver
describe('Paystack webhook', async () => {
  const { createHmac } = await import('node:crypto');
  const { paystackSignature, paystackWebhook, eventReference } = await import('../src/web/paystackWebhook');
  const key = 'sk_test_example';
  const body = JSON.stringify({ event: 'charge.success', data: { id: 1, reference: 'ZD-AAAAA-1', amount: 195000, currency: 'NGN' } });
  const env = (db = fakeD1()) => ({ DB: db }) as never;
  const exec = { waitUntil: () => {} } as unknown as ExecutionContext;
  const cfg = { ...config, paystackSecretKey: key } as Config;
  const post = (headers: Record<string, string>, payload = body) =>
    new Request('https://x/hooks/paystack', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: payload });

  it('signature is HMAC-SHA512 of the raw body (checked against an independent implementation)', async () => {
    const expected = createHmac('sha512', key).update(body).digest('hex');
    expect(await paystackSignature(key, new TextEncoder().encode(body).buffer as ArrayBuffer)).toBe(expected);
  });

  it('rejects a missing, wrong or tampered signature', async () => {
    const good = createHmac('sha512', key).update(body).digest('hex');
    expect((await paystackWebhook(post({}), env(), cfg, exec, 'r')).status).toBe(401);
    expect((await paystackWebhook(post({ 'x-paystack-signature': 'ab' }), env(), cfg, exec, 'r')).status).toBe(401);
    expect((await paystackWebhook(post({ 'x-paystack-signature': good }, body.replace('195000', '1')), env(), cfg, exec, 'r')).status).toBe(401);
  });

  it('acknowledges events for references that are not ours, and event types we do not handle', async () => {
    const sign = (b: string) => createHmac('sha512', key).update(b).digest('hex');
    expect((await paystackWebhook(post({ 'x-paystack-signature': sign(body) }), env(), cfg, exec, 'r')).status).toBe(200);
    const other = JSON.stringify({ event: 'transfer.success', data: { reference: 'x' } });
    expect((await paystackWebhook(post({ 'x-paystack-signature': sign(other) }, other), env(), cfg, exec, 'r')).status).toBe(200);
  });

  it('finds the reference for charge, refund and dispute event shapes', () => {
    expect(eventReference({ data: { reference: 'ZD-AAAAA-1' } })).toBe('ZD-AAAAA-1');
    expect(eventReference({ data: { transaction_reference: 'ZD-AAAAA-2' } })).toBe('ZD-AAAAA-2');
    expect(eventReference({ data: { transaction: { reference: 'ZD-AAAAA-3' } } })).toBe('ZD-AAAAA-3');
    expect(eventReference({ data: { reference: "'; DROP TABLE x" } })).toBeNull();
  });
});
