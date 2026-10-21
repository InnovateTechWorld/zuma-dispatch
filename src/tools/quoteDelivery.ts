import { pickupWindow } from '../business/profile';
import { COVERAGE, SERVICE_STATES, stateOf } from '../business/states';
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

/** A place the customer gave as a demo postcode: exact, and never asked about separately (resolve_address `confirm: in_quote`). */
export const confirmedInQuote = (p: Pick<PlaceRow, 'postcode_status' | 'precision'>) => p.postcode_status === 'demo' && p.precision === 'exact';

/**
 * The question that ends the quote message. It only confirms; booking comes after the customer's
 * details, so it never says "I will book it". When an address has not been checked on its own yet,
 * it asks about the addresses too.
 */
export const ADDRESS_CHECK_QUESTION = 'Are both addresses right? If yes, just reply YES. If one is wrong, tell me which one and I\'ll fix it.';
export const BOOK_QUESTION = 'Does this look right? Just reply YES to continue.';
/** What to ask after the YES: one short list, only the items still missing. */
export const DETAILS_ASK = 'Perfect! To book it, I just need:\n1. Your name\n2. The recipient\'s name\n3. The recipient\'s phone number';

export function quoteView(q: QuoteRow, pickup: PlaceRow, dropoff: PlaceRow, now: number, reused: boolean): Record<string, unknown> {
  const size = SIZES[q.package_size];
  const checkAddresses = confirmedInQuote(pickup) || confirmedInQuote(dropoff);
  const closing = checkAddresses ? ADDRESS_CHECK_QUESTION : BOOK_QUESTION;
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
    addresses_confirmed_in_this_message: checkAddresses,
    closing_question: closing,
    details_question: DETAILS_ASK,
    what_to_do: [
      `In one message, read back on separate lines: "Pickup: ${pickup.label}", "Drop-off: ${dropoff.label}", the ${q.package_size} package, the total ${formatNaira(q.amount_kobo)}, and the line "Quote ref ${q.id}" (it shows in later turns that this price came from the tool).`,
      q.approximate === 1 ? 'Say the distance is estimated because the route service was unavailable.' : '',
      window.now ? '' : `Mention: ${window.note}`,
      `End the message with exactly: "${closing}"`,
      checkAddresses
        ? 'A clear yes confirms both addresses and the price. If they say an address is wrong (or just "no"), ask which one if unclear, resolve it again and send a new quote. A size change, a question or "hmm" is not a yes: answer or re-quote, then ask again.'
        : 'A clear yes confirms the price. A size change, a question or "hmm" is not a yes: answer or re-quote, then ask again.',
      `After the yes, if you do not yet have the sender's name, the recipient's name and the recipient's phone, ask only for the missing ones in one short numbered list, like: "${DETAILS_ASK.replaceAll('\n', ' / ')}". When you have all three, call create_dispatch_job (customer_confirmed: true) without asking again.`,
      'Never change this price.',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

export async function quoteDelivery(args: QuoteArgs, ctx: ToolContext): Promise<Record<string, unknown>> {
  const now = ctx.now();
  const [pickup, dropoff] = await Promise.all([loadPlace(ctx, args.pickup_place_id, 'pickup'), loadPlace(ctx, args.dropoff_place_id, 'dropoff')]);

  // The state is computed from the coordinates (not the stored flag), so places resolved under the
  // old 40 km Abuja radius are judged by today's rule.
  for (const [p, role] of [[pickup, 'pickup'], [dropoff, 'drop-off']] as const) {
    if (!stateOf(p)) {
      throw new ToolError(
        'OUT_OF_SERVICE_AREA',
        `The ${role} (${p.label}) is outside our service area.`,
        `Tell the customer: ${COVERAGE} Offer a human dispatcher for anywhere else.`,
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
  const from = stateOf(pickup)!;
  const to = stateOf(dropoff)!;
  if (from !== to) {
    throw new ToolError(
      'INTERSTATE_NOT_SUPPORTED',
      `The pickup is in ${SERVICE_STATES[from].name} and the drop-off is in ${SERVICE_STATES[to].name}.`,
      `Tell the customer we deliver within one state only (within Abuja, or within Lagos), not between states. Offer a human dispatcher if they need it carried between ${SERVICE_STATES[from].name} and ${SERVICE_STATES[to].name}.`,
    );
  }

  const straight = haversineMeters(pickup, dropoff);
  if (pickup.id === dropoff.id || straight < MIN_DISTANCE_M) {
    throw new ToolError(
      'SAME_LOCATION',
      'Pickup and drop-off are the same place (or less than 150 m apart).',
      'Check with the customer: the two addresses look identical. Ask for the correct drop-off.',
    );
  }

  // Same places + size + rate card, still valid, and not yet booked: return the existing quote so the
  // price is stable across turns. A quote that already has a job is never handed out again: two
  // customers asking for the same trip must not share one quote (and so one booking).
  const existing = await ctx.db
    .prepare(
      'SELECT * FROM quotes WHERE pickup_place_id = ? AND dropoff_place_id = ? AND package_size = ? AND rate_card_version = ? AND expires_at > ? ' +
        'AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.quote_id = quotes.id) ORDER BY created_at DESC LIMIT 1',
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
