import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config';
import type { ToolContext } from '../src/mcp/tooling';
import { FAILED_RECHECK_MS } from '../src/payments/service';
import { bankReason, createPaymentLink, verifyPayment } from '../src/tools/payments';
import { addJob, d1 } from './helpers/sqliteD1';

afterEach(() => vi.restoreAllMocks());

const T0 = Date.parse('2026-10-22T11:00:00+01:00'); // a Thursday, inside rider hours
const config = { paystackSecretKey: 'sk_test_x', providerTimeoutMs: 4000 } as unknown as Config;

/** Paystack as seen by the server: verify answers from `state`, initialize makes new checkouts. */
function paystack(state: Record<string, { status: string; gateway_response?: string }>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url.replace('https://api.paystack.co', '')}`);
    const verify = /\/transaction\/verify\/(.+)$/.exec(url);
    if (verify) {
      const ref = decodeURIComponent(verify[1]!);
      const s = state[ref];
      if (!s) return Response.json({ status: false, message: 'Transaction reference not found' }, { status: 400 });
      return Response.json({ status: true, data: { id: 1, reference: ref, amount: 300_000, currency: 'NGN', status: s.status, gateway_response: s.gateway_response ?? null, channel: 'card', paid_at: s.status === 'success' ? new Date().toISOString() : null } });
    }
    if (url.endsWith('/transaction/initialize')) {
      const body = JSON.parse(String(init?.body)) as { reference: string };
      state[body.reference] = { status: 'abandoned' };
      return Response.json({ status: true, data: { authorization_url: `https://checkout.paystack.com/${body.reference}`, access_code: 'ac', reference: body.reference } });
    }
    return new Response('{}', { status: 404 });
  });
  return calls;
}

function setup() {
  const { db, env } = d1();
  const job = addJob(db, { booked: T0 - 5 * 60_000, kobo: 300_000 });
  db.prepare(`INSERT INTO payments (reference, job_id, attempt, amount_kobo, status, method, authorization_url, access_code, created_at) VALUES (?, ?, 1, 300000, 'initialized', 'link', ?, 'ac', ?)`)
    .run(`${job}-1`, job, `https://checkout.paystack.com/${job}-1`, T0 - 4 * 60_000);
  let now = T0;
  const ctx: ToolContext = { env, config, db: env.DB, requestId: 'r', now: () => now, waitUntil: () => {}, publicOrigin: 'https://x', trace: [] };
  return { db, job, ctx, advance: (ms: number) => (now += ms) };
}
const status = (db: ReturnType<typeof d1>['db'], id: string) => (db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as { status: string }).status;

