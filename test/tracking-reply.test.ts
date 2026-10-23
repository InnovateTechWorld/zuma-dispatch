import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config';
import type { ToolContext } from '../src/mcp/tooling';
import { readTrackPath, trackToken, trackUrl } from '../src/business/trackLink';
import { paidFollowUp, paymentReceivedMessage } from '../src/business/messages';
import { getJobStatus } from '../src/tools/jobs';
import { trackPage } from '../src/web/pages';
import { addJob, d1 } from './helpers/sqliteD1';

// 22–23 Oct 2026: asked "where is the rider now?", the model made up links twice
// ("zumadispatch.example/track/…", "maps.google.com/?q=6.5697,3.3652"). The payment confirmation now
// carries a real /t/… link that always opens the live position, and get_job_status sends the same one.
const NOW = Date.parse('2026-10-22T12:00:00+01:00'); // Thursday, rider hours
const SECRET = 'm'.repeat(64);
const config = { mcpBearerToken: SECRET, businessName: 'Zuma Dispatch' } as unknown as Config;

function paidJob() {
  const { db, env } = d1();
  const job = addJob(db, { booked: NOW - 20 * 60_000, status: 'paid', paid: '2026-10-22T11:55:00', recipient: 'John' });
  db.prepare(`UPDATE jobs SET rider_id = 'R-LA1', rider_assigned_at = ? WHERE id = ?`).run(NOW - 5 * 60_000, job);
  return { db, env, job };
}

describe('the tracking link', () => {
  it('is signed: the code depends on the job and the secret, and forged or reused codes are refused', async () => {
    const t = await trackToken('ZD-MTQ2B', SECRET);
    expect(t).toMatch(/^[0-9a-f]{10}$/);
    expect(await trackToken('ZD-MTQ2B', SECRET)).toBe(t); // stable
    expect(await trackToken('ZD-ABCDE', SECRET)).not.toBe(t);
    expect(await trackToken('ZD-MTQ2B', 'other secret')).not.toBe(t);
    expect(await readTrackPath(`/t/ZD-MTQ2B-${t}`, SECRET)).toBe('ZD-MTQ2B');
    expect(await readTrackPath(`/t/ZD-MTQ2B-${t}/`, SECRET)).toBe('ZD-MTQ2B');
    expect(await readTrackPath(`/t/ZD-ABCDE-${t}`, SECRET)).toBeNull(); // another job's code
    expect(await readTrackPath('/t/ZD-MTQ2B-0000000000', SECRET)).toBeNull();
    expect(await readTrackPath(`/t/zd-mtq2b-${t}`, SECRET)).toBeNull();
    expect(await readTrackPath('/t/../board', SECRET)).toBeNull();
    expect(await trackUrl('https://x/', 'ZD-MTQ2B', SECRET)).toBe(`https://x/t/ZD-MTQ2B-${t}`);
  });

  it('is in the payment confirmation and the follow-up, next to the rider', () => {
    const job = { id: 'ZD-MTQ2B', amount_kobo: 195_000, handover_code: '5380', status: 'paid', rider_id: 'R-LA1', recipient_name: 'John' };
    expect(paymentReceivedMessage(job, NOW, 'https://x/t/ZD-MTQ2B-abc')).toContain('Tunde (rider): 0800 000 0104\nTrack Tunde live: https://x/t/ZD-MTQ2B-abc');
    expect(paidFollowUp(job, NOW, 'https://x/t/ZD-MTQ2B-abc')).toContain('Track Tunde live: https://x/t/ZD-MTQ2B-abc');
    expect(paymentReceivedMessage({ ...job, status: 'delivered' }, NOW, 'https://x/t/ZD-MTQ2B-abc')).not.toContain('Track');
    expect(paymentReceivedMessage({ ...job, rider_id: null }, NOW, 'https://x/t/ZD-MTQ2B-abc')).not.toContain('Track'); // no rider, nothing to track
    expect(paymentReceivedMessage(job, NOW)).not.toContain('Track'); // no link given
  });

  it('opens Google Maps at the live position; never cached', async () => {
    const { env, job } = paidJob();
    const t = await trackToken(job, SECRET);
    const res = await trackPage(new URL(`https://x/t/${job}-${t}`), env, config);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=-?\d+\.\d{5},-?\d+\.\d{5}$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('a forged link, an unpaid job and a cancelled job get a plain page, never details', async () => {
    const { db, env, job } = paidJob();
    const forged = await trackPage(new URL(`https://x/t/${job}-0000000000`), env, config);
    expect(forged.status).toBe(404);
    expect(await forged.text()).not.toContain(job);
    const unpaid = addJob(db, { booked: NOW - 60_000 });
    const r1 = await trackPage(new URL(`https://x/t/${unpaid}-${await trackToken(unpaid, SECRET)}`), env, config);
    expect([r1.status, (await r1.text()).includes("starts once it's paid")]).toEqual([200, true]);
    db.prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`).run(unpaid);
    const r2 = await trackPage(new URL(`https://x/t/${unpaid}-${await trackToken(unpaid, SECRET)}`), env, config);
    expect(await r2.text()).toContain('was cancelled');
    const gone = await trackPage(new URL(`https://x/t/ZD-ZZZZZ-${await trackToken('ZD-ZZZZZ', SECRET)}`), env, config);
    expect(gone.status).toBe(404);
  });
});

describe('where is the rider: the only link is the real tracking link', () => {
  it('gives a ready reply with our live link, and forbids any other link', async () => {
    const { env, job } = paidJob();
    const ctx = { env, config, db: env.DB, requestId: 'r', now: () => NOW, waitUntil: () => {}, publicOrigin: 'https://x', trace: [] } as ToolContext;
    const r = await getJobStatus({ job_id: job }, ctx);
    const link = `https://x/t/${job}-${await trackToken(job, SECRET)}`;
    const msg = String(r['message_for_customer']);
    expect(msg).toMatch(/^Tunde \(motorbike, LSD 553 XA\) is on the way to the pickup/);
    expect(msg).toContain(`Live map: ${link}`);
    expect(r['live_map']).toBe(link);
    expect(r['what_to_do']).toContain('word for word');
    expect(r['what_to_do']).toContain(`(${link})`);
    expect(r['what_to_do']).toMatch(/never write any other link, tracking page or URL/);
    expect(msg).not.toMatch(/zumadispatch|\.example|maps\.google\.com\/\?q=/);
  });
});
