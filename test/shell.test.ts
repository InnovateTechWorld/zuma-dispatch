import { describe, expect, it } from 'vitest';
import { announcementText, page, themeSwitch } from '../src/web/layout';
import { readTheme, safeBack, themeCookie } from '../src/web/session';
import { hereWithoutFlash } from '../src/web/shell';
import { alertsFrom, tabBadges, type Signals } from '../src/web/signals';

const quiet: Signals = {
  waiting: 0, chord: 'ok', chordDetail: null, review: 0, ready: 0, out: 0, awaiting: 0, stuck: 0, noticeFailed: 0,
  sheet: { state: 'ok', detail: null, at: 1 }, tools24h: { calls: 5, errors: 0, faults: 0 }, webhook: true,
};

describe('Home alerts', () => {
  it('a quiet day has nothing that needs you', () => {
    expect(alertsFrom(quiet)).toEqual([]);
    expect(Object.values(tabBadges(quiet)).every((b) => b.n === 0)).toBe(true);
  });
  it('lists urgent things first, each with one next step', () => {
    const a = alertsFrom({ ...quiet, ready: 2, waiting: 1, review: 3, sheet: { state: 'failed', detail: 'HTTP 403', at: 1 } });
    expect(a.map((x) => x.key)).toEqual(['waiting', 'review', 'sheet', 'ready']);
    expect(a[0]).toMatchObject({ tone: 'urgent', title: '1 chat is waiting for a person', href: '/board/handovers' });
    expect(a[1]!.title).toBe('3 payments need review');
    expect(a[2]!.detail).toContain('HTTP 403');
    expect(a[3]).toMatchObject({ tone: 'action', href: '/board/deliveries?status=paid' });
  });
  it('says when Chord could not be checked instead of claiming nobody is waiting', () => {
    const a = alertsFrom({ ...quiet, waiting: null, chord: 'unreachable', chordDetail: 'chord_timeout' });
    expect(a.map((x) => x.key)).toEqual(['chord']);
    expect(a[0]!.detail).toContain('chord_timeout');
    expect(tabBadges({ ...quiet, waiting: null, chord: 'unreachable' }).system.n).toBe(1);
  });
  it('flags misconfiguration and failed tools, and badges the right tabs', () => {
    const s = { ...quiet, chord: 'invalid' as const, waiting: null, tools24h: { calls: 9, errors: 3, faults: 2 }, stuck: 1, noticeFailed: 1 };
    expect(alertsFrom(s).map((x) => x.key)).toEqual(['stuck', 'config', 'notices', 'tools']);
    expect(tabBadges(s)).toMatchObject({ payments: { n: 2, urgent: true }, system: { n: 2 }, handovers: { n: 0 } });
  });
});

describe('theme', () => {
  const req = (cookie: string) => new Request('https://x/board', { headers: { Cookie: cookie } });
  it('reads only light or dark; anything else follows the device', () => {
    expect(readTheme(req('zd_theme=dark'))).toBe('dark');
    expect(readTheme(req('a=1; zd_theme=light'))).toBe('light');
    expect(readTheme(req('zd_theme=<script>'))).toBe('auto');
    expect(readTheme(new Request('https://x/board'))).toBe('auto');
  });
  it('auto deletes the cookie; https cookies are Secure', () => {
    expect(themeCookie(new URL('https://x/board'), 'dark')).toBe('zd_theme=dark; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure');
    expect(themeCookie(new URL('http://127.0.0.1/board'), 'auto')).toBe('zd_theme=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  });
  it('returns only to board pages or the sign-in page (keeping a safe next)', () => {
    expect(safeBack('/board/deliveries?status=paid')).toBe('/board/deliveries?status=paid');
    expect(safeBack('/board/login?next=%2Fboard%2Fjobs%2FZD-AB12C')).toBe('/board/login?next=%2Fboard%2Fjobs%2FZD-AB12C');
    expect(safeBack('/board/login?next=https://evil.example')).toBe('/board/login');
    expect(safeBack('https://evil.example')).toBe('/board');
    expect(safeBack(null)).toBe('/board');
  });
  it('marks the current choice pressed and renders data-theme only when chosen', () => {
    const html = themeSwitch('dark', '/board');
    expect(html).toContain('value="dark" aria-pressed="true"');
    expect(html).toContain('value="light" aria-pressed="false"');
    expect(html).toContain('Switch to Match device');
    expect(page({ title: 't', body: '', theme: 'light' }).headers.get('Content-Type')).toContain('text/html');
  });
  it('page() sets data-theme for light/dark and nothing for auto', async () => {
    expect(await page({ title: 't', body: '', theme: 'dark' }).text()).toContain('<html lang="en" data-theme="dark">');
    expect(await page({ title: 't', body: '', theme: 'auto' }).text()).toContain('<html lang="en"><head>');
  });
});

describe('shell helpers', () => {
  it('drops one-off flash parameters from the return path', () => {
    expect(hereWithoutFlash(new URL('https://x/board/payments?msg=Done&sig=abc&tone=error'))).toBe('/board/payments');
    expect(hereWithoutFlash(new URL('https://x/board/deliveries?status=paid&msg=x'))).toBe('/board/deliveries?status=paid');
  });
  it('announcement: trimmed, collapsed, capped at 280, empty means none', () => {
    expect(announcementText('  Lagos riders\n off Sunday  ')).toBe('Lagos riders off Sunday');
    expect(announcementText('x'.repeat(400))!.length).toBe(280);
    expect(announcementText('   ')).toBeNull();
    expect(announcementText(undefined)).toBeNull();
  });
});

describe('tool faults vs refusals', () => {
  it('only our failures count as broken', async () => {
    const { isFault, alertsFrom: af } = await import('../src/web/signals');
    for (const c of ['INTERNAL_ERROR', 'GEOCODER_UNAVAILABLE', 'ROUTING_UNAVAILABLE', 'PAYMENT_PROVIDER_UNAVAILABLE', 'PAYMENT_PROVIDER_BUSY', 'UNKNOWN_TOOL', null]) expect(isFault(c)).toBe(true);
    for (const c of ['OUT_OF_SERVICE_AREA', 'JOB_NOT_FOUND', 'INTERSTATE_NOT_SUPPORTED', 'INVALID_ARGUMENTS', 'SAME_LOCATION']) expect(isFault(c)).toBe(false);
    expect(af({ ...quiet, tools24h: { calls: 50, errors: 40, faults: 0 } })).toEqual([]);
  });
});

describe('announcement banner', () => {
  it('escapes what the owner typed', async () => {
    const { announcement } = await import('../src/web/layout');
    expect(announcement('<script>x</script>')).toContain('&lt;script&gt;');
    expect(announcement(null)).toBe('');
  });
});
