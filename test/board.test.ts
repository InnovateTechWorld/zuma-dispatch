import { describe, expect, it } from 'vitest';
import { breakdown, lastSevenDays, percentiles, pipelineChart, watDayStart, weekChart } from '../src/web/charts';
import { listHref, listQuery, progressSteps, readFlash } from '../src/web/pages';
import { cookieName, crossSite, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, lockoutSeconds, readCookie, safeNext, sessionCookie } from '../src/web/session';

const HTTPS = new URL('https://zuma.example/board');
const HTTP = new URL('http://127.0.0.1:8787/board');
const post = (headers: Record<string, string>) => new Request('https://zuma.example/board/login', { method: 'POST', headers });

describe('board sign-in', () => {
  it('only redirects to board pages after sign-in (no open redirect)', () => {
    expect(safeNext('/board/jobs/ZD-AB12C')).toBe('/board/jobs/ZD-AB12C');
    expect(safeNext('/board?q=ada+obi&status=paid')).toBe('/board?q=ada+obi&status=paid');
    for (const bad of ['//evil.example', 'https://evil.example/board', '/board/../admin', '/boardx', '/board/login', '/board\\evil', null, '']) {
      expect(safeNext(bad)).toBe('/board');
    }
  });

  it('sets a host-only, HttpOnly, SameSite=Lax cookie; Secure and __Host- on HTTPS only', () => {
    expect(cookieName(HTTPS)).toBe('__Host-zd_board');
    expect(sessionCookie(HTTPS, 'abc', 60)).toBe('__Host-zd_board=abc; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure');
    expect(sessionCookie(HTTP, '', 0)).toBe('zd_board=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  });

  it('reads one cookie among several', () => {
    const r = new Request('https://x/', { headers: { Cookie: 'a=1; __Host-zd_board=deadbeef ; b=2' } });
    expect(readCookie(r, '__Host-zd_board')).toBe('deadbeef');
    expect(readCookie(r, 'zd_board')).toBeNull();
  });

  it('blocks cross-site form posts but accepts our own (including Origin: null from strict referrer policies)', () => {
    expect(crossSite(post({ 'Sec-Fetch-Site': 'same-origin', Origin: 'null' }), HTTPS)).toBe(false);
    expect(crossSite(post({ 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' }), HTTPS)).toBe(true);
    expect(crossSite(post({ 'Sec-Fetch-Site': 'same-site' }), HTTPS)).toBe(true); // a sibling subdomain is still another app
    expect(crossSite(post({ Origin: 'https://evil.example' }), HTTPS)).toBe(true); // older browser, no Sec-Fetch-Site
    expect(crossSite(post({ Origin: 'https://zuma.example' }), HTTPS)).toBe(false);
    expect(crossSite(post({}), HTTPS)).toBe(false); // curl / scripts
  });

  it('checks the first 10 attempts in a window, refuses the 11th unchecked, and forgets after 15 minutes', () => {
    const now = 10_000_000;
    expect(lockoutSeconds(null, now)).toBe(0);
    expect(lockoutSeconds({ window_start: now - 60_000, failures: LOGIN_MAX_FAILURES }, now)).toBe(0); // 10th attempt is checked
    expect(lockoutSeconds({ window_start: now - 60_000, failures: LOGIN_MAX_FAILURES + 1 }, now)).toBe((LOGIN_WINDOW_MS - 60_000) / 1000);
    expect(lockoutSeconds({ window_start: now - LOGIN_WINDOW_MS + 100, failures: 50 }, now)).toBe(1); // never "0 seconds" while locked
  });
});

describe('board filters', () => {
  it('ignores unknown statuses instead of showing an empty list', () => {
    const defaults = { when: '', dateFrom: '', dateTo: '', timeFrom: '', timeTo: '', by: 'booked', sort: 'newest', page: 1, notes: [] };
    expect(listQuery(new URL('https://x/board?status=bogus&q=%20ada%20&city=kano'))).toEqual({ status: '', q: 'ada', live: false, city: '', ...defaults });
    expect(listQuery(new URL('https://x/board?status=paid&live=1&city=lagos'))).toEqual({ status: 'paid', q: '', live: true, city: 'lagos', ...defaults });
    expect(listHref({ city: 'abuja', status: 'paid' })).toBe('/board/deliveries?status=paid&city=abuja');
  });
  it('builds short links that keep the other filters', () => {
    expect(listHref({})).toBe('/board/deliveries');
    expect(listHref({ q: 'ada obi', status: 'paid', live: true })).toBe('/board/deliveries?q=ada+obi&status=paid&live=1');
    expect(listHref({ q: '', status: '', live: false })).toBe('/board/deliveries');
  });
});

describe('board charts', () => {
  const day = 86_400_000;
  it('uses WAT calendar days (23:30 UTC is already tomorrow in Abuja)', () => {
    const lateUtc = Date.UTC(2026, 9, 20, 23, 30);
    expect(new Date(watDayStart(lateUtc)).toISOString()).toBe('2026-10-20T23:00:00.000Z');
  });
  it('fills in quiet days so the week always has 7 columns, today last', () => {
    const now = Date.UTC(2026, 9, 20, 12);
    const today = Math.floor((now + 3_600_000) / day);
    const days = lastSevenDays([{ day: today, booked: 3, paid: 1, revenue: 195000 }], now);
    expect(days).toHaveLength(7);
    expect(days[6]).toEqual({ day: today, booked: 3, paid: 1, revenue: 195000 });
    expect(days[0]!.booked).toBe(0);
    expect(weekChart(days)).toContain('3 booked · 1 paid (33%)');
  });
  it('says so when there is nothing to draw, and escapes labels', () => {
    expect(pipelineChart({}, () => '/board')).toContain('No bookings yet');
    expect(breakdown('Paid with', [], 'No successful payments yet.')).toContain('No successful payments yet.');
    expect(breakdown('Noticed by', [{ label: '<b>x</b>', n: 1 }], '')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
  it('pipeline segments link to the matching filter; every status appears in the legend', () => {
    const html = pipelineChart({ paid: 2, cancelled: 1 }, (s) => `/board?status=${s}`);
    expect(html.match(/class="pipe__seg/g)).toHaveLength(2);
    expect(html).toContain('href="/board?status=paid"');
    expect(html).toContain('amount mismatch');
    expect(html).toContain('67%');
  });
  it('computes median and p95 by nearest rank', () => {
    expect(percentiles([])).toBeNull();
    expect(percentiles([5, 1, 3, 2, 4])).toEqual({ p50: 3, p95: 5 });
  });
});

describe('job progress', () => {
  const base = { created_at: 1, paid_at: null, updated_at: 9 };
  it('happy path: done up to the status, waiting on the next step', () => {
    const steps = progressSteps({ ...base, status: 'paid', paid_at: 5 }, []);
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'current', 'todo']);
    expect(steps[1]!.at).toBe(5);
  });
  it('delivered: every step done', () => {
    expect(progressSteps({ ...base, status: 'delivered', paid_at: 5 }, [{ to_status: 'dispatched', created_at: 6 }, { to_status: 'delivered', created_at: 7 }]).every((s) => s.state === 'done')).toBe(true);
  });
  it('a failed payment stops after booking but can still be paid', () => {
    expect(progressSteps({ ...base, status: 'payment_failed' }, [{ to_status: 'payment_failed', created_at: 4 }]).map((s) => `${s.label}:${s.state}`)).toEqual([
      'Booked:done', 'Payment failed:stopped', 'Paid:todo', 'Dispatched:todo', 'Delivered:todo',
    ]);
  });
  it('a cancelled job ends at the cancellation', () => {
    expect(progressSteps({ ...base, status: 'cancelled' }, []).map((s) => s.label)).toEqual(['Booked', 'Cancelled']);
  });
});

describe('flash messages after an action', () => {
  it('shows only messages the server signed (a crafted ?msg= link shows nothing)', async () => {
    const secret = 'a-board-token-of-16+chars';
    const forged = new URL('https://x/board?msg=Payment%20approved&sig=0000');
    expect(await readFlash(forged, secret)).toBeNull();
    expect(await readFlash(new URL('https://x/board?msg=hi'), secret)).toBeNull();
    // Sign the way the server does, then tamper with the tone: rejected.
    const { sha256Hex } = await import('../src/web/session');
    const sig = (await sha256Hex(`zuma-board-flash:${secret}:i:ZD-AAAAA: mark dispatched.`)).slice(0, 24);
    const good = new URL(`https://x/board?msg=${encodeURIComponent('ZD-AAAAA: mark dispatched.')}&sig=${sig}`);
    expect(await readFlash(good, secret)).toEqual({ msg: 'ZD-AAAAA: mark dispatched.', error: false });
    good.searchParams.set('tone', 'error');
    expect(await readFlash(good, secret)).toBeNull();
  });
});
