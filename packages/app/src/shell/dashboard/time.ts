import { addDays, dateIn, startOfDay } from '@business-os/contracts';

/**
 * Date helpers for the operational dashboard. "Today" is always the business's calendar date in its own
 * IANA time zone (never the viewer's), so a person in another zone sees the same days as the business.
 */

/** The business's calendar date for an instant. */
export const businessToday = (timeZone: string, now: number = Date.now()) => dateIn(now, timeZone);

/**
 * The upcoming-schedule window: from now to the start of the day `days` days after today, in the business
 * zone. With 7 that is the rest of today plus the six whole days after it (days are 23 to 25 hours long
 * where the clocks change). Returned as ISO instants for the events endpoint (half-open [from, to)).
 */
export function upcomingWindow(timeZone: string, days: number, now: number = Date.now()): { from: string; to: string; lastDay: string } {
  const today = businessToday(timeZone, now);
  return { from: new Date(now).toISOString(), to: new Date(startOfDay(addDays(today, days), timeZone)).toISOString(), lastDay: addDays(today, days - 1) };
}

/** Whole days an invoice due on `dueDate` is past due on `today` (both business calendar dates). 0 when not yet overdue. */
export function daysOverdue(dueDate: string, today: string): number {
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 86_400_000) : 0;
}

/** "Today", "Tomorrow" or the weekday and date of a business calendar date. */
export function dayLabel(day: string, today: string, locale?: string): string {
  if (day === today) return 'Today';
  if (day === addDays(today, 1)) return 'Tomorrow';
  try {
    return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.parse(`${day}T12:00:00Z`));
  } catch {
    return day;
  }
}

/** The business calendar date an instant falls on. */
export const businessDay = (instant: string, timeZone: string) => dateIn(Date.parse(instant), timeZone);

/** A time of day in the business zone ("9:30 am"). */
export function timeIn(instant: string, timeZone: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(Date.parse(instant));
  } catch {
    return instant;
  }
}
