import { describe, expect, it } from 'vitest';
import {
  addDays, canonicalTimeZone, CreateEventRequest, dateIn, EventTime, instantsFor, offsetMinutes, parseWallTime, resolveWallTime, startOfDay,
  UpdateEventRequest, wallTimeOf, weekdayOf,
} from '../src/index.ts';

const w = (s: string) => parseWallTime(s)!;
const iso = (ms: number) => new Date(ms).toISOString();

describe('time zones', () => {
  it('accepts IANA zones in canonical spelling and nothing else', () => {
    expect(canonicalTimeZone('america/new_york')).toBe('America/New_York');
    expect(canonicalTimeZone('Australia/Lord_Howe')).toBe('Australia/Lord_Howe');
    expect(canonicalTimeZone('UTC')).toBe('UTC');
    for (const bad of ['', 'Mars/Olympus', '+05:00', '-0800', 'Europe/London; DROP', 'x'.repeat(65)]) expect(canonicalTimeZone(bad), bad).toBeNull();
  });

  it('knows each zone’s offset, including half- and quarter-hour zones, from the runtime’s database', () => {
    const jan = Date.UTC(2031, 0, 15, 12);
    const jul = Date.UTC(2031, 6, 15, 12);
    expect([offsetMinutes(jan, 'America/New_York'), offsetMinutes(jul, 'America/New_York')]).toEqual([-300, -240]);
    expect([offsetMinutes(jan, 'America/Phoenix'), offsetMinutes(jul, 'America/Phoenix')]).toEqual([-420, -420]); // no DST
    expect([offsetMinutes(jan, 'Australia/Sydney'), offsetMinutes(jul, 'Australia/Sydney')]).toEqual([660, 600]); // southern hemisphere
    expect([offsetMinutes(jan, 'Australia/Lord_Howe'), offsetMinutes(jul, 'Australia/Lord_Howe')]).toEqual([660, 630]); // 30-minute DST
    expect([offsetMinutes(jan, 'Asia/Kolkata'), offsetMinutes(jul, 'Asia/Kolkata')]).toEqual([330, 330]);
    expect([offsetMinutes(jan, 'Pacific/Chatham'), offsetMinutes(jul, 'Pacific/Chatham')]).toEqual([825, 765]);
    expect([offsetMinutes(jan, 'Asia/Kathmandu'), offsetMinutes(jul, 'Europe/London')]).toEqual([345, 60]);
  });
});

describe('wall-clock to instant', () => {
  it('maps an ordinary local time to exactly one instant', () => {
    expect(instantsFor(w('2031-07-10T22:00'), 'Europe/London').map(iso)).toEqual(['2031-07-10T21:00:00.000Z']);
    expect(resolveWallTime(w('2031-07-10T09:00'), 'Asia/Kolkata')).toEqual({ ok: true, instant: Date.parse('2031-07-10T03:30:00Z') });
  });

  it('refuses times in a spring-forward gap, in either hemisphere and for 30-minute shifts', () => {
    expect(resolveWallTime(w('2031-03-09T02:30'), 'America/New_York')).toEqual({ ok: false, reason: 'nonexistent' });
    expect(resolveWallTime(w('2031-03-30T01:15'), 'Europe/London')).toEqual({ ok: false, reason: 'nonexistent' });
    expect(resolveWallTime(w('2031-10-05T02:30'), 'Australia/Sydney')).toEqual({ ok: false, reason: 'nonexistent' });
    expect(resolveWallTime(w('2031-10-05T02:15'), 'Australia/Lord_Howe')).toEqual({ ok: false, reason: 'nonexistent' });
    expect(resolveWallTime(w('2031-10-05T02:45'), 'Australia/Lord_Howe').ok).toBe(true); // only half an hour is skipped
    // Just either side of the gap exists.
    expect(resolveWallTime(w('2031-03-09T01:59'), 'America/New_York').ok).toBe(true);
    expect(resolveWallTime(w('2031-03-09T03:00'), 'America/New_York').ok).toBe(true);
  });

  it('requires a choice for a fall-back time that happens twice, and honours it', () => {
    const r = resolveWallTime(w('2031-11-02T01:30'), 'America/New_York');
    expect(r).toEqual({ ok: false, reason: 'ambiguous', earlier: Date.parse('2031-11-02T05:30:00Z'), later: Date.parse('2031-11-02T06:30:00Z') });
    expect(resolveWallTime(w('2031-11-02T01:30'), 'America/New_York', 'earlier')).toEqual({ ok: true, instant: Date.parse('2031-11-02T05:30:00Z') });
    expect(resolveWallTime(w('2031-11-02T01:30'), 'America/New_York', 'later')).toEqual({ ok: true, instant: Date.parse('2031-11-02T06:30:00Z') });
    expect(resolveWallTime(w('2031-04-06T02:30'), 'Australia/Sydney')).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(resolveWallTime(w('2031-04-06T01:45'), 'Australia/Lord_Howe')).toMatchObject({ ok: false, reason: 'ambiguous' });
    // Zones without DST never ask.
    expect(resolveWallTime(w('2031-11-02T01:30'), 'America/Phoenix').ok).toBe(true);
  });

  it('parses only real local times', () => {
    expect(parseWallTime('2031-02-29T10:00')).toBeNull();
    expect(parseWallTime('2032-02-29T10:00')).not.toBeNull();
    expect(parseWallTime('2031-01-01T24:00')).toBeNull();
    expect(parseWallTime('2031-01-01T10:00Z')).toBeNull();
    expect(parseWallTime('2031-01-01 10:00')).toBeNull();
  });
});

