import type { LatLng } from '../lib/geo';

/**
 * Zuma Dispatch business profile: a made-up same-day courier in Abuja and Lagos.
 * The skill's references describe the same facts in plain language; this file is
 * the source of truth the tools enforce.
 */
/** Coverage moved to ./states.ts (FCT + Lagos State, same-state deliveries only). */

/** Riders work 07:00–20:00 WAT, Monday to Saturday. Bookings are accepted any time. */
export const RIDER_HOURS = { startHour: 7, endHour: 20, days: [1, 2, 3, 4, 5, 6] as number[] } as const;

/** Africa/Lagos is UTC+1 all year (no DST), so a fixed offset is exact. */
export function lagosParts(epochMs: number): { day: number; hour: number; minute: number } {
  const d = new Date(epochMs + 60 * 60 * 1000);
  return { day: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** "14:05" in Nigeria time (WAT, the same in Abuja and Lagos). */
export function watTime(epochMs: number): string {
  const { hour, minute } = lagosParts(epochMs);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Whether a rider can be dispatched now, and if not, when the next pickup window opens. */
export function pickupWindow(epochMs: number): { now: boolean; note: string } {
  const { day, hour } = lagosParts(epochMs);
  const workingDay = RIDER_HOURS.days.includes(day);
  if (workingDay && hour >= RIDER_HOURS.startHour && hour < RIDER_HOURS.endHour) {
    return { now: true, note: 'A rider can be dispatched as soon as payment is confirmed.' };
  }
  const opensToday = workingDay && hour < RIDER_HOURS.startHour;
  const nextDay = opensToday ? 'today' : day === 6 || day === 0 ? 'Monday' : 'tomorrow';
  return { now: false, note: `Riders work 7am to 8pm, Monday to Saturday. Pickup will be ${nextDay} from 7am.` };
}
