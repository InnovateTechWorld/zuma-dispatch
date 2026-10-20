import { GEOCODE_BIAS } from '../business/profile';
import type { Config, GeocoderName } from '../config';
import { inNigeria, isValidCoordinate } from '../lib/geo';
import { fetchJson, traceLabel, type HttpResult } from '../lib/http';

/** Coarseness of a result: exact building/POI, a street, a neighbourhood, or a whole LGA/city. */
export type Precision = 'exact' | 'street' | 'area' | 'lga';

export interface Candidate {
  label: string;
  lat: number;
  lng: number;
  precision: Precision;
  /** 'nipost' = the fixed FCT area-council table used for a postcode's area (src/geocode/postcode.ts). */
  provider: GeocoderName | 'nipost';
}

export interface ProviderResult {
  provider: GeocoderName;
  /** 'ok' with zero candidates means the provider answered but found nothing. */
  outcome: 'ok' | 'error' | 'skipped';
  candidates: Candidate[];
  trace: string;
}

export interface Geocoder {
  name: GeocoderName;
  /** Why the provider cannot be used with this config, or null if it can. */
  unavailable: (config: Config) => string | null;
  search: (query: string, config: Config) => Promise<ProviderResult>;
}

const MAX_CANDIDATES = 3;
const { centre } = GEOCODE_BIAS;

function keep(c: Candidate[]): Candidate[] {
  return c.filter((x) => isValidCoordinate(x) && inNigeria(x)).slice(0, MAX_CANDIDATES);
}

function failed(provider: GeocoderName, r: HttpResult<unknown>): ProviderResult {
  return { provider, outcome: 'error', candidates: [], trace: traceLabel(provider, r) };
}

// ---------------------------------------------------------------- Google Places (New)
// https://developers.google.com/maps/documentation/places/web-service/text-search
interface GooglePlace {
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
}
function googlePrecision(types: string[] = []): Precision {
  if (types.some((t) => ['street_address', 'premise', 'subpremise', 'point_of_interest', 'establishment'].includes(t))) return 'exact';
  if (types.includes('route')) return 'street';
  if (types.some((t) => t.startsWith('sublocality') || t === 'neighborhood')) return 'area';
  return 'lga';
}
const google: Geocoder = {
  name: 'google',
  unavailable: (c) => (c.googleMapsApiKey ? null : 'no GOOGLE_MAPS_API_KEY'),
  async search(query, config) {
    const r = await fetchJson<{ places?: GooglePlace[] }>('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      timeoutMs: config.providerTimeoutMs,
      headers: {
        'X-Goog-Api-Key': config.googleMapsApiKey!,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.types',
      },
      body: {
        textQuery: query,
        regionCode: 'ng',
        pageSize: MAX_CANDIDATES,
        locationBias: { circle: { center: { latitude: centre.lat, longitude: centre.lng }, radius: GEOCODE_BIAS.radiusM } },
      },
    });
    if (!r.ok) return failed('google', r);
    const candidates = keep(
      (r.data.places ?? []).map((p) => ({
        label: [p.displayName?.text, p.formattedAddress].filter(Boolean).join(', '),
        lat: p.location?.latitude as number,
        lng: p.location?.longitude as number,
        precision: googlePrecision(p.types),
        provider: 'google' as const,
      })),
    );
    return { provider: 'google', outcome: 'ok', candidates, trace: traceLabel('google', r, `${candidates.length}`) };
  },
};

// ---------------------------------------------------------------- Nominatim
// Usage policy: https://operations.osmfoundation.org/policies/nominatim/ (identifying UA, <=1 req/s, cache results)
interface NominatimPlace {
  display_name?: string;
  name?: string;
  lat?: string;
  lon?: string;
  addresstype?: string;
  category?: string;
}
function nominatimPrecision(p: NominatimPlace): Precision {
  const t = p.addresstype ?? '';
  if (['road', 'street'].includes(t)) return 'street';
  if (['suburb', 'neighbourhood', 'quarter', 'residential', 'city_district', 'hamlet', 'village'].includes(t)) return 'area';
  if (['city', 'town', 'municipality', 'county', 'state', 'region', 'country', 'state_district'].includes(t)) return 'lga';
  return 'exact';
}
let lastNominatimCall = 0;
const nominatim: Geocoder = {
  name: 'nominatim',
  unavailable: () => null,
  async search(query, config) {
    // Best-effort 1 req/s within this isolate; the D1 cache keeps repeat queries off the API entirely.
    const wait = lastNominatimCall + 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 1000)));
    lastNominatimCall = Date.now();
    const d = 0.45; // ~50 km viewbox around the centre, used as a preference (bounded=0)
    const params = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      countrycodes: 'ng',
      limit: String(MAX_CANDIDATES),
      viewbox: `${centre.lng - d},${centre.lat + d},${centre.lng + d},${centre.lat - d}`,
      bounded: '0',
      'accept-language': 'en',
    });
    const r = await fetchJson<NominatimPlace[]>(`https://nominatim.openstreetmap.org/search?${params}`, { timeoutMs: config.providerTimeoutMs });
    if (!r.ok) return failed('nominatim', r);
    const candidates = keep(
      (Array.isArray(r.data) ? r.data : []).map((p) => ({
        label: shorten(p.display_name ?? p.name ?? ''),
        lat: Number(p.lat),
        lng: Number(p.lon),
        precision: nominatimPrecision(p),
        provider: 'nominatim' as const,
      })),
    );
    return { provider: 'nominatim', outcome: 'ok', candidates, trace: traceLabel('nominatim', r, `${candidates.length}`) };
  },
};

