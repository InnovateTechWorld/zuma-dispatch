import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { listHref, listQuery } from '../src/web/jobsShared';
import {
  DAY_MS, dateConditions, dayStartMs, hhmm, orderBy, parseDay, parseTime, readDateFilters, resolveRange, timeLabel, WAT_MS, watDay, watMidnight,
} from '../src/web/listFilters';
import { board } from '../src/web/pages';
import { safeNext } from '../src/web/session';
import { addJob, d1 } from './helpers/sqliteD1';

/** Epoch ms for a WAT wall-clock time. */
const wat = (iso: string) => Date.parse(`${iso}+01:00`);
const NOW = wat('2026-10-22T14:30:00'); // a Thursday afternoon in Lagos
const q = (search: string) => readDateFilters(new URL(`https://x/board/deliveries?${search}`));

describe('parseDay: real calendar dates only', () => {
  it('reads the date picker format and day-first typing', () => {
    expect(parseDay('2026-10-21')).toBe('2026-10-21');
    expect(parseDay('21/10/2026')).toBe('2026-10-21');
    expect(parseDay('1/2/2026')).toBe('2026-02-01'); // 1 February, Nigerian order
    expect(parseDay('21.10.2026')).toBe('2026-10-21');
    expect(parseDay(' 2026-1-5 ')).toBe('2026-01-05');
  });
  it('refuses impossible and odd dates instead of rolling them over', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '31/04/2026', '2025-02-29', '1999-12-31', '2101-01-01', 'yesterday', '2026/10/21', '10-21', '', '0000-00-00'])
      expect(parseDay(bad), bad).toBeNull();
    expect(parseDay('2028-02-29')).toBe('2028-02-29'); // leap year
  });
});

describe('parseTime', () => {
  it('reads 24-hour, seconds from some browsers, and am/pm', () => {
    expect(parseTime('08:30')).toBe(510);
    expect(parseTime('8:30')).toBe(510);
    expect(parseTime('20:00:00')).toBe(1200);
    expect(parseTime('20:00:00.000')).toBe(1200);
    expect(parseTime('8pm')).toBe(1200);
    expect(parseTime('8:30 AM')).toBe(510);
    expect(parseTime('12am')).toBe(0);
    expect(parseTime('12pm')).toBe(720);
    expect(parseTime('23:59')).toBe(1439);
  });
  it('refuses times that do not exist', () => {
    for (const bad of ['24:00', '12:60', '13pm', '0am', 'noon', '8', '-1:00', '']) expect(parseTime(bad), bad).toBeNull();
  });
});

describe('WAT days', () => {
  it('a WAT day starts at 23:00 UTC the evening before', () => {
    expect(dayStartMs('2026-10-22')).toBe(Date.UTC(2026, 9, 21, 23));
    expect(watMidnight(NOW)).toBe(dayStartMs('2026-10-22'));
    // 00:30 WAT is still "yesterday" in UTC, but today in Lagos.
    expect(watDay(wat('2026-10-22T00:30:00'))).toBe('2026-10-22');
    expect(watDay(wat('2026-10-21T23:59:59'))).toBe('2026-10-21');
  });
});

describe('readDateFilters: correct what is safe, explain the rest', () => {
  it('defaults: any time, booked date, newest first, page 1', () => {
    expect(q('')).toEqual({ when: '', dateFrom: '', dateTo: '', timeFrom: '', timeTo: '', by: 'booked', sort: 'newest', page: 1, notes: [] });
  });
  it('swaps a start date after the end date, and says so', () => {
    const f = q('date_from=2026-10-21&date_to=2026-10-15');
    expect([f.dateFrom, f.dateTo]).toEqual(['2026-10-15', '2026-10-21']);
    expect(f.notes).toEqual(['The start date was after the end date, so they were swapped.']);
  });
  it('ignores an impossible date with a note, keeps the other one', () => {
    const f = q('date_from=2026-02-30&date_to=2026-03-05');
    expect([f.dateFrom, f.dateTo]).toEqual(['', '2026-03-05']);
    expect(f.notes[0]).toMatch(/Ignored the start date “2026-02-30”: not a real date/);
  });
  it('clips and escapes nothing itself (the page escapes), but never echoes more than 24 characters', () => {
    const f = q(`date_to=${encodeURIComponent('<script>' + 'x'.repeat(100))}`);
    expect(f.notes[0]).toContain('“<script>xxxxxxxxxxxxxxxx…”');
  });
  it('typed dates win over a preset', () => {
    expect(q('when=today&date_from=2026-10-01')).toMatchObject({ when: '', dateFrom: '2026-10-01' });
    expect(q('when=today')).toMatchObject({ when: 'today' });
  });
  it('unknown values fall back to defaults quietly', () => {
    expect(q('when=forever&by=shipped&sort=random&page=-3')).toMatchObject({ when: '', by: 'booked', sort: 'newest', page: 1, notes: [] });
    expect(q('page=2.5').page).toBe(1);
    expect(q('page=99999').page).toBe(500);
    expect(q('page=3').page).toBe(3);
  });
  it('normalises times and drops an empty range', () => {
    expect(q('time_from=8pm&time_to=7:00')).toMatchObject({ timeFrom: '20:00', timeTo: '07:00', notes: [] });
    const same = q('time_from=09:00&time_to=09:00');
    expect([same.timeFrom, same.timeTo]).toEqual(['', '']);
    expect(same.notes[0]).toMatch(/both 09:00/);
    expect(q('time_from=25:00').notes[0]).toMatch(/Ignored the start time “25:00”/);
  });
});

