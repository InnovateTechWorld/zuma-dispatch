import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Env } from '../../src/env';

/**
 * A D1 stand-in over Node's built-in SQLite (D1 is SQLite), with the schema built from our real
 * migrations, so SQL is tested exactly as production runs it.
 */
export function d1(): { env: Env; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(`migrations/${f}`, 'utf8'));
  const isRead = (sql: string) => /^\s*(SELECT|WITH)\b/i.test(sql);
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => {
      if (isRead(sql)) return { results: db.prepare(sql).all(...(args as never[])) as unknown[], success: true, meta: {} };
      const r = db.prepare(sql).run(...(args as never[]));
      return { results: [], success: true, meta: { changes: Number(r.changes) } };
    },
    first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...(args as never[]));
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  const D1 = {
    prepare: (sql: string) => stmt(sql),
    // D1 runs a batch as one transaction: all or nothing.
    batch: async (list: ReturnType<typeof stmt>[]) => {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of list) out.push(await s.all());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { db, env: { DB: D1 } as unknown as Env };
}

/** Epoch ms for a WAT wall-clock time. */
export const wat = (iso: string) => Date.parse(`${iso}+01:00`);

let n = 0;
export function addJob(db: DatabaseSync, o: { booked: string | number; status?: string; paid?: string; delivered?: string; kobo?: number; km?: number; state?: 'FC' | 'LA'; sender?: string; recipient?: string }): string {
  n++;
  const id = `ZD-T${String(n).padStart(4, '0')}`;
  const created = typeof o.booked === 'number' ? o.booked : wat(o.booked);
  db.prepare(`INSERT INTO places (id, query_text, label, lat, lng, precision, provider, confidence, in_service_area, created_at, state) VALUES (?, 'x', ?, 6.5, 3.4, 'exact', 'test', 'high', 1, ?, ?)`).run(`P-A${n}`, `Pickup ${n}`, created, o.state ?? 'LA');
  db.prepare(`INSERT INTO places (id, query_text, label, lat, lng, precision, provider, confidence, in_service_area, created_at, state) VALUES (?, 'x', ?, 6.5, 3.4, 'exact', 'test', 'high', 1, ?, ?)`).run(`P-B${n}`, `Dropoff ${n}`, created, o.state ?? 'LA');
  db.prepare(`INSERT INTO quotes (id, pickup_place_id, dropoff_place_id, package_size, distance_m, distance_source, approximate, amount_kobo, breakdown_json, rate_card_version, created_at, expires_at)
              VALUES (?, ?, ?, 'small', ?, 'osrm', 0, ?, '[]', 'v', ?, ?)`).run(`Q-${n}`, `P-A${n}`, `P-B${n}`, (o.km ?? 5) * 1000, o.kobo ?? 150_000, created, created + 1);
  db.prepare(`INSERT INTO jobs (id, quote_id, sender_name, recipient_name, recipient_phone, amount_kobo, status, handover_code, created_at, updated_at, paid_at)
              VALUES (?, ?, ?, ?, '+2348035182746', ?, ?, '1234', ?, ?, ?)`).run(id, `Q-${n}`, o.sender ?? 'Ada', o.recipient ?? 'Bola', o.kobo ?? 150_000, o.status ?? 'awaiting_payment', created, created, o.paid ? wat(o.paid) : null);
  if (o.delivered) db.prepare(`INSERT INTO job_events (job_id, type, from_status, to_status, actor, created_at) VALUES (?, 'status_changed', 'dispatched', 'delivered', 'dispatcher', ?)`).run(id, wat(o.delivered));
  return id;
}
