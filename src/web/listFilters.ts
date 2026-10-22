/**
 * Date, time-of-day and sort filters for the Deliveries list. Pure (no database), so every edge case is
 * unit-tested: real calendar dates only, day-first dates typed by hand, a start after the end,
 * overnight time ranges, presets vs typed dates, and WAT day boundaries.
 *
 * Nigeria is UTC+1 all year (no daylight saving), so a WAT day is a fixed 24 h window.
 */

export const WAT_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export type When = '' | 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'last_month';
export type DateBy = 'booked' | 'paid' | 'delivered';
export type Sort = 'newest' | 'oldest' | 'amount_desc' | 'amount_asc' | 'distance_desc' | 'updated';

export const WHEN_LABEL: Record<Exclude<When, ''>, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  month: 'This month',
  last_month: 'Last month',
};
export const BY_LABEL: Record<DateBy, string> = { booked: 'Booked', paid: 'Paid', delivered: 'Delivered' };
export const SORT_LABEL: Record<Sort, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  amount_desc: 'Highest amount',
  amount_asc: 'Lowest amount',
  distance_desc: 'Longest trip',
  updated: 'Recently changed',
};
/** Quick time-of-day ranges, matching rider hours (7am–8pm). Ends are inclusive to the minute. */
export const TIME_PRESETS: { key: string; label: string; from: string; to: string }[] = [
  { key: 'morning', label: 'Morning 7–12', from: '07:00', to: '11:59' },
  { key: 'afternoon', label: 'Afternoon 12–5', from: '12:00', to: '16:59' },
  { key: 'evening', label: 'Evening 5–8', from: '17:00', to: '19:59' },
  { key: 'after_hours', label: 'After hours 8pm–7am', from: '20:00', to: '06:59' },
];

export const MAX_PAGE = 500;

export interface DateFilters {
  when: When;
  /** Normalised YYYY-MM-DD, or '' when absent or not a real date. */
  dateFrom: string;
  dateTo: string;
  /** Normalised HH:MM, or ''. */
  timeFrom: string;
  timeTo: string;
  by: DateBy;
  sort: Sort;
  page: number;
  /** Plain-English notes about input we corrected or ignored, shown above the list. */
  notes: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');
const clip = (s: string) => (s.length > 24 ? `${s.slice(0, 24)}…` : s);

/** A real calendar date as YYYY-MM-DD, from "2026-10-21" (date input) or "21/10/2026" (typed, day first). */
export function parseDay(raw: string | null): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dmy) [y, m, d] = [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])];
  else return null;
  if (y < 2000 || y > 2100) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC rolls 2026-02-30 over to 2 March: a real date survives the round trip unchanged.
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Epoch ms of WAT midnight that starts this YYYY-MM-DD day. */
export function dayStartMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) - WAT_MS;
}

/** WAT midnight at or before this instant. */
export function watMidnight(ms: number): number {
  return Math.floor((ms + WAT_MS) / DAY_MS) * DAY_MS - WAT_MS;
}

export function watDay(ms: number): string {
  return new Date(ms + WAT_MS).toISOString().slice(0, 10);
}

