import { inviteForSignup, admitFixture } from './support/admission';
/**
 * Scheduling S1 (docs/scheduling-s1.md): calendars and events through the real route handlers, against
 * PostgreSQL with the migrations and privileged SQL applied as in production. Two independent businesses
 * and every membership role. Concurrency tests coordinate through PostgreSQL itself (pg_blocking_pids),
 * never through sleeps.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AvailabilityResponse, CalendarResponse, DefaultCalendarResponse, EventResponse, ListCalendarsResponse, ListEventsResponse, SchedulingConflictResponse,
} from '@business-os/contracts';
import type { Permission, Role } from '@/modules/access';

// Custom permission sets for one role at a time, standing in for narrower roles (a read-only viewer).
// Everything else is the real code path: the route wrapper derives permissions from the verified membership.
const custom: Partial<Record<Role, Permission[]>> = {};
vi.mock('@/modules/access', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/access')>();
  return { ...real, permissionsFor: (role: Role) => custom[role] ?? real.permissionsFor(role) };
});

import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as customersRoute from '@/app/api/v1/b/[slug]/customers/route';
import * as calendarsRoute from '@/app/api/v1/b/[slug]/scheduling/calendars/route';
import * as defaultCalendarRoute from '@/app/api/v1/b/[slug]/scheduling/calendars/default/route';
import * as calendarRoute from '@/app/api/v1/b/[slug]/scheduling/calendars/[calendarId]/route';
import * as archiveCalendarRoute from '@/app/api/v1/b/[slug]/scheduling/calendars/[calendarId]/archive/route';
import * as restoreCalendarRoute from '@/app/api/v1/b/[slug]/scheduling/calendars/[calendarId]/restore/route';
import * as eventsRoute from '@/app/api/v1/b/[slug]/scheduling/events/route';
import * as eventRoute from '@/app/api/v1/b/[slug]/scheduling/events/[eventId]/route';
import * as cancelEventRoute from '@/app/api/v1/b/[slug]/scheduling/events/[eventId]/cancel/route';
import * as archiveEventRoute from '@/app/api/v1/b/[slug]/scheduling/events/[eventId]/archive/route';
import * as availabilityRoute from '@/app/api/v1/b/[slug]/scheduling/availability/route';
import { devOutbox } from '@/core/email';
import { backendPid, finishesOrBlocks, waitUntilBlocked } from './support/locks';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
/** Holds locks for the "participates in the lock protocol" tests; a superuser session that never writes rows. */
const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
const app = new pg.Client({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await Promise.all([admin.connect(), holder.connect(), app.connect()]);
});
afterAll(async () => {
  await Promise.all([admin.end(), holder.end(), app.end()]);
});
afterEach(() => {
  for (const key of Object.keys(custom)) delete custom[key as Role];
});

// A separate address range from the other suites, so rate-limit counters do not collide.
let ip = 1;
type User = { email: string; cookie: string; id: string };

