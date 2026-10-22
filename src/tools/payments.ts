import { pickupWindow, watTime } from '../business/profile';
import { eventStmt, getJob, getPayment, listPayments, transitionJob, type JobRow, type PaymentRow } from '../db/repo';
import { paymentReference } from '../lib/ids';
import { log } from '../lib/log';
import { formatNaira } from '../lib/money';
import { afterPaymentTiming, linkMessage, paidFollowUp, paymentReceivedMessage, transferMessage } from '../business/messages';
import { noteAgentConfirmed } from '../chord/notices';
import { assignRider, riderView } from '../business/riders';
import { ToolError, type ToolContext } from '../mcp/tooling';
import { chargeBankTransfer, initializeTransaction } from '../payments/paystack';
import { checkPayments, isAwaitingTransfer, type PaymentCheck } from '../payments/service';
import { loadJob } from './jobs';
import { queueSheetSync } from '../sheets/queue';

export type PaymentMethod = 'link' | 'bank_transfer';

/** We hand out a checkout link for this long before issuing a fresh one. */
export const LINK_TTL_MS = 60 * 60_000;
/** Paystack keeps a transfer account open for this long. */
export const TRANSFER_TTL_MS = 30 * 60_000;
/** Don't hand out transfer details that expire sooner than this; the customer needs time to send. */
const TRANSFER_MIN_REMAINING_MS = 8 * 60_000;
/** More attempts than this means something is wrong; a person should look. */
const MAX_ATTEMPTS = 5;

const LINK_REUSABLE: PaymentRow['status'][] = ['initialized', 'abandoned'];
const IN_PROGRESS: PaymentRow['status'][] = ['ongoing', 'pending', 'processing', 'queued'];

function blockedForPayment(job: JobRow): ToolError | null {
  switch (job.status) {
    case 'paid':
    case 'dispatched':
    case 'delivered':
      return new ToolError('ALREADY_PAID', `Job ${job.id} is already paid (${job.status}).`, 'Tell the customer it is paid. Do not send another link or account.');
    case 'cancelled':
      return new ToolError('JOB_CANCELLED', `Job ${job.id} was cancelled.`, 'Do not send payment details. If the customer still wants the delivery, quote and book again.');
    case 'amount_mismatch':
      return new ToolError('NEEDS_REVIEW', `Job ${job.id} has a payment under review.`, 'Do not send payment details. Tell the customer a dispatcher is checking the payment and hand the conversation to a human.');
    default:
      return null;
  }
}

// ------------------------------------------------------------------ create_payment_link
export async function createPaymentLink(args: { job_id: string; method?: PaymentMethod | undefined }, ctx: ToolContext): Promise<Record<string, unknown>> {
  const method: PaymentMethod = args.method ?? 'link';
  let job = await loadJob(ctx, args.job_id);
  const blocked = blockedForPayment(job);
  if (blocked) throw blocked;

  // The customer may already have paid an earlier link or transfer (double tap, or paid without saying).
  const check = await checkPayments(ctx, job, { via: 'link_request' });
  job = check.job;
  const afterCheck = blockedForPayment(job);
  if (afterCheck) throw afterCheck;

  const now = ctx.now();
  const same = check.payments.filter((p) => p.method === method && p.amount_kobo === job.amount_kobo);

  if (method === 'link') {
    const latest = same[0];
    if (latest?.authorization_url && IN_PROGRESS.includes(latest.status)) {
      return {
        ...linkView(job, latest, now, true),
        what_to_do: 'A card payment on this link is mid-way (OTP or bank step). Ask the customer to finish it rather than start again, then call verify_payment.',
      };
    }
    if (latest?.authorization_url && LINK_REUSABLE.includes(latest.status) && now - latest.created_at < LINK_TTL_MS) {
      return linkView(job, latest, now, true);
    }
  } else {
    const open = same.find((p) => isAwaitingTransfer(p, now) && (p.transfer_expires_at ?? 0) - now > TRANSFER_MIN_REMAINING_MS);
    if (open) return transferView(job, open, now, true);
  }

  const attempts = await listPayments(ctx.db, job.id);
  const nextAttempt = (attempts[0]?.attempt ?? 0) + 1;
  if (nextAttempt > MAX_ATTEMPTS) {
    throw new ToolError(
      'TOO_MANY_PAYMENT_ATTEMPTS',
      `Job ${job.id} already has ${MAX_ATTEMPTS} payment attempts.`,
      'Do not create more. Hand the conversation to a human dispatcher to sort out payment.',
    );
  }
  const payment = await newAttempt(ctx, job, nextAttempt, now, method);
  // After a declined card, new details mean the job is waiting for payment again, not "failed":
  // the board, Home's totals and get_job_status should say so.
  if (job.status === 'payment_failed') {
    await transitionJob(ctx.db, job.id, ['payment_failed'], 'awaiting_payment', 'agent', now, { via: 'new_payment_details', reference: payment.reference });
  }
  queueSheetSync(ctx.env, ctx.waitUntil, ctx.publicOrigin, job.id);
  const view = method === 'link' ? linkView(job, payment, now, false) : transferView(job, payment, now, false);

  // The other method may still be open (e.g. they asked for a link, then for transfer details).
  const otherOpen = check.payments.some((p) =>
    p.method === 'link' ? p.method !== method && LINK_REUSABLE.includes(p.status) && now - p.created_at < LINK_TTL_MS : p.method !== method && isAwaitingTransfer(p, now),
  );
  if (otherOpen) {
    view['what_to_do'] = `${String(view['what_to_do'])} Also tell them to pay only ONE way (these details or the earlier ${method === 'link' ? 'bank transfer' : 'link'}), not both.`;
  }
  return view;
}

