import { COVERAGE, SERVICE_STATES, stateOf, type ServiceState } from '../business/states';
import { insertPlaceStmt, type PlaceRow } from '../db/repo';
import { geocode, type Confidence } from '../geocode/chain';
import { areaPart, cleanedQuery, houseNumber, isRelevant } from '../geocode/query';
import type { LatLng } from '../lib/geo';
import { demoPostcode, FCT_AREA_COUNCILS, findPostcode, lgaQuery, namesLga, nipostLgaName, nipostValidity, STATES, type NipostStatus } from '../geocode/postcode';
import type { Candidate } from '../geocode/providers';
import { haversineMeters } from '../lib/geo';
import { newPlaceId } from '../lib/ids';
import { cleanText, normalizeQuery } from '../lib/text';
import { log } from '../lib/log';
import { ToolError, type ToolContext } from '../mcp/tooling';

export interface ResolveArgs {
  text: string;
  role: 'pickup' | 'dropoff';
  /** Which service state the delivery is in, once known (the other address's state). Optional. */
  state?: 'abuja' | 'lagos';
}

const VAGUE = /^(abuja|fct|federal capital territory|lagos|lagos state|eko|lasgidi|nigeria|my (house|office|place|home)|here|there|home|office)$/i;

const HINTS: Record<NonNullable<ResolveArgs['state']>, ServiceState> = { abuja: 'FC', lagos: 'LA' };

/** Distance to the centre of the state the place is in (or of the nearer service state when outside both). */
function kmFromCentre(c: LatLng): number {
  const st = stateOf(c);
  const centres = st ? [SERVICE_STATES[st].centre] : Object.values(SERVICE_STATES).map((x) => x.centre);
  return Math.round(Math.min(...centres.map((x) => haversineMeters(c, x))) / 100) / 10;
}

/**
 * With a state hint, drops matches in the OTHER service state ("Shoprite" exists in both cities).
 * Matches outside both states are kept (they become out_of_area). If nothing is left, the original
 * list is kept so the customer can be told where the place actually is. Pure, exported for tests.
 */
export function preferState<T extends LatLng>(candidates: T[], hint: ServiceState | undefined): T[] {
  if (!hint) return candidates;
  const kept = candidates.filter((c) => {
    const st = stateOf(c);
    return st === null || st === hint;
  });
  return kept.length > 0 ? kept : candidates;
}

/**
 * Chord does not show the model earlier turns' tool results, so it re-resolves addresses on every
 * turn (observed in the simulator test, FIELD_NOTES_FULL #9). Returning the same answer, and therefore
 * the same place_ids, for the same text keeps quotes and bookings stable across turns.
 */
const STABLE_RESULT_MS = 6 * 60 * 60_000;

export async function resolveAddress(args: ResolveArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const text = cleanText(args.text, 300);
  const now = ctx.now();
  // v2: postcode areas from the fixed FCT table and landmark matches limited to the postcode's area.
  // v4: service area = FCT + Lagos State (hint in the key); duplicate labels merged; all-outside matches collapsed.
  // v5: `confirm` (in_quote for demo postcodes, ask_first otherwise) added to confirmed results.
  // v8: Google Places joins the chain (GOOGLE_MAPS_API_KEY set 2026-10-22).
  // v6/v7: relevance filter (place name first), cleaned-spelling retry, area fallback, house number kept (src/geocode/query.ts).
  const stableKey = `resolve:v10:${args.state ?? 'any'}:${normalizeQuery(text)}`;
  try {
    const prior = await ctx.db
      .prepare('SELECT result_json, created_at FROM geocode_cache WHERE cache_key = ?')
      .bind(stableKey)
      .first<{ result_json: string; created_at: number }>();
    if (prior && now - prior.created_at < STABLE_RESULT_MS) {
      ctx.trace.push('resolve:stable-reuse');
      return { ...(JSON.parse(prior.result_json) as Record<string, unknown>), role: args.role };
    }
  } catch (e) {
    log('warn', 'stable_resolve_read_failed', { message: String(e) });
  }
  const result = await resolveFresh(args, text, now, ctx);
  // Only definite answers are pinned; "not found"/"needs detail" should be retried with new text anyway.
  if (result['status'] === 'confirmed' || result['status'] === 'ambiguous' || result['status'] === 'out_of_area') {
    await ctx.db
      .prepare('INSERT INTO geocode_cache (cache_key, provider, result_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET result_json = excluded.result_json, created_at = excluded.created_at')
      .bind(stableKey, 'resolve', JSON.stringify(result), now)
      .run()
      .catch((e: unknown) => log('warn', 'stable_resolve_write_failed', { message: String(e) }));
  }
  return result;
}