/** Minutes after midnight from "08:30", "8:30", "08:30:00" (time inputs), "8pm" or "8:30am". */
export function parseTime(raw: string | null): number | null {
  const s = (raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  const m24 = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  if (m24) {
    const h = Number(m24[1]), min = Number(m24[2]);
    return h <= 23 && min <= 59 ? h * 60 + min : null;
  }
  const m12 = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(s);
  if (m12) {
    const h = Number(m12[1]), min = Number(m12[2] ?? 0);
    if (h < 1 || h > 12 || min > 59) return null;
    return ((h % 12) + (m12[3] === 'pm' ? 12 : 0)) * 60 + min;
  }
  return null;
}

export const hhmm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** Reads the date, time and sort filters from the URL, correcting what it safely can and noting the rest. */
export function readDateFilters(url: URL): DateFilters {
  const p = url.searchParams;
  const notes: string[] = [];
  const whenRaw = p.get('when') ?? '';
  let when: When = Object.hasOwn(WHEN_LABEL, whenRaw) ? (whenRaw as When) : '';
  const byRaw = p.get('by') ?? '';
  const by: DateBy = Object.hasOwn(BY_LABEL, byRaw) ? (byRaw as DateBy) : 'booked';
  const sortRaw = p.get('sort') ?? '';
  const sort: Sort = Object.hasOwn(SORT_LABEL, sortRaw) ? (sortRaw as Sort) : 'newest';
  const pageNum = Number(p.get('page') ?? '1');
  const page = Number.isInteger(pageNum) && pageNum >= 1 ? Math.min(pageNum, MAX_PAGE) : 1;

  const day = (key: string, label: string) => {
    const raw = (p.get(key) ?? '').trim();
    const v = parseDay(raw);
    if (raw && !v) notes.push(`Ignored the ${label} “${clip(raw)}”: not a real date. Use the date picker, or type it like 21/10/2026.`);
    return v ?? '';
  };
  let dateFrom = day('date_from', 'start date');
  let dateTo = day('date_to', 'end date');
  if (dateFrom && dateTo && dateFrom > dateTo) {
    [dateFrom, dateTo] = [dateTo, dateFrom];
    notes.push('The start date was after the end date, so they were swapped.');
  }
  // Typed dates are more specific than a preset, so they win.
  if ((dateFrom || dateTo) && when) when = '';

  const time = (key: string, label: string) => {
    const raw = (p.get(key) ?? '').trim();
    const v = parseTime(raw);
    if (raw && v === null) notes.push(`Ignored the ${label} “${clip(raw)}”: not a time of day. Use 24-hour time like 08:30 or 20:00.`);
    return v;
  };
  const tf = time('time_from', 'start time');
  const tt = time('time_to', 'end time');
  let timeFrom = tf === null ? '' : hhmm(tf);
  let timeTo = tt === null ? '' : hhmm(tt);
  if (tf !== null && tt !== null && tf === tt) {
    notes.push(`The start and end times are both ${hhmm(tf)}, so the time filter was left off.`);
    timeFrom = timeTo = '';
  }
  return { when, dateFrom, dateTo, timeFrom, timeTo, by, sort, page, notes };
}

export interface Range {
  /** Inclusive start and exclusive end, epoch ms; null = open. */
  start: number | null;
  end: number | null;
  /** "today", "15–21 Oct 2026", "from 1 Oct 2026"… or '' for any time. */
  label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayLabel(ms: number): string {
  const d = new Date(ms + WAT_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function spanLabel(start: number, endExclusive: number): string {
  const last = endExclusive - DAY_MS;
  if (last <= start) return `on ${dayLabel(start)}`;
  const a = new Date(start + WAT_MS), b = new Date(last + WAT_MS);
  if (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()) return `${a.getUTCDate()}–${dayLabel(last)}`;
  if (a.getUTCFullYear() === b.getUTCFullYear()) return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${dayLabel(last)}`;
  return `${dayLabel(start)} – ${dayLabel(last)}`;
}

/** The time window the filters select, as WAT-day-aligned epoch bounds. */
export function resolveRange(f: Pick<DateFilters, 'when' | 'dateFrom' | 'dateTo'>, now: number): Range {
  const today = watMidnight(now);
  if (f.dateFrom || f.dateTo) {
    const start = f.dateFrom ? dayStartMs(f.dateFrom) : null;
    const end = f.dateTo ? dayStartMs(f.dateTo) + DAY_MS : null;
    const label = start !== null && end !== null ? spanLabel(start, end) : start !== null ? `from ${dayLabel(start)}` : `up to ${dayLabel(end! - DAY_MS)}`;
    return { start, end, label };
  }
  const monthStart = (offset: number) => {
    const d = new Date(today + WAT_MS);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1) - WAT_MS;
  };
  switch (f.when) {
    case 'today':
      return { start: today, end: today + DAY_MS, label: 'today' };
    case 'yesterday':
      return { start: today - DAY_MS, end: today, label: 'yesterday' };
    case '7d':
      return { start: today - 6 * DAY_MS, end: today + DAY_MS, label: `in the last 7 days (${spanLabel(today - 6 * DAY_MS, today + DAY_MS)})` };
    case '30d':
      return { start: today - 29 * DAY_MS, end: today + DAY_MS, label: `in the last 30 days (${spanLabel(today - 29 * DAY_MS, today + DAY_MS)})` };
    case 'month':
      return { start: monthStart(0), end: monthStart(1), label: `this month (${MONTHS[new Date(today + WAT_MS).getUTCMonth()]})` };
    case 'last_month': {
      const s = monthStart(-1);
      return { start: s, end: monthStart(0), label: `last month (${MONTHS[new Date(s + WAT_MS).getUTCMonth()]} ${new Date(s + WAT_MS).getUTCFullYear()})` };
    }
    default:
      return { start: null, end: null, label: '' };
  }
}

/** The column that "the date" means for this filter (booked, paid or delivered). */
export function dateColumn(by: DateBy): string {
  if (by === 'paid') return 'j.paid_at';
  if (by === 'delivered') return "(SELECT MAX(e.created_at) FROM job_events e WHERE e.job_id = j.id AND e.to_status = 'delivered')";
  return 'j.created_at';
}

/**
 * SQL conditions for the date range and time of day on that column. Jobs without the date (not paid,
 * not delivered) never match a paid/delivered filter. Times are whole minutes in WAT; a range that
 * crosses midnight ("20:00 to 06:59") matches either side of it.
 */
export function dateConditions(f: DateFilters, now: number): { sql: string[]; binds: unknown[] } {
  const col = dateColumn(f.by);
  const sql: string[] = [];
  const binds: unknown[] = [];
  const range = resolveRange(f, now);
  if (f.by !== 'booked') sql.push(`${col} IS NOT NULL`);
  if (range.start !== null) {
    sql.push(`${col} >= ?`);
    binds.push(range.start);
  }
  if (range.end !== null) {
    sql.push(`${col} < ?`);
    binds.push(range.end);
  }
  const tf = parseTime(f.timeFrom), tt = parseTime(f.timeTo);
  if (tf !== null || tt !== null) {
    const minute = `(CAST((${col} + ${WAT_MS}) / 60000 AS INTEGER) % 1440)`;
    const from = tf ?? 0, to = tt ?? 1439;
    if (from <= to) {
      sql.push(`${minute} BETWEEN ? AND ?`);
      binds.push(from, to);
    } else {
      sql.push(`(${minute} >= ? OR ${minute} <= ?)`);
      binds.push(from, to);
    }
  }
  return { sql, binds };
}

/** "08:00–11:59", "20:00–06:59 (overnight)", "from 17:00", "up to 09:00", or ''. */
export function timeLabel(f: Pick<DateFilters, 'timeFrom' | 'timeTo'>): string {
  if (!f.timeFrom && !f.timeTo) return '';
  if (f.timeFrom && f.timeTo) return `${f.timeFrom}–${f.timeTo}${f.timeFrom > f.timeTo ? ' (overnight)' : ''} WAT`;
  return f.timeFrom ? `from ${f.timeFrom} WAT` : `up to ${f.timeTo} WAT`;
}

/** ORDER BY for the sort, always ending on the job id so pages never overlap or skip a row. */
export function orderBy(sort: Sort, by: DateBy): string {
  const col = dateColumn(by);
  switch (sort) {
    case 'oldest':
      return `${col} IS NULL, ${col} ASC, j.id ASC`;
    case 'amount_desc':
      return 'j.amount_kobo DESC, j.created_at DESC, j.id DESC';
    case 'amount_asc':
      return 'j.amount_kobo ASC, j.created_at DESC, j.id DESC';
    case 'distance_desc':
      return 'q.distance_m IS NULL, q.distance_m DESC, j.created_at DESC, j.id DESC';
    case 'updated':
      return 'j.updated_at DESC, j.id DESC';
    default:
      return `${col} IS NULL, ${col} DESC, j.id DESC`;
  }
}
