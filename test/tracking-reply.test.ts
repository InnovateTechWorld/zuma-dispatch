import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config';
import type { ToolContext } from '../src/mcp/tooling';
import { getJobStatus } from '../src/tools/jobs';
import { addJob, d1 } from './helpers/sqliteD1';

// 22 Oct 2026 recording: asked "where is the rider now?", the model rewrote the reply and sent
// "Track live: https://zumadispatch.example/track/ZD-5MHJZ", a page that does not exist.
const NOW = Date.parse('2026-10-22T12:00:00+01:00'); // Thursday, rider hours

describe('where is the rider: the only link is the real map link', () => {
  it('gives a ready reply with the Google Maps link, and forbids any other link', async () => {
    const { db, env } = d1();
    const job = addJob(db, { booked: NOW - 20 * 60_000, status: 'paid', paid: '2026-10-22T11:55:00' });
    db.prepare(`UPDATE jobs SET rider_id = 'R-LA1', rider_assigned_at = ? WHERE id = ?`).run(NOW - 5 * 60_000, job);
    const ctx = { env, config: {} as Config, db: env.DB, requestId: 'r', now: () => NOW, waitUntil: () => {}, publicOrigin: 'https://x', trace: [] } as ToolContext;
    const r = await getJobStatus({ job_id: job }, ctx);
    const msg = String(r['message_for_customer']);
    const link = /https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=[\d.-]+,[\d.-]+/.exec(msg)?.[0];
    expect(link).toBeTruthy();
    expect(msg).toMatch(/^Tunde \(motorbike, LSD 553 XA\) is on the way to the pickup/);
    expect(r['what_to_do']).toContain('word for word');
    expect(r['what_to_do']).toContain(`(${link})`);
    expect(r['what_to_do']).toMatch(/never write any other link, tracking page or URL/);
    expect(msg).not.toMatch(/zumadispatch|\.example|\/track\//);
  });
});
