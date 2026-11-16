import type { ReportingDatePreset, ReportingGranularity } from '@business-os/contracts';
import { formatMoney } from '../sales/format';

export const PRESETS: { id: ReportingDatePreset; label: string }[] = [
  { id: 'last_7_days', label: 'Last 7 days' },
  { id: 'last_30_days', label: 'Last 30 days' },
  { id: 'last_90_days', label: 'Last 90 days' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'last_3_months', label: 'Last 3 months' },
  { id: 'last_12_months', label: 'Last 12 months' },
  { id: 'year_to_date', label: 'Year to date' },
];

export const GRANULARITY_LABEL: Record<ReportingGranularity, string> = { day: 'Day', week: 'Week', month: 'Month', none: 'Total only' };

export const ZONE_LABEL: Record<string, string> = {
  finance: 'Finance', sales: 'Sales', customers: 'Customers', projects: 'Projects', scheduling: 'Scheduling', people: 'People', communications: 'Communications',
};

/** A metric value for people: money in its own currency (never converted), counts as whole numbers. */
export function formatValue(value: string | null, valueType: 'money' | 'count', currency: string | null, locale?: string): string {
  if (value === null) return 'Hidden (small group)';
  if (valueType === 'money' && currency) return formatMoney(value, currency, locale);
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value as unknown as number);
  } catch {
    return value;
  }
}

/** Short axis text from an approximate number. */
export function formatTick(value: number, valueType: 'money' | 'count', currency: string | null, locale?: string): string {
  // Counts are whole numbers: a fractional gridline ("0.3 invoices") is left unlabelled.
  if (valueType === 'count' && !Number.isInteger(value)) return '';
  try {
    return new Intl.NumberFormat(locale, valueType === 'money' && currency
      ? { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }
      : { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  } catch {
    return String(value);
  }
}

/** A bucket start date as a period label ("3 Nov", "Week of 2 Nov", "Nov 2026"), shown as that calendar date everywhere. */
export function bucketLabel(day: string, granularity: ReportingGranularity, locale?: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  try {
    if (granularity === 'month') return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
    const short = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
    return granularity === 'week' ? `Week of ${short}` : short;
  } catch {
    return day;
  }
}

export function rangeLabel(from: string, to: string, locale?: string): string {
  try {
    const f = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
    return `${f.format(new Date(`${from}T00:00:00Z`))} – ${f.format(new Date(`${to}T00:00:00Z`))}`;
  } catch {
    return `${from} – ${to}`;
  }
}

/** "+12.5% vs previous period", with a direction for the colour (which never carries the meaning alone). */
export function changeText(changePercent: string | null): { text: string; trend: 'up' | 'down' | 'neutral' } | null {
  if (changePercent === null) return null;
  const n = Number(changePercent);
  if (n === 0) return { text: 'No change vs previous period', trend: 'neutral' };
  return { text: `${n > 0 ? '+' : ''}${changePercent}% vs previous period`, trend: n > 0 ? 'up' : 'down' };
}

// ---- R2: date helpers (presentation only; the API resolves and validates every range itself) ------------

const DAY_MS = 86_400_000;
const toDay = (d: Date) => d.toISOString().slice(0, 10);
const parseDay = (day: string) => new Date(`${day}T00:00:00Z`);
const addDays = (day: string, n: number) => toDay(new Date(parseDay(day).getTime() + n * DAY_MS));

/** Inclusive number of calendar days between two YYYY-MM-DD dates. */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / DAY_MS) + 1;
}

/**
 * Roughly how many days a date setting covers, from the business's "today" (the catalogue's). Used only to
 * pick a readable interval and to keep requests inside the API's bucket limit; the API resolves the real range.
 */
export function approxDays(date: { kind: 'fixed'; from: string; to: string } | { kind: 'relative'; preset: ReportingDatePreset }, today: string): number {
  if (date.kind === 'fixed') return daysBetween(date.from, date.to);
  switch (date.preset) {
    case 'last_7_days': return 7;
    case 'last_30_days': return 30;
    case 'last_90_days': return 90;
    case 'this_month': return Number(today.slice(8, 10));
    case 'last_month': return 31;
    case 'last_3_months': return 92;
    case 'last_12_months': return 366;
    case 'year_to_date': return daysBetween(`${today.slice(0, 4)}-01-01`, today);
  }
}

/** A readable interval for a range: days up to a month, weeks up to a quarter, months beyond. */
export function autoGranularity(days: number): Exclude<ReportingGranularity, 'none'> {
  if (days <= 31) return 'day';
  if (days <= 92) return 'week';
  return 'month';
}

/** The last calendar day of the bucket that starts on `start` (weeks start on Monday, per the API). */
export function bucketEnd(start: string, granularity: ReportingGranularity): string {
  if (granularity === 'day') return start;
  if (granularity === 'week') return addDays(start, 6);
  if (granularity === 'month') {
    const d = parseDay(start);
    return toDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
  }
  return start;
}

/**
 * The dates one bucket covers inside the report's range. The first bucket can start before the range and
 * the last can end after it; the API only counts in-range records, so the drill-down is clipped the same way.
 */
export function bucketRange(start: string, granularity: ReportingGranularity, range: { from: string; to: string }): { from: string; to: string } {
  const end = bucketEnd(start, granularity);
  return { from: start < range.from ? range.from : start, to: end > range.to ? range.to : end };
}

/** Checks a custom range before it is sent. Returns a message for the person, or null when it can be run. */
export function customRangeProblem(from: string, to: string, maxRangeDays: number): string | null {
  const valid = (v: string) => /^20\d{2}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(parseDay(v).getTime()) && toDay(parseDay(v)) === v;
  if (!valid(from) || !valid(to)) return 'Enter both dates (years 2000 to 2099).';
  if (from > to) return 'The start date must be on or before the end date.';
  if (daysBetween(from, to) > maxRangeDays) return `Choose a range of at most ${maxRangeDays.toLocaleString()} days.`;
  return null;
}
