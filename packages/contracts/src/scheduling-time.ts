// Wall-clock ↔ instant conversion for Scheduling (docs/scheduling-s1.md §4). Pure functions on top of
// the runtime's IANA time-zone database (Intl), shared by the API and the clients so both interpret a
// local time in a zone the same way. No dependency, no assumption about any country's zones or DST rules.
//
// A local time in a zone maps to 0 instants (a gap, e.g. when clocks spring forward), 1 instant, or 2
// instants (an overlap, e.g. when clocks fall back). The API refuses the first, and requires the second
// to be disambiguated ('earlier' or 'later') or to be sent as an unambiguous instant instead.

const MINUTE = 60_000;
const DAY = 86_400_000;

/** A wall-clock time with no zone: what a person reads on a clock. Month is 1–12. */
export interface WallTime {
  year: number; month: number; day: number; hour: number; minute: number; second?: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/**
 * The canonical spelling of an IANA zone the runtime knows (e.g. "america/new_york" → "America/New_York"),
 * or null. Offset strings ("+05:00") and abbreviations Intl rejects are not zones.
 */
export function canonicalTimeZone(value: string): string | null {
  if (value.length > 64 || !ZONE_SHAPE.test(value)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The wall-clock time an instant shows in a zone, with its weekday (0 = Sunday). */
export function wallTimeOf(instant: Date | number, timeZone: string): WallTime & { second: number; weekday: number } {
  const parts = formatter(timeZone).formatToParts(typeof instant === 'number' ? instant : instant.getTime());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')), weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

const asUtc = (w: WallTime) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second ?? 0);

/** The zone's offset from UTC at an instant, in minutes (east positive). Whole seconds of historical offsets are kept. */
export function offsetMinutes(instant: number, timeZone: string): number {
  const at = Math.floor(instant / 1000) * 1000;
  return (asUtc(wallTimeOf(at, timeZone)) - at) / MINUTE;
}

/** True for a real calendar time (no 31 April, no 24:00). */
export function isRealWallTime(w: WallTime): boolean {
  if (![w.year, w.month, w.day, w.hour, w.minute, w.second ?? 0].every(Number.isInteger)) return false;
  if (w.hour < 0 || w.hour > 23 || w.minute < 0 || w.minute > 59 || (w.second ?? 0) < 0 || (w.second ?? 0) > 59) return false;
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day));
  return w.year >= 1 && w.year <= 9999 && d.getUTCFullYear() === w.year && d.getUTCMonth() === w.month - 1 && d.getUTCDate() === w.day;
}

/** Every instant at which the zone's clocks show `w`, earliest first: 0 (a gap), 1, or 2 (an overlap). */
export function instantsFor(w: WallTime, timeZone: string): number[] {
  const naive = asUtc(w);
  // Any transition near `naive` is between the offsets a day either side (zones change at most once a day).
  const offsets = new Set([offsetMinutes(naive - DAY, timeZone), offsetMinutes(naive, timeZone), offsetMinutes(naive + DAY, timeZone)]);
  const found = new Set<number>();
  for (const o of offsets) {
    const candidate = naive - o * MINUTE;
    if (asUtc(wallTimeOf(candidate, timeZone)) === naive) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

export type Disambiguation = 'earlier' | 'later';
export type Resolved =
  | { ok: true; instant: number }
  | { ok: false; reason: 'nonexistent' }
  | { ok: false; reason: 'ambiguous'; earlier: number; later: number };

/**
 * One instant for a wall-clock time in a zone. A time in a gap is refused (never shifted silently); a
 * time that occurs twice needs `disambiguation`.
 */
export function resolveWallTime(w: WallTime, timeZone: string, disambiguation?: Disambiguation): Resolved {
  const found = instantsFor(w, timeZone);
  if (found.length === 0) return { ok: false, reason: 'nonexistent' };
  if (found.length === 1) return { ok: true, instant: found[0]! };
  if (!disambiguation) return { ok: false, reason: 'ambiguous', earlier: found[0]!, later: found[found.length - 1]! };
  return { ok: true, instant: disambiguation === 'earlier' ? found[0]! : found[found.length - 1]! };
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
/** Parses "YYYY-MM-DDTHH:mm[:ss]" (no zone, no offset) into a real wall time, or null. */
export function parseWallTime(value: string): WallTime | null {
  const m = LOCAL.exec(value);
  if (!m) return null;
  const w = { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: m[6] ? +m[6] : 0 };
  return isRealWallTime(w) ? w : null;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
/** "YYYY-MM-DD" of a wall time. */
export const dateKey = (w: { year: number; month: number; day: number }) => `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
/** "YYYY-MM-DDTHH:mm" of a wall time. */
export const wallTimeKey = (w: WallTime) => `${dateKey(w)}T${pad(w.hour)}:${pad(w.minute)}`;

/** Adds whole days to a calendar date ("YYYY-MM-DD"), in the proleptic Gregorian calendar. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY);
  return dateKey({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() });
}

/** Weekday of a calendar date, 0 = Sunday. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The first instant of a calendar date in a zone. Usually local midnight; where midnight does not exist
 * (a zone that changes its clocks at 00:00) it is the instant the day actually starts, and where midnight
 * occurs twice it is the earlier one. Day, week and month views are built from these boundaries, so a
 * day can be 23, 24 or 25 hours long.
 */
export function startOfDay(date: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const midnight = { year, month, day, hour: 0, minute: 0 };
  const found = instantsFor(midnight, timeZone);
  if (found.length > 0) return found[0]!;
  // In a gap: the clocks jumped over midnight at the instant the old offset reached it.
  return asUtc(midnight) - offsetMinutes(asUtc(midnight) - DAY, timeZone) * MINUTE;
}

/** The calendar date ("YYYY-MM-DD") an instant falls on in a zone. */
export const dateIn = (instant: Date | number, timeZone: string) => dateKey(wallTimeOf(instant, timeZone));
