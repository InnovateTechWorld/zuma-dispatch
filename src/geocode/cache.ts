import { log } from '../lib/log';

/**
 * D1-backed cache for provider responses. Required by Nominatim's usage policy, keeps us
 * inside free quotas, and makes repeated demo runs fast and deterministic.
 * Google's terms allow caching coordinates for up to 30 days, which bounds the TTL.
 */
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 24 * 60 * 60 * 1000;

export async function cacheGet<T>(db: D1Database, key: string, now: number): Promise<T | null> {
  try {
    const row = await db
      .prepare('SELECT result_json, created_at FROM geocode_cache WHERE cache_key = ?')
      .bind(key)
      .first<{ result_json: string; created_at: number }>();
    if (!row) return null;
    const value = JSON.parse(row.result_json) as T;
    const empty = Array.isArray(value) && value.length === 0;
    if (now - row.created_at > (empty ? EMPTY_TTL_MS : HIT_TTL_MS)) return null;
    return value;
  } catch (e) {
    log('warn', 'cache_read_failed', { message: String(e) });
    return null; // a cache failure must never fail the tool
  }
}

export async function cachePut(db: D1Database, key: string, provider: string, value: unknown, now: number): Promise<void> {
  try {
    await db
      .prepare(
        'INSERT INTO geocode_cache (cache_key, provider, result_json, created_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(cache_key) DO UPDATE SET result_json = excluded.result_json, created_at = excluded.created_at',
      )
      .bind(key, provider, JSON.stringify(value), now)
      .run();
  } catch (e) {
    log('warn', 'cache_write_failed', { message: String(e) });
  }
}
