import { eventStmt, getJob, listPayments, transitionJob, type JobRow, type PaymentRow, type PaymentStatus } from '../db/repo';
import { log } from '../lib/log';
import type { ToolContext } from '../mcp/tooling';
import { combine, decideAttempt, type AttemptVerdict } from './decide';
import { verifyTransaction } from './paystack';

/** Don't ask Paystack about the same reference more than once per this interval (rate limits; no polling loops). */
export const RECHECK_INTERVAL_MS = 10_000;
/** How many recent attempts are re-verified per check. Older open ones are still re-verified when the job is cancelled. */
const MAX_ATTEMPTS_CHECKED = 3;

const FINAL: PaymentStatus[] = ['success', 'failed', 'reversed', 'mismatch', 'not_found'];
const WAITING: PaymentStatus[] = ['initialized', 'ongoing', 'pending', 'processing', 'queued'];
/** A transfer sent just before its account expires can still confirm a little later. */
export const TRANSFER_GRACE_MS = 15 * 60_000;

/** A bank-transfer attempt whose account is still open and no money has arrived yet. */
export function isAwaitingTransfer(p: PaymentRow, now: number): boolean {
  return p.method === 'bank_transfer' && WAITING.includes(p.status) && p.transfer_expires_at !== null && now < p.transfer_expires_at;
}

/** An expired transfer account that never received money counts as "not paid", not "in progress". */
function expiredTransfer(p: PaymentRow, v: AttemptVerdict, now: number): AttemptVerdict {
  if (v.kind === 'in_progress' && p.method === 'bank_transfer' && p.transfer_expires_at !== null && now > p.transfer_expires_at + TRANSFER_GRACE_MS) {
    return { kind: 'not_paid_yet' };
  }
  return v;
}

function storedVerdict(p: PaymentRow): AttemptVerdict | null {
  switch (p.status) {
    case 'success': return { kind: 'paid' };
    case 'mismatch': return { kind: 'mismatch', reason: p.gateway_response ?? 'mismatch' };
    case 'reversed': return { kind: 'reversed' };
    case 'failed': return { kind: 'failed', reason: p.gateway_response ?? 'failed' };
    case 'ongoing': case 'pending': case 'processing': case 'queued': return { kind: 'in_progress' };
    case 'initialized': case 'abandoned': return { kind: 'not_paid_yet' };
    default: return null; // initializing / not_found: no opinion
  }
}

function verdictToStatus(v: AttemptVerdict, paystackStatus: string): PaymentStatus {
  if (v.kind === 'paid') return 'success';
  if (v.kind === 'mismatch') return 'mismatch';
  const known: PaymentStatus[] = ['failed', 'abandoned', 'ongoing', 'pending', 'processing', 'queued', 'reversed'];
  return known.includes(paystackStatus as PaymentStatus) ? (paystackStatus as PaymentStatus) : 'initialized';
}

export interface PaymentCheck {
  outcome: ReturnType<typeof combine>;
  job: JobRow;
  payments: PaymentRow[];
  paidAttempts: number;
  /** Needs a human: amount/currency/reference mismatch, reversal, double payment, or paid after cancellation. */
  needsReview: string | null;
  /** Answer came from stored state because Paystack was asked very recently. */
  throttled: boolean;
}

/**
 * Re-verifies a job's open payment attempts with Paystack and applies the result to the
 * job with compare-and-set transitions, so concurrent checks (agent + return page) are safe.
 */
export interface CheckOptions {
  /** Re-verify every open attempt, not just the most recent few (cancel, cancelled jobs, webhooks). */
  allOpen?: boolean;
  /** Ignore the 10 s re-check throttle (a webhook says something just changed). */
  force?: boolean;
  /** Recorded on the job's audit trail: who triggered this check. */
  via?: 'verify' | 'paystack_webhook' | 'return_page' | 'link_request' | 'cancel';
}