describe('resolveRange (now = Thu 22 Oct 2026, 14:30 WAT)', () => {
  const r = (search: string) => resolveRange(q(search), NOW);
  const day = (d: string) => dayStartMs(d);
  it('presets', () => {
    expect(r('when=today')).toMatchObject({ start: day('2026-10-22'), end: day('2026-10-23'), label: 'today' });
    expect(r('when=yesterday')).toMatchObject({ start: day('2026-10-21'), end: day('2026-10-22') });
    expect(r('when=7d')).toMatchObject({ start: day('2026-10-16'), end: day('2026-10-23'), label: 'in the last 7 days (16–22 Oct 2026)' });
    expect(r('when=30d').start).toBe(day('2026-09-23'));
    expect(r('when=30d').label).toBe('in the last 30 days (23 Sep – 22 Oct 2026)');
    expect(r('when=month')).toMatchObject({ start: day('2026-10-01'), end: day('2026-11-01'), label: 'this month (Oct)' });
    expect(r('when=last_month')).toMatchObject({ start: day('2026-09-01'), end: day('2026-10-01'), label: 'last month (Sep 2026)' });
  });
  it('last month in January is December of the year before', () => {
    expect(resolveRange(q('when=last_month'), wat('2027-01-10T09:00:00'))).toMatchObject({ start: day('2026-12-01'), end: day('2027-01-01'), label: 'last month (Dec 2026)' });
  });
  it('typed ranges include both days; open ends', () => {
    expect(r('date_from=2026-10-15&date_to=2026-10-21')).toMatchObject({ start: day('2026-10-15'), end: day('2026-10-22'), label: '15–21 Oct 2026' });
    expect(r('date_from=2026-10-21&date_to=2026-10-21')).toMatchObject({ end: day('2026-10-22'), label: 'on 21 Oct 2026' });
    expect(r('date_from=2025-12-30&date_to=2026-01-02').label).toBe('30 Dec 2025 – 2 Jan 2026');
    expect(r('date_from=2026-10-01')).toMatchObject({ start: day('2026-10-01'), end: null, label: 'from 1 Oct 2026' });
    expect(r('date_to=2026-10-01')).toMatchObject({ start: null, end: day('2026-10-02'), label: 'up to 1 Oct 2026' });
    expect(r('')).toEqual({ start: null, end: null, label: '' });
  });
});

describe('labels and links', () => {
  it('describes overnight time ranges', () => {
    expect(timeLabel({ timeFrom: '20:00', timeTo: '06:59' })).toBe('20:00–06:59 (overnight) WAT');
    expect(timeLabel({ timeFrom: '17:00', timeTo: '' })).toBe('from 17:00 WAT');
    expect(hhmm(0)).toBe('00:00');
  });
  it('links keep every filter, leave out defaults, and round-trip', () => {
    const f = listQuery(new URL('https://x/board/deliveries?q=ada&status=paid&city=lagos&when=7d&time_from=20:00&time_to=06:59&by=paid&sort=amount_desc&page=2&live=1'));
    const href = listHref(f);
    expect(href).toBe('/board/deliveries?q=ada&status=paid&city=lagos&when=7d&time_from=20%3A00&time_to=06%3A59&by=paid&sort=amount_desc&page=2&live=1');
    expect(listQuery(new URL(`https://x${href}`))).toMatchObject({ ...f, notes: [] });
    expect(listHref(listQuery(new URL('https://x/board/deliveries?by=booked&sort=newest&page=1')))).toBe('/board/deliveries');
  });
  it('a long filtered link is still a safe place to return to after an action', () => {
    const f = listQuery(new URL(`https://x/board/deliveries?q=${encodeURIComponent('ọ'.repeat(80))}&when=30d&time_from=20:00&time_to=06:59&by=delivered&sort=oldest&page=12`));
    const href = listHref(f);
    expect(href.length).toBeGreaterThan(300);
    expect(safeNext(href)).toBe(href);
  });
});

