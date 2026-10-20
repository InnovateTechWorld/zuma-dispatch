import { pickupWindow } from '../business/profile';
import { eventStmt, getJob, getJobByQuote, getPlace, getQuote, transitionJob, type JobRow } from '../db/repo';
import { newHandoverCode, newJobId, normalizeId } from '../lib/ids';
import { formatNaira } from '../lib/money';
import { normalizeNigerianPhone } from '../lib/phone';
import { cleanPersonName, cleanText } from '../lib/text';
import { ToolError, type ToolContext } from '../mcp/tooling';
import { checkPayments, isAwaitingTransfer } from '../payments/service';

export async function loadJob(ctx: ToolContext, raw: string): Promise<JobRow> {
  const id = normalizeId(raw, 'ZD', 5);
  const job = id ? await getJob(ctx.db, id) : null;
  if (!job) {
    throw new ToolError(
      'JOB_NOT_FOUND',
      `No job with id "${raw}".`,
      'Ask the customer for the job id from their booking message (it looks like ZD-7K3QP). Never guess one.',
    );
  }
  return job;
}

function jobView(job: JobRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const phone = normalizeNigerianPhone(job.recipient_phone);
  return {
    job_id: job.id,
    status: job.status,
    amount_due: formatNaira(job.amount_kobo),
    recipient: job.recipient_name,
    recipient_phone: phone.ok ? phone.masked : 'on file',
    ...extra,
  };
}

// ------------------------------------------------------------------ create_dispatch_job
export interface CreateJobArgs {
  quote_id: string;
  sender_name: string;
  recipient_name: string;
  recipient_phone: string;
  package_note?: string | undefined;
  customer_confirmed: true;
}

export async function createDispatchJob(args: CreateJobArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const now = ctx.now();
  const quoteId = normalizeId(args.quote_id, 'Q', 8);
  const quote = quoteId ? await getQuote(ctx.db, quoteId) : null;
  if (!quote) {
    throw new ToolError('QUOTE_NOT_FOUND', `No quote with id "${args.quote_id}".`, 'Call quote_delivery first and use the quote_id it returns.');
  }

  // Idempotent: one job per quote. A retry (or a double "yes") returns the same job.
  const existing = await getJobByQuote(ctx.db, quote.id);
  if (existing) {
    return jobView(existing, {
      already_booked: true,
      handover_code: existing.handover_code,
      what_to_do: 'This quote is already booked; do not book again. Continue with create_payment_link for this job_id if it is unpaid.',
    });
  }

  if (quote.expires_at <= now) {
    throw new ToolError(
      'QUOTE_EXPIRED',
      `Quote ${quote.id} expired.`,
      'Call quote_delivery again with the same place_ids and package_size, tell the customer the (possibly new) price, and get a fresh yes before booking.',
    );
  }

  const sender = cleanPersonName(args.sender_name);
  const recipient = cleanPersonName(args.recipient_name);
  const phone = normalizeNigerianPhone(args.recipient_phone);
  const problems: { field: string; what_to_do: string }[] = [];
  if (!sender) problems.push({ field: 'sender_name', what_to_do: "Ask for the sender's name (at least two letters)." });
  if (!recipient) problems.push({ field: 'recipient_name', what_to_do: "Ask for the recipient's name." });
  if (!phone.ok) {
    problems.push({
      field: 'recipient_phone',
      what_to_do:
        phone.reason === 'not_nigerian_mobile'
          ? 'That is not a Nigerian mobile number (they start 070, 080, 081, 090 or 091). Ask the customer to check it.'
          : 'Ask for the recipient\'s 11-digit Nigerian mobile number, e.g. 0803 123 4567.',
    });
  }
  if (problems.length > 0 || !sender || !recipient || !phone.ok) {
    throw new ToolError('INVALID_DETAILS', 'Some booking details need fixing.', problems.map((p) => p.what_to_do).join(' '), false, {
      fields: problems,
    });
  }

  const job: JobRow = {
    id: newJobId(),
    quote_id: quote.id,
    sender_name: sender,
    sender_phone: null,
    recipient_name: recipient,
    recipient_phone: phone.e164,
    package_note: args.package_note ? cleanText(args.package_note, 200) || null : null,
    amount_kobo: quote.amount_kobo, // always from the stored quote
    currency: 'NGN',
    status: 'awaiting_payment',
    handover_code: newHandoverCode(),
    version: 1,
    created_at: now,
    updated_at: now,
    paid_at: null,
    cancel_reason: null,
  };

  try {
    await ctx.db.batch([
      ctx.db
        .prepare(
          'INSERT INTO jobs (id, quote_id, sender_name, sender_phone, recipient_name, recipient_phone, package_note, amount_kobo, currency, status, handover_code, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(job.id, job.quote_id, job.sender_name, job.sender_phone, job.recipient_name, job.recipient_phone, job.package_note,
          job.amount_kobo, job.currency, job.status, job.handover_code, job.version, job.created_at, job.updated_at),
      eventStmt(ctx.db, { jobId: job.id, type: 'created', to: job.status, actor: 'agent', detail: { quote_id: quote.id }, at: now }),
    ]);
  } catch (e) {
    // Two concurrent bookings of the same quote: UNIQUE(quote_id) lets only one win.
    const winner = await getJobByQuote(ctx.db, quote.id);
    if (winner) return jobView(winner, { already_booked: true, handover_code: winner.handover_code });
    throw e;
  }

  const [pickup, dropoff] = await Promise.all([getPlace(ctx.db, quote.pickup_place_id), getPlace(ctx.db, quote.dropoff_place_id)]);
  return jobView(job, {
    pickup: pickup?.label,
    dropoff: dropoff?.label,
    handover_code: job.handover_code,
    pickup_timing: pickupWindow(now).note,
    what_to_do: `Booked as ${job.id}. Tell the customer the job id and handover code (${job.handover_code}): the recipient gives this code to the rider. Then call create_payment_link with this job_id.`,
  });
}

