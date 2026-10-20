import type { LatLng } from '../lib/geo';

/**
 * Zuma Dispatch business profile: a made-up same-day courier in Abuja.
 * The skill's references describe the same facts in plain language; this file is
 * the source of truth the tools enforce.
 */
export const SERVICE_AREA = {
  /** City centre (Central Business District). */
  centre: { lat: 9.0579, lng: 7.4951 } satisfies LatLng,
  /** Covers Kubwa, Gwarinpa, Lugbe, the airport, Nyanya, Karu and Mararaba. Excludes Gwagwalada, Abaji and Suleja. */
  radiusKm: 40,
  description:
    'Abuja metro within about 40 km of the city centre: Wuse, Garki, Maitama, Asokoro, Jabi, Utako, Wuye, Gwarinpa, Kubwa, Lugbe, the airport, Nyanya, Karu and Mararaba.',
} as const;

/** Bias point for geocoders when the customer gives no city. */
export const GEOCODE_BIAS = { centre: SERVICE_AREA.centre, radiusM: 50_000 } as const;

/** Riders work 07:00–20:00 WAT, Monday to Saturday. Bookings are accepted any time. */
export const RIDER_HOURS = { startHour: 7, endHour: 20, days: [1, 2, 3, 4, 5, 6] as number[] } as const;

/** Africa/Lagos is UTC+1 all year (no DST), so a fixed offset is exact. */
export function lagosParts(epochMs: number): { day: number; hour: number; minute: number } {
  const d = new Date(epochMs + 60 * 60 * 1000);
  return { day: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** "14:05" in Abuja time. */
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
