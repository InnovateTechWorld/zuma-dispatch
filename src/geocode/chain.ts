import type { Config, GeocoderName } from '../config';
import { haversineMeters } from '../lib/geo';
import { normalizeQuery } from '../lib/text';
import { cacheGet, cachePut } from './cache';
import { GEOCODERS, type Candidate, type ProviderResult } from './providers';

/** Two providers "agree" when their top results are this close. */
export const AGREE_METERS = 400;
/** Two results from one provider are different places when this far apart. */
export const DISTINCT_METERS = 3000;

export type Confidence = 'high' | 'medium' | 'low';

export interface ChainOutcome {
  candidates: Candidate[];
  confidence: Confidence;
  /** True when two providers disagreed or one provider returned far-apart places. */
  ambiguous: boolean;
  /** Every provider answered with an error (as opposed to "found nothing"). */
  allFailed: boolean;
}

async function searchCached(name: GeocoderName, query: string, config: Config, db: D1Database, now: number): Promise<ProviderResult> {
  const provider = GEOCODERS[name];
  const why = provider.unavailable(config);
  if (why) return { provider: name, outcome: 'skipped', candidates: [], trace: `${name}:skipped(${why})` };
  const key = `geo:${name}:${normalizeQuery(query)}`;
  const cached = await cacheGet<Candidate[]>(db, key, now);
  if (cached) return { provider: name, outcome: 'ok', candidates: cached, trace: `${name}:cache:${cached.length}` };
  const result = await provider.search(query, config);
  if (result.outcome === 'ok') await cachePut(db, key, name, result.candidates, now);
  return result;
}

/** Merges results that point at the same spot, keeping the more precise label. */
export function dedupe(list: Candidate[]): Candidate[] {
  const rank = { exact: 0, street: 1, area: 2, lga: 3 } as const;
  const out: Candidate[] = [];
  for (const c of list) {
    const i = out.findIndex((o) => haversineMeters(o, c) <= AGREE_METERS);
    if (i === -1) out.push(c);
    else if (rank[c.precision] < rank[out[i]!.precision]) out[i] = c;
  }
  return out;
}

/** Decides confidence/ambiguity from up to two providers' answers. Pure, unit-tested. */
export function judge(primary: Candidate[], second: Candidate[] | null): Omit<ChainOutcome, 'allFailed'> {
  const own = (list: Candidate[]) => {
    const [top, next] = list;
    const spread = top && next && haversineMeters(top, next) > DISTINCT_METERS && next.precision === top.precision;
    return { top, spread: Boolean(spread) };
  };
  const a = own(primary);
  if (!a.top) {
    if (second && second.length > 0) {
      const b = own(second);
      return { candidates: b.spread ? dedupe(second).slice(0, 3) : [b.top!], confidence: b.spread ? 'low' : 'medium', ambiguous: b.spread };
    }
    return { candidates: [], confidence: 'low', ambiguous: false };
  }
  if (second && second.length > 0) {
    const bTop = second[0]!;
    if (haversineMeters(a.top, bTop) <= AGREE_METERS) {
      return { candidates: dedupe([a.top, bTop]).slice(0, 1), confidence: 'high', ambiguous: false };
    }
    return { candidates: dedupe([a.top, bTop, ...primary.slice(1), ...second.slice(1)]).slice(0, 3), confidence: 'low', ambiguous: true };
  }
  if (a.spread) return { candidates: dedupe(primary).slice(0, 3), confidence: 'low', ambiguous: true };
  return { candidates: [a.top], confidence: 'medium', ambiguous: false };
}

/** After the first provider answers, the second gets this much longer before we go without it. */
export const SECOND_OPINION_GRACE_MS = 1500;
/** Don't start further fallback providers after this much total time (Chord waits ~60 s per reply, but customers notice ~5 s). */
const CHAIN_BUDGET_MS = 6000;

const sleep = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));

/**
 * Runs the configured geocoder chain.
 *  fallback:   providers in order until one finds something.
 *  crosscheck: the first two usable providers in parallel (2 of the 6 concurrent connections
 *              a Worker may hold). Agreement raises confidence; disagreement becomes an
 *              "ambiguous" answer the customer resolves. The second opinion is time-boxed:
 *              once the first answers, the second gets SECOND_OPINION_GRACE_MS more; if it is
 *              late we answer with one source and let it finish in the background (its result
 *              is cached for next time).
 */
export async function geocode(
  query: string,
  config: Config,
  db: D1Database,
  now: number,
  trace: string[],
  waitUntil: (p: Promise<unknown>) => void = () => {},
): Promise<ChainOutcome> {
  const started = Date.now();
  const usable = config.geocoderChain.filter((n) => {
    const why = GEOCODERS[n].unavailable(config);
    if (why) trace.push(`${n}:skipped(${why})`);
    return !why;
  });
  if (usable.length === 0) return { candidates: [], confidence: 'low', ambiguous: false, allFailed: true };

  const results: ProviderResult[] = [];
  const record = (r: ProviderResult) => {
    results.push(r);
    trace.push(r.trace);
    return r;
  };
  let next = 0;
  let a: Candidate[] = [];
  let b: Candidate[] | null = null;

  if (config.geocoderMode === 'crosscheck' && usable.length >= 2) {
    const firstP = searchCached(usable[0]!, query, config, db, now);
    const secondP = searchCached(usable[1]!, query, config, db, now);
    next = 2;
    const first = record(await firstP);
    let second: ProviderResult | null;
    if (first.outcome === 'ok' && first.candidates.length > 0) {
      second = await Promise.race([secondP, sleep(SECOND_OPINION_GRACE_MS)]);
      if (!second) {
        trace.push(`${usable[1]}:late(>${SECOND_OPINION_GRACE_MS}ms after first)`);
        waitUntil(secondP); // finishes in the background and fills the cache
      }
    } else {
      second = await secondP; // the first had nothing: the second is now the main answer
    }
    if (second) record(second);
    a = first.candidates;
    b = second && second.outcome === 'ok' ? second.candidates : null;
    if (a.length === 0 && b && b.length > 0) {
      a = b;
      b = null;
    }
  }

  // Fallback mode, or crosscheck where nothing was found yet: remaining providers one by one.
  while (a.length === 0 && next < usable.length && Date.now() - started < CHAIN_BUDGET_MS) {
    const r = record(await searchCached(usable[next++]!, query, config, db, now));
    a = r.candidates;
  }

  if (a.length === 0) return { candidates: [], confidence: 'low', ambiguous: false, allFailed: results.length > 0 && results.every((r) => r.outcome === 'error') };
  return { ...judge(a, b), allFailed: false };
}