async function listed(env: Env, search: string): Promise<{ ids: string[]; html: string }> {
  const url = new URL(`https://x/board/deliveries${search ? `?${search}` : ''}`);
  const res = await board(new Request(url), url, env, { businessName: 'Zuma Dispatch' } as never, {} as never, { signedIn: true, theme: 'auto' });
  const html = await res.text();
  const tbody = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  return { ids: [...tbody.matchAll(/href="\/board\/jobs\/(ZD-[0-9A-Z]{5})"/g)].map((m) => m[1]!), html };
}

describe('Deliveries list against SQLite', () => {
  const { db, env } = d1();
  const realNow = Date.now;
  const a = addJob(db, { booked: '2026-10-22T00:30:00', kobo: 300_000, km: 12 }); // today, just after midnight WAT
  const b = addJob(db, { booked: '2026-10-21T23:59:00', status: 'paid', paid: '2026-10-22T00:05:00', kobo: 195_000 }); // yesterday, paid today
  const c = addJob(db, { booked: '2026-10-21T10:00:00', status: 'delivered', paid: '2026-10-21T10:10:00', delivered: '2026-10-21T11:00:00', kobo: 285_000, state: 'FC' });
  const d = addJob(db, { booked: '2026-10-15T21:15:00', status: 'cancelled', kobo: 900_000, km: 22, sender: 'Tolu' });
  const e = addJob(db, { booked: '2026-09-30T08:00:00', status: 'paid', paid: '2026-09-30T08:20:00', kobo: 150_000 });

  const at = async (search: string) => {
    Date.now = () => NOW;
    try {
      return await listed(env, search);
    } finally {
      Date.now = realNow;
    }
  };

  it('newest first by default, and "today" uses WAT midnight, not UTC', async () => {
    expect((await at('')).ids).toEqual([a, b, c, d, e]);
    expect((await at('when=today')).ids).toEqual([a]);
    expect((await at('when=yesterday')).ids).toEqual([b, c]);
  });
  it('the same preset by payment date picks different jobs, and unpaid jobs never match', async () => {
    expect((await at('when=today&by=paid')).ids).toEqual([b]);
    expect((await at('by=paid')).ids).toEqual([b, c, e]);
    expect((await at('by=delivered')).ids).toEqual([c]);
  });
  it('typed range includes both days; a reversed range is swapped with a note', async () => {
    expect((await at('date_from=2026-10-15&date_to=2026-10-21')).ids).toEqual([b, c, d]);
    const swapped = await at('date_from=2026-10-21&date_to=2026-10-15');
    expect(swapped.ids).toEqual([b, c, d]);
    expect(swapped.html).toContain('so they were swapped');
  });
  it('time of day, including an overnight range', async () => {
    expect((await at('time_from=20:00&time_to=06:59')).ids).toEqual([a, b, d]); // 00:30, 23:59, 21:15
    expect((await at('time_from=07:00&time_to=11:59')).ids).toEqual([c, e]);
    expect((await at('time_from=21:15&time_to=21:15')).ids).toEqual([a, b, c, d, e]); // equal times: filter left off
    expect((await at('time_from=23:59')).ids).toEqual([b]);
  });
  it('sorts, with stable tie-breaks', async () => {
    expect((await at('sort=oldest')).ids).toEqual([e, d, c, b, a]);
    expect((await at('sort=amount_desc')).ids).toEqual([d, a, c, b, e]);
    expect((await at('sort=amount_asc')).ids).toEqual([e, b, c, a, d]);
    expect((await at('sort=distance_desc')).ids.slice(0, 2)).toEqual([d, a]);
    expect((await at('by=paid&sort=oldest')).ids).toEqual([e, c, b]);
  });
  it('chip counts follow the date filter, and totals add up', async () => {
    const { html } = await at('when=yesterday');
    expect(html).toMatch(/2 deliveries booked yesterday · ₦4,800 booked · ₦4,800 paid \(2 jobs\)/);
    expect(html).toMatch(/>All<span class="num">2<\/span>/);
    expect(html).toMatch(/>Abuja<span class="num">1<\/span>/);
  });
  it('combines with status, city and search', async () => {
    expect((await at('when=30d&status=paid')).ids).toEqual([b, e]);
    expect((await at('when=30d&city=abuja')).ids).toEqual([c]);
    expect((await at('q=tolu&when=30d')).ids).toEqual([d]);
    expect((await at('q=tolu&when=7d')).ids).toEqual([]); // 15 Oct is just outside 16–22 Oct
  });
  it('empty results explain themselves; a page past the end links back', async () => {
    const none = await at('date_from=2026-01-01&date_to=2026-01-31');
    expect(none.ids).toEqual([]);
    expect(none.html).toContain('No deliveries booked 1–31 Jan 2026');
    const past = await at('page=4');
    expect(past.html).toContain('There are no deliveries on page 4');
    expect((await at('by=delivered&when=today')).html).toContain('Only jobs that were delivered have a delivered date.');
  });
  it('bad input never breaks the page and is never echoed raw', async () => {
    const r = await at(`date_from=${encodeURIComponent('"><script>alert(1)</script>')}&time_to=99:99&sort=x&page=abc`);
    expect(r.ids).toEqual([a, b, c, d, e]);
    expect(r.html).not.toContain('<script>alert');
    expect(r.html).toContain('Ignored the start date');
    expect(r.html).toContain('Ignored the end time');
  });
  it('the row shows the date being filtered on', async () => {
    expect((await at('by=paid&when=today')).html).toMatch(/paid 10-22 00:05 WAT/);
  });
  it('sortable headers flip direction and say so to screen readers', async () => {
    const { html } = await at('sort=amount_desc');
    expect(html).toContain('<th aria-sort="descending"><a class="th-sort" href="/board/deliveries?sort=amount_asc"');
  });
  it('old /board links with the new filters land on the list', async () => {
    const url = new URL('https://x/board?when=today');
    const res = await board(new Request(url), url, env, { businessName: 'Zuma Dispatch' } as never, {} as never, { signedIn: true, theme: 'auto' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://x/board/deliveries?when=today');
  });
});

it('pages never overlap: 230 jobs, 100 per page', async () => {
  const { db, env } = d1();
  const ids = new Set<string>();
  for (let i = 0; i < 230; i++) addJob(db, { booked: new Date(wat('2026-10-01T09:00:00') + Math.floor(i / 3) * 60_000 + WAT_MS).toISOString().slice(0, 19), kobo: 150_000 });
  for (const page of [1, 2, 3]) {
    const r = await listed(env, `page=${page}&sort=amount_desc`);
    r.ids.forEach((x) => ids.add(x));
    if (page === 1) expect(r.html).toContain('Page 1 of 3');
  }
  expect(ids.size).toBe(230); // equal amounts and shared minutes still page cleanly
  expect(dateConditions(q('when=today'), NOW).binds).toEqual([dayStartMs('2026-10-22'), dayStartMs('2026-10-22') + DAY_MS]);
  expect(orderBy('newest', 'booked')).toContain('j.id DESC');
});

describe('signing in keeps a filtered link', () => {
  it('re-encodes characters browsers leave raw, and still refuses anything off the board', () => {
    expect(safeNext('/board/deliveries?when=30d&time_from=20:00&time_to=06:59')).toBe('/board/deliveries?when=30d&time_from=20%3A00&time_to=06%3A59');
    expect(safeNext('/board/deliveries?q=ada obi')).toBe('/board/deliveries?q=ada+obi');
    expect(safeNext('/board/deliveries?')).toBe('/board/deliveries');
    expect(safeNext('//evil.example/board?x=1')).toBe('/board');
    expect(safeNext('/board/../admin?x=1')).toBe('/board');
    expect(safeNext('/board/login?next=/board')).toBe('/board');
    expect(safeNext('/board/deliveries?q=%E0%A4')).toBe('/board/deliveries?q=%EF%BF%BD'); // broken encoding becomes a harmless character
  });
});