describe('calendar days', () => {
  it('starts a day at local midnight, or where midnight does not exist, when the day really starts', () => {
    expect(iso(startOfDay('2031-07-11', 'Europe/London'))).toBe('2031-07-10T23:00:00.000Z');
    expect(iso(startOfDay('2031-07-11', 'Australia/Perth'))).toBe('2031-07-10T16:00:00.000Z');
    // America/Santiago moves its clocks forward at midnight in September: the day starts at 01:00.
    const santiago = startOfDay('2031-09-07', 'America/Santiago');
    expect(wallTimeOf(santiago, 'America/Santiago')).toMatchObject({ year: 2031, month: 9, day: 7, hour: 1, minute: 0 });
    expect(dateIn(santiago - 1, 'America/Santiago')).toBe('2031-09-06');
  });

  it('has 23-, 24- and 25-hour days', () => {
    const len = (d: string, z: string) => (startOfDay(addDays(d, 1), z) - startOfDay(d, z)) / 3_600_000;
    expect(len('2031-03-09', 'America/New_York')).toBe(23);
    expect(len('2031-11-02', 'America/New_York')).toBe(25);
    expect(len('2031-11-03', 'America/New_York')).toBe(24);
    expect(len('2031-10-05', 'Australia/Lord_Howe')).toBe(23.5);
  });

  it('does date arithmetic across months, years and leap days', () => {
    expect(addDays('2031-12-31', 1)).toBe('2032-01-01');
    expect(addDays('2032-02-28', 1)).toBe('2032-02-29');
    expect(addDays('2032-03-01', -1)).toBe('2032-02-29');
    expect(weekdayOf('2031-01-01')).toBe(3); // Wednesday
    expect(dateIn(Date.parse('2031-07-10T21:30:00Z'), 'Pacific/Chatham')).toBe('2031-07-11');
  });
});

describe('event time contracts', () => {
  it('accepts an instant with an offset or a local time with an explicit zone, and nothing ambiguous', () => {
    expect(EventTime.safeParse({ at: '2031-01-01T10:00:00+05:30' }).success).toBe(true);
    expect(EventTime.safeParse({ at: '2031-01-01T10:00:00Z' }).success).toBe(true);
    expect(EventTime.safeParse({ at: '2031-01-01T10:00:00' }).success).toBe(false); // no offset: which zone?
    expect(EventTime.parse({ local: '2031-01-01T10:00', timeZone: 'europe/paris' })).toEqual({ local: '2031-01-01T10:00', timeZone: 'Europe/Paris' });
    expect(EventTime.safeParse({ local: '2031-01-01T10:00' }).success).toBe(false); // a local time needs a zone
    expect(EventTime.safeParse({ local: '2031-01-01T10:00', timeZone: 'Nowhere/City' }).success).toBe(false);
    expect(EventTime.safeParse({ local: '2031-01-01T10:00', timeZone: 'UTC', disambiguation: 'first' }).success).toBe(false);
  });

  it('enforces conflicts unless the request says otherwise, and needs something to update', () => {
    const base = { calendarId: '0b6f3c1e-8a0a-4b8f-9a55-3d1c1a3f7b10', title: 'A', start: { at: '2031-01-01T10:00:00Z' }, end: { at: '2031-01-01T11:00:00Z' } };
    expect(CreateEventRequest.parse(base).enforceConflicts).toBe(true);
    expect(CreateEventRequest.parse({ ...base, enforceConflicts: false }).enforceConflicts).toBe(false);
    expect(UpdateEventRequest.safeParse({ version: 1 }).success).toBe(false);
    expect(UpdateEventRequest.safeParse({ version: 1, enforceConflicts: false }).success).toBe(false);
    expect(UpdateEventRequest.safeParse({ version: 1, title: 'B' }).success).toBe(true);
  });
});
