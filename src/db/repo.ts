/**
 * Data access. Every statement uses prepare().bind() (no string-built SQL).
 * Rows mirror migrations/*.sql; money is integer kobo, times are epoch ms.
 */
export interface PlaceRow {
  id: string;
  query_text: string;
  label: string;
  lat: number;
  lng: number;
  precision: 'exact' | 'street' | 'area' | 'lga';
  postcode: string | null;
  postcode_status: string | null;
  provider: string;
  confidence: 'high' | 'medium' | 'low';
  in_service_area: 0 | 1;
  /** Service state from the coordinates ('FC' | 'LA'), or null outside both (migration 0010). */
  state?: 'FC' | 'LA' | null;
  created_at: number;
}

export interface QuoteRow {
  id: string;
  pickup_place_id: string;
  dropoff_place_id: string;
  package_size: 'small' | 'medium' | 'large';
  distance_m: number;
  duration_s: number | null;
  distance_source: string;
  approximate: 0 | 1;
  amount_kobo: number;
  currency: 'NGN';
  breakdown_json: string;
  rate_card_version: string;
  created_at: number;
  expires_at: number;
}

export type JobStatus = 'awaiting_payment' | 'paid' | 'dispatched' | 'delivered' | 'cancelled' | 'payment_failed' | 'amount_mismatch';

export interface JobRow {
  id: string;
  quote_id: string;
  sender_name: string;
  sender_phone: string | null;
  recipient_name: string;
  recipient_phone: string;
  package_note: string | null;
  amount_kobo: number;
  currency: 'NGN';
  status: JobStatus;
  handover_code: string;
  version: number;
  created_at: number;
  updated_at: number;
  paid_at: number | null;
  cancel_reason: string | null;
}

export type PaymentStatus =
  | 'initializing'
  | 'initialized'
  | 'success'
  | 'failed'
  | 'abandoned'
  | 'ongoing'
  | 'pending'
  | 'processing'
  | 'queued'
  | 'reversed'
  | 'mismatch'
  | 'not_found';

export interface PaymentRow {
  reference: string;
  job_id: string;
  attempt: number;
  amount_kobo: number;
  currency: string;
  authorization_url: string | null;
  access_code: string | null;
  status: PaymentStatus;
  gateway_response: string | null;
  paystack_id: number | null;
  channel: string | null;
  created_at: number;
  last_checked_at: number | null;
  paid_at: number | null;
  method: 'link' | 'bank_transfer';
  transfer_bank: string | null;
  transfer_account_number: string | null;
  transfer_account_name: string | null;
  transfer_expires_at: number | null;
}

export type Actor = 'agent' | 'dispatcher' | 'system' | 'customer';

export const getPlace = (db: D1Database, id: string) => db.prepare('SELECT * FROM places WHERE id = ?').bind(id).first<PlaceRow>();
export const getQuote = (db: D1Database, id: string) => db.prepare('SELECT * FROM quotes WHERE id = ?').bind(id).first<QuoteRow>();
export const getJob = (db: D1Database, id: string) => db.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>();
export const getJobByQuote = (db: D1Database, quoteId: string) =>
  db.prepare('SELECT * FROM jobs WHERE quote_id = ?').bind(quoteId).first<JobRow>();

export async function listPayments(db: D1Database, jobId: string): Promise<PaymentRow[]> {
  const r = await db.prepare('SELECT * FROM payments WHERE job_id = ? ORDER BY attempt DESC').bind(jobId).all<PaymentRow>();
  return r.results;
}

export async function getPayment(db: D1Database, reference: string): Promise<PaymentRow | null> {
  return db.prepare('SELECT * FROM payments WHERE reference = ?').bind(reference).first<PaymentRow>();
}

export function insertPlaceStmt(db: D1Database, p: PlaceRow): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO places (id, query_text, label, lat, lng, precision, postcode, postcode_status, provider, confidence, in_service_area, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(p.id, p.query_text, p.label, p.lat, p.lng, p.precision, p.postcode, p.postcode_status, p.provider, p.confidence, p.in_service_area, p.state ?? null, p.created_at);
}

export function eventStmt(
  db: D1Database,
  e: { jobId: string; type: string; from?: string | null; to?: string | null; actor: Actor; detail?: unknown; at: number },
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO job_events (job_id, type, from_status, to_status, actor, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(e.jobId, e.type, e.from ?? null, e.to ?? null, e.actor, e.detail === undefined ? null : JSON.stringify(e.detail), e.at);
}

/**
 * Compare-and-set status change. Succeeds only if the job is currently in one of `from`,
 * so two concurrent callers cannot both win (D1 meta.changes tells us who did).
 */
export async function transitionJob(
  db: D1Database,
  jobId: string,
  from: JobStatus[],
  to: JobStatus,
  actor: Actor,
  now: number,
  detail?: unknown,
  extraSet = '',
  extraBinds: unknown[] = [],
): Promise<boolean> {
  const placeholders = from.map(() => '?').join(', ');
  // One transaction (a D1 batch). The event row is inserted first, under exactly the UPDATE's
  // condition, so it is written only when the update will change the row, and it records the
  // job's real previous status (not the list of statuses it was allowed to come from).
  const [, update] = await db.batch([
    db
      .prepare(
        `INSERT INTO job_events (job_id, type, from_status, to_status, actor, detail_json, created_at)
         SELECT id, 'status_changed', status, ?, ?, ?, ? FROM jobs WHERE id = ? AND status IN (${placeholders})`,
      )
      .bind(to, actor, detail === undefined ? null : JSON.stringify(detail), now, jobId, ...from),
    db
      .prepare(`UPDATE jobs SET status = ?, version = version + 1, updated_at = ?${extraSet} WHERE id = ? AND status IN (${placeholders})`)
      .bind(to, now, ...extraBinds, jobId, ...from),
  ]);
  return update?.meta.changes === 1;
}
