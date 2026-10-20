import { describe, expect, it } from 'vitest';
import { combine, decideAttempt } from '../src/payments/decide';

const expected = { reference: 'ZD-7K3QP-1', amountKobo: 345_000, currency: 'NGN' as const };
const ok = { status: 'success', amount: 345_000, currency: 'NGN', reference: 'ZD-7K3QP-1' };

describe('decideAttempt', () => {
  it('pays only when status, amount, currency and reference all match', () => {
    expect(decideAttempt(ok, expected)).toEqual({ kind: 'paid' });
  });

  it('flags a successful payment with the wrong amount (mocked; hard to trigger for real)', () => {
    const v = decideAttempt({ ...ok, amount: 100_000 }, expected);
    expect(v.kind).toBe('mismatch');
    expect(v.kind === 'mismatch' && v.reason).toContain('amount 100000 kobo != 345000 kobo');
  });

  it('flags wrong currency and wrong reference', () => {
    expect(decideAttempt({ ...ok, currency: 'USD' }, expected).kind).toBe('mismatch');
    expect(decideAttempt({ ...ok, reference: 'ZD-OTHER-1' }, expected).kind).toBe('mismatch');
  });

  it('accepts lower-case currency from the API', () => {
    expect(decideAttempt({ ...ok, currency: 'ngn' }, expected)).toEqual({ kind: 'paid' });
  });

  it('treats abandoned (Paystack status of a fresh unpaid checkout) as not paid yet', () => {
    expect(decideAttempt({ ...ok, status: 'abandoned' }, expected)).toEqual({ kind: 'not_paid_yet' });
  });

  it.each(['ongoing', 'pending', 'processing', 'queued'])('treats %s as in progress', (status) => {
    expect(decideAttempt({ ...ok, status }, expected)).toEqual({ kind: 'in_progress' });
  });

  it('reports failure reason and reversal', () => {
    expect(decideAttempt({ ...ok, status: 'failed', gateway_response: 'Declined' }, expected)).toEqual({ kind: 'failed', reason: 'Declined' });
    expect(decideAttempt({ ...ok, status: 'reversed' }, expected)).toEqual({ kind: 'reversed' });
  });

  it('never treats an unknown status as paid', () => {
    expect(decideAttempt({ ...ok, status: 'weird' }, expected).kind).toBe('unknown');
  });
});

describe('combine', () => {
  it('prefers a success over older abandoned attempts', () => {
    expect(combine([{ kind: 'not_paid_yet' }, { kind: 'paid' }])).toBe('paid');
  });
  it('escalates a mismatch even if another attempt succeeded', () => {
    expect(combine([{ kind: 'paid' }, { kind: 'mismatch', reason: 'x' }])).toBe('mismatch');
  });
  it('in progress beats not paid yet; empty is none', () => {
    expect(combine([{ kind: 'not_paid_yet' }, { kind: 'in_progress' }])).toBe('in_progress');
    expect(combine([])).toBe('none');
  });
  it('a later failure does not hide an earlier pending attempt', () => {
    expect(combine([{ kind: 'failed', reason: 'x' }, { kind: 'in_progress' }])).toBe('in_progress');
  });
});
