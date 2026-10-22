import { stateOf, type ServiceState } from './states';

/**
 * Made-up rider roster (test data only, like the business). A rider is assigned the moment a job is
 * paid, so the confirmation can say who is coming. Small and medium packages go by motorbike, large by
 * car (rate card). Dispatchers still mark "dispatched" (picked up) and "delivered" on the board.
 */
export interface Rider {
  id: string;
  name: string;
  vehicle: 'motorbike' | 'car';
  plate: string;
  /** Placeholder number (E.164) in an obviously fake block (0800 000 01xx): the riders are made up, and a
   *  realistic number could belong to a stranger. A real roster would carry each rider's own phone. */
  phone: string;
  state: ServiceState;
}

export const RIDERS: Rider[] = [
  { id: 'R-FC1', name: 'Musa Ibrahim', vehicle: 'motorbike', plate: 'ABJ 482 KT', phone: '+2348000000101', state: 'FC' },
  { id: 'R-FC2', name: 'Chidi Okeke', vehicle: 'motorbike', plate: 'ABJ 219 LM', phone: '+2348000000102', state: 'FC' },
  { id: 'R-FC3', name: 'Aisha Bello', vehicle: 'car', plate: 'ABJ 731 GW', phone: '+2348000000103', state: 'FC' },
  { id: 'R-LA1', name: 'Tunde Bakare', vehicle: 'motorbike', plate: 'LSD 553 XA', phone: '+2348000000104', state: 'LA' },
  { id: 'R-LA2', name: 'Emeka Nwosu', vehicle: 'motorbike', plate: 'KJA 108 BR', phone: '+2348000000105', state: 'LA' },
  { id: 'R-LA3', name: 'Funke Adeyemi', vehicle: 'car', plate: 'LND 664 EY', phone: '+2348000000106', state: 'LA' },
];

export const riderById = (id: string | null | undefined) => (id ? RIDERS.find((r) => r.id === id) ?? null : null);

/** "+2348000000104" → "0800 000 0104". */
export const riderPhone = (r: Rider) => { const d = r.phone.replace(/^\+234/, ''); return `0${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`; };

/** Rider details shown to the customer once the job is paid: first name, vehicle, plate and phone. */
export function riderView(id: string | null | undefined): { name: string; vehicle: string; plate: string; phone: string } | null {
  const r = riderById(id);
  return r ? { name: r.name.split(' ')[0]!, vehicle: r.vehicle, plate: r.plate, phone: riderPhone(r) } : null;
}

/** "You can call Tunde on 0800 000 0104." */
export const riderContact = (r: Rider) => `You can call ${r.name.split(' ')[0]} on ${riderPhone(r)}.`;

/** "Tunde (motorbike, LSD 553 XA)": what the customer is told. First name only. */
export function riderLine(r: Rider): string {
  return `${r.name.split(' ')[0]} (${r.vehicle}, ${r.plate})`;
}

/**
 * Picks a rider: right state and vehicle, fewest active jobs (paid or dispatched), then the one
 * assigned least recently. Pure, exported for tests. Null when the roster has nobody suitable.
 */
export function chooseRider(
  state: ServiceState,
  packageSize: string,
  load: { rider_id: string; active: number; last_assigned: number }[],
): Rider | null {
  const vehicle = packageSize === 'large' ? 'car' : 'motorbike';
  const pool = RIDERS.filter((r) => r.state === state && r.vehicle === vehicle);
  if (pool.length === 0) return null;
  const stats = (r: Rider) => load.find((l) => l.rider_id === r.id) ?? { active: 0, last_assigned: 0 };
  return [...pool].sort((a, b) => stats(a).active - stats(b).active || stats(a).last_assigned - stats(b).last_assigned || a.id.localeCompare(b.id))[0]!;
}

/**
 * Assigns a rider to a just-paid job, once (the UPDATE only fills an empty rider_id, so two paths
 * confirming the same payment cannot assign two riders). Returns the job's rider either way. Never throws.
 */
export async function assignRider(db: D1Database, jobId: string, now: number): Promise<Rider | null> {
  try {
    const job = await db
      .prepare(
        `SELECT j.rider_id, q.package_size, pu.lat, pu.lng FROM jobs j JOIN quotes q ON q.id = j.quote_id
           LEFT JOIN places pu ON pu.id = q.pickup_place_id WHERE j.id = ?`,
      )
      .bind(jobId)
      .first<{ rider_id: string | null; package_size: string; lat: number | null; lng: number | null }>();
    if (!job) return null;
    if (job.rider_id) return riderById(job.rider_id);
    const state = job.lat != null && job.lng != null ? stateOf({ lat: job.lat, lng: job.lng }) : null;
    if (!state) return null;
    const load = await db
      .prepare(
        `SELECT rider_id, SUM(CASE WHEN status IN ('paid', 'dispatched') THEN 1 ELSE 0 END) AS active, MAX(rider_assigned_at) AS last_assigned
           FROM jobs WHERE rider_id IS NOT NULL GROUP BY rider_id`,
      )
      .all<{ rider_id: string; active: number; last_assigned: number }>();
    const rider = chooseRider(state, job.package_size, load.results);
    if (!rider) return null;
    // The event row is written only if this UPDATE won (changes() = the previous statement in the batch).
    const [res] = await db.batch([
      db.prepare('UPDATE jobs SET rider_id = ?, rider_assigned_at = ? WHERE id = ? AND rider_id IS NULL').bind(rider.id, now, jobId),
      db
        .prepare("INSERT INTO job_events (job_id, type, from_status, to_status, actor, detail_json, created_at) SELECT ?, 'rider_assigned', NULL, NULL, 'system', ?, ? WHERE changes() = 1")
        .bind(jobId, JSON.stringify({ rider: rider.name, vehicle: rider.vehicle, plate: rider.plate }), now),
    ]);
    if (res?.meta.changes === 1) return rider;
    // Someone else assigned first: report theirs.
    const again = await db.prepare('SELECT rider_id FROM jobs WHERE id = ?').bind(jobId).first<{ rider_id: string | null }>();
    return riderById(again?.rider_id);
  } catch {
    return null;
  }
}
