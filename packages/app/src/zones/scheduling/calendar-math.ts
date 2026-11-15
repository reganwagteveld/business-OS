// Day, week and month view geometry (docs/scheduling-s1.md §6). Every boundary is computed in the
// selected calendar's IANA zone with the shared time functions, so a day is 23, 24 or 25 hours long
// where the zone changes its clocks, and nothing assumes any country's rules.
import { addDays, dateIn, startOfDay, wallTimeOf, weekdayOf, type SchedulingEvent } from '@business-os/contracts';

export type ViewKind = 'day' | 'week' | 'month';

export interface ViewRange {
  /** Calendar dates shown, in order ("YYYY-MM-DD"). */
  days: string[];
  /** First instant of the first day and first instant after the last day: the [from, to) the API is asked for. */
  from: number;
  to: number;
}

/** First day of the week for a locale (0 = Sunday), from Intl week data where the runtime has it; ISO Monday otherwise. */
export function weekStartFor(locale: string): number {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const firstDay = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay;
    if (firstDay) return firstDay % 7;
  } catch {
    // An unknown locale falls back to ISO weeks.
  }
  return 1;
}

export function viewRange(kind: ViewKind, anchor: string, timeZone: string, weekStart: number): ViewRange {
  let first: string;
  let count: number;
  if (kind === 'day') {
    first = anchor;
    count = 1;
  } else if (kind === 'week') {
    first = addDays(anchor, -((weekdayOf(anchor) - weekStart + 7) % 7));
    count = 7;
  } else {
    const monthStart = `${anchor.slice(0, 7)}-01`;
    first = addDays(monthStart, -((weekdayOf(monthStart) - weekStart + 7) % 7));
    count = 42; // six weeks always fit any month
  }
  const days = Array.from({ length: count }, (_, i) => addDays(first, i));
  return { days, from: startOfDay(days[0]!, timeZone), to: startOfDay(addDays(days[days.length - 1]!, 1), timeZone) };
}

/** The anchor date one view earlier (-1) or later (+1). Months keep the day where they can (31 Jan → 28/29 Feb). */
export function shiftAnchor(kind: ViewKind, anchor: string, direction: 1 | -1): string {
  if (kind === 'day') return addDays(anchor, direction);
  if (kind === 'week') return addDays(anchor, 7 * direction);
  const [y, m, d] = anchor.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + direction;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export const todayIn = (timeZone: string, now = Date.now()) => dateIn(now, timeZone);

/** One event's piece inside one day, in minutes from that day's local midnight (0–1440). */
export interface Segment {
  event: SchedulingEvent;
  top: number;
  bottom: number;
  /** The event started before this day / continues after it. */
  continuesBefore: boolean;
  continuesAfter: boolean;
  lane: number;
  lanes: number;
}

const minutesOf = (instant: number, timeZone: string) => {
  const w = wallTimeOf(instant, timeZone);
  return w.hour * 60 + w.minute;
};

/**
 * The part of each event inside `day`, laid out in side-by-side lanes where they overlap. Positions come
 * from local wall-clock minutes, so an event at 09:00 sits at the 09:00 line on any day, short or long.
 */
export function daySegments(events: SchedulingEvent[], day: string, timeZone: string): Segment[] {
  const dayStart = startOfDay(day, timeZone);
  const dayEnd = startOfDay(addDays(day, 1), timeZone);
  const pieces = events
    .map((event) => ({ event, s: Date.parse(event.startAt), e: Date.parse(event.endAt) }))
    .filter(({ s, e }) => s < dayEnd && e > dayStart)
    .map(({ event, s, e }) => {
      const top = s <= dayStart ? 0 : minutesOf(s, timeZone);
      const bottom = e >= dayEnd ? 1440 : minutesOf(e, timeZone);
      return { event, top, bottom: Math.max(bottom, top + 15), continuesBefore: s < dayStart, continuesAfter: e > dayEnd, lane: 0, lanes: 1 };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.event.id.localeCompare(b.event.id));
  // Greedy lanes within each cluster of mutually overlapping pieces.
  let cluster: Segment[] = [];
  let clusterEnd = -1;
  const close = () => {
    const lanes = Math.max(1, ...cluster.map((p) => p.lane + 1));
    for (const p of cluster) p.lanes = lanes;
    cluster = [];
  };
  for (const piece of pieces) {
    if (piece.top >= clusterEnd && cluster.length) close();
    const laneEnds: number[] = [];
    for (const p of cluster) laneEnds[p.lane] = Math.max(laneEnds[p.lane] ?? 0, p.bottom);
    let lane = laneEnds.findIndex((end) => end <= piece.top);
    if (lane === -1) lane = laneEnds.length;
    piece.lane = lane;
    cluster.push(piece);
    clusterEnd = Math.max(clusterEnd, piece.bottom);
  }
  if (cluster.length) close();
  return pieces;
}

/** Events touching `day`, by start: for the month grid. */
export function eventsOnDay(events: SchedulingEvent[], day: string, timeZone: string): SchedulingEvent[] {
  const dayStart = startOfDay(day, timeZone);
  const dayEnd = startOfDay(addDays(day, 1), timeZone);
  return events.filter((e) => Date.parse(e.startAt) < dayEnd && Date.parse(e.endAt) > dayStart).sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id));
}

// ---- formatting (Intl, the business's locale, the calendar's zone) ------------------------------------

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(locale: string, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    } catch {
      f = new Intl.DateTimeFormat('en', { ...options, timeZone });
    }
    cache.set(key, f);
  }
  return f;
}
/** A calendar date as a stable instant for formatting its name (noon UTC never crosses a date line for date-only parts). */
const dateValue = (day: string) => Date.parse(`${day}T12:00:00Z`);

export const formatTime = (instant: string | number, locale: string, timeZone: string) =>
  fmt(locale, timeZone, { hour: 'numeric', minute: '2-digit' }).format(typeof instant === 'string' ? Date.parse(instant) : instant);
export const formatDateTime = (instant: string, locale: string, timeZone: string) =>
  fmt(locale, timeZone, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(Date.parse(instant));
export const formatDayHeading = (day: string, locale: string) => fmt(locale, 'UTC', { weekday: 'short', day: 'numeric' }).format(dateValue(day));
export const formatLongDay = (day: string, locale: string) => fmt(locale, 'UTC', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(dateValue(day));
export const formatMonth = (day: string, locale: string) => fmt(locale, 'UTC', { month: 'long', year: 'numeric' }).format(dateValue(day));
export const formatWeekday = (day: string, locale: string) => fmt(locale, 'UTC', { weekday: 'short' }).format(dateValue(day));
export const formatHour = (hour: number, locale: string) => fmt(locale, 'UTC', { hour: 'numeric' }).format(Date.UTC(2000, 0, 1, hour));

/** The heading of a view: one day, a week's span, or a month. */
export function formatRangeTitle(kind: ViewKind, range: ViewRange, anchor: string, locale: string): string {
  if (kind === 'day') return formatLongDay(anchor, locale);
  if (kind === 'month') return formatMonth(anchor, locale);
  const first = range.days[0]!;
  const last = range.days[range.days.length - 1]!;
  return fmt(locale, 'UTC', { day: 'numeric', month: 'short', year: 'numeric' }).formatRange(dateValue(first), dateValue(last));
}

/** The wall-clock date and time ("YYYY-MM-DD", "HH:mm") of an instant in a zone, for the form's inputs. */
export function localParts(instant: string, timeZone: string): { date: string; time: string } {
  const w = wallTimeOf(Date.parse(instant), timeZone);
  return { date: dateIn(Date.parse(instant), timeZone), time: `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}` };
}
