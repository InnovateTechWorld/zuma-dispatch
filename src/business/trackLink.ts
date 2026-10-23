import { getPlace, getQuote, type JobRow } from '../db/repo';
import { pickupWindow } from './profile';
import { riderById } from './riders';
import { simulateRider, type RiderUpdate } from './tracking';

/**
 * A real tracking link for the customer: `/t/ZD-MTQ2B-3f9a1c0b7e` always opens the rider's current
 * (simulated) position in Google Maps.
 *
 * Why: twice on 23 Oct 2026 the model answered "where is the rider?" without calling get_job_status and
 * made up a link ("https://maps.google.com/?q=6.5697,3.3652"). Instructions alone did not stop it. The
 * model does reuse links already in the chat, so the payment confirmation now carries this link. Even a
 * reply that skips the tool then has a link that works and shows the live position.
 *
 * The code after the job id is an HMAC of the job id, so a link can't be guessed from a job id. It is keyed
 * on a secret the server already holds. Rotating that secret breaks old links, which is acceptable for a
 * same-day delivery.
 */
const TOKEN_HEX = 10;

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function trackToken(jobId: string, secret: string): Promise<string> {
  return (await hmacHex(`zuma-track-v1:${secret}`, jobId)).slice(0, TOKEN_HEX);
}

export async function trackUrl(origin: string, jobId: string, secret: string): Promise<string> {
  return `${origin.replace(/\/+$/, '')}/t/${jobId}-${await trackToken(jobId, secret)}`;
}

/** Parses "/t/ZD-MTQ2B-3f9a1c0b7e" and checks the code in constant time. Null when anything is off. */
export async function readTrackPath(path: string, secret: string): Promise<string | null> {
  const m = /^\/t\/(ZD-[0-9A-Z]{5})-([0-9a-f]{10})\/?$/.exec(path);
  if (!m) return null;
  const want = await trackToken(m[1]!, secret);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[2]!.charCodeAt(i);
  return diff === 0 ? m[1]! : null;
}

/** The rider's simulated position for a job (shared by get_job_status and the tracking page). */
export async function riderUpdate(db: D1Database, job: JobRow, now: number): Promise<RiderUpdate | null> {
  const rider = riderById(job.rider_id);
  if (!rider || !['paid', 'dispatched', 'delivered'].includes(job.status)) return null;
  const quote = await getQuote(db, job.quote_id);
  if (!quote) return null;
  const [pickup, dropoff] = await Promise.all([getPlace(db, quote.pickup_place_id), getPlace(db, quote.dropoff_place_id)]);
  if (!pickup || !dropoff) return null;
  const dispatched = await db
    .prepare("SELECT created_at FROM job_events WHERE job_id = ? AND to_status = 'dispatched' ORDER BY id DESC LIMIT 1")
    .bind(job.id)
    .first<{ created_at: number }>();
  const w = pickupWindow(now);
  return simulateRider({
    jobId: job.id, status: job.status, rider, pickup, dropoff,
    assignedAt: job.rider_assigned_at ?? job.paid_at ?? job.updated_at,
    dispatchedAt: dispatched?.created_at ?? null,
    tripMinutes: quote.duration_s ? quote.duration_s / 60 : null,
    riderHoursNow: w.now, riderHoursNote: w.note, now,
  });
}
