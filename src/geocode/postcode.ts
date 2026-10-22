import type { Config } from '../config';
import { fetchJson, traceLabel } from '../lib/http';
import { cacheGet, cachePut } from './cache';

/**
 * NIPOST postcodes (https://docs.postcode.gov.ng).
 *
 * New format: 5 segments, e.g. FC-02-A09-DB-09 (state, LGA, district, area, building unit).
 * The API accepts dashed, spaced or compact forms. Legacy 6-digit postal codes (e.g. 900001)
 * are recognised but cannot be verified through the API.
 *
 * What a test key can do (verified 2026-10-20, see docs/FIELD_NOTES_FULL.md #1):
 *  - /v1/lookup level 1 answers validity only, with no names or coordinates. Coordinates need L5.
 *  - The documented sandbox codes return not_found, so validity is reported honestly
 *    and never blocks the flow.
 *  - /v1/reference/lgas returns real LGA names, which give an area-level location.
 */

export const STATES: Record<string, string> = {
  AB: 'Abia', AD: 'Adamawa', AK: 'Akwa Ibom', AN: 'Anambra', BA: 'Bauchi', BE: 'Benue', BR: 'Borno', BY: 'Bayelsa',
  CR: 'Cross River', DE: 'Delta', EB: 'Ebonyi', ED: 'Edo', EK: 'Ekiti', EN: 'Enugu', FC: 'Federal Capital Territory',
  GM: 'Gombe', IM: 'Imo', JI: 'Jigawa', KD: 'Kaduna', KE: 'Kebbi', KG: 'Kogi', KN: 'Kano', KT: 'Katsina', KW: 'Kwara',
  LA: 'Lagos', NA: 'Nasarawa', NI: 'Niger', OG: 'Ogun', ON: 'Ondo', OS: 'Osun', OY: 'Oyo', PL: 'Plateau', RI: 'Rivers',
  SK: 'Sokoto', TA: 'Taraba', YB: 'Yobe', ZA: 'Zamfara',
};

export interface ParsedPostcode {
  kind: 'nipost';
  code: string; // canonical dashed form
  state: string;
  lga: string;
  rest: string; // the customer's text with the postcode removed
}
export interface LegacyPostcode {
  kind: 'legacy';
  code: string;
  rest: string;
}

const NEW_FORMAT = /\b([A-Za-z]{2})[\s-]*(\d{2})[\s-]*([A-Za-z0-9]{3})[\s-]*([A-Za-z]{2})[\s-]*(\d{2})\b/;
const LEGACY = /\b(\d{6})\b/;

export function findPostcode(text: string): ParsedPostcode | LegacyPostcode | null {
  const m = NEW_FORMAT.exec(text);
  if (m) {
    const [whole, st, lga, district, area, unit] = m as unknown as [string, string, string, string, string, string];
    const state = st.toUpperCase();
    // Numeric segments are 01-99, never 00 (docs: concepts/postcode-format).
    if (STATES[state] && lga !== '00' && unit !== '00' && /\d/.test(whole)) {
      const code = [state, lga, district.toUpperCase(), area.toUpperCase(), unit].join('-');
      return { kind: 'nipost', code, state, lga, rest: tidy(text.replace(whole, ' ')) };
    }
  }
  const l = LEGACY.exec(text);
  // Ignore long digit runs (phone numbers) that merely contain 6 digits.
  if (l && !/\d{7,}/.test(text.replace(/\s/g, ''))) {
    return { kind: 'legacy', code: l[1]!, rest: tidy(text.replace(l[0], ' ')) };
  }
  return null;
}

function tidy(s: string): string {
  return s
    .replace(/\b(postcode|post code|postal code|code)\b[:\s]*/gi, ' ')
    .replace(/\s*,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.-]+|[\s,.-]+$/g, '');
}

export type NipostStatus = 'valid' | 'not_found' | 'invalid' | 'unavailable' | 'demo';

/**
 * Demo postcodes: four made-up NIPOST-format codes that resolve to exact places, so a tester can type one
 * and the agent knows precisely where they are.
 *
 * Why they exist: with our test key NIPOST cannot locate anything. Its sandbox answers `not_found` for
 * every code, including the five codes its docs say "always resolve" (all in Abaji). Coordinates need
 * lookup level 5, which needs a live key and business verification (FIELD_NOTES_FULL #1, #15, #17).
 *
 * How they are kept safe:
 * - The district segment is `ZDM` (Zuma Dispatch deMo): letters only. Real NIPOST districts are a letter
 *   plus two digits (A01, A02 …), so these can never shadow a real code.
 * - The state and LGA segments are the real ones for each place.
 * - Active only with a NIPOST *test* key. A live deployment ignores them and asks NIPOST.
 * - Answers say `nipost_status: "demo"`, never "valid".
 */