/**
 * Records the attempt BEFORE calling Paystack, so a call that times out can still be verified
 * later by its reference. On timeout we retry once with the same reference; "duplicate
 * reference" then means the first call reached Paystack but we never got the answer, so we move
 * to the next attempt number (the orphan is still verified by reference later).
 */
async function newAttempt(ctx: ToolContext, job: JobRow, attempt: number, now: number, method: PaymentMethod, depth = 0): Promise<PaymentRow> {
  const reference = paymentReference(job.id, attempt);
  try {
    await ctx.db
      .prepare('INSERT INTO payments (reference, job_id, attempt, amount_kobo, currency, status, method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(reference, job.id, attempt, job.amount_kobo, 'NGN', 'initializing', method, now)
      .run();
  } catch {
    // UNIQUE(job_id, attempt): a concurrent call (double tap) is creating this attempt right now.
    throw new ToolError(
      'LINK_BEING_CREATED',
      'Payment details for this job are being created by another request.',
      'Wait a few seconds and call create_payment_link again; it will return the same details.',
      true,
    );
  }

  const base = {
    email: `${job.id.toLowerCase()}@example.com`, // placeholder: WhatsApp customers rarely give an email, and we never send their phone to Paystack
    amountKobo: job.amount_kobo,
    reference,
    metadata: {
      job_id: job.id,
      quote_id: job.quote_id,
      method,
      cancel_action: `${ctx.publicOrigin}/pay/return?reference=${encodeURIComponent(reference)}&cancelled=1`,
      custom_fields: [
        { display_name: 'Job', variable_name: 'job_id', value: job.id },
        { display_name: 'Quote', variable_name: 'quote_id', value: job.quote_id },
      ],
    },
  };

  let outcome: 'created' | 'duplicate_reference' | 'timeout';
  if (method === 'link') {
    const input = { ...base, callbackUrl: `${ctx.publicOrigin}/pay/return` };
    let r = await initializeTransaction(input, ctx.config, ctx.trace);
    if (r.kind === 'timeout') r = await initializeTransaction(input, ctx.config, ctx.trace);
    outcome = r.kind;
    if (r.kind === 'created') {
      await ctx.db
        .prepare('UPDATE payments SET status = ?, authorization_url = ?, access_code = ? WHERE reference = ?')
        .bind('initialized', r.authorizationUrl, r.accessCode, reference)
        .run();
    }
  } else {
    const input = { ...base, expiresAt: now + TRANSFER_TTL_MS };
    let r = await chargeBankTransfer(input, ctx.config, ctx.trace);
    if (r.kind === 'timeout') r = await chargeBankTransfer(input, ctx.config, ctx.trace);
    outcome = r.kind;
    if (r.kind === 'created') {
      await ctx.db
        .prepare(
          'UPDATE payments SET status = ?, transfer_bank = ?, transfer_account_number = ?, transfer_account_name = ?, transfer_expires_at = ? WHERE reference = ?',
        )
        .bind('ongoing', r.bankName, r.accountNumber, r.accountName, r.expiresAt, reference)
        .run();
    }
  }

  if (outcome === 'created') {
    await eventStmt(ctx.db, { jobId: job.id, type: method === 'link' ? 'payment_link' : 'bank_transfer_details', actor: 'agent', detail: { reference, attempt }, at: now }).run();
    return (await getPayment(ctx.db, reference))!;
  }
  if (outcome === 'duplicate_reference' && depth === 0) {
    await ctx.db.prepare('UPDATE payments SET status = ? WHERE reference = ?').bind('initialized', reference).run();
    log('warn', 'paystack_duplicate_reference_recovered', { reference, request_id: ctx.requestId });
    return newAttempt(ctx, job, attempt + 1, now, method, depth + 1);
  }
  // Still timing out after a retry. Leave the row as 'initializing' so a later verify can find it.
  throw new ToolError(
    'PAYMENT_PROVIDER_UNAVAILABLE',
    'Paystack did not answer in time.',
    'Apologise and try create_payment_link once more in a moment. If it fails again, hand the conversation to a human dispatcher.',
    true,
  );
}

function linkView(job: JobRow, p: PaymentRow, now: number, reused: boolean): Record<string, unknown> {
  return {
    job_id: job.id,
    method: 'link',
    payment_url: p.authorization_url,
    reference: p.reference,
    amount: formatNaira(p.amount_kobo),
    valid_for_minutes: Math.max(1, Math.round((p.created_at + LINK_TTL_MS - now) / 60000)),
    reused_existing_link: reused,
    test_mode: true,
    message_for_customer: linkMessage(p.amount_kobo, p.authorization_url ?? ''),
    what_to_do: 'Send message_for_customer as it is (the link must stay on its own line). When they reply "paid", call verify_payment.' + (reused ? ' It is the same link as before.' : ''),
  };
}

export function transferView(job: JobRow, p: PaymentRow, now: number, reused: boolean): Record<string, unknown> {
  const expires = p.transfer_expires_at ?? now;
  return {
    job_id: job.id,
    method: 'bank_transfer',
    bank: p.transfer_bank,
    account_number: p.transfer_account_number,
    account_name: p.transfer_account_name,
    amount_exact: formatNaira(p.amount_kobo),
    expires_at_wat: watTime(expires),
    minutes_left: Math.max(0, Math.round((expires - now) / 60000)),
    reference: p.reference,
    reused_existing_details: reused,
    test_mode: true,
    message_for_customer: transferMessage({ amount_kobo: p.amount_kobo, bank: p.transfer_bank ?? '', account_number: p.transfer_account_number ?? '', account_name: p.transfer_account_name ?? '', expires: watTime(expires) }),
    what_to_do: 'Send message_for_customer as it is. Never leave out the bank, account number, account name or exact amount. When they reply "sent", call verify_payment.',
  };
}

/** Pickup timing worded for after payment (the quote-time wording says "as soon as payment is confirmed"). */
// ------------------------------------------------------------------ verify_payment
/** In a live test the model replied only "Your delivery is paid and booked", dropping the rider and the code. */
const PAID_TODO = 'It is paid. Do not call any more tools after this one. Reply with message_for_customer word for word as your whole reply, even if an earlier message in the chat seems to say the same: it has the payment confirmation, the rider and the handover code the customer needs. Do not shorten it, skip it or replace it with your own summary. Then answer anything else they asked.';
/**
 * Paystack's gateway_response for a decline ("Declined", "Insufficient Funds") is useful to the
 * customer; anything long, technical or odd-looking is left out rather than shown.
 */
export function bankReason(raw: string | null): string | null {
  const text = (raw ?? '').replace(/[^\p{L}\p{N} .,'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 60 || /\b(error|exception|null|undefined)\b/i.test(text)) return null;
  return text.replace(/\.$/, '');
}

export async function verifyPayment(args: { job_id: string }, ctx: ToolContext): Promise<Record<string, unknown>> {
  let job = await loadJob(ctx, args.job_id);
  // Already paid by our records (webhook, return page, an earlier check, or a dispatcher's approval):
  // never re-ask Paystack and risk "no link, send one" or "under review" to a customer who has paid.
  // A second payment for the same job is still caught by the Paystack webhook.
  if (job.status === 'paid' || job.status === 'dispatched' || job.status === 'delivered') {
    if (!job.rider_id && job.status === 'paid') {
      await assignRider(ctx.db, job.id, ctx.now()); // jobs paid before riders existed
      job = (await getJob(ctx.db, job.id)) ?? job;
    }
    return {
      job_id: job.id, payment_status: 'paid', job_status: job.status, amount: formatNaira(job.amount_kobo),
      pickup_timing: job.status === 'paid' ? afterPaymentTiming(ctx.now(), Boolean(job.rider_id)) : job.status === 'dispatched' ? 'A rider already has the package.' : 'The package has been delivered.',
      handover_code: job.handover_code,
      rider: riderView(job.rider_id),
      message_for_customer: (await noteAgentConfirmed(ctx.db, job.id, ctx.now())) === 'customer_already_told' ? paidFollowUp(job, ctx.now()) : paymentReceivedMessage(job, ctx.now()),
      what_to_do: PAID_TODO,
    };
  }

  const check: PaymentCheck = await checkPayments(ctx, job, { allOpen: job.status === 'cancelled' });
  if (check.outcome === 'none') {
    throw new ToolError('NO_PAYMENT_LINK', `Job ${job.id} has no payment link or transfer details yet.`, 'Call create_payment_link and send the details to the customer.');
  }

  const now = ctx.now();
  const base = { job_id: job.id, job_status: check.job.status, amount: formatNaira(job.amount_kobo) };
  if (check.needsReview) {
    return {
      ...base,
      payment_status: 'needs_review',
      what_to_do: `Do not confirm the booking. Tell the customer a dispatcher will check their payment shortly, then hand the conversation to a human. Reason for the dispatcher: ${check.needsReview}`,
    };
  }
  if (check.job.status === 'cancelled') {
    return { ...base, payment_status: 'not_paid', what_to_do: 'This job is cancelled and no payment was taken. If the customer still wants the delivery, quote and book again.' };
  }
  const latestLink = check.payments.find((p) => p.method === 'link' && p.authorization_url);
  const openTransfer = check.payments.find((p) => isAwaitingTransfer(p, now));
  switch (check.outcome) {
    case 'paid':
      return {
        ...base,
        payment_status: 'paid',
        handover_code: check.job.handover_code,
        rider: riderView(check.job.rider_id),
        pickup_timing: afterPaymentTiming(now, Boolean(check.job.rider_id)),
        // Ready-to-send text: in a live test the model once dropped the confirmation and the timing
        // and replied only "keep the envelope ready" (FIELD_NOTES_FULL #13). A full sentence to pass on is harder to drop.
        message_for_customer: (await noteAgentConfirmed(ctx.db, check.job.id, now)) === 'customer_already_told' ? paidFollowUp(check.job, now) : paymentReceivedMessage(check.job, now),
        what_to_do: PAID_TODO,
      };
    case 'in_progress':
      if (openTransfer) {
        return {
          ...base,
          payment_status: 'awaiting_transfer',
          bank: openTransfer.transfer_bank,
          account_number: openTransfer.transfer_account_number,
          amount_exact: formatNaira(openTransfer.amount_kobo),
          expires_at_wat: watTime(openTransfer.transfer_expires_at ?? now),
          message_for_customer: `Thanks. The bank hasn't confirmed your ${formatNaira(openTransfer.amount_kobo)} transfer yet; transfers usually land within a few minutes. I'll confirm here as soon as it does, or message me again in 2–3 minutes. If you haven't sent it yet: exactly ${formatNaira(openTransfer.amount_kobo)} to ${openTransfer.transfer_bank} ${openTransfer.transfer_account_number} before ${watTime(openTransfer.transfer_expires_at ?? now)}.`,
          what_to_do: 'Send message_for_customer. Never say it is paid.',
        };
      }
      return {
        ...base,
        payment_status: 'in_progress',
        message_for_customer: `Thanks, I can see your ${base.amount} payment started, and Paystack is still processing it. Finish any OTP or bank step; I'll confirm here as soon as it lands, or message me again in a minute.`,
        what_to_do: 'Send message_for_customer. Do not say it is paid.',
      };
    case 'failed': {
      const latestFailed = check.payments.find((p) => p.status === 'failed');
      const reason = bankReason(latestFailed?.gateway_response ?? null);
      const attemptsLeft = MAX_ATTEMPTS - (check.payments[0]?.attempt ?? 0);
      const head = `Your ${base.amount} payment for ${job.id} didn't go through${reason ? ` (the bank said: ${reason})` : ''}. No money was taken.`;
      return attemptsLeft > 0
        ? {
            ...base,
            payment_status: 'failed',
            reason: reason ?? null,
            message_for_customer: `${head}\n\nWould you like a new payment link to try another card, or bank transfer details instead?`,
            what_to_do:
              'Reply with message_for_customer word for word. Never say it is paid. When they choose, call create_payment_link (it makes new details automatically; method "bank_transfer" for a transfer). If they say they retried on the same page, call verify_payment again.',
          }
        : {
            ...base,
            payment_status: 'failed',
            reason: reason ?? null,
            message_for_customer: `${head}\n\nI've passed this to our team so they can help you pay another way.`,
            what_to_do: 'This job has used all its payment attempts. Call hand_to_team (reason: repeated failed payments), then reply with message_for_customer.',
          };
    }
    case 'not_paid_yet':
      return {
        ...base,
        payment_status: 'not_paid_yet',
        payment_url: latestLink?.authorization_url ?? null,
        checked_seconds_ago: check.throttled ? 'under 10' : 0,
        message_for_customer: `I don't see a completed payment for ${job.id} yet.${latestLink?.authorization_url ? ` You can pay ${base.amount} here:\n${latestLink.authorization_url}` : ''} I'll confirm as soon as it lands.`,
        what_to_do:
          'Send message_for_customer (or fresh bank transfer details if an earlier transfer account expired). Never say it is paid.',
      };
    default:
      return { ...base, payment_status: 'needs_review', what_to_do: 'The payment state is unclear. Hand the conversation to a human dispatcher.' };
  }
}
