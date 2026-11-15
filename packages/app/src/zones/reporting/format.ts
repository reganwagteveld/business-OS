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
