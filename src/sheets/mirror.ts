import { formatNaira } from '../lib/money';
import { log } from '../lib/log';
import { normalizeNigerianPhone } from '../lib/phone';
import { parseServiceAccount, rowFromRange, Sheets } from './google';

/**
 * One-way mirror of deliveries into a Google Sheet, for the business owner's phone.
 *
 *  - D1 is the source of truth. The sheet is a copy: edits typed into it are never read back, so a
 *    mistyped status can't move a job. Actions stay on the board.
 *  - Sync runs in the background (ctx.waitUntil) after each job change and never fails the caller.
 *    The last result is stored in sheet_state and shown on the board; "Resync all" rebuilds the tab.
 *  - Values are written RAW, so text like "=HYPERLINK(...)" in a name can never become a formula.
 *  - Phones are masked: sheets get shared, and the full number stays on the authenticated board.
 *  - A row is claimed in D1 before it is appended, so two quick changes can't add two rows.
 */
export const TAB = 'Deliveries';
export const HEADERS = [
  'Job ID', 'Status', 'Booked (WAT)', 'Sender', 'Recipient', 'Recipient phone', 'Pickup', 'Drop-off', 'Size',
  'Distance (km)', 'Amount', 'Payment method', 'Paid via', 'Paid at (WAT)', 'Last update (WAT)', 'Board link',
];
const LAST_COL = 'P';

export interface MirrorEnv {
  DB: D1Database;
  GOOGLE_SHEET_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  PROVIDER_TIMEOUT_MS: string;
}

export function mirrorClient(env: MirrorEnv): Sheets | null {
  const sa = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const id = env.GOOGLE_SHEET_ID?.trim();
  if (!sa || !id || !/^[A-Za-z0-9_-]{20,100}$/.test(id)) return null;
  return new Sheets(sa, id, Math.max(4000, Number(env.PROVIDER_TIMEOUT_MS) || 4000) + 4000);
}

export function mirrorStatus(env: MirrorEnv): 'enabled' | 'not_configured' | 'invalid_config' {
  const anySet = Boolean(env.GOOGLE_SHEET_ID?.trim() || env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim());
  if (!anySet) return 'not_configured';
  return mirrorClient(env) ? 'enabled' : 'invalid_config';
}

const wat = (ms: number | null | undefined) => (ms ? new Date(ms + 3_600_000).toISOString().slice(0, 16).replace('T', ' ') : '');
const PAID_VIA: Record<string, string> = {
  paystack_webhook: 'Paystack notification', return_page: 'Checkout return page', verify: 'Customer check',
  link_request: 'Link request', cancel: 'Cancel check',
};

interface JoinedJob {
  id: string; status: string; created_at: number; updated_at: number; paid_at: number | null; sender_name: string;
  recipient_name: string; recipient_phone: string; amount_kobo: number; pickup: string | null; dropoff: string | null;
  package_size: string | null; distance_m: number | null; method: string | null; paid_via: string | null;
}

const JOB_SQL = `SELECT j.id, j.status, j.created_at, j.updated_at, j.paid_at, j.sender_name, j.recipient_name, j.recipient_phone, j.amount_kobo,
       pu.label AS pickup, dr.label AS dropoff, q.package_size, q.distance_m,
       (SELECT p.method FROM payments p WHERE p.job_id = j.id ORDER BY (p.status = 'success') DESC, p.attempt DESC LIMIT 1) AS method,
       (SELECT json_extract(e.detail_json, '$.via') FROM job_events e WHERE e.job_id = j.id AND e.to_status = 'paid' ORDER BY e.id DESC LIMIT 1) AS paid_via
  FROM jobs j JOIN quotes q ON q.id = j.quote_id
  LEFT JOIN places pu ON pu.id = q.pickup_place_id LEFT JOIN places dr ON dr.id = q.dropoff_place_id`;

/** The sheet row for a job. Pure, exported for tests. */
export function toRow(j: JoinedJob, origin: string): string[] {
  const phone = normalizeNigerianPhone(j.recipient_phone);
  return [
    j.id, j.status.replaceAll('_', ' '), wat(j.created_at), j.sender_name, j.recipient_name, phone.ok ? phone.masked : '(on file)',
    j.pickup ?? '', j.dropoff ?? '', j.package_size ?? '', j.distance_m !== null ? (j.distance_m / 1000).toFixed(1) : '',
    formatNaira(j.amount_kobo), j.method === 'bank_transfer' ? 'Bank transfer' : j.method === 'link' ? 'Payment link' : '',
    j.paid_via ? (PAID_VIA[j.paid_via] ?? j.paid_via) : '', wat(j.paid_at), wat(j.updated_at), `${origin}/board/jobs/${j.id}`,
  ];
}

async function recordState(db: D1Database, ok: boolean, detail: string): Promise<void> {
  await db
    .prepare("INSERT INTO sheet_state (key, ok, detail, updated_at) VALUES ('last', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET ok = excluded.ok, detail = excluded.detail, updated_at = excluded.updated_at")
    .bind(ok ? 1 : 0, detail.slice(0, 300), Date.now())
    .run()
    .catch(() => {});
}

function failure(r: { ok: boolean; status?: number | null; body?: string | null; failure?: string }): string {
  return r.ok ? '' : `${r.failure ?? 'error'} ${r.status ?? ''} ${(r.body ?? '').slice(0, 160)}`.trim();
}

