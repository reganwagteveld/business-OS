// Calendar arithmetic for reports (docs/reporting-r1.md §5). Pure: no database, no clock except the
// `today` passed in. Every date is a business-local calendar date (YYYY-MM-DD); ranges are inclusive.
// Weeks start on Monday (ISO 8601), matching PostgreSQL's date_trunc('week').
import type { ReportingDateConfig, ReportingGranularity, ReportingRange } from '@business-os/contracts';
import { RuleViolationError } from '@/core/http/errors';

export const LIMITS = {
  /** Metrics in one query or saved view. */
  maxMetrics: 6,
  /** Longest range, in days (five years and a leap day). */
  maxRangeDays: 1827,
  /** Most buckets in one series (for example 400 days, or five years of months). */
  maxBuckets: 400,
  /** Most series shown per metric; the rest are counted in `hiddenSeries`. */
  maxSeries: 12,
  /** Most rows in one page of drill-down records. */
  maxDetailRows: 100,
} as const;

const DAY_MS = 86_400_000;
const toTime = (day: string) => Date.parse(`${day}T00:00:00Z`);
const toDay = (time: number) => new Date(time).toISOString().slice(0, 10);

export const addDays = (day: string, days: number) => toDay(toTime(day) + days * DAY_MS);
export const daysBetween = (from: string, to: string) => Math.round((toTime(to) - toTime(from)) / DAY_MS);

function parts(day: string) {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}
const ymd = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** First day of the month `months` months from `day`'s month (negative goes back). */
function shiftMonth(day: string, months: number): { y: number; m: number } {
  const { y, m } = parts(day);
  const index = y * 12 + (m - 1) + months;
  return { y: Math.floor(index / 12), m: (index % 12) + 1 };
}
export const startOfMonth = (day: string) => `${day.slice(0, 8)}01`;
export const endOfMonth = (day: string) => {
  const { y, m } = parts(day);
  return ymd(y, m, daysInMonth(y, m));
};

/** Start of the bucket that contains `day`. */
export function bucketStart(day: string, unit: 'day' | 'week' | 'month'): string {
  if (unit === 'day') return day;
  if (unit === 'month') return startOfMonth(day);
  const weekday = new Date(toTime(day)).getUTCDay(); // 0 = Sunday
  return addDays(day, -((weekday + 6) % 7));
}

/**
 * Bucket start dates covering [from, to]. The first bucket may start before `from` (a week or month
 * already under way): it still only holds records inside the range.
 */
export function buckets(range: ReportingRange, granularity: ReportingGranularity): string[] {
  if (granularity === 'none') return [range.from];
  const out: string[] = [];
  let cursor = bucketStart(range.from, granularity);
  while (cursor <= range.to) {
    out.push(cursor);
    if (granularity === 'day') cursor = addDays(cursor, 1);
    else if (granularity === 'week') cursor = addDays(cursor, 7);
    else {
      const next = shiftMonth(cursor, 1);
      cursor = ymd(next.y, next.m, 1);
    }
    if (out.length > LIMITS.maxBuckets) break;
  }
  return out;
}

/** The business-local calendar date now, in an IANA zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Resolves a fixed or relative date configuration against today's date in the business's zone. */
export function resolveDate(config: ReportingDateConfig, today: string): ReportingRange {
  if (config.kind === 'fixed') return { from: config.from, to: config.to };
  const { y } = parts(today);
  const monthsBack = (n: number) => {
    const s = shiftMonth(today, -n);
    return ymd(s.y, s.m, 1);
  };
  switch (config.preset) {
    case 'last_7_days': return { from: addDays(today, -6), to: today };
    case 'last_30_days': return { from: addDays(today, -29), to: today };
    case 'last_90_days': return { from: addDays(today, -89), to: today };
    case 'this_month': return { from: startOfMonth(today), to: today };
    case 'last_month': {
      const from = monthsBack(1);
      return { from, to: endOfMonth(from) };
    }
    case 'last_3_months': return { from: monthsBack(2), to: today };
    case 'last_12_months': return { from: monthsBack(11), to: today };
    case 'year_to_date': return { from: ymd(y, 1, 1), to: today };
  }
}

/**
 * The comparison period (owner decision R-D5): the IMMEDIATELY preceding period with the same number of
 * days, ending the day before the range starts. 1–15 Nov (15 days) → 17–31 Oct; 1–30 Nov (30 days) →
 * 2–31 Oct; 1–31 Mar (31 days) → 29 Jan–28 Feb (non-leap year). Calendar-aligned comparisons (previous
 * calendar month, same period last year) are not R1 semantics.
 */
export function previousPeriod(range: ReportingRange): ReportingRange {
  const length = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}

/** Refuses a range or granularity outside the limits, with a message that says what to change. */
export function checkRange(range: ReportingRange, granularity: ReportingGranularity): void {
  if (range.from > range.to) throw new RuleViolationError('invalid_date_range', 'The start date must be on or before the end date.');
  const days = daysBetween(range.from, range.to) + 1;
  if (days > LIMITS.maxRangeDays) {
    throw new RuleViolationError('range_too_large', `A report can cover at most ${LIMITS.maxRangeDays} days (five years). Choose a shorter range.`);
  }
  if (buckets(range, granularity).length > LIMITS.maxBuckets) {
    throw new RuleViolationError('too_many_buckets', `This range has more than ${LIMITS.maxBuckets} ${granularity} periods. Choose a longer interval or a shorter range.`);
  }
}
