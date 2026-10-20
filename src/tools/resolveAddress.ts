import { SERVICE_AREA } from '../business/profile';
import { insertPlaceStmt, type PlaceRow } from '../db/repo';
import { geocode, type Confidence } from '../geocode/chain';
import { findPostcode, lgaQuery, nipostLgaName, nipostValidity, STATES, type NipostStatus } from '../geocode/postcode';
import type { Candidate } from '../geocode/providers';
import { haversineMeters } from '../lib/geo';
import { newPlaceId } from '../lib/ids';
import { cleanText, normalizeQuery } from '../lib/text';
import { log } from '../lib/log';
import { ToolError, type ToolContext } from '../mcp/tooling';

export interface ResolveArgs {
  text: string;
  role: 'pickup' | 'dropoff';
}

const VAGUE = /^(abuja|fct|federal capital territory|nigeria|my (house|office|place|home)|here|there|home|office)$/i;

function inServiceArea(c: { lat: number; lng: number }): boolean {
  return haversineMeters(c, SERVICE_AREA.centre) <= SERVICE_AREA.radiusKm * 1000;
}

/**
 * Chord does not show the model earlier turns' tool results, so it re-resolves addresses on every
 * turn (observed in the simulator test, FIELD_NOTES #9). Returning the same answer, and therefore
 * the same place_ids, for the same text keeps quotes and bookings stable across turns.
 */
const STABLE_RESULT_MS = 6 * 60 * 60_000;

export async function resolveAddress(args: ResolveArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const text = cleanText(args.text, 300);
  const now = ctx.now();
  const stableKey = `resolve:${normalizeQuery(text)}`;
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
  let postcode: { code: string; nipost_status: NipostStatus | 'legacy_unverifiable'; area: string | null } | null = null;
  let query = text;
  let postcodeOnly = false;
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
    const areaQuery = lgaName ? lgaQuery(pc.state, lgaName) : STATES[pc.state]!;
    query = postcodeOnly ? areaQuery : `${pc.rest}, ${lgaName ?? STATES[pc.state]}`;
  } else if (pc?.kind === 'legacy') {
    postcode = { code: pc.code, nipost_status: 'legacy_unverifiable', area: null };
    if (pc.rest.length < 3) return needsDetail(args.role, text, `${pc.code} is an old 6-digit postal code, which covers a wide area.`, postcode);
    query = pc.rest;
  }

  // 2. Geocoder chain (fallback or crosscheck).
  let outcome = await geocode(query, ctx.config, ctx.db, now, ctx.trace, ctx.waitUntil);
  // A postcode with a landmark that the map doesn't know: fall back to the postcode's LGA.
  if (outcome.candidates.length === 0 && pc?.kind === 'nipost' && !postcodeOnly && postcode?.area) {
    postcodeOnly = true;
    outcome = await geocode(lgaQuery(pc.state, postcode.area.split(',')[0]!), ctx.config, ctx.db, now, ctx.trace, ctx.waitUntil);
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

  // 3. Persist every candidate so later tools can reference it by id (never by coordinates).
  // With only a postcode, the map result is just a point inside the LGA: keep one, labelled honestly.
  const picked = postcodeOnly ? outcome.candidates.slice(0, 1) : outcome.candidates;
  const rows = picked.map((c) => toRow(c, text, outcome.confidence, postcode, postcodeOnly, now));
  await ctx.db.batch(rows.map((r) => insertPlaceStmt(ctx.db, r)));

  if (outcome.ambiguous && rows.length > 1 && !postcodeOnly) {
    return {
      status: 'ambiguous',
      role: args.role,
      candidates: rows.map((r) => ({ place_id: r.id, label: r.label, in_service_area: r.in_service_area === 1 })),
      ...(postcode ? { postcode } : {}),
      what_to_do:
        'These are different places. Show the customer the labels as a short numbered list and ask which one they mean, then use that place_id. If none is right, ask for a nearby landmark and call resolve_address again.',
    };
  }

  const place = rows[0]!;
  const summary = {
    place_id: place.id,
    label: place.label,
    precision: place.precision,
    in_service_area: place.in_service_area === 1,
    km_from_city_centre: Math.round(haversineMeters(place, SERVICE_AREA.centre) / 100) / 10,
  };

  if (place.in_service_area !== 1) {
    return {
      status: 'out_of_area',
      role: args.role,
      place: summary,
      ...(postcode ? { postcode } : {}),
      service_area: SERVICE_AREA.description,
      what_to_do:
        'Tell the customer we only deliver within the Abuja metro area and name the place we found. If they need an intercity or out-of-town delivery, offer to hand them to a human dispatcher.',
    };
  }

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

  return {
    status: 'confirmed',
    role: args.role,
    place: summary,
    confidence: outcome.confidence,
    ...(postcode ? { postcode } : {}),
    what_to_do:
      place.precision === 'area'
        ? `Read the label back ("${place.label}") and ask the customer to confirm. Also ask for a landmark or street for the rider, but you can quote with this place_id.`
        : `Read the label back ("${place.label}") and ask the customer to confirm it is right before quoting.`,
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
    in_service_area: inServiceArea(c) ? 1 : 0,
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