async function resolveFresh(args: ResolveArgs, text: string, now: number, ctx: ToolContext): Promise<Record<string, unknown>> {
  if (text.length < 2 || VAGUE.test(text.replace(/[.!]+$/, ''))) {
    return needsDetail(args.role, text, 'That is too general to find on a map.');
  }

  // 1. NIPOST postcode, if the customer gave one.
  const pc = findPostcode(text);
  const hint: ServiceState | undefined = args.state ? HINTS[args.state] : undefined;
  // A postcode names its state: bias the map search there (FC and LA are ours; others stay unbiased → out of area).
  const bias: ServiceState | undefined = pc?.kind === 'nipost' && (pc.state === 'FC' || pc.state === 'LA') ? pc.state : hint;
  let postcode: { code: string; nipost_status: NipostStatus | 'legacy_unverifiable'; area: string | null } | null = null;
  let query = text;
  let postcodeOnly = false;
  let areaPoint: Candidate | null = null;
  // A demo postcode (test keys only) is an exact, known place: answer it directly (see DEMO_POSTCODES).
  const demo = pc?.kind === 'nipost' ? demoPostcode(pc.code, ctx.config.nipostApiKey) : null;
  if (pc?.kind === 'nipost' && demo) {
    const demoPostcodeInfo = { code: pc.code, nipost_status: 'demo' as const, area: `${demo.lga}, ${STATES[pc.state]}` };
    const row = toRow({ label: demo.label, lat: demo.lat, lng: demo.lng, precision: 'exact', provider: 'nipost' }, text, 'high', demoPostcodeInfo, false, now);
    await ctx.db.batch([insertPlaceStmt(ctx.db, row)]);
    ctx.trace.push('nipost:demo-postcode');
    return {
      status: 'confirmed',
      role: args.role,
      place: { place_id: row.id, label: row.label, precision: row.precision, state: stateName(row), in_service_area: row.in_service_area === 1, km_from_city_centre: kmFromCentre(row) },
      confidence: 'high',
      postcode: demoPostcodeInfo,
      ...demoConfirm(row, hint),
    };
  }
  if (pc?.kind === 'nipost') {
    const [validity, lgaName] = await Promise.all([
      nipostValidity(pc.code, ctx.config, ctx.trace),
      nipostLgaName(pc.state, pc.lga, ctx.config, ctx.db, now, ctx.trace),
    ]);
    const area = lgaName ? `${lgaName}, ${STATES[pc.state]}` : STATES[pc.state] ?? null;
    postcode = { code: pc.code, nipost_status: validity, area };
    if (validity === 'invalid') {
      return {
        status: 'not_found',
        role: args.role,
        postcode,
        what_to_do: `NIPOST says ${pc.code} is not a valid postcode. Ask the customer to check it, or to describe the place with a landmark and area instead.`,
      };
    }
    postcodeOnly = pc.rest.length < 3;
    areaPoint = await postcodeArea(pc.state, pc.lga, lgaName, ctx, now, bias);
    const areaQuery = lgaName ? lgaQuery(pc.state, lgaName) : STATES[pc.state]!;
    query = postcodeOnly ? areaQuery : `${pc.rest}, ${lgaName ?? STATES[pc.state]}`;
  } else if (pc?.kind === 'legacy') {
    postcode = { code: pc.code, nipost_status: 'legacy_unverifiable', area: null };
    if (pc.rest.length < 3) return needsDetail(args.role, text, `${pc.code} is an old 6-digit postal code, which covers a wide area.`, postcode);
    query = pc.rest;
  }

  // 2. Geocoder chain (fallback or crosscheck). A postcode on its own is answered from its area point.
  const areaOutcome = (p: Candidate) => ({ candidates: [p], confidence: 'medium' as Confidence, ambiguous: false, allFailed: false });
  let outcome = postcodeOnly && areaPoint ? areaOutcome(areaPoint) : await geocode(query, ctx.config, ctx.db, now, ctx.trace, ctx.waitUntil, bias);
  if (!postcodeOnly && hint) {
    const kept = preferState(outcome.candidates, hint);
    outcome = { ...outcome, candidates: kept, ambiguous: outcome.ambiguous && kept.length > 1 };
  }
  // A postcode says which LGA the place is in. Map results far from that LGA are other places with the
  // same name ("Abaji General Hospital" came back as Wuse's and a Bauchi hospital): drop them.
  if (areaPoint && !postcodeOnly && outcome.candidates.length > 0) {
    const kept = withinKm(outcome.candidates, areaPoint, POSTCODE_AREA_KM);
    outcome = { ...outcome, candidates: kept, ambiguous: outcome.ambiguous && kept.length > 1 };
  }
  // Free text only (postcodes have their own area logic): drop matches that share no distinctive word with
  // what the customer typed, then, if nothing is left, retry with a cleaned spelling and, in parallel, the
  // area they named. See src/geocode/query.ts for the live case behind each step.
  let areaFallback: string | null = null;
  if (!pc) {
    const relevant = (o: typeof outcome, ref: string) => {
      const named = o.candidates.filter((c) => isRelevant(c.label, ref));
      // When the customer's city has matches, places elsewhere are other places with the same name.
      const inCity = hint ? named.filter((c) => stateOf(c) === hint) : [];
      return inCity.length ? inCity : named;
    };
    const kept = relevant(outcome, query);
    if (kept.length !== outcome.candidates.length) ctx.trace.push(`relevance:dropped:${outcome.candidates.length - kept.length}`);
    outcome = { ...outcome, candidates: kept, ambiguous: outcome.ambiguous && kept.length > 1 };
    // The customer said which city, but every match is somewhere else ("St. Finbarr's Church, Jos" for an
    // Akoka address): try the cleaned spelling and the area first; keep the far-away match only if those fail.
    const onlyElsewhere = Boolean(hint) && kept.length > 0 && kept.every((c) => stateOf(c) !== hint);
    if ((kept.length === 0 || onlyElsewhere) && !outcome.allFailed) {
      const cleaned = cleanedQuery(query);
      const area = areaPart(query);
      const cityName = hint === 'LA' ? 'Lagos' : hint === 'FC' ? 'Abuja' : '';
      const [c, a] = await Promise.all([
        cleaned ? geocode(cleaned, ctx.config, ctx.db, now, ctx.trace, ctx.waitUntil, bias) : Promise.resolve(null),
        area ? geocode(cityName && !area.includes(cityName.toLowerCase()) ? `${area}, ${cityName}` : area, ctx.config, ctx.db, now, ctx.trace, ctx.waitUntil, bias) : Promise.resolve(null),
      ]);
      const cKept = c && cleaned ? relevant(c, cleaned) : [];
      const aKept = a && area ? relevant(a, area) : [];
      const inHint = (xs: Candidate[]) => (hint ? xs.filter((x) => stateOf(x) === hint) : xs);
      if (onlyElsewhere && !inHint(cKept).length && !inHint(aKept).length) {
        // Nothing better nearby: keep the original matches (reported as out of area below).
      } else if (inHint(cKept).length || (!onlyElsewhere && cKept.length)) {
        ctx.trace.push('query:cleaned');
        const use = onlyElsewhere ? inHint(cKept) : cKept;
        outcome = { ...c!, candidates: use, ambiguous: c!.ambiguous && use.length > 1 };
      } else if (inHint(aKept).length) {
        ctx.trace.push('query:area-fallback');
        areaFallback = area;
        outcome = { candidates: [{ ...inHint(aKept)[0]!, precision: 'area' }], confidence: 'low', ambiguous: false, allFailed: false };
      } else if (!onlyElsewhere && (c?.allFailed ?? true) && (a?.allFailed ?? true) && (c || a)) {
        outcome = { ...outcome, allFailed: true };
      }
    }
    // The rider needs the house number the customer gave; the map only knows the street.
    const hn = houseNumber(text);
    const isStreet = (x: Candidate) => x.precision === 'street' || /\b(road|rd|street|avenue|close|crescent|drive|way|lane)\b/i.test(x.label.split(',')[0] ?? '');
    if (hn && !areaFallback) outcome = { ...outcome, candidates: outcome.candidates.map((x) => (isStreet(x) && !x.label.startsWith(hn) ? { ...x, label: `${hn} ${x.label}` } : x)) };
  }

  // A postcode with a landmark that the map doesn't know (in that area): fall back to the postcode's area.
  if (outcome.candidates.length === 0 && pc?.kind === 'nipost' && !postcodeOnly && postcode?.area) {
    postcodeOnly = true;
    outcome = areaPoint ? areaOutcome(areaPoint) : await geocode(lgaQuery(pc.state, postcode.area.split(',')[0]!), ctx.config, ctx.db, now, ctx.trace, ctx.waitUntil, bias);
  }

  if (outcome.candidates.length === 0) {
    if (outcome.allFailed) {
      throw new ToolError(
        'GEOCODER_UNAVAILABLE',
        'The map services did not respond.',
        'Apologise and try this tool once more. If it fails again, hand the conversation to a human dispatcher; do not guess the location.',
        true,
      );
    }
    return {
      status: 'not_found',
      role: args.role,
      ...(postcode ? { postcode } : {}),
      what_to_do:
        'We could not find that place. Ask for a well-known landmark nearby (market, school, bank, filling station, estate gate) or the street and area name. After two failed attempts, hand over to a human dispatcher.',
    };
  }

  // Same label twice (e.g. a town and its LGA centroid, both "Badagry, Lagos State") would give the
  // customer two identical choices: keep the first.
  const seen = new Set<string>();
  const unique = outcome.candidates.filter((c) => {
    const k = c.label.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Every match is outside both states ("Ota" → two places in Ogun): no point asking which, say where it is.
  const allOutside = unique.length > 0 && unique.every((c) => !stateOf(c));
  const kept = allOutside ? unique.slice(0, 1) : unique;
  outcome = { ...outcome, candidates: kept, ambiguous: outcome.ambiguous && kept.length > 1 };

  // 3. Persist every candidate so later tools can reference it by id (never by coordinates).
  // With only a postcode, the map result is just a point inside the LGA: keep one, labelled honestly.
  const picked = postcodeOnly ? outcome.candidates.slice(0, 1) : outcome.candidates;
  const rows = picked.map((c) => toRow(c, text, outcome.confidence, postcode, postcodeOnly, now));
  await ctx.db.batch(rows.map((r) => insertPlaceStmt(ctx.db, r)));

  if (outcome.ambiguous && rows.length > 1 && !postcodeOnly) {
    return {
      status: 'ambiguous',
      role: args.role,
      candidates: rows.map((r) => ({ place_id: r.id, label: r.label, state: stateName(r), in_service_area: r.in_service_area === 1 })),
      ...(postcode ? { postcode } : {}),
      what_to_do:
        'These are different places. Show the customer the labels as a short numbered list and ask which one they mean, then use that place_id. If none is right, ask for a nearby landmark and call resolve_address again.',
    };
  }

  const place = rows[0]!;
  const placeState = stateOf(place);
  const summary = {
    place_id: place.id,
    label: place.label,
    precision: place.precision,
    state: stateName(place),
    in_service_area: place.in_service_area === 1,
    km_from_city_centre: kmFromCentre(place),
  };

  if (place.in_service_area !== 1) {
    return {
      status: 'out_of_area',
      role: args.role,
      place: summary,
      ...(postcode ? { postcode } : {}),
      service_area: COVERAGE,
      what_to_do:
        'Tell the customer we deliver only within Abuja (the FCT) and within Lagos State, and name the place we found. For anywhere else, or a delivery between states, offer to hand them to a human dispatcher.',
    };
  }

  // The other address is in a different service state: this would be an interstate delivery.
  const interstate = hint && placeState && placeState !== hint
    ? ` Note: this is in ${SERVICE_STATES[placeState].name}, but the other address is in ${SERVICE_STATES[hint].name}. We only deliver within one state: if both are right, tell the customer we cannot carry it between states and offer a human dispatcher.`
    : '';

  if (place.precision === 'lga') {
    return needsDetail(
      args.role,
      text,
      postcodeOnly && postcode?.area
        ? `The postcode places this in ${postcode.area}, which is too wide an area for a rider.`
        : 'That only narrows it to a whole district.',
      postcode,
      summary,
    );
  }

  if (areaFallback) {
    return {
      status: 'confirmed',
      role: args.role,
      place: summary,
      confidence: 'low',
      confirm: 'ask_first',
      what_to_do: `"${text}" itself is not on the map; only the area was found: "${place.label}". Tell the customer that simply, read the area back, and ask for the street or a well-known landmark nearby for the rider (you can quote with this place_id once they confirm the area).${interstate}`,
    };
  }
  return {
    status: 'confirmed',
    role: args.role,
    place: summary,
    confidence: outcome.confidence,
    ...(postcode ? { postcode } : {}),
    // Map results can be the wrong place with the right name ("Yaba Market" → Yaba College), even when two
    // providers agree, so every one of them is confirmed on its own before quoting.
    confirm: 'ask_first',
    what_to_do:
      place.precision === 'area'
        ? `Read the label back ("${place.label}") and ask the customer to confirm it before quoting. Also ask for a landmark or street for the rider, but you can quote with this place_id.${interstate}`
        : `Read the label back ("${place.label}") and ask the customer to confirm it is right before quoting.${interstate}`,
  };
}

/**
 * A demo postcode names one exact, known place, so it needs no question of its own (the fast path):
 * the quote message reads it back and the customer confirms it there together with the booking.
 * An address in the other state never takes the fast path: that has to be said first.
 */
export function demoConfirm(row: { label: string; lat: number; lng: number }, hint: ServiceState | null | undefined): { confirm: 'in_quote' | 'ask_first'; what_to_do: string } {
  const st = stateOf(row);
  if (hint && st && st !== hint) {
    return {
      confirm: 'ask_first',
      what_to_do: `Read the label back ("${row.label}"). Note: this is in ${SERVICE_STATES[st].name}, but the other address is in ${SERVICE_STATES[hint].name}. We only deliver within one state: tell the customer we cannot carry it between states and offer a human dispatcher.`,
    };
  }
  return {
    confirm: 'in_quote',
    what_to_do: `Exact place from the postcode: "${row.label}". Do not ask about this address on its own. Once you have both addresses and the package size, call quote_delivery: the quote message reads this address back and the customer confirms the addresses and the booking with one yes.`,
  };
}

function toRow(
  c: Candidate,
  query: string,
  confidence: Confidence,
  postcode: { code: string; nipost_status: string; area: string | null } | null,
  postcodeOnly: boolean,
  now: number,
): PlaceRow {
  return {
    id: newPlaceId(),
    query_text: query,
    label: (postcodeOnly && postcode?.area ? `${postcode.area} (area of postcode ${postcode.code})` : c.label).slice(0, 200) || query,
    lat: c.lat,
    lng: c.lng,
    precision: postcodeOnly ? 'lga' : c.precision,
    postcode: postcode?.code ?? null,
    postcode_status: postcode?.nipost_status ?? null,
    provider: c.provider,
    confidence,
    in_service_area: stateOf(c) ? 1 : 0,
    state: stateOf(c),
    created_at: now,
  };
}

function needsDetail(
  role: string,
  text: string,
  why: string,
  postcode?: unknown,
  place?: unknown,
): Record<string, unknown> {
  return {
    status: 'needs_detail',
    role,
    ...(place ? { place } : {}),
    ...(postcode ? { postcode } : {}),
    what_to_do: `${why} Ask the customer for the street, estate or a nearby landmark${role === 'pickup' ? ' where the rider should collect the package' : ' where the package should be delivered'}, then call resolve_address again with the fuller address. Do not quote yet.`,
    received: text,
  };
}

/** How far from the postcode's LGA centre a match may be. FCT's largest area councils are ~50 km across. */
export const POSTCODE_AREA_KM = 35;

/** Keeps candidates within `km` of a point. Pure, exported for tests. */
export function withinKm<T extends LatLng>(candidates: T[], centre: LatLng, km: number): T[] {
  return candidates.filter((c) => haversineMeters(c, centre) <= km * 1000);
}

/**
 * Where a NIPOST postcode's LGA is. FCT: the fixed area-council table. Elsewhere: the geocoder, but only
 * a result whose label names the LGA (otherwise null, and the caller geocodes the text as before).
 */
async function postcodeArea(state: string, lga: string, lgaName: string | null, ctx: ToolContext, now: number, bias?: ServiceState): Promise<Candidate | null> {
  const fct = state === 'FC' ? FCT_AREA_COUNCILS[lga] : undefined;
  if (fct) return { label: `${fct.name}, ${STATES.FC}`, lat: fct.lat, lng: fct.lng, precision: 'lga', provider: 'nipost' };
  if (!lgaName) return null;
  const r = await geocode(lgaQuery(state, lgaName), ctx.config, ctx.db, now, ctx.trace, ctx.waitUntil, bias);
  return r.candidates.find((c) => namesLga(c.label, lgaName)) ?? null;
}

/** "Abuja (FCT)", "Lagos", or null when outside both. */
function stateName(p: LatLng): string | null {
  const st = stateOf(p);
  return st ? SERVICE_STATES[st].name : null;
}