describe('a declined card', () => {
  it('says plainly it did not go through, that no money was taken, and offers both ways to pay again', async () => {
    const { db, job, ctx } = setup();
    paystack({ [`${job}-1`]: { status: 'failed', gateway_response: 'Declined' } });
    const r = await verifyPayment({ job_id: job }, ctx);
    expect(r).toMatchObject({ payment_status: 'failed', job_status: 'payment_failed', reason: 'Declined' });
    expect(r['message_for_customer']).toBe(
      `Your ₦3,000 payment for ${job} didn't go through (the bank said: Declined). No money was taken.\n\nWould you like a new payment link to try another card, or bank transfer details instead?`,
    );
    expect(r['what_to_do']).toMatch(/Never say it is paid/);
    expect(status(db, job)).toBe('payment_failed');
  });

  it('a new link after the decline is a fresh checkout, and the job is waiting for payment again', async () => {
    const { db, job, ctx, advance } = setup();
    const calls = paystack({ [`${job}-1`]: { status: 'failed', gateway_response: 'Insufficient Funds' } });
    await verifyPayment({ job_id: job }, ctx);
    advance(11_000);
    const link = await createPaymentLink({ job_id: job }, ctx);
    expect(link).toMatchObject({ reused_existing_link: false, payment_url: `https://checkout.paystack.com/${job}-2` });
    expect(status(db, job)).toBe('awaiting_payment');
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
    const ev = db.prepare(`SELECT from_status, to_status, actor FROM job_events WHERE job_id = ? AND type = 'status_changed' ORDER BY id`).all(job);
    expect(ev).toEqual([
      { from_status: 'awaiting_payment', to_status: 'payment_failed', actor: 'system' },
      { from_status: 'payment_failed', to_status: 'awaiting_payment', actor: 'agent' },
    ]);
  });

  it('then paying the new link confirms it, with the rider and code', async () => {
    const { db, job, ctx, advance } = setup();
    const state: Record<string, { status: string; gateway_response?: string }> = { [`${job}-1`]: { status: 'failed', gateway_response: 'Declined' } };
    paystack(state);
    await verifyPayment({ job_id: job }, ctx);
    advance(11_000);
    await createPaymentLink({ job_id: job }, ctx);
    state[`${job}-2`] = { status: 'success' };
    advance(11_000);
    const r = await verifyPayment({ job_id: job }, ctx);
    expect(r).toMatchObject({ payment_status: 'paid' });
    expect(String(r['message_for_customer'])).toMatch(/^Payment received: ₦3,000/);
    expect(status(db, job)).toBe('paid');
  });

  it('a retry on the same checkout page that succeeds is still caught (the failed attempt is re-checked)', async () => {
    const { db, job, ctx, advance } = setup();
    const state: Record<string, { status: string; gateway_response?: string }> = { [`${job}-1`]: { status: 'failed', gateway_response: 'Declined' } };
    paystack(state);
    expect((await verifyPayment({ job_id: job }, ctx))['payment_status']).toBe('failed');
    state[`${job}-1`] = { status: 'success' }; // the customer tried another card on the same page
    advance(11_000);
    expect((await verifyPayment({ job_id: job }, ctx))['payment_status']).toBe('paid');
    expect(status(db, job)).toBe('paid');
    expect((db.prepare('SELECT rider_id FROM jobs WHERE id = ?').get(job) as { rider_id: string | null }).rider_id).toMatch(/^R-LA/);
  });

  it('asking again within 10 seconds does not call Paystack again, and still says failed (never paid)', async () => {
    const { job, ctx, advance } = setup();
    const calls = paystack({ [`${job}-1`]: { status: 'failed', gateway_response: 'Declined' } });
    await verifyPayment({ job_id: job }, ctx);
    advance(3_000);
    const r = await verifyPayment({ job_id: job }, ctx);
    expect(r['payment_status']).toBe('failed');
    expect(calls.filter((c) => c.includes('/verify/'))).toHaveLength(1);
  });

  it('after a day, a failed attempt is final and not asked about again', async () => {
    const { db, job, ctx } = setup();
    db.prepare(`UPDATE payments SET status = 'failed', gateway_response = 'Declined', created_at = ? WHERE reference = ?`).run(T0 - FAILED_RECHECK_MS - 60_000, `${job}-1`);
    db.prepare(`UPDATE jobs SET status = 'payment_failed' WHERE id = ?`).run(job);
    const calls = paystack({});
    const r = await verifyPayment({ job_id: job }, ctx);
    expect(r['payment_status']).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('when every attempt is used up, it hands the customer to a person instead of offering another link', async () => {
    const { db, job, ctx } = setup();
    // Each new link is made only after the previous one was checked, so earlier attempts are already "failed".
    db.prepare(`UPDATE payments SET status = 'failed', gateway_response = 'Declined' WHERE reference = ?`).run(`${job}-1`);
    for (let a = 2; a <= 5; a++)
      db.prepare(`INSERT INTO payments (reference, job_id, attempt, amount_kobo, status, method, authorization_url, access_code, created_at, gateway_response) VALUES (?, ?, ?, 300000, 'failed', 'link', 'u', 'ac', ?, 'Declined')`).run(`${job}-${a}`, job, a, T0 - 3 * 60_000 + a);
    const state: Record<string, { status: string; gateway_response?: string }> = {};
    for (let a = 1; a <= 5; a++) state[`${job}-${a}`] = { status: 'failed', gateway_response: 'Declined' };
    paystack(state);
    const r = await verifyPayment({ job_id: job }, ctx);
    expect(r['message_for_customer']).toMatch(/I've passed this to our team so they can help you pay another way\.$/);
    expect(r['what_to_do']).toMatch(/hand_to_team/);
    await expect(createPaymentLink({ job_id: job }, ctx)).rejects.toMatchObject({ code: 'TOO_MANY_PAYMENT_ATTEMPTS' });
  });
});

describe('bankReason: what the bank said, only when it is safe to show', () => {
  it('keeps short plain reasons', () => {
    expect(bankReason('Declined')).toBe('Declined');
    expect(bankReason('Insufficient Funds.')).toBe('Insufficient Funds');
    expect(bankReason("Do not honour")).toBe('Do not honour');
  });
  it('drops empty, long, technical or odd-looking ones', () => {
    expect(bankReason(null)).toBeNull();
    expect(bankReason('   ')).toBeNull();
    expect(bankReason('x'.repeat(61))).toBeNull();
    expect(bankReason('Internal error: null pointer')).toBeNull();
    expect(bankReason('<script>alert(1)</script> Declined')).toBe('script alert 1 script Declined');
  });
});