// ---------------------------------------------------------------- Photon (komoot)
// https://photon.komoot.io/ — "please be fair"
interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, string | undefined>;
}
function photonPrecision(p: Record<string, string | undefined>): Precision {
  const key = p['osm_key'];
  const value = p['osm_value'] ?? '';
  const type = p['type'] ?? '';
  if (type === 'street' || key === 'highway') return 'street';
  if (['district', 'locality'].includes(type) || ['suburb', 'neighbourhood', 'quarter', 'residential'].includes(value)) return 'area';
  if (['city', 'county', 'state', 'country'].includes(type) || (key === 'place' && ['city', 'town', 'state'].includes(value))) return 'lga';
  return 'exact';
}
const photon: Geocoder = {
  name: 'photon',
  unavailable: () => null,
  async search(query, config) {
    const params = new URLSearchParams({ q: query, limit: String(MAX_CANDIDATES + 2), lat: String(centre.lat), lon: String(centre.lng), lang: 'en' });
    const r = await fetchJson<{ features?: PhotonFeature[] }>(`https://photon.komoot.io/api/?${params}`, { timeoutMs: config.providerTimeoutMs });
    if (!r.ok) return failed('photon', r);
    const candidates = keep(
      (r.data.features ?? [])
        .filter((f) => (f.properties?.['countrycode'] ?? '').toUpperCase() === 'NG')
        .map((f) => {
          const p = f.properties ?? {};
          const parts = [p['name'], p['street'], p['district'] ?? p['locality'], p['city'], p['state']].filter(Boolean);
          return {
            label: [...new Set(parts)].join(', '),
            lat: f.geometry?.coordinates?.[1] as number,
            lng: f.geometry?.coordinates?.[0] as number,
            precision: photonPrecision(p),
            provider: 'photon' as const,
          };
        }),
    );
    return { provider: 'photon', outcome: 'ok', candidates, trace: traceLabel('photon', r, `${candidates.length}`) };
  },
};

// ---------------------------------------------------------------- OpenRouteService (Pelias)
interface OrsFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: { label?: string; layer?: string; confidence?: number };
}
function orsPrecision(layer = ''): Precision {
  if (['venue', 'address'].includes(layer)) return 'exact';
  if (layer === 'street') return 'street';
  if (['neighbourhood', 'borough', 'microhood', 'macrohood'].includes(layer)) return 'area';
  return 'lga';
}
const ors: Geocoder = {
  name: 'ors',
  unavailable: (c) => (c.orsApiKey ? null : 'no OPENROUTE_BASIC_KEY'),
  async search(query, config) {
    const params = new URLSearchParams({
      api_key: config.orsApiKey!,
      text: query,
      'boundary.country': 'NG',
      'focus.point.lat': String(centre.lat),
      'focus.point.lon': String(centre.lng),
      size: String(MAX_CANDIDATES),
    });
    const r = await fetchJson<{ features?: OrsFeature[] }>(`https://api.openrouteservice.org/geocode/search?${params}`, {
      timeoutMs: config.providerTimeoutMs,
    });
    if (!r.ok) return failed('ors', r);
    const candidates = keep(
      (r.data.features ?? [])
        // Pelias "fallback" matches below 0.6 confidence are usually just the city centroid.
        .filter((f) => (f.properties?.confidence ?? 0) >= 0.6)
        .map((f) => ({
          label: (f.properties?.label ?? '').replace(/, Nigeria$/, ''),
          lat: f.geometry?.coordinates?.[1] as number,
          lng: f.geometry?.coordinates?.[0] as number,
          precision: orsPrecision(f.properties?.layer),
          provider: 'ors' as const,
        })),
    );
    return { provider: 'ors', outcome: 'ok', candidates, trace: traceLabel('ors', r, `${candidates.length}`) };
  },
};

/** Keeps the first few comma parts of Nominatim's very long display names. */
function shorten(displayName: string): string {
  const parts = displayName.split(',').map((s) => s.trim()).filter(Boolean);
  const withoutCountry = parts.filter((p) => p !== 'Nigeria' && !/^\d{6}$/.test(p));
  return withoutCountry.slice(0, 4).join(', ');
}

export const GEOCODERS: Record<GeocoderName, Geocoder> = { google, nominatim, photon, ors };
