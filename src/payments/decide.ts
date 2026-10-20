import type { VerifyData } from './paystack';

/**
 * Decides what a Paystack verify response means for one payment attempt.
 * Pure function so every branch is unit-tested (test/decide.test.ts).
 *
 * Paystack's top-level `status: true` only means the API call worked. The transaction
 * is paid only when data.status is "success" AND the amount, currency and reference
 * all match what we asked for. Anything else is not paid.
 */
export type AttemptVerdict =
  | { kind: 'paid' }
  | { kind: 'mismatch'; reason: string }
  | { kind: 'in_progress' }
  | { kind: 'not_paid_yet' }
  | { kind: 'failed'; reason: string }
  | { kind: 'reversed' }
  | { kind: 'unknown'; status: string };

export interface Expected {
  reference: string;
  amountKobo: number;
  currency: 'NGN';
}

export function decideAttempt(data: VerifyData, expected: Expected): AttemptVerdict {
  switch (data.status) {
    case 'success': {
      const problems: string[] = [];
      if (data.reference !== expected.reference) problems.push(`reference ${data.reference} != ${expected.reference}`);
      if (data.amount !== expected.amountKobo) problems.push(`amount ${data.amount} kobo != ${expected.amountKobo} kobo`);
      if ((data.currency ?? '').toUpperCase() !== expected.currency) problems.push(`currency ${data.currency} != ${expected.currency}`);
      return problems.length === 0 ? { kind: 'paid' } : { kind: 'mismatch', reason: problems.join('; ') };
    }
    case 'ongoing':
    case 'pending':
    case 'processing':
    case 'queued':
      return { kind: 'in_progress' };
    case 'abandoned':
      // Paystack reports a freshly created, unpaid checkout as "abandoned"; the link still works.
      return { kind: 'not_paid_yet' };
    case 'failed':
      return { kind: 'failed', reason: data.gateway_response || 'declined' };
    case 'reversed':
      return { kind: 'reversed' };
    default:
      return { kind: 'unknown', status: String(data.status) };
  }
}

/** Combines several attempts (newest first) into one answer for the job. */
export function combine(verdicts: AttemptVerdict[]): AttemptVerdict['kind'] | 'none' {
  if (verdicts.length === 0) return 'none';
  const order: AttemptVerdict['kind'][] = ['mismatch', 'reversed', 'paid', 'in_progress', 'not_paid_yet', 'failed', 'unknown'];
  // A mismatch or reversal anywhere needs a human even if another attempt succeeded;
  // after that, any success wins; otherwise the most hopeful state.
  for (const k of order) if (verdicts.some((v) => v.kind === k)) return k;
  return 'unknown';
}