/** Makes sure the tab and header row exist. */
async function ensureTab(sheets: Sheets): Promise<string | null> {
  const tabs = await sheets.tabs();
  if (!tabs.ok) return `cannot open spreadsheet: ${failure(tabs)}`;
  if (!(tabs.data.sheets ?? []).some((s) => s.properties?.title === TAB)) {
    const added = await sheets.addTab(TAB);
    if (!added.ok) return `cannot add "${TAB}" tab: ${failure(added)}`;
  }
  const header = await sheets.update(`${TAB}!A1:${LAST_COL}1`, [HEADERS]);
  return header.ok ? null : `cannot write header: ${failure(header)}`;
}

/** Updates (or appends) one job's row. Never throws. */
export async function syncJob(env: MirrorEnv, jobId: string, origin: string): Promise<void> {
  const sheets = mirrorClient(env);
  if (!sheets) return;
  try {
    const job = await env.DB.prepare(`${JOB_SQL} WHERE j.id = ?`).bind(jobId).first<JoinedJob>();
    if (!job) return;
    const row = toRow(job, origin);
    const mapped = await env.DB.prepare('SELECT row_number FROM sheet_rows WHERE job_id = ?').bind(jobId).first<{ row_number: number | null }>();

    if (mapped?.row_number) {
      const r = await sheets.update(`${TAB}!A${mapped.row_number}:${LAST_COL}${mapped.row_number}`, [row]);
      if (!r.ok) throw new Error(`update row ${mapped.row_number}: ${failure(r)}`);
    } else if (mapped) {
      return; // another sync is appending this job's first row right now; the next change updates it
    } else {
      const claim = await env.DB.prepare('INSERT INTO sheet_rows (job_id, row_number, synced_at) VALUES (?, NULL, ?) ON CONFLICT(job_id) DO NOTHING')
        .bind(jobId, Date.now())
        .run();
      if (claim.meta.changes !== 1) return;
      const first = await env.DB.prepare('SELECT COUNT(*) AS n FROM sheet_rows WHERE row_number IS NOT NULL').first<{ n: number }>();
      if ((first?.n ?? 0) === 0) {
        const problem = await ensureTab(sheets);
        if (problem) {
          await env.DB.prepare('DELETE FROM sheet_rows WHERE job_id = ?').bind(jobId).run();
          throw new Error(problem);
        }
      }
      let r = await sheets.append(`${TAB}!A:${LAST_COL}`, [row]);
      if (!r.ok && r.status === 400 && /Unable to parse range/i.test(r.body ?? '')) {
        // The tab was deleted or renamed by hand: recreate it and try once more.
        const problem = await ensureTab(sheets);
        if (!problem) r = await sheets.append(`${TAB}!A:${LAST_COL}`, [row]);
      }
      const n = r.ok ? rowFromRange(r.data.updates?.updatedRange) : null;
      if (!r.ok || !n) {
        await env.DB.prepare('DELETE FROM sheet_rows WHERE job_id = ?').bind(jobId).run(); // release the claim so a later sync retries
        throw new Error(`append: ${failure(r) || 'no row number in response'}`);
      }
      await env.DB.prepare('UPDATE sheet_rows SET row_number = ?, synced_at = ? WHERE job_id = ?').bind(n, Date.now(), jobId).run();
    }
    await recordState(env.DB, true, `synced ${jobId}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log('warn', 'sheet_sync_failed', { job_id: jobId, message: message.slice(0, 200) });
    await recordState(env.DB, false, `${jobId}: ${message}`);
  }
}

/** Rebuilds the whole tab from D1 (header + newest 2,000 jobs) and the row map. */
export async function resyncAll(env: MirrorEnv, origin: string): Promise<{ ok: boolean; detail: string }> {
  const sheets = mirrorClient(env);
  if (!sheets) return { ok: false, detail: 'Google Sheets mirror is not configured.' };
  const problem = await ensureTab(sheets);
  if (problem) {
    await recordState(env.DB, false, problem);
    return { ok: false, detail: problem };
  }
  const jobs = await env.DB.prepare(`${JOB_SQL} ORDER BY j.created_at ASC LIMIT 2000`).all<JoinedJob>();
  const clear = await sheets.clear(`${TAB}!A2:${LAST_COL}`);
  if (!clear.ok) {
    await recordState(env.DB, false, `clear: ${failure(clear)}`);
    return { ok: false, detail: `Could not clear the sheet: ${failure(clear)}` };
  }
  if (jobs.results.length > 0) {
    const w = await sheets.update(`${TAB}!A2:${LAST_COL}${jobs.results.length + 1}`, jobs.results.map((j) => toRow(j, origin)));
    if (!w.ok) {
      await recordState(env.DB, false, `write: ${failure(w)}`);
      return { ok: false, detail: `Could not write rows: ${failure(w)}` };
    }
  }
  const now = Date.now();
  const stmts = [env.DB.prepare('DELETE FROM sheet_rows')];
  jobs.results.forEach((j, i) => stmts.push(env.DB.prepare('INSERT INTO sheet_rows (job_id, row_number, synced_at) VALUES (?, ?, ?)').bind(j.id, i + 2, now)));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await recordState(env.DB, true, `resynced ${jobs.results.length} jobs`);
  return { ok: true, detail: `Rebuilt the sheet with ${jobs.results.length} job(s).` };
}
