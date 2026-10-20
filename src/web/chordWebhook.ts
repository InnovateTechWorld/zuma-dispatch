import { secretsMatch } from '../lib/auth';
import { log } from '../lib/log';

/**
 * Receiver for Chord webhooks (docs: Webhooks). Subscribed event: conversation.escalated, fired
 * when a thread moves agent_active -> human_active, e.g. the teammate called handover_to_human.
 * The dispatcher board lists these so a person picks the customer up.
 *
 * Signature: deliveries carry no X-Chord-Timestamp, so the "body signature" scheme applies:
 *   X-Chord-Signature: sha256=<lowerhex(HMAC_SHA256(secret, raw body bytes))>
 * Dedupe on X-Chord-Delivery-Id (stable across retries). Answer 2xx fast; Chord retries 408/425/429/5xx.
 */
export async function bodySignature(secret: string, rawBody: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody));
  return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const MAX_BODY = 256 * 1024;

export async function chordWebhook(request: Request, db: D1Database, secret: string | null, requestId: string): Promise<Response> {
  if (!secret) return new Response('webhook receiver not configured', { status: 503 });
  if (request.headers.get('X-Chord-Timestamp')) {
    // Timestamped signatures belong to the external-chat bridge, which we do not use. Never try both schemes.
    return new Response('unexpected signature scheme', { status: 400 });
  }
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY) return new Response('payload too large', { status: 413 });
  const provided = (request.headers.get('X-Chord-Signature') ?? '').trim().toLowerCase();
  if (!provided || !(await secretsMatch(provided, await bodySignature(secret, raw)))) {
    log('warn', 'chord_webhook_bad_signature', { request_id: requestId });
    return new Response('bad signature', { status: 401 });
  }

  let event: { id?: string; type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response('bad json', { status: 400 });
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return new Response('bad event', { status: 400 });
  const deliveryId = request.headers.get('X-Chord-Delivery-Id') ?? event.id ?? crypto.randomUUID();
  const type = String(event.type ?? request.headers.get('X-Chord-Event') ?? 'unknown');
  const data = event.data ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 500) : null);
  const res = await db
    .prepare(
      'INSERT INTO chord_events (delivery_id, event_id, type, thread_id, initiator, reason, payload_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING',
    )
    .bind(deliveryId.slice(0, 100), String(event.id ?? '').slice(0, 100), type.slice(0, 100), str(data['thread_id']), str(data['initiator']), str(data['reason']), JSON.stringify(data).slice(0, 4000), Date.now())
    .run();
  log('info', 'chord_webhook', { request_id: requestId, type, duplicate: res.meta.changes === 0 });
  return new Response(null, { status: 204 });
}