// ------------------------------------------------------------------ get_job_status
const STATUS_TEXT: Record<JobRow['status'], string> = {
  awaiting_payment: 'Booked, waiting for payment.',
  paid: 'Paid. A dispatcher is assigning a rider.',
  dispatched: 'A rider is on the way.',
  delivered: 'Delivered.',
  cancelled: 'Cancelled.',
  payment_failed: 'The last payment attempt failed. A new payment link can be sent.',
  amount_mismatch: 'Payment is under review by a human dispatcher.',
};

export async function getJobStatus(args: { job_id: string }, ctx: ToolContext): Promise<Record<string, unknown>> {
  const job = await loadJob(ctx, args.job_id);
  const quote = await getQuote(ctx.db, job.quote_id);
  const [pickup, dropoff] = quote ? await Promise.all([getPlace(ctx.db, quote.pickup_place_id), getPlace(ctx.db, quote.dropoff_place_id)]) : [null, null];
  const last = await ctx.db
    .prepare('SELECT type, to_status, actor, created_at FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT 1')
    .bind(job.id)
    .first<{ type: string; to_status: string | null; actor: string; created_at: number }>();
  return jobView(job, {
    status_text: STATUS_TEXT[job.status],
    pickup: pickup?.label,
    dropoff: dropoff?.label,
    last_update_minutes_ago: last ? Math.round((ctx.now() - last.created_at) / 60000) : null,
    what_to_do:
      job.status === 'awaiting_payment' || job.status === 'payment_failed'
        ? 'If the customer says they have paid, call verify_payment. Otherwise offer the payment link (create_payment_link).'
        : job.status === 'amount_mismatch'
          ? 'Tell the customer a dispatcher is reviewing the payment and hand the conversation to a human.'
          : 'Tell the customer the status in one short sentence.',
  });
}

// ------------------------------------------------------------------ cancel_job
export async function cancelJob(args: { job_id: string; reason: string }, ctx: ToolContext): Promise<Record<string, unknown>> {
  let job = await loadJob(ctx, args.job_id);
  let transferWasOpen = false;
  if (job.status === 'cancelled') return jobView(job, { already_cancelled: true, what_to_do: 'It was already cancelled. Confirm that to the customer.' });

  if (job.status === 'awaiting_payment' || job.status === 'payment_failed') {
    // A payment may have just landed: check every open attempt before cancelling.
    const check = await checkPayments(ctx, job, { allOpen: true });
    job = check.job;
    // A card payment mid-OTP is real money in flight: don't cancel under it. An open bank-transfer
    // account that has received nothing is just an invitation to pay, so it does not block.
    const now = ctx.now();
    const cardInFlight = check.payments.some((p) => p.method === 'link' && ['ongoing', 'pending', 'processing', 'queued'].includes(p.status));
    if (check.outcome === 'in_progress' && cardInFlight) {
      throw new ToolError(
        'PAYMENT_IN_PROGRESS',
        'A card payment for this job is in progress at Paystack.',
        'Do not cancel now. Tell the customer a payment is still processing; if it completes, a human dispatcher will handle a refund. Hand over to a human if they insist.',
      );
    }
    transferWasOpen = check.payments.some((p) => isAwaitingTransfer(p, now));
  }
  if (job.status !== 'awaiting_payment' && job.status !== 'payment_failed') {
    throw new ToolError(
      'CANNOT_CANCEL',
      `Job ${job.id} is ${job.status}; only unpaid jobs can be cancelled here.`,
      'Do not cancel. Tell the customer a human dispatcher will help (refunds and paid jobs are handled by people) and hand the conversation over.',
    );
  }
  const reason = cleanText(args.reason, 200);
  const done = await transitionJob(ctx.db, job.id, ['awaiting_payment', 'payment_failed'], 'cancelled', 'agent', ctx.now(), { reason }, ', cancel_reason = ?', [reason]);
  const fresh = (await getJob(ctx.db, job.id)) ?? job;
  if (!done && fresh.status !== 'cancelled') {
    throw new ToolError('CANNOT_CANCEL', `Job ${job.id} changed to ${fresh.status} while cancelling.`, 'Call get_job_status and tell the customer the current status.');
  }
  return jobView(fresh, {
    what_to_do:
      'Confirm the cancellation and ask the customer not to use the old payment link' +
      (transferWasOpen ? ' or send money to the transfer account' : '') +
      '. If they already paid or pay anyway, a dispatcher will refund them.',
  });
}
