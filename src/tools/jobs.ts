import { riderView } from '../business/riders';
import { reservedMessage } from '../business/messages';
import { pickupWindow } from '../business/profile';
import { eventStmt, getJob, getJobByQuote, getPlace, getQuote, transitionJob, type JobRow, type QuoteRow } from '../db/repo';
import { haversineMeters } from '../lib/geo';
import { newHandoverCode, newJobId, normalizeId } from '../lib/ids';
import { formatNaira } from '../lib/money';
import { normalizeNigerianPhone } from '../lib/phone';
import { cleanPersonName, cleanText } from '../lib/text';
import { ToolError, type ToolContext } from '../mcp/tooling';
import { checkPayments, isAwaitingTransfer } from '../payments/service';
import { queueSheetSync } from '../sheets/queue';

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
      what_to_do: 'This quote is already booked; do not book again. Continue with create_payment_link for this job_id if it is unpaid.',
    });
  }

  // Same customer booking the same trip again, under a different quote id (e.g. the model lost
  // track of an earlier booking between turns): return the open job instead of a duplicate.
  const phoneForDup = normalizeNigerianPhone(args.recipient_phone);
  const senderForDup = cleanPersonName(args.sender_name);
  if (phoneForDup.ok && senderForDup) {
    const twin = await findTwinJob(ctx, quote, phoneForDup.e164, senderForDup, now);
    if (twin) {
      return jobView(twin, {
        already_booked: true,
        what_to_do: `This trip is already booked as ${twin.id} (same route, size and recipient, not yet paid). Do not book again: tell the customer it is the same booking and continue with create_payment_link for ${twin.id}.`,
      });
    }
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
    if (winner) return jobView(winner, { already_booked: true });
    throw e;
  }

  queueSheetSync(ctx.env, ctx.waitUntil, ctx.publicOrigin, job.id);
  const [pickup, dropoff] = await Promise.all([getPlace(ctx.db, quote.pickup_place_id), getPlace(ctx.db, quote.dropoff_place_id)]);
  return jobView(job, {
    pickup: pickup?.label,
    dropoff: dropoff?.label,
    pickup_timing: pickupWindow(now).note,
    // No handover code here on purpose: it is released only once payment is confirmed (verify_payment,
    // or the "Payment received" notice), so a code always means "this delivery is paid for".
    message_for_customer: reservedMessage(job),
    what_to_do: `Reserved as ${job.id}, awaiting payment. Send message_for_customer. If the customer already said how they want to pay, skip its question and call create_payment_link now. The rider and the handover code come only after payment.`,
  });
}

const TWIN_WINDOW_MS = 2 * 60 * 60_000;
const TWIN_DISTANCE_M = 200;

/**
 * Chord sends no conversation or customer id with tool calls (verified: no _meta, no identifying
 * headers), so "the same customer re-booking" is recognised from the booking itself: same sender
 * name, same recipient phone, same size, pickup and drop-off within 200 m, still unpaid, < 2 h old.
 * Different senders to the same recipient are never merged.
 */
async function findTwinJob(ctx: ToolContext, quote: QuoteRow, recipientE164: string, senderName: string, now: number): Promise<JobRow | null> {
  const [pu, dr] = await Promise.all([getPlace(ctx.db, quote.pickup_place_id), getPlace(ctx.db, quote.dropoff_place_id)]);
  if (!pu || !dr) return null;
  const rows = await ctx.db
    .prepare(
      `SELECT j.*, p1.lat AS pu_lat, p1.lng AS pu_lng, p2.lat AS dr_lat, p2.lng AS dr_lng
         FROM jobs j JOIN quotes q ON q.id = j.quote_id
         JOIN places p1 ON p1.id = q.pickup_place_id JOIN places p2 ON p2.id = q.dropoff_place_id
        WHERE j.recipient_phone = ? AND lower(j.sender_name) = lower(?) AND q.package_size = ? AND j.status IN ('awaiting_payment', 'payment_failed') AND j.created_at > ?
        ORDER BY j.created_at DESC LIMIT 5`,
    )
    .bind(recipientE164, senderName, quote.package_size, now - TWIN_WINDOW_MS)
    .all<JobRow & { pu_lat: number; pu_lng: number; dr_lat: number; dr_lng: number }>();
  return (
    rows.results.find(
      (r) =>
        haversineMeters({ lat: r.pu_lat, lng: r.pu_lng }, pu) <= TWIN_DISTANCE_M &&
        haversineMeters({ lat: r.dr_lat, lng: r.dr_lng }, dr) <= TWIN_DISTANCE_M,
    ) ?? null
  );
}