export async function checkPayments(ctx: ToolContext, job: JobRow, opts: CheckOptions = {}): Promise<PaymentCheck> {
  const now = ctx.now();
  const payments = await listPayments(ctx.db, job.id);
  const verdicts: AttemptVerdict[] = [];
  let throttled = false;

  for (const [i, p] of payments.entries()) {
    const open = !FINAL.includes(p.status);
    const recent = !opts.force && p.last_checked_at !== null && now - p.last_checked_at < RECHECK_INTERVAL_MS;
    if (!open || (!opts.allOpen && i >= MAX_ATTEMPTS_CHECKED) || recent) {
      if (open && recent) throttled = true;
      const v = storedVerdict(p);
      if (v) verdicts.push(expiredTransfer(p, v, now));
      continue;
    }
    const result = await verifyTransaction(p.reference, ctx.config, ctx.trace);
    if (result.kind === 'not_found') {
      // Never created at Paystack (e.g. initialize timed out before reaching them).
      const status: PaymentStatus = p.status === 'initializing' ? 'not_found' : p.status;
      await ctx.db.prepare('UPDATE payments SET status = ?, last_checked_at = ? WHERE reference = ?').bind(status, now, p.reference).run();
      p.status = status;
      continue;
    }
    const v = decideAttempt(result.data, { reference: p.reference, amountKobo: p.amount_kobo, currency: 'NGN' });
    const status = verdictToStatus(v, result.data.status);
    const paidAt = v.kind === 'paid' ? (Date.parse(result.data.paid_at ?? '') || now) : null;
    await ctx.db
      .prepare(
        'UPDATE payments SET status = ?, gateway_response = ?, paystack_id = ?, channel = ?, last_checked_at = ?, paid_at = COALESCE(paid_at, ?) WHERE reference = ?',
      )
      .bind(
        status,
        v.kind === 'mismatch' ? v.reason : (result.data.gateway_response ?? null),
        result.data.id ?? null,
        result.data.channel ?? null,
        now,
        paidAt,
        p.reference,
      )
      .run();
    if (status !== p.status) {
      await eventStmt(ctx.db, { jobId: job.id, type: 'payment_checked', from: p.status, to: status, actor: 'system', detail: { reference: p.reference }, at: now }).run();
    }
    p.status = status;
    verdicts.push(expiredTransfer(p, v, now));
  }

  const outcome = combine(verdicts);
  const paidAttempts = payments.filter((p) => p.status === 'success').length;
  let needsReview: string | null = null;

  if (outcome === 'paid') {
    const won = await transitionJob(ctx.db, job.id, ['awaiting_payment', 'payment_failed'], 'paid', 'system', now, { via: opts.via ?? 'verify' }, ', paid_at = ?', [now]);
    if (won) log('info', 'job_paid', { job_id: job.id, request_id: ctx.requestId, via: opts.via ?? 'verify' });
    if (job.status === 'cancelled') needsReview = 'The customer paid for a job that had been cancelled. A refund or reinstatement is needed.';
    if (paidAttempts > 1) needsReview = `The customer paid ${paidAttempts} times for this job. One payment needs refunding.`;
  } else if (outcome === 'mismatch') {
    await transitionJob(ctx.db, job.id, ['awaiting_payment', 'payment_failed'], 'amount_mismatch', 'system', now, { via: opts.via ?? 'verify' });
    needsReview = 'Paystack reports a payment whose amount, currency or reference does not match the job. Do not dispatch.';
  } else if (outcome === 'reversed') {
    needsReview = 'A payment for this job was reversed (refund or chargeback).';
  } else if (outcome === 'failed') {
    await transitionJob(ctx.db, job.id, ['awaiting_payment'], 'payment_failed', 'system', now, { via: opts.via ?? 'verify' });
  }

  if (needsReview) {
    // Several checks (agent, return page, retries) can see the same problem: record it once.
    const detail = JSON.stringify({ reason: needsReview });
    const res = await ctx.db
      .prepare(
        "INSERT INTO job_events (job_id, type, actor, detail_json, created_at) SELECT ?, 'needs_review', 'system', ?, ? " +
          "WHERE NOT EXISTS (SELECT 1 FROM job_events WHERE job_id = ? AND type = 'needs_review' AND detail_json = ?)",
      )
      .bind(job.id, detail, now, job.id, detail)
      .run();
    if (res.meta.changes === 1) log('warn', 'payment_needs_review', { job_id: job.id, request_id: ctx.requestId, outcome });
  }

  const fresh = (await getJob(ctx.db, job.id)) ?? job;
  return { outcome, job: fresh, payments, paidAttempts, needsReview, throttled };
}
