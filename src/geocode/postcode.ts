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
 * What a test key can do (verified 2026-10-20, see docs/FIELD_NOTES.md #1):
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

export type NipostStatus = 'valid' | 'not_found' | 'invalid' | 'unavailable';

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

/** Text to geocode for an LGA, phrased the way OSM names it. */
export function lgaQuery(state: string, lgaName: string): string {
  return state === 'FC' ? `${lgaName} Area Council, Federal Capital Territory` : `${lgaName}, ${STATES[state]} State`;
}
