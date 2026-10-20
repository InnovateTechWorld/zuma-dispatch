import type { Config } from '../config';
import { eventStmt, getJob, getPayment } from '../db/repo';
import type { Env } from '../env';
import { secretsMatch } from '../lib/auth';
import { log } from '../lib/log';
import { ToolError, type ToolContext } from '../mcp/tooling';
import { checkPayments } from '../payments/service';

/**
 * Paystack webhook receiver: the server learns about a payment the moment it lands, so the job is
 * marked paid (and shows on the dispatcher board) without the customer having to say "paid".
 *
 * Rules (Paystack docs: Payments -> Webhooks):
 *  - x-paystack-signature = lowerhex(HMAC_SHA512(secret key, raw body)). No signature, no processing.
 *  - The payload is never trusted for money: a charge.success only triggers our normal verification
 *    (GET /transaction/verify + status, amount, currency and reference checks), the same code path
 *    as verify_payment and the return page.
 *  - Answer 200 quickly. If Paystack's verify API is unavailable we answer 503 so Paystack retries;
 *    verify_payment and /pay/return remain as fallbacks.
 *  - Paystack posts from fixed IPs. We record whether the source IP is one of them (defence in
 *    depth, logged) but rely on the signature, which is what proves authenticity.
 */
export const PAYSTACK_IPS = ['52.31.139.75', '52.49.173.169', '52.214.14.220'];
const MAX_BODY = 512 * 1024;

export async function paystackSignature(secretKey: string, rawBody: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secretKey), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface PaystackEvent {
  event?: string;
  data?: {
    id?: number | string;
    reference?: string;
    transaction_reference?: string;
    transaction?: { reference?: string };
  };
}

/** Which of our payment references an event is about, wherever Paystack puts it for that event type. */
export function eventReference(e: PaystackEvent): string | null {
  const ref = e.data?.reference ?? e.data?.transaction_reference ?? e.data?.transaction?.reference ?? null;
  return typeof ref === 'string' && /^[A-Za-z0-9.=-]{1,64}$/.test(ref) ? ref : null;
}

export async function paystackWebhook(
  request: Request,
  env: Env,
  config: Config,
  execCtx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY) return new Response('payload too large', { status: 413 });
  const provided = (request.headers.get('x-paystack-signature') ?? '').trim().toLowerCase();
  if (!provided || !(await secretsMatch(provided, await paystackSignature(config.paystackSecretKey, raw)))) {
    log('warn', 'paystack_webhook_bad_signature', { request_id: requestId });
    return new Response('bad signature', { status: 401 });
  }

  let e: PaystackEvent;
  try {
    e = JSON.parse(new TextDecoder().decode(raw)) as PaystackEvent;
  } catch {
    return new Response('bad json', { status: 400 });
  }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return new Response('bad event', { status: 400 });
  const event = String(e.event ?? 'unknown').slice(0, 64);
  const reference = eventReference(e);
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  const ipTrusted = PAYSTACK_IPS.includes(ip);
  if (!ipTrusted) log('warn', 'paystack_webhook_unexpected_ip', { request_id: requestId, ip });
  const dedupeKey = `${event}:${String(e.data?.id ?? reference ?? crypto.randomUUID())}`.slice(0, 160);
  const now = Date.now();

  const record = (outcome: string, jobId: string | null) =>
    env.DB.prepare(
      'INSERT INTO paystack_events (dedupe_key, event, reference, job_id, outcome, source_ip, ip_trusted, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(dedupe_key) DO UPDATE SET outcome = excluded.outcome, received_at = excluded.received_at',
    )
      .bind(dedupeKey, event, reference, jobId, outcome, ip.slice(0, 64), ipTrusted ? 1 : 0, now)
      .run()
      .catch((err: unknown) => log('warn', 'paystack_event_record_failed', { message: String(err) }));

  const handled = event === 'charge.success' || event.startsWith('refund.') || event.startsWith('charge.dispute');
  const payment = reference ? await getPayment(env.DB, reference) : null;
  if (!handled || !payment) {
    // Other event types, or a reference that isn't ours (another integration on the same Paystack account).
    execCtx.waitUntil(record(handled ? 'unknown_reference' : 'ignored', null));
    log('info', 'paystack_webhook', { request_id: requestId, event, outcome: handled ? 'unknown_reference' : 'ignored' });
    return new Response(null, { status: 200 });
  }
  const job = await getJob(env.DB, payment.job_id);
  if (!job) {
    execCtx.waitUntil(record('unknown_reference', null));
    return new Response(null, { status: 200 });
  }

  if (event !== 'charge.success') {
    // Refund or dispute: money is moving back. A person decides what happens to the delivery.
    await eventStmt(env.DB, { jobId: job.id, type: 'needs_review', actor: 'system', detail: { reason: `Paystack ${event} for ${reference}. Check refund/dispute before dispatching.` }, at: now }).run();
    execCtx.waitUntil(record('needs_review', job.id));
    return new Response(null, { status: 200 });
  }

  const ctx: ToolContext = {
    env,
    config,
    db: env.DB,
    requestId,
    now: () => Date.now(),
    waitUntil: (p) => execCtx.waitUntil(p),
    publicOrigin: new URL(request.url).origin,
    trace: [],
  };
  try {
    const check = await checkPayments(ctx, job, { allOpen: true, force: true, via: 'paystack_webhook' });
    const outcome = check.needsReview ? 'needs_review' : check.outcome === 'paid' ? 'paid' : 'not_paid';
    execCtx.waitUntil(record(outcome, job.id));
    log('info', 'paystack_webhook', { request_id: requestId, event, job_id: job.id, outcome, trace: ctx.trace.join('>') });
    return new Response(null, { status: 200 });
  } catch (err) {
    // Paystack's verify API is down or rate-limiting: ask Paystack to retry this delivery later.
    execCtx.waitUntil(record('error', job.id));
    log('warn', 'paystack_webhook_verify_failed', { request_id: requestId, job_id: job.id, code: err instanceof ToolError ? err.code : String(err) });
    return new Response('verification temporarily unavailable', { status: 503 });
  }
}
