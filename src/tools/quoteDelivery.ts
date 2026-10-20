import { pickupWindow, SERVICE_AREA } from '../business/profile';
import { MAX_ROAD_KM, MIN_DISTANCE_M, priceTrip, RATE_CARD_VERSION, SIZES, type PackageSize } from '../business/rates';
import { getPlace, type PlaceRow, type QuoteRow } from '../db/repo';
import { haversineMeters } from '../lib/geo';
import { newQuoteId, normalizeId } from '../lib/ids';
import { formatNaira } from '../lib/money';
import { ToolError, type ToolContext } from '../mcp/tooling';
import { route } from '../routing/route';

export interface QuoteArgs {
  pickup_place_id: string;
  dropoff_place_id: string;
  package_size: PackageSize;
}

async function loadPlace(ctx: ToolContext, raw: string, role: 'pickup' | 'dropoff'): Promise<PlaceRow> {
  const id = normalizeId(raw, 'P', 8);
  const place = id ? await getPlace(ctx.db, id) : null;
  if (!place) {
    throw new ToolError(
      'PLACE_NOT_FOUND',
      `No ${role} place with id "${raw}".`,
      `Call resolve_address for the ${role} first and use the place_id it returns. Never make up a place_id.`,
    );
  }
  return place;
}

export function quoteView(q: QuoteRow, pickup: PlaceRow, dropoff: PlaceRow, now: number, reused: boolean): Record<string, unknown> {
  const size = SIZES[q.package_size];
  const window = pickupWindow(now);
  const minutesLeft = Math.max(0, Math.round((q.expires_at - now) / 60000));
  return {
    quote_id: q.id,
    total: formatNaira(q.amount_kobo),
    total_kobo: q.amount_kobo,
    currency: 'NGN',
    breakdown: JSON.parse(q.breakdown_json),
    package: size.label,
    vehicle: size.vehicle,
    pickup: pickup.label,
    dropoff: dropoff.label,
    distance_km: Math.round(q.distance_m / 100) / 10,
    approximate_distance: q.approximate === 1,
    eta_minutes: q.duration_s ? Math.max(10, Math.round(q.duration_s / 60)) : null,
    valid_for_minutes: minutesLeft,
    pickup_timing: window.note,
    reused_existing_quote: reused,
    what_to_do: [
      `Read back: pickup "${pickup.label}", drop-off "${dropoff.label}", ${q.package_size} package, total ${formatNaira(q.amount_kobo)}.`,
      q.approximate === 1 ? 'Say the distance is estimated because the route service was unavailable.' : '',
      window.now ? '' : `Mention: ${window.note}`,
      'Ask "Shall I book it?" and wait for a clear yes before calling create_dispatch_job. Never change this price.',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

export async function quoteDelivery(args: QuoteArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const now = ctx.now();
  const [pickup, dropoff] = await Promise.all([loadPlace(ctx, args.pickup_place_id, 'pickup'), loadPlace(ctx, args.dropoff_place_id, 'dropoff')]);

  for (const [p, role] of [[pickup, 'pickup'], [dropoff, 'drop-off']] as const) {
    if (p.in_service_area !== 1) {
      throw new ToolError(
        'OUT_OF_SERVICE_AREA',
        `The ${role} (${p.label}) is outside our service area.`,
        `Tell the customer we deliver only within ${SERVICE_AREA.description} Offer a human dispatcher for out-of-town requests.`,
      );
    }
    if (p.precision === 'lga') {
      throw new ToolError(
        'PLACE_TOO_VAGUE',
        `The ${role} (${p.label}) is only known to district level.`,
        `Ask the customer for a street, estate or landmark for the ${role} and call resolve_address again.`,
      );
    }
  }

  const straight = haversineMeters(pickup, dropoff);
  if (pickup.id === dropoff.id || straight < MIN_DISTANCE_M) {
    throw new ToolError(
      'SAME_LOCATION',
      'Pickup and drop-off are the same place (or less than 150 m apart).',
      'Check with the customer: the two addresses look identical. Ask for the correct drop-off.',
    );
  }

  // Same places + size + rate card, still valid: return the existing quote so the price is stable.
  const existing = await ctx.db
    .prepare(
      'SELECT * FROM quotes WHERE pickup_place_id = ? AND dropoff_place_id = ? AND package_size = ? AND rate_card_version = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
    )
    .bind(pickup.id, dropoff.id, args.package_size, RATE_CARD_VERSION, now + 5 * 60_000)
    .first<QuoteRow>();
  if (existing) return quoteView(existing, pickup, dropoff, now, true);

  const r = await route(pickup, dropoff, ctx.config, ctx.trace);
  if (!r) {
    throw new ToolError(
      'ROUTING_UNAVAILABLE',
      'No route service is available.',
      'Apologise and try once more. If it fails again, hand the conversation to a human dispatcher.',
      true,
    );
  }
  if (r.distanceM / 1000 > MAX_ROAD_KM) {
    throw new ToolError(
      'TRIP_TOO_LONG',
      `The road distance is about ${Math.round(r.distanceM / 1000)} km, beyond our ${MAX_ROAD_KM} km limit.`,
      'Tell the customer this trip is too long for same-day dispatch and offer a human dispatcher.',
    );
  }

  const price = priceTrip(args.package_size, r.distanceM);
  const quote: QuoteRow = {
    id: newQuoteId(),
    pickup_place_id: pickup.id,
    dropoff_place_id: dropoff.id,
    package_size: args.package_size,
    distance_m: r.distanceM,
    duration_s: r.durationS,
    distance_source: r.source,
    approximate: r.approximate ? 1 : 0,
    amount_kobo: price.totalKobo,
    currency: 'NGN',
    breakdown_json: JSON.stringify(price.lines),
    rate_card_version: RATE_CARD_VERSION,
    created_at: now,
    expires_at: now + ctx.config.quoteTtlMs,
  };
  await ctx.db
    .prepare(
      'INSERT INTO quotes (id, pickup_place_id, dropoff_place_id, package_size, distance_m, duration_s, distance_source, approximate, amount_kobo, currency, breakdown_json, rate_card_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      quote.id, quote.pickup_place_id, quote.dropoff_place_id, quote.package_size, quote.distance_m, quote.duration_s,
      quote.distance_source, quote.approximate, quote.amount_kobo, quote.currency, quote.breakdown_json,
      quote.rate_card_version, quote.created_at, quote.expires_at,
    )
    .run();
  return quoteView(quote, pickup, dropoff, now, false);
}