export const DEMO_POSTCODES: Record<string, { label: string; lat: number; lng: number; lga: string }> = {
  'FC-02-ZDM-JB-01': { label: 'Jabi Lake Mall, Bala Sokoto Way, Jabi, Abuja', lat: 9.07628, lng: 7.42548, lga: 'Abuja Municipal' },
  'LA-11-ZDM-PS-01': { label: 'Paystack office, 3A Ladoke Akintola Street, Ikeja GRA, Lagos', lat: 6.58346, lng: 3.35409, lga: 'Ikeja' },
  'LA-20-ZDM-NS-01': { label: 'Lagos National Stadium, Iganmu, Surulere, Lagos', lat: 6.49714, lng: 3.36499, lga: 'Surulere' },
  'LA-19-ZDM-UL-01': { label: 'University of Lagos (UNILAG), Akoka, Lagos', lat: 6.51203, lng: 3.39353, lga: 'Shomolu' },
};

/** The demo place for a parsed postcode, if any (test keys only). */
export function demoPostcode(code: string, nipostApiKey: string): (typeof DEMO_POSTCODES)[string] | null {
  return nipostApiKey.startsWith('nipost_test_') ? DEMO_POSTCODES[code] ?? null : null;
}

export async function nipostValidity(code: string, config: Config, trace: string[]): Promise<NipostStatus> {
  const r = await fetchJson<{ data?: { valid?: boolean; status?: string } }>(
    `https://api.postcode.gov.ng/v1/lookup?${new URLSearchParams({ code, level: '1' })}`,
    { timeoutMs: config.providerTimeoutMs, headers: { 'X-API-Key': config.nipostApiKey } },
  );
  trace.push(traceLabel('nipost-lookup', r));
  if (!r.ok) return 'unavailable';
  if (r.data.data?.valid === true) return 'valid';
  return r.data.data?.status === 'not_found' ? 'not_found' : 'invalid';
}

/** LGA name for a state + LGA code from NIPOST's free reference endpoint, cached for 30 days. */
export async function nipostLgaName(
  state: string,
  lga: string,
  config: Config,
  db: D1Database,
  now: number,
  trace: string[],
): Promise<string | null> {
  const key = `nipost:lgas:${state}`;
  let lgas = await cacheGet<{ code: string; name?: string }[]>(db, key, now);
  if (lgas) trace.push('nipost-lgas:cache');
  else {
    const r = await fetchJson<{ data?: { lgas?: { code: string; name?: string }[] } }>(
      `https://api.postcode.gov.ng/v1/reference/lgas?${new URLSearchParams({ state })}`,
      { timeoutMs: config.providerTimeoutMs, headers: { 'X-API-Key': config.nipostApiKey } },
    );
    trace.push(traceLabel('nipost-lgas', r));
    if (!r.ok) return null;
    lgas = r.data.data?.lgas ?? [];
    if (lgas.length > 0) await cachePut(db, key, 'nipost', lgas, now);
  }
  return lgas.find((x) => x.code === lga)?.name ?? null;
}

/**
 * Approximate centres of the six FCT area councils (NIPOST LGA codes 01–06). A postcode's area must
 * not depend on which geocoder answers first: for "Abaji Area Council, Federal Capital Territory",
 * Photon returns the FCT Administration building in Garki (1.4 km from the centre; Abaji is ~89 km away).
 * NIPOST's sandbox codes (FC-01-…) are all in Abaji.
 */
export const FCT_AREA_COUNCILS: Record<string, { name: string; lat: number; lng: number }> = {
  '01': { name: 'Abaji', lat: 8.4737, lng: 6.9445 },
  '02': { name: 'Abuja Municipal', lat: 9.0579, lng: 7.4951 },
  '03': { name: 'Bwari', lat: 9.2833, lng: 7.3833 },
  '04': { name: 'Gwagwalada', lat: 8.9428, lng: 7.0833 },
  '05': { name: 'Kuje', lat: 8.8794, lng: 7.2276 },
  '06': { name: 'Kwali', lat: 8.8833, lng: 7.0167 },
};

/** A geocoder answer only counts as an LGA's location if its label names that LGA. */
export function namesLga(label: string, lgaName: string): boolean {
  const first = lgaName.toLowerCase().split(/[\s,]+/)[0] ?? '';
  return first.length > 2 && label.toLowerCase().includes(first);
}

/** Text to geocode for an LGA, phrased the way OSM names it. */
export function lgaQuery(state: string, lgaName: string): string {
  return state === 'FC' ? `${lgaName} Area Council, Federal Capital Territory` : `${lgaName}, ${STATES[state]} State`;
}