function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.90.${Math.floor(ip / 250)}.${ip++ % 250}`, origin: ORIGIN });
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

async function newUser(prefix: string): Promise<User> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  await inviteForSignup(admin, email);
  await authRoute.POST(req('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: prefix } }));
  await admitFixture(admin, email);
  const mail = [...devOutbox].reverse().find((m) => m.to === email)!;
  const link = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!);
  const verify = new Request(`${BASE}${link.pathname}${link.search}`, { method: 'GET', headers: { 'x-forwarded-for': `100.90.250.${ip++ % 250}` } });
  await authRoute.GET(verify);
  const res = await authRoute.POST(req('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD } }));
  const cookie = res.headers.getSetCookie().find((c) => /session_token=/.test(c))!.split(';')[0]!;
  const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
  return { email, cookie, id: rows[0].id };
}

async function invite(slug: string, owner: User, user: User, role: string) {
  await invitationsRoute.POST(req('POST', `/api/v1/b/${slug}/invitations`, { cookie: owner.cookie, body: { email: user.email, role } }), ctx({ slug }));
  const mail = [...devOutbox].reverse().find((m) => m.to === user.email)!;
  const token = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!).searchParams.get('token');
  expect((await acceptRoute.POST(req('POST', '/api/v1/invitations/accept', { cookie: user.cookie, body: { token } }))).status).toBe(200);
}

/** A business (Perth time) with an OWNER and one member of each other role. */
async function team(label: string) {
  const owner = await newUser(`${label}-owner`);
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const created = await businessesRoute.POST(req('POST', '/api/v1/businesses', {
    cookie: owner.cookie, body: { name: `Business ${label}`, slug, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  }));
  expect(created.status).toBe(201);
  const people: Record<string, User> = { OWNER: owner };
  for (const role of ['ADMIN', 'MANAGER', 'MEMBER']) {
    const user = await newUser(`${label}-${role.toLowerCase()}`);
    await invite(slug, owner, user, role);
    people[role] = user;
  }
  const { rows } = await admin.query('SELECT id FROM businesses WHERE slug = $1', [slug]);
  return { slug, people, businessId: rows[0].id as string };
}

/** A business with only its OWNER: cheaper than `team` for tests that need a fresh default state. */
async function solo(label: string) {
  const owner = await newUser(`${label}-owner`);
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const created = await businessesRoute.POST(req('POST', '/api/v1/businesses', {
    cookie: owner.cookie, body: { name: `Business ${label}`, slug, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  }));
  expect(created.status).toBe(201);
  const { rows } = await admin.query('SELECT id FROM businesses WHERE slug = $1', [slug]);
  return { slug, owner, businessId: rows[0].id as string };
}

/** S1-01: a business with any active calendar has exactly one default, and the default is active. */
async function expectOneDefault(businessId: string) {
  const { rows } = await admin.query(
    `SELECT count(*) FILTER (WHERE archived_at IS NULL)::int AS active,
            count(*) FILTER (WHERE default_slot = 'default')::int AS defaults,
            count(*) FILTER (WHERE default_slot = 'default' AND archived_at IS NULL)::int AS active_defaults
     FROM scheduling_calendars WHERE business_id = $1`, [businessId]);
  const r = rows[0];
  if (r.active > 0) expect(r, 'active calendars need exactly one active default').toMatchObject({ defaults: 1, active_defaults: 1 });
  else expect(r.defaults).toBe(0);
}

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const api = (who: User, slug: string) => {
  const s = `/api/v1/b/${slug}/scheduling`;
  const c = (calendarId: string) => ctx({ slug, calendarId });
  const e = (eventId: string) => ctx({ slug, eventId });
  const q = (values: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) if (v !== undefined) p.set(k, v);
    return `?${p.toString()}`;
  };
  return {
    calendars: (qs = '') => calendarsRoute.GET(req('GET', `${s}/calendars${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    createCalendar: (body: unknown) => calendarsRoute.POST(req('POST', `${s}/calendars`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    initDefault: () => defaultCalendarRoute.POST(req('POST', `${s}/calendars/default`, { cookie: who.cookie }), ctx({ slug })).then(json),
    calendar: (id: string) => calendarRoute.GET(req('GET', `${s}/calendars/${id}`, { cookie: who.cookie }), c(id)).then(json),
    patchCalendar: (id: string, body: unknown) => calendarRoute.PATCH(req('PATCH', `${s}/calendars/${id}`, { cookie: who.cookie, body }), c(id)).then(json),
    archiveCalendar: (id: string, version: number) => archiveCalendarRoute.POST(req('POST', `${s}/calendars/${id}/archive`, { cookie: who.cookie, body: { version } }), c(id)).then(json),
    restoreCalendar: (id: string, version: number) => restoreCalendarRoute.POST(req('POST', `${s}/calendars/${id}/restore`, { cookie: who.cookie, body: { version } }), c(id)).then(json),
    events: (values: Record<string, string | undefined>) => eventsRoute.GET(req('GET', `${s}/events${q(values)}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    create: (body: unknown) => eventsRoute.POST(req('POST', `${s}/events`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    event: (id: string) => eventRoute.GET(req('GET', `${s}/events/${id}`, { cookie: who.cookie }), e(id)).then(json),
    patch: (id: string, body: unknown) => eventRoute.PATCH(req('PATCH', `${s}/events/${id}`, { cookie: who.cookie, body }), e(id)).then(json),
    cancel: (id: string, version: number) => cancelEventRoute.POST(req('POST', `${s}/events/${id}/cancel`, { cookie: who.cookie, body: { version } }), e(id)).then(json),
    archive: (id: string, version: number) => archiveEventRoute.POST(req('POST', `${s}/events/${id}/archive`, { cookie: who.cookie, body: { version } }), e(id)).then(json),
    availability: (values: Record<string, string | undefined>) => availabilityRoute.GET(req('GET', `${s}/availability${q(values)}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    createCustomer: (body: unknown) => customersRoute.POST(req('POST', `/api/v1/b/${slug}/customers`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
  };
};
const audits = async (targetId: string) =>
  (await admin.query('SELECT action, actor_user_id, business_id, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows;

const at = (iso: string) => ({ at: iso });
/** A slot on day `d` (1-based) of a far-future month, so tests never collide with each other's events. */
let slotBase = Date.UTC(2031, 0, 1);
const freshDay = () => {
  slotBase += 86_400_000;
  return slotBase;
};
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let calA: string;
let calB: string;
beforeAll(async () => {
  A = await team('sa');
  B = await team('sb');
  calA = (await api(A.people.MEMBER!, A.slug).initDefault()).body.calendar.id;
  calB = (await api(B.people.MEMBER!, B.slug).initDefault()).body.calendar.id;
}, 120_000);

/** A blocking event on `calendar` in A from `start` for `hours`. */
async function book(calendar: string, start: number, hours = 1, extra: Record<string, unknown> = {}) {
  const res = await api(A.people.MEMBER!, A.slug).create({ calendarId: calendar, title: 'Booking', start: at(iso(start)), end: at(iso(start + hours * H)), ...extra });
  return res;
}

describe('calendars', () => {
  it('initialises one default calendar in the business time zone, idempotently and safely under concurrency', async () => {
    const C = await team('sc');
    const results = await Promise.all(Array.from({ length: 8 }, () => api(C.people.MEMBER!, C.slug).initDefault()));
    for (const r of results) DefaultCalendarResponse.parse(r.body);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(7);
    expect(new Set(results.map((r) => r.body.calendar.id)).size).toBe(1);
    expect(results[0]!.body.calendar).toMatchObject({ isDefault: true, timeZone: 'Australia/Perth', name: 'Calendar', archivedAt: null });
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM scheduling_calendars WHERE business_id = $1', [C.businessId]);
    expect(rows[0].n).toBe(1);
    expect((await audits(results[0]!.body.calendar.id)).map((a) => a.action)).toEqual(['scheduling.calendar.initialized']);
  });

  it('manages several calendars; validates colours and IANA zones; names need not be unique', async () => {
    const m = api(A.people.MANAGER!, A.slug);
    const one = await m.createCalendar({ name: 'Rooms', colour: '#2563eb', timeZone: 'europe/london' });
    expect(one.status).toBe(201);
    expect(CalendarResponse.parse(one.body).calendar).toMatchObject({ name: 'Rooms', colour: '#2563eb', timeZone: 'Europe/London', isDefault: false, version: 1 });
    expect((await m.createCalendar({ name: 'Rooms' })).body.calendar.timeZone).toBe('Australia/Perth'); // business zone by default
    for (const body of [
      { name: '' }, { name: 'x'.repeat(101) }, { name: 'X', colour: 'blue' }, { name: 'X', colour: '#12345' }, { name: 'X', timeZone: 'Mars/Olympus' },
      { name: 'X', timeZone: '+05:00' }, { name: 'X', timeZone: 'EST5EDT; DROP' }, { name: 'X', isDefault: false }, { name: 'X', businessId: B.businessId },
    ]) {
      expect((await m.createCalendar(body)).status, JSON.stringify(body)).toBe(400);
    }
    const list = await m.calendars();
    ListCalendarsResponse.parse(list.body);
    expect(list.body.calendars.filter((c: { name: string }) => c.name === 'Rooms').length).toBeGreaterThanOrEqual(2);
  });

  it('moves the default atomically, refuses to archive the default, and keeps a business with exactly one default', async () => {
    const C = await team('sd');
    const o = api(C.people.OWNER!, C.slug);
    const first = (await o.initDefault()).body.calendar;
    const second = (await o.createCalendar({ name: 'Second' })).body.calendar;
    expect((await o.archiveCalendar(first.id, first.version)).body).toEqual({ error: 'default_calendar' });
    const promoted = await o.patchCalendar(second.id, { version: second.version, isDefault: true });
    expect(promoted.body.calendar.isDefault).toBe(true);
    const demoted = (await o.calendar(first.id)).body.calendar;
    expect(demoted.isDefault).toBe(false);
    expect((await o.patchCalendar(first.id, { version: demoted.version, isDefault: false })).status).toBe(400); // no "un-default"
    // Concurrent "make me the default" requests: serialised by the per-business lock; one default at the end.
    const extra = await Promise.all([1, 2, 3, 4].map((i) => o.createCalendar({ name: `C${i}` })));
    await Promise.all(extra.map((r) => o.patchCalendar(r.body.calendar.id, { version: 1, isDefault: true })));
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM scheduling_calendars WHERE business_id = $1 AND default_slot = 'default' AND archived_at IS NULL", [C.businessId]);
    expect(rows[0].n).toBe(1);
    // The old default can now be archived; archiving keeps its events and makes them read-only.
    const fresh = (await o.calendar(first.id)).body.calendar;
    const ev = (await o.create({ calendarId: first.id, title: 'Kept', start: at('2031-06-01T00:00:00Z'), end: at('2031-06-01T01:00:00Z') })).body.event;
    const archived = await o.archiveCalendar(first.id, fresh.version);
    expect(archived.body.calendar.archivedAt).not.toBeNull();
    expect((await o.event(ev.id)).body.event).toMatchObject({ id: ev.id, status: 'SCHEDULED', archivedAt: null });
    expect((await o.patch(ev.id, { version: ev.version, title: 'Edit' })).body).toEqual({ error: 'archived_reference' });
    expect((await o.create({ calendarId: first.id, title: 'New', start: at('2031-06-02T00:00:00Z'), end: at('2031-06-02T01:00:00Z') })).body).toEqual({ error: 'archived_reference' });
    expect((await o.calendars()).body.calendars.map((c: { id: string }) => c.id)).not.toContain(first.id);
    expect((await o.calendars('?archived=archived')).body.calendars.map((c: { id: string }) => c.id)).toEqual([first.id]);
    // Its own view still shows its history; the business-wide view does not.
    const range = { from: '2031-06-01T00:00:00Z', to: '2031-06-03T00:00:00Z' };
    expect((await o.events({ ...range, calendarId: first.id })).body.events.map((x: { id: string }) => x.id)).toEqual([ev.id]);
    expect((await o.events(range)).body.events).toEqual([]);
    const restored = await o.restoreCalendar(first.id, archived.body.calendar.version);
    expect(restored.body.calendar.archivedAt).toBeNull();
    expect((await o.restoreCalendar(first.id, restored.body.calendar.version)).body).toEqual({ error: 'not_archived' });
  });

  it('S1-01: the first calendar created through the API is the default, without calling initialisation', async () => {
    const S = await solo('se');
    const o = api(S.owner, S.slug);
    await expectOneDefault(S.businessId);
    const first = await o.createCalendar({ name: 'Front desk' });
    expect(first.status).toBe(201);
    expect(first.body.calendar).toMatchObject({ isDefault: true, name: 'Front desk' });
    await expectOneDefault(S.businessId);
    // Initialisation now finds it rather than adding a second calendar.
    const init = await o.initDefault();
    expect(init.status).toBe(200);
    expect(init.body.calendar.id).toBe(first.body.calendar.id);
    const second = await o.createCalendar({ name: 'Second' });
    expect(second.body.calendar.isDefault).toBe(false);
    const third = await o.createCalendar({ name: 'Third', isDefault: true });
    expect(third.body.calendar.isDefault).toBe(true);
    expect((await o.calendar(first.body.calendar.id)).body.calendar.isDefault).toBe(false);
    await expectOneDefault(S.businessId);
    // No supported call removes the default: archiving it is refused, "un-defaulting" is not part of the contract.
    const t = (await o.calendar(third.body.calendar.id)).body.calendar;
    expect((await o.archiveCalendar(t.id, t.version)).body).toEqual({ error: 'default_calendar' });
    expect((await o.patchCalendar(t.id, { version: t.version, isDefault: false })).status).toBe(400);
    // Archiving and restoring the others never leaves the business without a default.
    for (const id of [first.body.calendar.id, second.body.calendar.id]) {
      const c = (await o.calendar(id)).body.calendar;
      const archived = (await o.archiveCalendar(id, c.version)).body.calendar;
      await expectOneDefault(S.businessId);
      await o.restoreCalendar(id, archived.version);
      await expectOneDefault(S.businessId);
    }
    expect((await audits(first.body.calendar.id)).map((a) => [a.action, a.metadata])).toContainEqual(['scheduling.calendar.created', { default: 'first_calendar' }]);
  });

  it('S1-01: concurrent first creates and initialisations always leave exactly one default', async () => {
    for (let round = 0; round < 4; round++) {
      const S = await solo(`sf${round}`);
      const o = api(S.owner, S.slug);
      // Odd rounds: creates only, nobody initialises. Even rounds: creates racing initialisations.
      const results = await Promise.all(round % 2 === 1
        ? ['A', 'B', 'C', 'D', 'E'].map((name) => o.createCalendar({ name }))
        : [
          o.createCalendar({ name: 'A' }), o.initDefault(), o.createCalendar({ name: 'B' }), o.initDefault(),
          o.createCalendar({ name: 'C', isDefault: true }), o.createCalendar({ name: 'D' }), o.initDefault(),
        ]);
      expect(results.map((r) => r.status).every((s) => s === 200 || s === 201), `round ${round}: ${results.map((r) => r.status)}`).toBe(true);
      await expectOneDefault(S.businessId);
      const listed = (await o.calendars()).body.calendars as { id: string; isDefault: boolean }[];
      expect(listed.filter((c) => c.isDefault)).toHaveLength(1);
      expect(listed.length).toBeGreaterThanOrEqual(round % 2 === 1 ? 5 : 4);
      expect(listed.length).toBeLessThanOrEqual(5); // initialisation adds a calendar only when it ran before every create
    }
  });

  it('refuses stale calendar edits', async () => {
    const m = api(A.people.ADMIN!, A.slug);
    const cal = (await m.createCalendar({ name: 'Stale test' })).body.calendar;
    expect((await m.patchCalendar(cal.id, { version: 1, name: 'First' })).status).toBe(200);
    expect((await m.patchCalendar(cal.id, { version: 1, name: 'Second' })).body).toEqual({ error: 'stale' });
    expect((await m.archiveCalendar(cal.id, 1)).body).toEqual({ error: 'stale' });
  });
});

describe('events: rules', () => {
  it('creates a valid event; authorship from the session; no text in the audit log', async () => {
    const t = freshDay();
    const res = await api(A.people.MEMBER!, A.slug).create({
      calendarId: calA, title: '  Fitting for Ms Rossi ', location: 'Studio 2', description: 'Bring fabric', start: at(iso(t + 9 * H)), end: at(iso(t + 10 * H)),
    });
    expect(res.status).toBe(201);
    const { event, conflicts } = EventResponse.parse(res.body);
    expect(conflicts).toEqual([]);
    expect(event).toMatchObject({
      calendarId: calA, title: 'Fitting for Ms Rossi', status: 'SCHEDULED', blocksAvailability: true, customerId: null, cancelledAt: null,
      createdById: A.people.MEMBER!.id, updatedById: A.people.MEMBER!.id, version: 1, startAt: iso(t + 9 * H), endAt: iso(t + 10 * H),
    });
    const log = await audits(event.id);
    expect(log.map((a) => a.action)).toEqual(['scheduling.event.created']);
    expect(log[0].business_id).toBe(A.businessId);
    expect(JSON.stringify(log)).not.toMatch(/Rossi|Studio|fabric/);
  });

  it('rejects an end before the start, zero-length events, over-long events and unknown fields', async () => {
    const t = freshDay();
    const m = api(A.people.MEMBER!, A.slug);
    expect((await m.create({ calendarId: calA, title: 'X', start: at(iso(t + H)), end: at(iso(t)) })).body.error).toBe('invalid_interval');
    expect((await m.create({ calendarId: calA, title: 'X', start: at(iso(t)), end: at(iso(t)) })).body.error).toBe('invalid_interval');
    expect((await m.create({ calendarId: calA, title: 'X', start: at(iso(t)), end: at(iso(t + 32 * 24 * H)) })).body.error).toBe('duration_too_long');
    for (const body of [
      { calendarId: calA, title: '', start: at(iso(t)), end: at(iso(t + H)) },
      { calendarId: calA, title: 'X', start: at('2031-01-01T10:00'), end: at(iso(t + H)) }, // an instant needs Z or an offset
      { calendarId: calA, title: 'X', start: at(iso(t)), end: at(iso(t + H)), status: 'CANCELLED' },
      { calendarId: calA, title: 'X', start: at(iso(t)), end: at(iso(t + H)), businessId: B.businessId },
      { calendarId: calA, title: 'X', start: { local: '2031-02-30T10:00', timeZone: 'Europe/Paris' }, end: at(iso(t + H)) },
    ]) {
      expect((await m.create(body)).status, JSON.stringify(body)).toBe(400);
    }
    // The database refuses the same, whatever code writes.
    await expect(admin.query(
      `INSERT INTO scheduling_events (id, business_id, calendar_id, title, start_at, end_at, created_by_id, updated_by_id) VALUES ($1, $2, $3, 'x', $4, $4, $5, $5)`,
      [randomUUID(), A.businessId, calA, iso(t), A.people.OWNER!.id],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('detects overlaps, permits adjacent events, ignores cancelled and non-blocking ones, and allows overlaps only when enforcement is off', async () => {
    const t = freshDay() + 9 * H;
    const m = api(A.people.MEMBER!, A.slug);
    const first = (await book(calA, t, 2)).body.event; // [09:00, 11:00)
    // Overlap: refused with structured conflict information; nothing written.
    const before = (await admin.query('SELECT count(*)::int AS n FROM scheduling_events WHERE business_id = $1', [A.businessId])).rows[0].n;
    const clash = await book(calA, t + H, 2);
    expect(clash.status).toBe(409);
    // The S1 fields are unchanged; S2 adds kind, resource and blocking (docs/scheduling-s2.md §4.1).
    expect(SchedulingConflictResponse.parse(clash.body).conflicts).toEqual([
      { eventId: first.id, calendarId: calA, title: 'Booking', startAt: iso(t), endAt: iso(t + 2 * H), kind: 'calendar', resource: null, blocking: true },
    ]);
    expect((await admin.query('SELECT count(*)::int AS n FROM scheduling_events WHERE business_id = $1', [A.businessId])).rows[0].n).toBe(before);
    // Contained and containing intervals overlap too.
    expect((await book(calA, t + 0.5 * H, 0.5)).status).toBe(409);
    expect((await book(calA, t - H, 4)).status).toBe(409);
    // Adjacent on both sides: half-open intervals do not overlap.
    expect((await book(calA, t + 2 * H, 1)).status).toBe(201);
    expect((await book(calA, t - H, 1)).status).toBe(201);
    // A non-blocking event never conflicts and is never a conflict.
    expect((await book(calA, t, 2, { blocksAvailability: false })).status).toBe(201);
    // Enforcement off: the overlap is written and reported.
    const allowed = await book(calA, t + H, 0.5, { enforceConflicts: false });
    expect(allowed.status).toBe(201);
    expect(allowed.body.conflicts.map((c: { eventId: string }) => c.eventId)).toEqual([first.id]);
    expect((await audits(allowed.body.event.id))[0].metadata).toMatchObject({ enforced: 'false', overlaps: '1' });
    // An enforced booking conflicts with an existing booking that was made without enforcement.
    const later = (await book(calA, t + 5 * H, 1, { enforceConflicts: false })).body.event;
    const blocked = await book(calA, t + 5.5 * H, 1);
    expect(blocked.status).toBe(409);
    expect(blocked.body.conflicts.map((c: { eventId: string }) => c.eventId)).toEqual([later.id]);
    // Cancelled events stop blocking; archived ones too.
    expect((await m.cancel(later.id, later.version)).status).toBe(200);
    expect((await book(calA, t + 5.5 * H, 1)).status).toBe(201);
    // Other calendars are independent.
    const other = (await api(A.people.MANAGER!, A.slug).createCalendar({ name: 'Second chair' })).body.calendar.id;
    expect((await book(other, t, 2)).status).toBe(201);
    // The availability query agrees, and is scoped to the calendar.
    const free = await m.availability({ calendarId: calA, start: iso(t + 3 * H), end: iso(t + 4 * H) });
    expect(AvailabilityResponse.parse(free.body)).toEqual({ available: true, conflicts: [] });
    const busy = await m.availability({ calendarId: calA, start: iso(t), end: iso(t + H) });
    expect(busy.body.available).toBe(false);
    expect((await m.availability({ calendarId: calA, start: iso(t), end: iso(t + H), excludeEventId: first.id })).body.conflicts.map((c: { eventId: string }) => c.eventId)).not.toContain(first.id);
  });

  it('edits scheduled events; re-checks conflicts only when availability changes; refuses stale edits', async () => {
    const t = freshDay() + 9 * H;
    const m = api(A.people.MEMBER!, A.slug);
    const a = (await book(calA, t, 1)).body.event;
    const b = (await book(calA, t + 2 * H, 1)).body.event;
    // Moving b onto a is refused; with enforcement off it is allowed and reported.
    const move = await m.patch(b.id, { version: b.version, start: at(iso(t + 0.5 * H)), end: at(iso(t + 1.5 * H)) });
    expect(move.status).toBe(409);
    expect(move.body.conflicts.map((c: { eventId: string }) => c.eventId)).toEqual([a.id]);
    // A title change on an event that already overlaps is not a new conflict.
    const overlapping = (await book(calA, t, 1, { enforceConflicts: false })).body.event;
    const renamed = await m.patch(overlapping.id, { version: overlapping.version, title: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.event).toMatchObject({ title: 'Renamed', version: 2 });
    // Only the end changes: the start is kept, and the interval must still be valid.
    expect((await m.patch(b.id, { version: b.version, end: at(iso(t + 2 * H)) })).body.error).toBe('invalid_interval');
    const longer = await m.patch(b.id, { version: b.version, end: at(iso(t + 4 * H)) });
    expect(longer.body.event).toMatchObject({ startAt: iso(t + 2 * H), endAt: iso(t + 4 * H), version: 2 });
    expect((await m.patch(b.id, { version: 1, title: 'Late' })).body).toEqual({ error: 'stale' });
    // Switching blocking on re-checks.
    const soft = (await book(calA, t, 1, { blocksAvailability: false })).body.event;
    expect((await m.patch(soft.id, { version: soft.version, blocksAvailability: true })).status).toBe(409);
    expect((await m.patch(a.id, { version: a.version })).status).toBe(400); // nothing to update
  });

  it('cancels and archives without losing history; cancelled and archived events are read-only', async () => {
    const t = freshDay() + 9 * H;
    const m = api(A.people.MEMBER!, A.slug);
    const e = (await book(calA, t, 1)).body.event;
    const cancelled = await m.cancel(e.id, e.version);
    expect(cancelled.body.event).toMatchObject({ status: 'CANCELLED', cancelledById: A.people.MEMBER!.id, version: 2, archivedAt: null });
    expect(cancelled.body.event.cancelledAt).not.toBeNull();
    expect((await m.cancel(e.id, 2)).body).toEqual({ error: 'not_scheduled' });
    expect((await m.patch(e.id, { version: 2, title: 'Again' })).body).toEqual({ error: 'not_scheduled' });
    const range = { from: iso(t - H), to: iso(t + 2 * H), calendarId: calA };
    expect((await m.events(range)).body.events.map((x: { id: string }) => x.id)).not.toContain(e.id);
    expect((await m.events({ ...range, status: 'cancelled' })).body.events.map((x: { id: string }) => x.id)).toEqual([e.id]);
    const archived = await m.archive(e.id, 2);
    expect(archived.body.event).toMatchObject({ status: 'CANCELLED', version: 3 });
    expect(archived.body.event.archivedAt).not.toBeNull();
    expect((await m.archive(e.id, 3)).body).toEqual({ error: 'archived' });
    expect((await m.events({ ...range, status: 'all' })).body.events.map((x: { id: string }) => x.id)).not.toContain(e.id);
    expect((await m.event(e.id)).body.event.id).toBe(e.id); // still retrievable
    const { rows } = await admin.query('SELECT status, cancelled_at IS NOT NULL AS c, archived_at IS NOT NULL AS a FROM scheduling_events WHERE id = $1', [e.id]);
    expect(rows[0]).toEqual({ status: 'CANCELLED', c: true, a: true });
    expect((await audits(e.id)).map((a) => a.action)).toEqual(['scheduling.event.created', 'scheduling.event.cancelled', 'scheduling.event.archived']);
    // No ordinary role can delete scheduling history.
    await expect(app.query('DELETE FROM scheduling_events WHERE id = $1', [e.id])).rejects.toThrow(/permission denied/);
    await expect(app.query('DELETE FROM scheduling_calendars WHERE id = $1', [calA])).rejects.toThrow(/permission denied/);
  });

  it('links customers of the same business only, and only for people who may read customers', async () => {
    const t = freshDay();
    const m = api(A.people.MEMBER!, A.slug);
    const customer = (await m.createCustomer({ displayName: 'Rossi Tailoring' })).body.customer;
    const linked = await m.create({ calendarId: calA, title: 'Fitting', customerId: customer.id, start: at(iso(t)), end: at(iso(t + H)) });
    expect(linked.body.event).toMatchObject({ customerId: customer.id, customer: { id: customer.id, displayName: 'Rossi Tailoring', archived: false } });
    const foreign = (await api(B.people.OWNER!, B.slug).createCustomer({ displayName: 'Other' })).body.customer;
    expect((await m.create({ calendarId: calA, title: 'X', customerId: foreign.id, start: at(iso(t + 2 * H)), end: at(iso(t + 3 * H)) })).status).toBe(404);
    custom.MEMBER = ['scheduling:read', 'scheduling:create', 'scheduling:update', 'scheduling:cancel'];
    expect((await m.event(linked.body.event.id)).body.event).toMatchObject({ customerId: customer.id, customer: null });
    expect((await m.create({ calendarId: calA, title: 'X', customerId: customer.id, start: at(iso(t + 4 * H)), end: at(iso(t + 5 * H)) })).status).toBe(403);
  });

  it('lists a bounded range with keyset pagination', async () => {
    const t = freshDay();
    const m = api(A.people.MEMBER!, A.slug);
    const cal = (await api(A.people.MANAGER!, A.slug).createCalendar({ name: 'Paging' })).body.calendar.id;
    for (let i = 0; i < 5; i++) await book(cal, t + i * H, 1);
    const range = { from: iso(t), to: iso(t + 24 * H), calendarId: cal, limit: '2' };
    const pages: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await m.events({ ...range, cursor });
      ListEventsResponse.parse(page.body);
      pages.push(...page.body.events.map((e: { startAt: string }) => e.startAt));
      cursor = page.body.nextCursor ?? undefined;
    } while (cursor);
    expect(pages).toEqual([0, 1, 2, 3, 4].map((i) => iso(t + i * H)));
    expect((await m.events({ from: iso(t), to: iso(t + 63 * 24 * H) })).body.error).toBe('range_too_long');
    expect((await m.events({ from: iso(t), to: iso(t) })).body.error).toBe('invalid_range');
    expect((await m.events({ from: iso(t), to: iso(t + H), cursor: 'bm90LWEtY3Vyc29y' })).body.error).toBe('invalid_cursor');
    expect((await m.events({ from: iso(t) })).status).toBe(400);
  });
});

describe('events: time zones and dates', () => {
  const NY = 'America/New_York';
  it('refuses a local time in a spring-forward gap', async () => {
    const res = await api(A.people.MEMBER!, A.slug).create({
      calendarId: calA, title: 'Gap', start: { local: '2031-03-09T02:30', timeZone: NY }, end: { local: '2031-03-09T04:00', timeZone: NY },
    });
    expect(res).toMatchObject({ status: 400, body: { error: 'nonexistent_local_time' } });
  });

  it('requires a choice for an ambiguous fall-back time, and honours it', async () => {
    const m = api(A.people.MEMBER!, A.slug);
    const cal = (await api(A.people.MANAGER!, A.slug).createCalendar({ name: 'New York desk', timeZone: NY })).body.calendar.id;
    const base = { calendarId: cal, title: 'Ambiguous', end: { local: '2031-11-02T03:00', timeZone: NY } };
    expect((await m.create({ ...base, start: { local: '2031-11-02T01:30', timeZone: NY } })).body.error).toBe('ambiguous_local_time');
    const earlier = await m.create({ ...base, start: { local: '2031-11-02T01:30', timeZone: NY, disambiguation: 'earlier' } });
    expect(earlier.body.event.startAt).toBe('2031-11-02T05:30:00.000Z'); // EDT, UTC-4
    const later = await m.create({ ...base, start: { local: '2031-11-02T01:30', timeZone: NY, disambiguation: 'later' }, enforceConflicts: false });
    expect(later.body.event.startAt).toBe('2031-11-02T06:30:00.000Z'); // EST, UTC-5
    // An unambiguous instant needs no choice.
    expect((await m.create({ ...base, start: at('2031-11-02T01:30:00-05:00'), enforceConflicts: false })).body.event.startAt).toBe('2031-11-02T06:30:00.000Z');
    // A 03:00 end on the fall-back day is 4 hours after 00:00 local (the day has 25 hours).
    const day = await m.create({ ...base, title: 'Long day', start: { local: '2031-11-02T00:00', timeZone: NY }, enforceConflicts: false });
    expect(Date.parse(day.body.event.endAt) - Date.parse(day.body.event.startAt)).toBe(4 * H);
  });

  it('stores midnight-crossing and multi-day events as exact instants, with a calendar zone different from the business zone', async () => {
    const m = api(A.people.MEMBER!, A.slug);
    const london = (await api(A.people.MANAGER!, A.slug).createCalendar({ name: 'London', timeZone: 'Europe/London' })).body.calendar;
    expect(london.timeZone).toBe('Europe/London'); // the business is in Australia/Perth
    const night = await m.create({
      calendarId: london.id, title: 'Night shift', start: { local: '2031-07-10T22:00', timeZone: 'Europe/London' }, end: { local: '2031-07-11T06:00', timeZone: 'Europe/London' },
    });
    expect(night.body.event).toMatchObject({ startAt: '2031-07-10T21:00:00.000Z', endAt: '2031-07-11T05:00:00.000Z' }); // BST
    // Across the October change: 3 local days, 73 real hours.
    const trip = await m.create({
      calendarId: london.id, title: 'Trip', start: { local: '2031-10-25T09:00', timeZone: 'Europe/London' }, end: { local: '2031-10-28T09:00', timeZone: 'Europe/London' },
    });
    expect(Date.parse(trip.body.event.endAt) - Date.parse(trip.body.event.startAt)).toBe(73 * H);
    // The range query finds an event that started before the range and ends inside it.
    const morning = await m.events({ from: '2031-07-11T00:00:00+01:00', to: '2031-07-12T00:00:00+01:00', calendarId: london.id });
    expect(morning.body.events.map((e: { title: string }) => e.title)).toEqual(['Night shift']);
    // Local input may name another zone than the calendar's: the instant is what is stored.
    const kolkata = await m.create({ calendarId: london.id, title: 'Call', start: { local: '2031-07-12T09:00', timeZone: 'Asia/Kolkata' }, end: at('2031-07-12T04:30:00Z') });
    expect(kolkata.body.event.startAt).toBe('2031-07-12T03:30:00.000Z');
  });
});

describe('tenant isolation', () => {
  it('business A cannot see or touch business B calendars or events, and existence is not leaked', async () => {
    const b = api(B.people.OWNER!, B.slug);
    const eventB = (await b.create({ calendarId: calB, title: 'B only', start: at('2031-05-01T00:00:00Z'), end: at('2031-05-01T01:00:00Z') })).body.event;
    const a = api(A.people.OWNER!, A.slug);
    const missing = randomUUID();
    for (const res of [
      await a.calendar(calB), await a.calendar(missing), await a.event(eventB.id), await a.event(missing),
      await a.patch(eventB.id, { version: 1, title: 'x' }), await a.cancel(eventB.id, 1), await a.archive(eventB.id, 1),
      await a.patchCalendar(calB, { version: 1, name: 'x' }), await a.archiveCalendar(calB, 1),
      await a.create({ calendarId: calB, title: 'x', start: at('2031-05-01T00:00:00Z'), end: at('2031-05-01T01:00:00Z') }),
      await a.availability({ calendarId: calB, start: '2031-05-01T00:00:00Z', end: '2031-05-01T01:00:00Z' }),
      await a.events({ from: '2031-05-01T00:00:00Z', to: '2031-05-02T00:00:00Z', calendarId: calB }),
    ]) {
      expect(res).toEqual({ status: 404, body: { error: 'not_found' } });
    }
    expect((await a.events({ from: '2031-05-01T00:00:00Z', to: '2031-05-02T00:00:00Z' })).body.events).toEqual([]);
    expect((await a.calendars('?archived=all')).body.calendars.map((c: { id: string }) => c.id)).not.toContain(calB);
    // A member of A using B's slug, and an unknown slug, get the same answer.
    const viaSlug = await eventRoute.GET(req('GET', `/api/v1/b/${B.slug}/scheduling/events/${eventB.id}`, { cookie: A.people.OWNER!.cookie }), ctx({ slug: B.slug, eventId: eventB.id })).then(json);
    const unknown = await eventRoute.GET(req('GET', `/api/v1/b/nope-${randomUUID().slice(0, 8)}/scheduling/events/${eventB.id}`, { cookie: A.people.OWNER!.cookie }), ctx({ slug: 'nope', eventId: eventB.id })).then(json);
    expect(viaSlug).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(unknown).toEqual(viaSlug);
    expect((await b.event(eventB.id)).body.event.title).toBe('B only');
  });

  it('cross-tenant references fail in the database, even for a role that bypasses RLS', async () => {
    const customerB = (await api(B.people.OWNER!, B.slug).createCustomer({ displayName: 'B customer' })).body.customer.id;
    const insert = (calendarId: string, customerId: string | null) => admin.query(
      `INSERT INTO scheduling_events (id, business_id, calendar_id, title, start_at, end_at, customer_id, created_by_id, updated_by_id)
       VALUES ($1, $2, $3, 'x', '2031-05-02T00:00:00Z', '2031-05-02T01:00:00Z', $4, $5, $5)`, [randomUUID(), A.businessId, calendarId, customerId, A.people.OWNER!.id]);
    await expect(insert(calB, null)).rejects.toMatchObject({ code: '23503' });
    await expect(insert(calA, customerB)).rejects.toMatchObject({ code: '23503' });
    const ev = (await book(calA, Date.parse('2031-05-03T00:00:00Z'))).body.event.id;
    await expect(admin.query('UPDATE scheduling_events SET calendar_id = $1 WHERE id = $2', [calB, ev])).rejects.toMatchObject({ code: '23503' });
  });

  it('RLS holds independently of the application filter', async () => {
    const rlsCount = async (businessId: string | null, table: string) => {
      await app.query('BEGIN');
      try {
        if (businessId) await app.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
        return (await app.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE business_id <> coalesce($1::uuid, '00000000-0000-0000-0000-000000000000'))::int AS other FROM ${table}`, [businessId])).rows[0];
      } finally {
        await app.query('ROLLBACK');
      }
    };
    for (const table of ['scheduling_calendars', 'scheduling_events']) {
      expect(await rlsCount(null, table)).toEqual({ n: 0, other: 0 });
      const forA = await rlsCount(A.businessId, table);
      expect(forA.n).toBeGreaterThan(0);
      expect(forA.other).toBe(0);
    }
    // Writing another business's row under this business's context is refused by the policy.
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.business_id', $1, true)", [A.businessId]);
      await expect(app.query(
        `INSERT INTO scheduling_calendars (id, business_id, name, time_zone, created_by_id, updated_by_id) VALUES ($1, $2, 'x', 'UTC', $3, $3)`,
        [randomUUID(), B.businessId, A.people.OWNER!.id],
      )).rejects.toThrow(/row-level security/i);
    } finally {
      await app.query('ROLLBACK');
    }
    const { rows } = await admin.query(
      "SELECT relname FROM pg_class WHERE relname IN ('scheduling_calendars','scheduling_events') AND relrowsecurity AND relforcerowsecurity ORDER BY relname");
    expect(rows.map((r) => r.relname)).toEqual(['scheduling_calendars', 'scheduling_events']);
    const grants = await admin.query(
      "SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p FROM information_schema.role_table_grants WHERE grantee = 'bos_app' AND table_name IN ('scheduling_calendars', 'scheduling_events') GROUP BY table_name ORDER BY table_name");
    expect(grants.rows).toEqual([{ table_name: 'scheduling_calendars', p: 'INSERT,SELECT,UPDATE' }, { table_name: 'scheduling_events', p: 'INSERT,SELECT,UPDATE' }]);
  });
});

describe('permissions', () => {
  it('enforces every endpoint permission on the server', async () => {
    const t = freshDay();
    const owner = api(A.people.OWNER!, A.slug);
    const ev = (await book(calA, t, 1)).body.event;
    const cal = (await owner.createCalendar({ name: 'Perm' })).body.calendar;
    const create = { calendarId: calA, title: 'x', start: at(iso(t + 3 * H)), end: at(iso(t + 4 * H)) };
    const m = api(A.people.MEMBER!, A.slug);
    // MEMBER: books, edits and cancels, but does not manage calendars.
    expect((await m.createCalendar({ name: 'No' })).status).toBe(403);
    expect((await m.patchCalendar(cal.id, { version: cal.version, name: 'No' })).status).toBe(403);
    expect((await m.archiveCalendar(cal.id, cal.version)).status).toBe(403);
    expect((await m.restoreCalendar(cal.id, cal.version)).status).toBe(403);
    // A read-only role: reads everything, changes nothing.
    custom.MEMBER = ['business:read', 'scheduling:read'];
    expect((await m.calendars()).status).toBe(200);
    expect((await m.calendar(calA)).status).toBe(200);
    expect((await m.event(ev.id)).status).toBe(200);
    expect((await m.events({ from: iso(t), to: iso(t + H) })).status).toBe(200);
    expect((await m.availability({ calendarId: calA, start: iso(t), end: iso(t + H) })).status).toBe(200);
    for (const res of [await m.create(create), await m.initDefault(), await m.patch(ev.id, { version: ev.version, title: 'x' }), await m.cancel(ev.id, ev.version), await m.archive(ev.id, ev.version)]) {
      expect(res).toEqual({ status: 403, body: { error: 'forbidden' } });
    }
    // Each write key covers exactly its own operations.
    custom.MEMBER = ['scheduling:read', 'scheduling:update'];
    expect((await m.create(create)).status).toBe(403);
    expect((await m.cancel(ev.id, ev.version)).status).toBe(403);
    expect((await m.patch(ev.id, { version: ev.version, title: 'Updated' })).status).toBe(200);
    custom.MEMBER = ['scheduling:read', 'scheduling:cancel'];
    expect((await m.patch(ev.id, { version: 2, title: 'x' })).status).toBe(403);
    expect((await m.cancel(ev.id, 2)).status).toBe(200);
    // No scheduling keys at all: nothing, not even reads.
    custom.MEMBER = ['business:read'];
    for (const res of [await m.calendars(), await m.event(ev.id), await m.events({ from: iso(t), to: iso(t + H) })]) expect(res.status).toBe(403);
    // Managers manage calendars.
    expect((await api(A.people.MANAGER!, A.slug).patchCalendar(cal.id, { version: cal.version, name: 'Managed' })).status).toBe(200);
  });
});

describe('concurrency and the lock protocol', () => {
  const lockKey = (calendarId: string) => `hashtextextended('scheduling.calendar:' || '${calendarId}', 0)`;
  /** Holds one calendar's advisory lock in a separate session, runs `work`, and proves it waits for the lock. */
  async function provesItWaits<T>(calendarId: string, work: () => Promise<T>): Promise<T> {
    await holder.query(`SELECT pg_advisory_lock(${lockKey(calendarId)})`);
    let pending: Promise<T>;
    try {
      pending = work();
      expect(await finishesOrBlocks(admin, await backendPid(holder), pending)).toBe('blocked');
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(${lockKey(calendarId)})`);
    }
    return pending;
  }

  it('every availability-affecting mutation, enforced or not, waits for the calendar lock', async () => {
    const t = freshDay();
    const m = api(A.people.MEMBER!, A.slug);
    const other = (await api(A.people.MANAGER!, A.slug).createCalendar({ name: 'Lock target' })).body.calendar.id;
    const enforced = await provesItWaits(calA, () => book(calA, t, 1));
    expect(enforced.status).toBe(201);
    const loose = await provesItWaits(calA, () => book(calA, t, 1, { enforceConflicts: false }));
    expect(loose.status).toBe(201);
    const nonBlocking = await provesItWaits(calA, () => book(calA, t + 2 * H, 1, { blocksAvailability: false }));
    expect(nonBlocking.status).toBe(201);
    const e = enforced.body.event;
    const retimed = await provesItWaits(calA, () => m.patch(e.id, { version: 1, start: at(iso(t + 4 * H)), end: at(iso(t + 5 * H)) }));
    expect(retimed.status).toBe(200);
    // A move waits for the destination's lock (and the source's: covered by the deadlock test below).
    const moved = await provesItWaits(other, () => m.patch(e.id, { version: 2, calendarId: other }));
    expect(moved.body.event.calendarId).toBe(other);
    const cancelled = await provesItWaits(other, () => m.cancel(e.id, 3));
    expect(cancelled.body.event.status).toBe('CANCELLED');
    const archived = await provesItWaits(calA, () => m.archive(loose.body.event.id, 1));
    expect(archived.body.event.archivedAt).not.toBeNull();
  });

  it('archiving a calendar waits for event writes on it, so no event lands on an archived calendar', async () => {
    const o = api(A.people.OWNER!, A.slug);
    const cal = (await o.createCalendar({ name: 'Being archived' })).body.calendar;
    await holder.query('BEGIN');
    try {
      await holder.query('SELECT 1 FROM scheduling_calendars WHERE id = $1 FOR SHARE', [cal.id]); // as an event write in flight holds it
      const archiving = o.archiveCalendar(cal.id, cal.version);
      expect(await finishesOrBlocks(admin, await backendPid(holder), archiving)).toBe('blocked');
      await holder.query('COMMIT');
      expect((await archiving).body.calendar.archivedAt).not.toBeNull();
    } catch (error) {
      await holder.query('ROLLBACK');
      throw error;
    }
  });

  it('concurrent enforced bookings of one slot: exactly one succeeds', async () => {
    const t = freshDay() + 10 * H;
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => book(calA, t + (i % 3) * 0.25 * H, 1)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(11);
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM scheduling_events WHERE calendar_id = $1 AND status = 'SCHEDULED' AND archived_at IS NULL AND blocks_availability AND start_at < $3 AND end_at > $2",
      [calA, iso(t), iso(t + 2 * H)]);
    expect(rows[0].n).toBe(1);
  });

  it('a concurrent non-enforced booking may overlap, but an enforced one racing it is checked against it once it commits', async () => {
    const t = freshDay() + 10 * H;
    // Make the order deterministic: hold the lock, queue the non-enforced write, then the enforced one.
    await holder.query(`SELECT pg_advisory_lock(${lockKey(calA)})`);
    const holderPid = await backendPid(holder);
    let loose: ReturnType<typeof book>;
    let strict: ReturnType<typeof book>;
    try {
      loose = book(calA, t, 1, { enforceConflicts: false });
      await waitUntilBlocked(admin, holderPid, { count: 1 });
      strict = book(calA, t + 0.5 * H, 1);
      await waitUntilBlocked(admin, holderPid, { count: 2 });
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(${lockKey(calA)})`);
    }
    const [l, s] = await Promise.all([loose, strict]);
    // Lock waiters are not guaranteed FIFO, so either order is possible; both are correct outcomes:
    if (l.status === 201 && s.status === 409) expect(s.body.conflicts.map((c: { eventId: string }) => c.eventId)).toEqual([l.body.event.id]);
    else {
      expect(s.status).toBe(201);
      expect(l.status).toBe(201);
      expect(l.body.conflicts.map((c: { eventId: string }) => c.eventId)).toEqual([s.body.event.id]); // the overlap is reported
    }
  });

  it('concurrent enforced reschedules into one slot, and a booking racing a cancellation, never double-book', async () => {
    const t = freshDay() + 8 * H;
    const m = api(A.people.MEMBER!, A.slug);
    const movers = [];
    for (let i = 0; i < 6; i++) movers.push((await book(calA, t + (2 + i) * 2 * H, 1)).body.event);
    const target = t; // free slot [t, t+1h)
    const results = await Promise.all(movers.map((e) => m.patch(e.id, { version: e.version, start: at(iso(target)), end: at(iso(target + H)) })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).length).toBe(5);
    // Cancellation and a booking of the freed slot: the booking either sees the cancellation (201) or not (409), never a double booking.
    const winner = results.find((r) => r.status === 200)!.body.event;
    const [cancel, rebook] = await Promise.all([m.cancel(winner.id, winner.version), book(calA, target, 1)]);
    expect(cancel.status).toBe(200);
    expect([201, 409]).toContain(rebook.status);
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM scheduling_events WHERE calendar_id = $1 AND status = 'SCHEDULED' AND archived_at IS NULL AND blocks_availability AND start_at < $3 AND end_at > $2",
      [calA, iso(target), iso(target + H)]);
    expect(rows[0].n).toBe(rebook.status === 201 ? 1 : 0);
  });

  it('moves between two calendars in opposite directions never deadlock (deterministic lock order)', async () => {
    const mgr = api(A.people.MANAGER!, A.slug);
    const left = (await mgr.createCalendar({ name: 'Left' })).body.calendar.id;
    const right = (await mgr.createCalendar({ name: 'Right' })).body.calendar.id;
    const m = api(A.people.MEMBER!, A.slug);
    for (let round = 0; round < 8; round++) {
      const t = freshDay();
      const x = (await book(left, t, 1)).body.event;
      const y = (await book(right, t + 2 * H, 1)).body.event;
      const [toRight, toLeft] = await Promise.all([
        m.patch(x.id, { version: x.version, calendarId: right }),
        m.patch(y.id, { version: y.version, calendarId: left }),
      ]);
      expect([toRight.status, toLeft.status], `round ${round}`).toEqual([200, 200]);
      expect(toRight.body.event.calendarId).toBe(right);
      expect(toLeft.body.event.calendarId).toBe(left);
    }
    // And a move into an occupied slot on the destination is a conflict like any other.
    const t = freshDay();
    const x = (await book(left, t, 1)).body.event;
    await book(right, t, 1);
    const blocked = await m.patch(x.id, { version: x.version, calendarId: right });
    expect(blocked.status).toBe(409);
  });

  const defaultKey = (businessId: string) => `hashtextextended('scheduling.default:' || '${businessId}', 0)`;

  it('S1-02: a default change takes the business default lock before any calendar row, so it cannot deadlock with another default change', async () => {
    const S = await solo('sg');
    const o = api(S.owner, S.slug);
    await o.createCalendar({ name: 'Default' });
    const r = (await o.createCalendar({ name: 'R' })).body.calendar;
    // The holder plays a default change already in progress: it holds the default lock, then touches R's row,
    // as makeDefault does when R is the previous default or the target.
    await holder.query('BEGIN');
    try {
      await holder.query(`SELECT pg_advisory_xact_lock(${defaultKey(S.businessId)})`);
      const edit = o.patchCalendar(r.id, { version: r.version, name: 'Renamed', isDefault: true });
      expect(await finishesOrBlocks(admin, await backendPid(holder), edit)).toBe('blocked');
      // The edit must not be holding R's row while it waits: this UPDATE finishes without waiting.
      await holder.query("SET LOCAL lock_timeout = '3s'");
      await holder.query(`UPDATE scheduling_calendars SET description = 'by the other change', version = version + 1 WHERE id = $1`, [r.id]);
      await holder.query('COMMIT');
      // R changed underneath the edit, so the edit is stale: nothing it asked for is applied.
      expect((await edit).body).toEqual({ error: 'stale' });
    } catch (error) {
      await holder.query('ROLLBACK');
      throw error;
    }
    const after = (await o.calendar(r.id)).body.calendar;
    expect(after).toMatchObject({ name: 'R', description: 'by the other change', isDefault: false, version: r.version + 1 });
    await expectOneDefault(S.businessId);
  });

  it('S1-02: concurrent detail edits and default reassignments: no deadlock, one default, stale requests never overwrite', async () => {
    const S = await solo('sh');
    const o = api(S.owner, S.slug);
    const cals = [];
    for (const name of ['P', 'Q', 'R']) cals.push((await o.createCalendar({ name })).body.calendar);
    for (let round = 0; round < 8; round++) {
      const now = await Promise.all(cals.map((c) => o.calendar(c.id).then((x) => x.body.calendar)));
      const [p, q, r] = now;
      const requests = [
        { id: p.id, body: { version: p.version, name: `P${round}`, isDefault: true } },
        { id: q.id, body: { version: q.version, isDefault: true } },
        { id: r.id, body: { version: r.version, description: `r${round}`, isDefault: true } },
        { id: p.id, body: { version: p.version, description: `p${round}` } },
        { id: q.id, body: { version: q.version, colour: '#123456' } },
        { id: r.id, body: { version: r.version, isDefault: true } },
      ];
      const results = await Promise.all(requests.map((x) => o.patchCalendar(x.id, x.body)));
      for (const [i, res] of results.entries()) {
        expect([200, 409], `round ${round} request ${i}: ${JSON.stringify(res.body)}`).toContain(res.status);
        if (res.status === 409) expect(res.body).toEqual({ error: 'stale' });
      }
      await expectOneDefault(S.businessId);
      // Each calendar took at most one of the changes made from the same version, and only a successful one.
      // A request that asks for what is already there (the same colour, "make the default" on the default)
      // changes nothing and is not counted.
      const after = await Promise.all(cals.map((c) => o.calendar(c.id).then((x) => x.body.calendar)));
      const changes = (x: (typeof requests)[number]) => {
        const current = now.find((c) => c.id === x.id)!;
        return Object.entries(x.body).some(([k, v]) => k !== 'version' && (k === 'isDefault' ? !current.isDefault : current[k] !== v));
      };
      const won = (id: string) => requests.filter((x, i) => x.id === id && results[i]!.status === 200 && changes(x));
      for (const c of after) expect(won(c.id).length, `round ${round} ${c.name}`).toBeLessThanOrEqual(1);
      if (won(p.id)[0]?.body.name) expect(after[0]!.name).toBe(`P${round}`);
      else expect(after[0]!.name).toBe(p.name);
      if (won(p.id)[0]?.body.description) expect(after[0]!.description).toBe(`p${round}`);
      else expect(after[0]!.description).toBe(p.description);
      if (won(r.id)[0]?.body.description) expect(after[2]!.description).toBe(`r${round}`);
      else expect(after[2]!.description).toBe(r.description);
    }
  });

  it('a concurrent edit of the same event is reported as stale, not overwritten', async () => {
    const t = freshDay();
    const m = api(A.people.MEMBER!, A.slug);
    const e = (await book(calA, t, 1)).body.event;
    const results = await Promise.all([
      m.patch(e.id, { version: e.version, title: 'One' }), m.patch(e.id, { version: e.version, title: 'Two' }),
      m.patch(e.id, { version: e.version, start: at(iso(t + 2 * H)), end: at(iso(t + 3 * H)) }), m.cancel(e.id, e.version),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error === 'stale')).toHaveLength(3);
    expect((await m.event(e.id)).body.event.version).toBe(2);
  });
});
