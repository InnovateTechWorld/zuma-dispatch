import { STRAIGHT_LINE_ROAD_FACTOR } from '../business/rates';
import type { Config, RouterName } from '../config';
import { haversineMeters, type LatLng } from '../lib/geo';
import { fetchJson, traceLabel } from '../lib/http';

export interface Route {
  distanceM: number;
  durationS: number | null;
  source: RouterName;
  /** True when the distance is an estimate (straight line x road factor), not a routed road distance. */
  approximate: boolean;
}

/** Average city traffic speed used for the ETA when only a straight line is known. */
const FALLBACK_SPEED_KMH = 25;

async function osrm(a: LatLng, b: LatLng, config: Config, trace: string[]): Promise<Route | null> {
  // OSRM expects lon,lat order. Public demo server: fair, non-commercial use only.
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false&alternatives=false`;
  const r = await fetchJson<{ code?: string; routes?: { distance: number; duration: number }[] }>(url, { timeoutMs: config.providerTimeoutMs });
  trace.push(traceLabel('osrm', r, r.ok ? (r.data.code ?? '') : ''));
  const route = r.ok && r.data.code === 'Ok' ? r.data.routes?.[0] : undefined;
  if (!route || !Number.isFinite(route.distance)) return null;
  return { distanceM: Math.round(route.distance), durationS: Math.round(route.duration), source: 'osrm', approximate: false };
}

async function ors(a: LatLng, b: LatLng, config: Config, trace: string[]): Promise<Route | null> {
  if (!config.orsApiKey) {
    trace.push('ors-route:skipped(no key)');
    return null;
  }
  const params = new URLSearchParams({ api_key: config.orsApiKey, start: `${a.lng},${a.lat}`, end: `${b.lng},${b.lat}` });
  const r = await fetchJson<{ features?: { properties?: { summary?: { distance?: number; duration?: number } } }[] }>(
    `https://api.openrouteservice.org/v2/directions/driving-car?${params}`,
    { timeoutMs: config.providerTimeoutMs },
  );
  trace.push(traceLabel('ors-route', r));
  const s = r.ok ? r.data.features?.[0]?.properties?.summary : undefined;
  if (!s || typeof s.distance !== 'number') return null;
  return { distanceM: Math.round(s.distance), durationS: typeof s.duration === 'number' ? Math.round(s.duration) : null, source: 'ors', approximate: false };
}

export function straightLine(a: LatLng, b: LatLng): Route {
  const d = haversineMeters(a, b) * STRAIGHT_LINE_ROAD_FACTOR;
  return { distanceM: Math.round(d), durationS: Math.round((d / 1000 / FALLBACK_SPEED_KMH) * 3600), source: 'straight_line', approximate: true };
}

/** Tries each router in ROUTER_CHAIN order. straight_line always succeeds, so put it last. */
export async function route(a: LatLng, b: LatLng, config: Config, trace: string[]): Promise<Route | null> {
  for (const name of config.routerChain) {
    const result =
      name === 'osrm' ? await osrm(a, b, config, trace) : name === 'ors' ? await ors(a, b, config, trace) : straightLine(a, b);
    if (name === 'straight_line') trace.push('straight_line:ok');
    if (result) return result;
  }
  return null;
}
