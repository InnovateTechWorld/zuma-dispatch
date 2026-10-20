import { formatNaira, roundUpToNaira } from '../lib/money';

/**
 * Zuma Dispatch rate card. The only place prices are defined. The skill reference
 * `references/rate-card.md` explains the same numbers in plain language, and
 * test/units.test.ts checks the worked examples there against this code.
 */
export const RATE_CARD_VERSION = '2026-10-A';

export type PackageSize = 'small' | 'medium' | 'large';

interface SizeRate {
  label: string;
  vehicle: 'bike' | 'car';
  baseKobo: number; // covers the first INCLUDED_KM
  perKmKobo: number; // each km after that
  maxWeightKg: number;
}

export const INCLUDED_KM = 3;
export const ROUND_TO_NAIRA = 50;
/** Straight-line distance is multiplied by this when no road route is available (Abuja road network detour factor). */
export const STRAIGHT_LINE_ROAD_FACTOR = 1.4;
/** A quote is refused beyond this road distance even inside the service radius (e.g. a detour-heavy route). */
export const MAX_ROAD_KM = 60;
/** Pickup and drop-off closer than this are treated as the same place. */
export const MIN_DISTANCE_M = 150;

export const SIZES: Record<PackageSize, SizeRate> = {
  small: { label: 'Small (fits a backpack, up to 5 kg)', vehicle: 'bike', baseKobo: 1_500_00, perKmKobo: 150_00, maxWeightKg: 5 },
  medium: { label: 'Medium (shoebox to carton, up to 10 kg)', vehicle: 'bike', baseKobo: 2_000_00, perKmKobo: 180_00, maxWeightKg: 10 },
  large: { label: 'Large (up to 25 kg, by car)', vehicle: 'car', baseKobo: 3_500_00, perKmKobo: 300_00, maxWeightKg: 25 },
};

export interface PriceLine {
  label: string;
  amount: string;
}

export interface Price {
  totalKobo: number;
  lines: PriceLine[];
  billableKm: number;
}

/** Prices a trip. distanceM is road distance (or straight line x factor, already applied). */
export function priceTrip(size: PackageSize, distanceM: number): Price {
  const rate = SIZES[size];
  const km = Math.max(0, distanceM) / 1000;
  const extraKm = Math.max(0, Math.ceil(km - INCLUDED_KM)); // whole km, rounded up
  const raw = rate.baseKobo + extraKm * rate.perKmKobo;
  const total = roundUpToNaira(raw, ROUND_TO_NAIRA);
  const lines: PriceLine[] = [{ label: `${rate.label}, first ${INCLUDED_KM} km`, amount: formatNaira(rate.baseKobo) }];
  if (extraKm > 0) lines.push({ label: `${extraKm} km x ${formatNaira(rate.perKmKobo)}`, amount: formatNaira(extraKm * rate.perKmKobo) });
  if (total !== raw) lines.push({ label: `Rounded up to the nearest ₦${ROUND_TO_NAIRA}`, amount: formatNaira(total - raw) });
  return { totalKobo: total, lines, billableKm: Math.round(km * 10) / 10 };
}
