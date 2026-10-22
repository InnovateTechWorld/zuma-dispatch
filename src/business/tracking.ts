import { haversineMeters } from '../lib/geo';
import { riderContact, riderLine, type Rider } from './riders';

/**
 * Simulated rider tracking (test mode: there are no real riders or GPS). The position is computed
 * from the job's own timestamps, so it is the same on every call and moves forward with time:
 *
 *   paid        → the rider rides from a start point ~3 km away to the pickup (APPROACH_MIN)
 *   paid, later → at the pickup, waiting for the dispatcher to mark the package collected
 *   dispatched  → pickup → drop-off over the quoted trip time
 *   delivered   → at the drop-off
 *
 * The board and docs label it simulated; the customer just gets an update and a map link.
 */
export const APPROACH_MIN = 15;
const APPROACH_KM = 3;
const MIN_PER_KM = 2.5; // ~24 km/h through city traffic, used when the quote has no duration

export interface Point { lat: number; lng: number; label: string }
export type Phase = 'to_pickup' | 'at_pickup' | 'to_dropoff' | 'arriving' | 'delivered' | 'waiting_hours';
export interface RiderUpdate {
  phase: Phase;
  minutes_away: number | null;
  km_away: number | null;
  lat: number;
  lng: number;
  map_url: string;
  simulated: true;
  message: string;
}

const short = (label: string) => label.split(',')[0]!.trim();
const lerp = (a: Point, b: { lat: number; lng: number }, f: number) => ({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });
export const mapUrl = (p: { lat: number; lng: number }) => {
  const lat = p.lat.toFixed(5);
  const lng = p.lng.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
};

/** A start point ~3 km from the pickup, in a direction fixed by the job id (so it never jumps around). */
export function startPoint(jobId: string, pickup: Point): Point {
  let hash = 0;
  for (const ch of jobId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const angle = ((hash % 360) * Math.PI) / 180;
  const dLat = (APPROACH_KM / 111) * Math.cos(angle);
  const dLng = (APPROACH_KM / (111 * Math.cos((pickup.lat * Math.PI) / 180))) * Math.sin(angle);
  return { lat: pickup.lat + dLat, lng: pickup.lng + dLng, label: 'start' };
}

export function simulateRider(o: {
  jobId: string;
  status: string;
  rider: Rider;
  pickup: Point;
  dropoff: Point;
  /** When the rider was assigned (or the job paid). */
  assignedAt: number;
  dispatchedAt: number | null;
  tripMinutes: number | null;
  riderHoursNow: boolean;
  riderHoursNote: string;
  now: number;
}): RiderUpdate | null {
  const who = riderLine(o.rider);
  const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.round(haversineMeters(a, b) / 100) / 10;
  // Every update while the rider still has the job ends with how to reach them.
  const done = (phase: Phase, at: { lat: number; lng: number }, minutes: number | null, kmAway: number | null, message: string): RiderUpdate => ({
    phase, minutes_away: minutes, km_away: kmAway, lat: at.lat, lng: at.lng, map_url: mapUrl(at), simulated: true,
    message: phase === 'delivered' ? message : `${message} ${riderContact(o.rider)}`,
  });

  if (o.status === 'delivered') {
    return done('delivered', o.dropoff, null, null, `${who} delivered the package at ${short(o.dropoff.label)}.`);
  }
  if (o.status === 'dispatched') {
    const trip = Math.max(5, o.tripMinutes ?? km(o.pickup, o.dropoff) * MIN_PER_KM);
    const elapsed = Math.max(0, (o.now - (o.dispatchedAt ?? o.now)) / 60_000);
    if (elapsed >= trip) return done('arriving', o.dropoff, 0, 0, `${who} is arriving at ${short(o.dropoff.label)} now.`);
    const at = lerp(o.pickup, o.dropoff, elapsed / trip);
    const mins = Math.max(1, Math.ceil(trip - elapsed));
    const left = km(at, o.dropoff);
    return done('to_dropoff', at, mins, left, `${who} has the package and is on the way to ${short(o.dropoff.label)}, about ${mins} minute${mins === 1 ? '' : 's'} away (${left} km to go).`);
  }
  if (o.status !== 'paid') return null;
  if (!o.riderHoursNow) {
    return done('waiting_hours', o.pickup, null, null, `${who} will collect it at ${short(o.pickup.label)}. ${o.riderHoursNote}`);
  }
  const start = startPoint(o.jobId, o.pickup);
  const elapsed = Math.max(0, (o.now - o.assignedAt) / 60_000);
  if (elapsed >= APPROACH_MIN) return done('at_pickup', o.pickup, 0, 0, `${who} is at ${short(o.pickup.label)} now, collecting the package.`);
  const at = lerp(start, o.pickup, elapsed / APPROACH_MIN);
  const mins = Math.max(1, Math.ceil(APPROACH_MIN - elapsed));
  const away = km(at, o.pickup);
  return done('to_pickup', at, mins, away, `${who} is on the way to the pickup at ${short(o.pickup.label)}, about ${mins} minute${mins === 1 ? '' : 's'} away (${away} km).`);
}