// ------------------------------------------------------------------ get_job_status
const STATUS_TEXT: Record<JobRow['status'], string> = {
  awaiting_payment: 'Reserved, waiting for payment.',
  paid: 'Paid. The rider is on the way to the pickup.',
  dispatched: 'A rider is on the way.',
  delivered: 'Delivered.',
  cancelled: 'Cancelled.',
  payment_failed: 'The last payment attempt failed. A new payment link can be sent.',
  amount_mismatch: 'Payment is under review by a human dispatcher.',
};

export interface JobStatusArgs {
  job_id?: string | undefined;
  recipient_phone?: string | undefined;
  sender_name?: string | undefined;
}

/** How far back a phone + name lookup searches. */
const LOOKUP_WINDOW_MS = 14 * 24 * 60 * 60_000;

/**
 * Finds the customer's job without a job id. Chord passes the server no customer identity, so the
 * customer proves it is theirs with two things they know together: the recipient's phone and the
 * sender's name (first name is enough). Returns only status and route; never the handover code.
 */
async function lookupByDetails(ctx: ToolContext, phoneRaw: string, nameRaw: string): Promise<JobRow[]> {
  const phone = normalizeNigerianPhone(phoneRaw);
  const name = cleanPersonName(nameRaw);
  if (!phone.ok || !name) {
    throw new ToolError(
      'INVALID_DETAILS',
      'The phone number or name could not be used for a lookup.',
      "Ask for the recipient's Nigerian mobile number (e.g. 0803 123 4567) and the sender's name, or the job id from the booking message.",
    );
  }
  const rows = await ctx.db
    .prepare('SELECT * FROM jobs WHERE recipient_phone = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20')
    .bind(phone.e164, ctx.now() - LOOKUP_WINDOW_MS)
    .all<JobRow>();
  const want = name.toLowerCase().split(' ');
  // "Ada" matches "Ada Obi"; "Ada Obi" matches "ada obi"; "Ade" does not match "Ada".
  return rows.results.filter((j) => {
    const have = j.sender_name.toLowerCase().split(' ');
    return want.every((w, i) => have[i] === w);
  });
}

export async function getJobStatus(args: JobStatusArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  let job: JobRow;
  if (args.job_id) {
    job = await loadJob(ctx, args.job_id);
  } else if (args.recipient_phone && args.sender_name) {
    const matches = await lookupByDetails(ctx, args.recipient_phone, args.sender_name);
    if (matches.length === 0) {
      throw new ToolError(
        'JOB_NOT_FOUND',
        'No booking in the last 14 days matches that recipient phone and sender name.',
        "Check the details with the customer (the recipient's number as given at booking, the sender's name), or ask for the job id from the booking message. Never guess.",
      );
    }
    if (matches.length > 1) {
      return {
        multiple_matches: true,
        jobs: await Promise.all(
          matches.slice(0, 5).map(async (j) => {
            const q = await getQuote(ctx.db, j.quote_id);
            const d = q ? await getPlace(ctx.db, q.dropoff_place_id) : null;
            return { job_id: j.id, status: j.status, dropoff: d?.label ?? null, booked_minutes_ago: Math.round((ctx.now() - j.created_at) / 60000) };
          }),
        ),
        what_to_do: 'Several bookings match. List them briefly (drop-off and when booked) and ask which one, then call get_job_status with that job_id.',
      };
    }
    job = matches[0]!;
  } else {
    throw new ToolError(
      'NEED_JOB_REFERENCE',
      'Need a job id, or the recipient phone and sender name.',
      "Check your Customer Memory and earlier messages for a job id (ZD-...). If there is none, ask the customer for the recipient's phone number and the sender's name.",
    );
  }
  const quote = await getQuote(ctx.db, job.quote_id);
  const [pickup, dropoff] = quote ? await Promise.all([getPlace(ctx.db, quote.pickup_place_id), getPlace(ctx.db, quote.dropoff_place_id)]) : [null, null];
  const last = await ctx.db
    .prepare('SELECT type, to_status, actor, created_at FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT 1')
    .bind(job.id)
    .first<{ type: string; to_status: string | null; actor: string; created_at: number }>();
  const rider = riderView(job.rider_id);
  return jobView(job, {
    status_text: job.status === 'paid' && !rider ? 'Paid. A dispatcher is assigning a rider.' : STATUS_TEXT[job.status],
    ...(rider && ['paid', 'dispatched', 'delivered'].includes(job.status) ? { rider } : {}),
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
    const check = await checkPayments(ctx, job, { allOpen: true, via: 'cancel' });
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
  if (done) queueSheetSync(ctx.env, ctx.waitUntil, ctx.publicOrigin, job.id);
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
