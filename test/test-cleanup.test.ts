import { describe, expect, it } from 'vitest';
import { cleanupTestRun, MAX_JOBS_PER_RUN } from '../src/admin/testCleanup';
import { addJob, d1 } from './helpers/sqliteD1';

const NOW = Date.parse('2026-10-22T14:00:00+01:00');
const RUN = '48213';
const count = (db: ReturnType<typeof d1>['db'], sql: string) => Number((db.prepare(sql).get() as { n: number }).n);

/** One run's jobs exactly as scripts/e2e.py names them, with the rows each job collects. */
function seedRun(db: ReturnType<typeof d1>['db'], run: string, at = NOW - 60_000): string[] {
  const ids = [
    addJob(db, { booked: at, sender: `E2E Sender ${run}`, recipient: `E2E Recipient ${run}` }),
    addJob(db, { booked: at, sender: `E2E Lagos ${run}`, recipient: `E2E Lagos Recipient ${run}`, state: 'LA', status: 'cancelled' }),
    addJob(db, { booked: at, sender: `Other Sender ${run}`, recipient: `E2E Recipient ${run}` }),
    addJob(db, { booked: at, sender: `E2E Transfer ${run}`, recipient: `E2E Recipient ${run}`, status: 'amount_mismatch' }),
  ];
  for (const [i, id] of ids.entries()) {
    db.prepare(`INSERT INTO payments (reference, job_id, attempt, amount_kobo, status, created_at) VALUES (?, ?, 1, 150000, 'initialized', ?)`).run(`${id}-1`, id, at);
    db.prepare(`INSERT INTO job_events (job_id, type, actor, created_at) VALUES (?, 'created', 'agent', ?)`).run(id, at);
    db.prepare(`INSERT INTO chat_notices (job_id, kind, state, created_at, updated_at) VALUES (?, 'payment_received', 'skipped', ?, ?)`).run(id, at, at);
    if (i === 0) db.prepare(`INSERT INTO paystack_events (dedupe_key, event, reference, job_id, outcome, ip_trusted, received_at) VALUES (?, 'charge.success', ?, ?, 'needs_review', 0, ?)`).run(`e-${id}`, `${id}-1`, id, at);
  }
  db.prepare(`INSERT INTO paystack_events (dedupe_key, event, reference, job_id, outcome, ip_trusted, received_at) VALUES (?, 'charge.success', ?, NULL, 'unknown_reference', 0, ?)`).run(`e-ref-${run}`, `E2E-${run}-NOT-OURS`, at);
  for (let k = 0; k < 5; k++) db.prepare(`INSERT INTO tool_calls (request_id, tool, ok, latency_ms, created_at) VALUES (?, 'quote_delivery', 0, 5, ?)`).run(`test-${run}-${k}`, at);
  return ids;
}

describe('POST /mcp/test-cleanup', () => {
  it("removes one run's jobs and everything linked to them, and nothing else", async () => {
    const { db, env } = d1();
    const ids = seedRun(db, RUN);
    const otherRun = seedRun(db, '48214');
    // Real customers, including near-misses on the names.
    const real = [
      addJob(db, { booked: NOW - 60_000, sender: 'Ada Obi', recipient: 'Bola Musa' }),
      addJob(db, { booked: NOW - 60_000, sender: `Ada ${RUN}`, recipient: `Bola ${RUN}` }), // ends in the run id, not named E2E
      addJob(db, { booked: NOW - 60_000, sender: `E2E Sender ${RUN}`, recipient: 'Bola Musa' }), // only one name matches
    ];
    db.prepare(`INSERT INTO tool_calls (request_id, tool, ok, latency_ms, created_at) VALUES ('8c1f-real-chord-call', 'resolve_address', 1, 5, ?)`).run(NOW);

    const r = await cleanupTestRun(env, RUN, NOW, 'https://x');
    expect(r).toMatchObject({ ok: true, result: { run: RUN, jobs: 4, sheet: 'no rows to remove' } });
    if (!r.ok) return;
    expect(r.result.deleted).toEqual({ chat_notices: 4, sheet_rows: 0, paystack_events: 2, payments: 4, job_events: 4, jobs: 4, quotes: 4, tool_calls: 5 });

    const left = (db.prepare('SELECT id FROM jobs ORDER BY id').all() as { id: string }[]).map((j) => j.id);
    expect(left).toEqual([...otherRun, ...real].sort());
    expect(left.some((id) => ids.includes(id))).toBe(false);
    expect(count(db, `SELECT COUNT(*) AS n FROM tool_calls WHERE request_id LIKE 'test-48214-%'`)).toBe(5);
    expect(count(db, `SELECT COUNT(*) AS n FROM tool_calls WHERE request_id = '8c1f-real-chord-call'`)).toBe(1);
    expect(count(db, `SELECT COUNT(*) AS n FROM paystack_events WHERE reference = 'E2E-48214-NOT-OURS'`)).toBe(1);
    // Places are shared with real customers through the address cache, so they stay.
    expect(count(db, 'SELECT COUNT(*) AS n FROM places')).toBe(2 * 11);
  });

  it('is safe to run twice, or for a run that made nothing', async () => {
    const { db, env } = d1();
    seedRun(db, RUN);
    await cleanupTestRun(env, RUN, NOW, 'https://x');
    const again = await cleanupTestRun(env, RUN, NOW, 'https://x');
    expect(again).toMatchObject({ ok: true, result: { jobs: 0 } });
    expect(await cleanupTestRun(env, '00001', NOW, 'https://x')).toMatchObject({ ok: true, result: { jobs: 0, deleted: { jobs: 0, tool_calls: 0 } } });
  });

  it('only touches the last 24 hours', async () => {
    const { db, env } = d1();
    const old = seedRun(db, RUN, NOW - 25 * 60 * 60_000);
    const r = await cleanupTestRun(env, RUN, NOW, 'https://x');
    expect(r).toMatchObject({ ok: true, result: { jobs: 0 } });
    expect(count(db, `SELECT COUNT(*) AS n FROM jobs WHERE id IN ('${old.join("','")}')`)).toBe(4);
  });

  it('refuses a run id that is not 5 digits (no wildcards, no SQL)', async () => {
    const { env } = d1();
    for (const bad of ['', '%', '4821', '482133', "1' OR '1'='1", '_____', '4821%'])
      expect(await cleanupTestRun(env, bad, NOW, 'https://x'), bad).toMatchObject({ ok: false, status: 400 });
  });

  it('deletes nothing when far more jobs match than a run makes', async () => {
    const { db, env } = d1();
    for (let i = 0; i <= MAX_JOBS_PER_RUN; i++) addJob(db, { booked: NOW - 1000, sender: `E2E Sender ${RUN}`, recipient: `E2E Recipient ${RUN}` });
    const r = await cleanupTestRun(env, RUN, NOW, 'https://x');
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM jobs')).toBe(MAX_JOBS_PER_RUN + 1);
  });

  it('removes the sheet row bookkeeping, and reports when the mirror is off', async () => {
    const { db, env } = d1();
    const [first] = seedRun(db, RUN);
    db.prepare('INSERT INTO sheet_rows (job_id, row_number, synced_at) VALUES (?, 2, ?)').run(first!, NOW);
    const r = await cleanupTestRun(env, RUN, NOW, 'https://x');
    expect(r).toMatchObject({ ok: true, result: { sheet: 'mirror off', deleted: { sheet_rows: 1 } } });
  });
});
