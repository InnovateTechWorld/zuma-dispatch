import type { Env } from './env';

export const GEOCODERS = ['google', 'nominatim', 'photon', 'ors'] as const;
export const ROUTERS = ['osrm', 'ors', 'straight_line'] as const;
export type GeocoderName = (typeof GEOCODERS)[number];
export type RouterName = (typeof ROUTERS)[number];

export interface Config {
  businessName: string;
  businessCity: string;
  geocoderChain: GeocoderName[];
  geocoderMode: 'fallback' | 'crosscheck';
  routerChain: RouterName[];
  quoteTtlMs: number;
  providerTimeoutMs: number;
  paystackSecretKey: string;
  nipostApiKey: string;
  orsApiKey: string | null;
  googleMapsApiKey: string | null;
  mcpBearerToken: string;
  boardToken: string;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; problems: string[] };

/**
 * Validates configuration once per request. Problems name the variable but never
 * echo its value. The server refuses to serve tools if any problem is found, which is
 * how the "test keys only" rule is enforced in code rather than by convention.
 */
export function loadConfig(env: Env): ConfigResult {
  const problems: string[] = [];

  const paystack = env.PAYSTACK_TEST_SECRET_KEY?.trim() ?? '';
  if (!paystack) problems.push('PAYSTACK_TEST_SECRET_KEY is missing');
  else if (!paystack.startsWith('sk_test_'))
    problems.push('PAYSTACK_TEST_SECRET_KEY must be a Paystack test key (sk_test_...); live keys are refused');

  const nipost = env.NIPOST_API_KEY?.trim() ?? '';
  if (!nipost) problems.push('NIPOST_API_KEY is missing');
  else if (!nipost.startsWith('nipost_test_'))
    problems.push('NIPOST_API_KEY must be a NIPOST test key (nipost_test_...); live keys are refused');

  const bearer = env.MCP_BEARER_TOKEN?.trim() ?? '';
  if (bearer.length < 32) problems.push('MCP_BEARER_TOKEN must be at least 32 characters');

  const board = env.BOARD_TOKEN?.trim() ?? '';
  if (board.length < 16) problems.push('BOARD_TOKEN must be at least 16 characters');

  const geocoderChain = parseChain(env.GEOCODER_CHAIN, GEOCODERS, 'GEOCODER_CHAIN', problems);
  const routerChain = parseChain(env.ROUTER_CHAIN, ROUTERS, 'ROUTER_CHAIN', problems);

  const mode = (env.GEOCODER_MODE ?? 'fallback').trim();
  if (mode !== 'fallback' && mode !== 'crosscheck') problems.push('GEOCODER_MODE must be "fallback" or "crosscheck"');

  const ttlMinutes = Number(env.QUOTE_TTL_MINUTES ?? '30');
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 240)
    problems.push('QUOTE_TTL_MINUTES must be an integer between 5 and 240');

  const timeoutMs = Number(env.PROVIDER_TIMEOUT_MS ?? '4000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 15000)
    problems.push('PROVIDER_TIMEOUT_MS must be an integer between 500 and 15000');

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    config: {
      businessName: env.BUSINESS_NAME || 'Zuma Dispatch',
      businessCity: env.BUSINESS_CITY || 'Abuja',
      geocoderChain,
      geocoderMode: mode as Config['geocoderMode'],
      routerChain,
      quoteTtlMs: ttlMinutes * 60_000,
      providerTimeoutMs: timeoutMs,
      paystackSecretKey: paystack,
      nipostApiKey: nipost,
      orsApiKey: env.OPENROUTE_BASIC_KEY?.trim() || null,
      googleMapsApiKey: env.GOOGLE_MAPS_API_KEY?.trim() || null,
      mcpBearerToken: bearer,
      boardToken: board,
    },
  };
}

function parseChain<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  name: string,
  problems: string[],
): T[] {
  const items = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (items.length === 0) {
    problems.push(`${name} must list at least one of: ${allowed.join(', ')}`);
    return [];
  }
  const unknown = items.filter((i) => !(allowed as readonly string[]).includes(i));
  if (unknown.length > 0) problems.push(`${name} has unknown entries: ${unknown.join(', ')}`);
  return [...new Set(items)].filter((i): i is T => (allowed as readonly string[]).includes(i));
}
