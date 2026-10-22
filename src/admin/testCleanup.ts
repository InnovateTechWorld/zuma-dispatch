import type { Env } from '../env';
import { log } from '../lib/log';
import { mirrorStatus, resyncAll } from '../sheets/mirror';

/**
 * POST /mcp/test-cleanup {"run": "12345"}: removes what one test-script run created, so test runs
 * against production never clutter the dispatcher board, the owner's sheet or the tool-call stats.
 * Same bearer token as /mcp (only our own scripts hold it).
 *
 * What counts as one run's data, and nothing else:
 * - Jobs named by that run: recipient "E2E … <run>" and sender "E2E … <run>" or "Other Sender <run>",
 *   booked in the last 24 hours. A real customer's job can't match both names.
 * - Their payments, events, chat notices, sheet rows and quotes.
 * - Paystack webhook log entries for those jobs or the run's made-up references ("E2E-<run>-…").
 * - Tool calls the scripts tagged with X-Request-ID "test-<run>-…".
 *
 * Left alone on purpose: resolved places and the address cache. They are shared with real customers
 * (the same "Jabi Lake Mall" place id is reused for 6 hours), so deleting them could break a live
 * customer's quote. Quotes the run made but never booked are not linked to the run; they expire in
 * 30 minutes and never appear on the board.
 */
export const RUN_RE = /^\d{5}$/;
/** A run books under ten jobs; anything near this means the match is wrong, so nothing is deleted. */
export const MAX_JOBS_PER_RUN = 40;
const WINDOW_MS = 24 * 60 * 60_000;

export interface CleanupResult {
  run: string;
  jobs: number;
  deleted: Record<string, number>;
  sheet: string;
}

export const RUN_JOBS_SQL = `SELECT id, quote_id FROM jobs
  WHERE recipient_name LIKE 'E2E %' AND recipient_name LIKE ?1
    AND (sender_name LIKE 'E2E %' OR sender_name LIKE 'Other Sender %') AND sender_name LIKE ?1
    AND created_at >= ?2`;

export async function cleanupTestRun(env: Env, run: string, now: number, origin: string): Promise<{ ok: true; result: CleanupResult } | { ok: false; status: number; error: string }> {
  if (!RUN_RE.test(run)) return { ok: false, status: 400, error: 'run must be the 5-digit id the test script printed' };
  const db = env.DB;
  const tail = `% ${run}`;
  const jobs = (await db.prepare(RUN_JOBS_SQL).bind(tail, now - WINDOW_MS).all<{ id: string; quote_id: string }>()).results;
  if (jobs.length > MAX_JOBS_PER_RUN) {
    log('warn', 'test_cleanup_refused', { run, jobs: jobs.length });
    return { ok: false, status: 409, error: `${jobs.length} jobs match run ${run}, more than any test run makes; nothing was deleted` };
  }
  const ids = jobs.map((j) => j.id);
  const quotes = jobs.map((j) => j.quote_id);
  const inList = (n: number) => (n ? Array.from({ length: n }, () => '?').join(', ') : "''");
  const hadSheetRows = ids.length ? Number((await db.prepare(`SELECT COUNT(*) AS n FROM sheet_rows WHERE job_id IN (${inList(ids.length)})`).bind(...ids).first<{ n: number }>())?.n ?? 0) : 0;
  const refs = ids.length ? (await db.prepare(`SELECT reference FROM payments WHERE job_id IN (${inList(ids.length)})`).bind(...ids).all<{ reference: string }>()).results.map((r) => r.reference) : [];

  // Children first (foreign keys), in one batch so a run is removed completely or not at all.
  const steps: [string, D1PreparedStatement][] = [
    ['chat_notices', db.prepare(`DELETE FROM chat_notices WHERE job_id IN (${inList(ids.length)})`).bind(...ids)],
    ['sheet_rows', db.prepare(`DELETE FROM sheet_rows WHERE job_id IN (${inList(ids.length)})`).bind(...ids)],
    ['paystack_events', db.prepare(`DELETE FROM paystack_events WHERE job_id IN (${inList(ids.length)}) OR reference IN (${inList(refs.length)}) OR reference LIKE ?`).bind(...ids, ...refs, `E2E-${run}-%`)],
    ['payments', db.prepare(`DELETE FROM payments WHERE job_id IN (${inList(ids.length)})`).bind(...ids)],
    ['job_events', db.prepare(`DELETE FROM job_events WHERE job_id IN (${inList(ids.length)})`).bind(...ids)],
    ['jobs', db.prepare(`DELETE FROM jobs WHERE id IN (${inList(ids.length)})`).bind(...ids)],
    ['quotes', db.prepare(`DELETE FROM quotes WHERE id IN (${inList(quotes.length)}) AND id NOT IN (SELECT quote_id FROM jobs)`).bind(...quotes)],
    ['tool_calls', db.prepare(`DELETE FROM tool_calls WHERE request_id LIKE ?`).bind(`test-${run}-%`)],
  ];
  const out = await db.batch(steps.map(([, s]) => s));
  const deleted = Object.fromEntries(steps.map(([name], i) => [name, Number(out[i]?.meta?.changes ?? 0)]));

  // The owner's sheet already had rows for these jobs: rebuild it from the database without them.
  let sheet = 'no rows to remove';
  if (hadSheetRows > 0) {
    if (mirrorStatus(env) !== 'enabled') sheet = 'mirror off';
    else {
      const r = await resyncAll(env, origin);
      sheet = r.ok ? 'rebuilt' : `resync failed: ${r.detail}`;
    }
  }
  log('info', 'test_cleanup', { run, jobs: ids.length, ...deleted, sheet });
  return { ok: true, result: { run, jobs: ids.length, deleted, sheet } };
}
