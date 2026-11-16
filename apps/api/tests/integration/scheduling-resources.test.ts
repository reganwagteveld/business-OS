import { inviteForSignup, admitFixture } from './support/admission';
/**
 * Scheduling S2 (docs/scheduling-s2.md): resources, assignments, resource conflicts and the extended lock
 * protocol, through the real route handlers against PostgreSQL with the migrations and privileged SQL
 * applied as in production. Two businesses and every role. Concurrency tests coordinate through
 * PostgreSQL (pg_blocking_pids and lock probes), never through sleeps.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EventResponse, ListEventsResponse, ListResourcesResponse, ResourceAvailabilityResponse, ResourceResponse, SchedulingConflictResponse,
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
import * as calendarsRoute from '@/app/api/v1/b/[slug]/scheduling/calendars/route';
import * as defaultCalendarRoute from '@/app/api/v1/b/[slug]/scheduling/calendars/default/route';
import * as archiveCalendarRoute from '@/app/api/v1/b/[slug]/scheduling/calendars/[calendarId]/archive/route';
import * as eventsRoute from '@/app/api/v1/b/[slug]/scheduling/events/route';
import * as eventRoute from '@/app/api/v1/b/[slug]/scheduling/events/[eventId]/route';
import * as cancelEventRoute from '@/app/api/v1/b/[slug]/scheduling/events/[eventId]/cancel/route';
import * as archiveEventRoute from '@/app/api/v1/b/[slug]/scheduling/events/[eventId]/archive/route';
import * as resourcesRoute from '@/app/api/v1/b/[slug]/scheduling/resources/route';
import * as resourceRoute from '@/app/api/v1/b/[slug]/scheduling/resources/[resourceId]/route';
import * as archiveResourceRoute from '@/app/api/v1/b/[slug]/scheduling/resources/[resourceId]/archive/route';
import * as restoreResourceRoute from '@/app/api/v1/b/[slug]/scheduling/resources/[resourceId]/restore/route';
import * as resourceAvailabilityRoute from '@/app/api/v1/b/[slug]/scheduling/resources/availability/route';
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
const IP_BLOCK = Number(process.env.SCHEDULING_RESOURCES_TEST_IP_BLOCK ?? 91);
let ip = 1;
type User = { email: string; cookie: string; id: string };

function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.${IP_BLOCK}.${Math.floor(ip / 250)}.${ip++ % 250}`, origin: ORIGIN });
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
  const verify = new Request(`${BASE}${link.pathname}${link.search}`, { method: 'GET', headers: { 'x-forwarded-for': `100.${IP_BLOCK}.250.${ip++ % 250}` } });
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

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const api = (who: User, slug: string) => {
  const s = `/api/v1/b/${slug}/scheduling`;
  const e = (eventId: string) => ctx({ slug, eventId });
  const r = (resourceId: string) => ctx({ slug, resourceId });
  const q = (values: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) if (v !== undefined) p.set(k, v);
    return `?${p.toString()}`;
  };
  return {
    createCalendar: (body: unknown) => calendarsRoute.POST(req('POST', `${s}/calendars`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    initDefault: () => defaultCalendarRoute.POST(req('POST', `${s}/calendars/default`, { cookie: who.cookie }), ctx({ slug })).then(json),
    archiveCalendar: (id: string, version: number) => archiveCalendarRoute.POST(req('POST', `${s}/calendars/${id}/archive`, { cookie: who.cookie, body: { version } }), ctx({ slug, calendarId: id })).then(json),
    events: (values: Record<string, string | undefined>) => eventsRoute.GET(req('GET', `${s}/events${q(values)}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    create: (body: unknown) => eventsRoute.POST(req('POST', `${s}/events`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    event: (id: string) => eventRoute.GET(req('GET', `${s}/events/${id}`, { cookie: who.cookie }), e(id)).then(json),
    patch: (id: string, body: unknown) => eventRoute.PATCH(req('PATCH', `${s}/events/${id}`, { cookie: who.cookie, body }), e(id)).then(json),
    cancel: (id: string, version: number) => cancelEventRoute.POST(req('POST', `${s}/events/${id}/cancel`, { cookie: who.cookie, body: { version } }), e(id)).then(json),
    archive: (id: string, version: number) => archiveEventRoute.POST(req('POST', `${s}/events/${id}/archive`, { cookie: who.cookie, body: { version } }), e(id)).then(json),
    resources: (values: Record<string, string | undefined> = {}) => resourcesRoute.GET(req('GET', `${s}/resources${q(values)}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    createResource: (body: unknown) => resourcesRoute.POST(req('POST', `${s}/resources`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    resource: (id: string) => resourceRoute.GET(req('GET', `${s}/resources/${id}`, { cookie: who.cookie }), r(id)).then(json),
    patchResource: (id: string, body: unknown) => resourceRoute.PATCH(req('PATCH', `${s}/resources/${id}`, { cookie: who.cookie, body }), r(id)).then(json),
    archiveResource: (id: string, version: number) => archiveResourceRoute.POST(req('POST', `${s}/resources/${id}/archive`, { cookie: who.cookie, body: { version } }), r(id)).then(json),
    restoreResource: (id: string, version: number) => restoreResourceRoute.POST(req('POST', `${s}/resources/${id}/restore`, { cookie: who.cookie, body: { version } }), r(id)).then(json),
    availability: (values: Record<string, string | undefined>) => resourceAvailabilityRoute.GET(req('GET', `${s}/resources/availability${q(values)}`, { cookie: who.cookie }), ctx({ slug })).then(json),
  };
};
const audits = async (targetId: string) =>
  (await admin.query('SELECT action, actor_user_id, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows;
/** Live assignment rows of an event (database truth, bypassing the API). */
const liveAssignments = async (eventId: string) =>
  (await admin.query('SELECT resource_id FROM scheduling_event_resources WHERE event_id = $1 AND removed_at IS NULL ORDER BY resource_id', [eventId])).rows.map((x) => x.resource_id as string);
/** Occupying events holding `resourceId` that overlap [start, end): the invariant the lock protocol protects. */
const occupying = async (resourceId: string, start: number, end: number) => (await admin.query(
  `SELECT count(*)::int AS n FROM scheduling_event_resources a JOIN scheduling_events e ON e.id = a.event_id
   WHERE a.resource_id = $1 AND a.removed_at IS NULL AND e.status = 'SCHEDULED' AND e.archived_at IS NULL AND e.blocks_availability
     AND e.start_at < $3 AND e.end_at > $2`, [resourceId, iso(start), iso(end)])).rows[0].n as number;

const at = (iso: string) => ({ at: iso });
let slotBase = Date.UTC(2032, 0, 1);
const freshDay = () => (slotBase += 86_400_000);
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;
const sortIds = (ids: string[]) => [...ids].sort();

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let calA: string;
let calA2: string;
let calB: string;
beforeAll(async () => {
  A = await team('ra');
  B = await team('rb');
  calA = (await api(A.people.MEMBER!, A.slug).initDefault()).body.calendar.id;
  calA2 = (await api(A.people.MANAGER!, A.slug).createCalendar({ name: 'Second' })).body.calendar.id;
  calB = (await api(B.people.MEMBER!, B.slug).initDefault()).body.calendar.id;
}, 120_000);

const mgr = () => api(A.people.MANAGER!, A.slug);
const member = () => api(A.people.MEMBER!, A.slug);
async function newResource(name = `R-${randomUUID().slice(0, 6)}`, type = 'ROOM') {
  const res = await mgr().createResource({ name, type });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.resource as { id: string; name: string; version: number; status: string };
}
/** A blocking event in A on `calendar` from `start` for `hours`, holding `resourceIds`. */
function book(calendar: string, start: number, resourceIds: string[], extra: Record<string, unknown> = {}, hours = 1) {
  return member().create({ calendarId: calendar, title: 'Booking', start: at(iso(start)), end: at(iso(start + hours * H)), resourceIds, ...extra });
}

// =================================================================================================
describe('resource registry and lifecycle', () => {
  it('creates and edits resources of every type; validates input; audits without names or descriptions', async () => {
    const m = mgr();
    for (const type of ['PERSON', 'ROOM', 'EQUIPMENT', 'OTHER']) {
      const res = await m.createResource({ name: `  ${type} one `, type, description: 'Private note', colour: '#22aa88' });
      expect(res.status).toBe(201);
      expect(ResourceResponse.parse(res.body)).toMatchObject({ resource: { name: `${type} one`, type, status: 'ACTIVE', version: 1, archivedAt: null, createdById: A.people.MANAGER!.id }, upcomingBookings: 0 });
    }
    const r = await newResource('Edit me', 'EQUIPMENT');
    const edited = await m.patchResource(r.id, { version: 1, name: 'Edited', type: 'OTHER', colour: null });
    expect(edited.body.resource).toMatchObject({ name: 'Edited', type: 'OTHER', version: 2 });
    for (const body of [
      { name: '', type: 'ROOM' }, { name: 'x'.repeat(101), type: 'ROOM' }, { name: 'X' }, { name: 'X', type: 'HAIRDRESSER' }, { name: 'X', type: 'ROOM', colour: 'red' },
      { name: 'X', type: 'ROOM', status: 'ARCHIVED' }, { name: 'X', type: 'ROOM', businessId: B.businessId }, { name: 'X', type: 'ROOM', employeeId: randomUUID() },
    ]) expect((await m.createResource(body)).status, JSON.stringify(body)).toBe(400);
    expect((await m.patchResource(r.id, { version: 2 })).status).toBe(400);
    expect((await m.patchResource(r.id, { version: 2, status: 'ARCHIVED' })).status).toBe(400); // archive has its own endpoint
    expect((await m.patchResource(r.id, { version: 1, name: 'Stale' })).body).toEqual({ error: 'stale' });
    const trail = await audits(r.id);
    expect(trail.map((a) => a.action)).toEqual(['scheduling.resource.created', 'scheduling.resource.updated']);
    expect(trail[1]!.metadata).toEqual({ fields: ['name', 'type'] }); // colour was already empty
    expect(JSON.stringify(trail)).not.toMatch(/Edit me|Edited|Private note/);
  });

  it('moves ACTIVE ⇄ INACTIVE, archives from either, keeps archived resources read-only, and restores to ACTIVE', async () => {
    const m = mgr();
    const r = await newResource();
    let cur = (await m.patchResource(r.id, { version: 1, status: 'INACTIVE' })).body.resource;
    expect(cur).toMatchObject({ status: 'INACTIVE', version: 2 });
    cur = (await m.patchResource(r.id, { version: 2, status: 'ACTIVE' })).body.resource;
    expect(cur.status).toBe('ACTIVE');
    cur = (await m.patchResource(r.id, { version: 3, status: 'INACTIVE' })).body.resource;
    const archived = await m.archiveResource(r.id, cur.version);
    expect(archived.body.resource).toMatchObject({ status: 'ARCHIVED', version: 5 });
    expect(archived.body.resource.archivedAt).not.toBeNull();
    expect((await m.patchResource(r.id, { version: 5, name: 'x' })).body).toEqual({ error: 'archived' });
    expect((await m.patchResource(r.id, { version: 5, status: 'ACTIVE' })).body).toEqual({ error: 'archived' });
    expect((await m.archiveResource(r.id, 5)).body).toEqual({ error: 'archived' });
    expect((await m.restoreResource(r.id, 4)).body).toEqual({ error: 'stale' });
    const restored = await m.restoreResource(r.id, 5);
    expect(restored.body.resource).toMatchObject({ status: 'ACTIVE', archivedAt: null, version: 6 });
    expect((await m.restoreResource(r.id, 6)).body).toEqual({ error: 'not_archived' });
    expect((await audits(r.id)).map((a) => [a.action, a.metadata])).toEqual([
      ['scheduling.resource.created', { resourceType: 'ROOM' }],
      ['scheduling.resource.status_changed', { from: 'ACTIVE', to: 'INACTIVE' }],
      ['scheduling.resource.status_changed', { from: 'INACTIVE', to: 'ACTIVE' }],
      ['scheduling.resource.status_changed', { from: 'ACTIVE', to: 'INACTIVE' }],
      ['scheduling.resource.archived', { from: 'INACTIVE' }],
      ['scheduling.resource.restored', {}],
    ]);
    // The database refuses an inconsistent archive state whatever code writes it.
    await expect(admin.query("UPDATE scheduling_resources SET status = 'ARCHIVED' WHERE id = $1", [r.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('lists by name with search, type and status filters, keyset pages and a cursor bound to its filter', async () => {
    const S = await solo('rl');
    const o = api(S.owner, S.slug);
    for (const [name, type] of [['Bay 3', 'ROOM'], ['bay 1', 'ROOM'], ['Bay 2', 'OTHER'], ['Lift', 'EQUIPMENT'], ['Ana', 'PERSON']]) {
      expect((await o.createResource({ name, type })).status).toBe(201);
    }
    const lift = (await o.resources({ q: 'lift' })).body.resources[0];
    await o.archiveResource(lift.id, lift.version);
    const page1 = await o.resources({ limit: '2' });
    ListResourcesResponse.parse(page1.body);
    // Names sort in the database's collation (ICU en-US in CI: case-insensitive first), then id.
    expect(page1.body.resources.map((r: { name: string }) => r.name)).toEqual(['Ana', 'bay 1']);
    const page2 = await o.resources({ limit: '2', cursor: page1.body.nextCursor });
    expect(page2.body.resources.map((r: { name: string }) => r.name)).toEqual(['Bay 2', 'Bay 3']);
    expect(page2.body.nextCursor).toBeNull();
    expect((await o.resources({ q: 'BAY', type: 'ROOM' })).body.resources.map((r: { name: string }) => r.name)).toEqual(['bay 1', 'Bay 3']);
    expect((await o.resources({ status: 'archived' })).body.resources.map((r: { name: string }) => r.name)).toEqual(['Lift']);
    expect((await o.resources({ status: 'all' })).body.resources).toHaveLength(5);
    expect((await o.resources({ status: 'archived', cursor: page1.body.nextCursor })).status).toBe(400); // cursor of another list
    expect((await o.resources({ limit: '101' })).status).toBe(400);
  });
});

// =================================================================================================
describe('assignments', () => {
  it('assigns several resources with the event, all or nothing, and records who assigned them', async () => {
    const t = freshDay();
    const [room, person, kit] = [await newResource('Room', 'ROOM'), await newResource('Tech', 'PERSON'), await newResource('Unit 4', 'EQUIPMENT')];
    const res = await book(calA, t, [room.id, person.id, kit.id]);
    expect(res.status).toBe(201);
    const ev = EventResponse.parse(res.body).event;
    expect(ev.resources.map((r) => r.name)).toEqual(['Room', 'Tech', 'Unit 4']);
    expect(await liveAssignments(ev.id)).toEqual(sortIds([room.id, person.id, kit.id]));
    const rows = (await admin.query('SELECT business_id, created_by_id FROM scheduling_event_resources WHERE event_id = $1', [ev.id])).rows;
    expect(rows.every((x) => x.business_id === A.businessId && x.created_by_id === A.people.MEMBER!.id)).toBe(true);
    const trail = await audits(ev.id);
    expect(trail.map((a) => a.action)).toEqual(['scheduling.event.created', 'scheduling.event.resources_changed']);
    expect(trail[1]!.metadata).toEqual({ added: sortIds([room.id, person.id, kit.id]), removed: [] });
    // A refused request writes nothing: no event, no assignment.
    const before = (await admin.query('SELECT count(*)::int AS n FROM scheduling_event_resources WHERE business_id = $1', [A.businessId])).rows[0].n;
    const evBefore = (await admin.query('SELECT count(*)::int AS n FROM scheduling_events WHERE business_id = $1', [A.businessId])).rows[0].n;
    const inactive = await newResource();
    await mgr().patchResource(inactive.id, { version: 1, status: 'INACTIVE' });
    const archived = await newResource();
    await mgr().archiveResource(archived.id, 1);
    const resB = (await api(B.people.OWNER!, B.slug).createResource({ name: 'B room', type: 'ROOM' })).body.resource.id;
    const t2 = t + 5 * H;
    expect((await book(calA, t2, [room.id, randomUUID()])).body).toEqual({ error: 'not_found' });
    expect((await book(calA, t2, [room.id, resB])).body).toEqual({ error: 'not_found' }); // another business's resource is unknown here
    expect((await book(calA, t2, [room.id, inactive.id])).body).toEqual({ error: 'resource_inactive' });
    expect((await book(calA, t2, [archived.id])).body).toEqual({ error: 'archived_reference' });
    expect((await book(calA, t2, [room.id, room.id])).status).toBe(400);
    expect((await book(calA, t2, [room.id, room.id.toUpperCase()])).status).toBe(400);
    expect((await book(calA, t2, Array.from({ length: 21 }, () => randomUUID()))).status).toBe(400);
    expect((await book(calA, t2, ['not-a-uuid'])).status).toBe(400);
    expect((await admin.query('SELECT count(*)::int AS n FROM scheduling_event_resources WHERE business_id = $1', [A.businessId])).rows[0].n).toBe(before);
    expect((await admin.query('SELECT count(*)::int AS n FROM scheduling_events WHERE business_id = $1', [A.businessId])).rows[0].n).toBe(evBefore);
  });

  it('adds, removes and replaces assignments as a complete set; removal keeps history; re-adding is a new row; every change bumps the version', async () => {
    const t = freshDay();
    const [r1, r2, r3] = [await newResource(), await newResource(), await newResource()];
    const m = member();
    let ev = (await book(calA, t, [r1.id])).body.event;
    ev = (await m.patch(ev.id, { version: ev.version, resourceIds: [r1.id, r2.id] })).body.event;
    expect(ev.version).toBe(2);
    expect(sortIds(ev.resources.map((r: { id: string }) => r.id))).toEqual(sortIds([r1.id, r2.id]));
    ev = (await m.patch(ev.id, { version: 2, resourceIds: [r3.id] })).body.event;
    expect(ev.resources.map((r: { id: string }) => r.id)).toEqual([r3.id]);
    ev = (await m.patch(ev.id, { version: 3, resourceIds: [r3.id, r1.id] })).body.event;
    // Same set again: nothing changes, the version stays.
    expect((await m.patch(ev.id, { version: 4, resourceIds: [r1.id, r3.id] })).body.event.version).toBe(4);
    // Omitting resourceIds keeps them through a title edit.
    ev = (await m.patch(ev.id, { version: 4, title: 'Renamed' })).body.event;
    expect(ev.resources).toHaveLength(2);
    ev = (await m.patch(ev.id, { version: 5, resourceIds: [] })).body.event;
    expect(ev.resources).toEqual([]);
    const rows = (await admin.query('SELECT resource_id, removed_at IS NOT NULL AS removed, removed_by_id FROM scheduling_event_resources WHERE event_id = $1 ORDER BY created_at, resource_id', [ev.id])).rows;
    expect(rows.filter((x) => x.resource_id === r1.id).map((x) => x.removed)).toEqual([true, true]); // two rows: assigned, removed, re-added, removed
    expect(rows.every((x) => x.removed && x.removed_by_id === A.people.MEMBER!.id)).toBe(true);
    expect((await m.patch(ev.id, { version: 1, resourceIds: [r2.id] })).body).toEqual({ error: 'stale' });
    expect((await audits(ev.id)).filter((a) => a.action === 'scheduling.event.resources_changed').map((a) => a.metadata)).toEqual([
      { added: [r1.id], removed: [] }, { added: [r2.id], removed: [] }, { added: [r3.id], removed: sortIds([r1.id, r2.id]) },
      { added: [r1.id], removed: [] }, { added: [], removed: sortIds([r1.id, r3.id]) },
    ]);
    // The database allows one live row per (event, resource) whatever code writes.
    await m.patch(ev.id, { version: ev.version, resourceIds: [r2.id] });
    await expect(admin.query(
      'INSERT INTO scheduling_event_resources (id, business_id, event_id, resource_id, created_by_id) VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), A.businessId, ev.id, r2.id, A.people.OWNER!.id])).rejects.toMatchObject({ code: '23505' });
  });

  it('keeps inactive and archived resources on existing events (history), allows retiming them, but never re-adds them', async () => {
    const t = freshDay();
    const keep = await newResource('Kept', 'PERSON');
    const other = await newResource();
    let ev = (await book(calA, t, [keep.id, other.id])).body.event;
    const deactivated = await mgr().patchResource(keep.id, { version: 1, status: 'INACTIVE' });
    expect(deactivated.body.upcomingBookings).toBe(1);
    ev = (await member().event(ev.id)).body.event;
    expect(ev.resources.find((r: { id: string }) => r.id === keep.id).status).toBe('INACTIVE');
    // A retime keeps the inactive resource and checks it like any other.
    ev = (await member().patch(ev.id, { version: ev.version, start: at(iso(t + H)), end: at(iso(t + 2 * H)) })).body.event;
    expect(ev.resources).toHaveLength(2);
    await mgr().archiveResource(keep.id, 2);
    ev = (await member().patch(ev.id, { version: ev.version, resourceIds: [other.id] })).body.event; // removing it is fine
    expect((await member().patch(ev.id, { version: ev.version, resourceIds: [other.id, keep.id] })).body).toEqual({ error: 'archived_reference' });
    // An archived resource still occupies its existing bookings: another event holding it cannot be booked over them.
    const holdsArchived = (await book(calA, t + 10 * H, [other.id])).body.event;
    expect((await audits(keep.id)).at(-1)!.action).toBe('scheduling.resource.archived');
    expect(holdsArchived.resources).toHaveLength(1);
  });

  it('lists an event’s resources on reads and filters events by resource', async () => {
    const t = freshDay();
    const r = await newResource();
    const e1 = (await book(calA, t, [r.id])).body.event;
    await book(calA2, t + 2 * H, [r.id]);
    await book(calA, t + 4 * H, []);
    const list = await member().events({ from: iso(t), to: iso(t + 6 * H), resourceId: r.id });
    ListEventsResponse.parse(list.body);
    expect(list.body.events.map((e: { calendarId: string }) => e.calendarId)).toEqual([calA, calA2]);
    expect(list.body.events[0].id).toBe(e1.id);
    expect((await member().events({ from: iso(t), to: iso(t + 6 * H), resourceId: randomUUID() })).status).toBe(404);
    // S1 queries are unchanged: no resourceId, every event in range.
    expect((await member().events({ from: iso(t), to: iso(t + 6 * H) })).body.events).toHaveLength(3);
  });
});

// =================================================================================================
describe('resource conflicts', () => {
  it('refuses an enforced booking of a busy resource across calendars, with structured resource conflicts and nothing written', async () => {
    const t = freshDay();
    const room = await newResource('Treatment Room 2');
    const tech = await newResource('Employee A', 'PERSON');
    const first = (await book(calA, t, [room.id])).body.event;
    // Another calendar, same room, overlapping: refused, and the other requested resource is not left behind.
    const refused = await book(calA2, t + 0.5 * H, [tech.id, room.id]);
    expect(refused.status).toBe(409);
    const body = SchedulingConflictResponse.parse(refused.body);
    expect(body.conflicts).toEqual([{
      kind: 'resource', eventId: first.id, calendarId: calA, title: 'Booking', startAt: first.startAt, endAt: first.endAt,
      resource: { id: room.id, name: 'Treatment Room 2' }, blocking: true,
    }]);
    expect(JSON.stringify(refused.body)).not.toMatch(/description|location|customer/);
    expect(await occupying(tech.id, t - 1 * H, t + 3 * H)).toBe(0);
    // Touching is not overlapping.
    expect((await book(calA2, t + H, [room.id, tech.id])).status).toBe(201);
    expect((await book(calA2, t - H, [room.id])).status).toBe(201);
  });

  it('reports calendar and resource conflicts together, distinguishably, and one override accepts both', async () => {
    const t = freshDay();
    const room = await newResource('Room X');
    const busy = (await book(calA, t, [room.id])).body.event;
    const both = await book(calA, t, [room.id]);
    expect(both.status).toBe(409);
    expect(both.body.conflicts.map((c: { kind: string; eventId: string; blocking: boolean }) => [c.kind, c.eventId, c.blocking])).toEqual([
      ['calendar', busy.id, true], ['resource', busy.id, true],
    ]);
    const kept = await book(calA, t, [room.id], { enforceConflicts: false });
    expect(kept.status).toBe(201);
    expect(kept.body.conflicts.map((c: { kind: string; blocking: boolean }) => [c.kind, c.blocking])).toEqual([['calendar', false], ['resource', false]]);
    const accepted = (await audits(kept.body.event.id)).find((a) => a.action === 'scheduling.event.overlap_accepted')!;
    expect(accepted.metadata).toEqual({ calendarOverlaps: '1', resourceOverlaps: '1', eventIds: [busy.id], resourceIds: [room.id] });
    // An enforced booking now meets both existing occupants, including the one kept on purpose.
    const third = await book(calA2, t + 0.25 * H, [room.id]);
    expect(third.status).toBe(409);
    expect(sortIds(third.body.conflicts.map((c: { eventId: string }) => c.eventId))).toEqual(sortIds([busy.id, kept.body.event.id]));
    // Reading the kept event shows its overlaps for information.
    const read = await member().event(kept.body.event.id);
    expect(read.body.conflicts.map((c: { kind: string; blocking: boolean }) => [c.kind, c.blocking])).toEqual([['calendar', false], ['resource', false]]);
  });

  it('cancelled, archived and non-blocking events, and removed assignments, do not occupy a resource', async () => {
    const t = freshDay();
    const r = await newResource();
    const m = member();
    const a = (await book(calA, t, [r.id])).body.event;
    expect((await book(calA2, t, [r.id])).status).toBe(409);
    await m.cancel(a.id, a.version);
    const b = (await book(calA2, t, [r.id])).body.event;
    expect(b).toBeTruthy();
    await m.archive(b.id, b.version);
    const c = (await book(calA2, t, [r.id], { blocksAvailability: false })).body.event;
    expect(c.resources).toHaveLength(1);
    const d = (await book(calA2, t, [r.id])).body.event;
    await m.patch(d.id, { version: d.version, resourceIds: [] });
    expect((await book(calA, t, [r.id])).status).toBe(201); // calA: d still holds calA2's time, but no longer the resource
    // Switching blocking back on is checked against what occupies the resource now.
    const nb = (await book(calA, t + 3 * H, [r.id])).body.event;
    const shadow = (await book(calA2, t + 3 * H, [r.id], { blocksAvailability: false })).body.event;
    const on = await m.patch(shadow.id, { version: shadow.version, blocksAvailability: true });
    expect(on.status).toBe(409);
    expect(on.body.conflicts.map((x: { eventId: string; kind: string }) => [x.kind, x.eventId])).toEqual([['resource', nb.id]]);
  });

  it('a retime re-checks every resource; adding resources checks only the added ones; a calendar move alone does not re-check resources', async () => {
    const t = freshDay();
    const [r1, r2, r3] = [await newResource(), await newResource(), await newResource()];
    const m = member();
    const busy1 = (await book(calA2, t + 2 * H, [r1.id])).body.event;
    const busy3 = (await book(calA2, t, [r3.id])).body.event;
    // Kept overlap on r3 at t.
    let ev = (await book(calA, t, [r3.id, r2.id], { enforceConflicts: false })).body.event;
    // Adding r1 (free at t): only r1 is checked, so the existing accepted r3 overlap does not block it.
    ev = (await m.patch(ev.id, { version: ev.version, resourceIds: [r1.id, r2.id, r3.id] })).body.event;
    expect(ev.resources).toHaveLength(3);
    // Moving calendar keeps the time: resources are not re-checked (only the destination calendar is).
    const moved = await m.patch(ev.id, { version: ev.version, calendarId: calA2 });
    expect(moved.status).toBe(409); // busy3 is on calA2 at t: a calendar conflict
    expect(moved.body.conflicts.map((c: { kind: string; eventId: string }) => [c.kind, c.eventId])).toEqual([['calendar', busy3.id]]);
    // A retime into busy1's slot re-checks every resource: r1 clashes there.
    const retimed = await m.patch(ev.id, { version: ev.version, start: at(iso(t + 2 * H)), end: at(iso(t + 3 * H)) });
    expect(retimed.status).toBe(409);
    expect(retimed.body.conflicts.filter((c: { kind: string }) => c.kind === 'resource').map((c: { eventId: string; resource: { id: string } }) => [c.eventId, c.resource.id]))
      .toEqual([[busy1.id, r1.id]]);
    expect(await liveAssignments(ev.id)).toEqual(sortIds([r1.id, r2.id, r3.id])); // unchanged after the refusal
  });
});

// =================================================================================================
describe('availability', () => {
  it('answers available, occupied and unavailable from real bookings, with calendar context and the edited event left out', async () => {
    const t = freshDay();
    const [free, busy, inactive] = [await newResource('Free'), await newResource('Busy'), await newResource('Off')];
    await mgr().patchResource(inactive.id, { version: 1, status: 'INACTIVE' });
    const ev = (await book(calA, t, [busy.id])).body.event;
    const res = await member().availability({ start: iso(t + 0.5 * H), end: iso(t + 1.5 * H), resourceIds: [free.id, busy.id, inactive.id].join(','), calendarId: calA });
    expect(res.status).toBe(200);
    const body = ResourceAvailabilityResponse.parse(res.body);
    expect(body.resources.map((r) => [r.resource.name, r.state, r.conflicts.map((c) => c.eventId)])).toEqual([
      ['Busy', 'occupied', [ev.id]], ['Free', 'available', []], ['Off', 'unavailable', []],
    ]);
    expect(body.calendar).toMatchObject({ calendarId: calA, available: false });
    const excl = await member().availability({ start: iso(t), end: iso(t + H), resourceIds: busy.id, excludeEventId: ev.id });
    expect(excl.body.resources[0].state).toBe('available');
    expect((await member().availability({ start: iso(t + H), end: iso(t + 2 * H), resourceIds: busy.id })).body.resources[0].state).toBe('available'); // touching
    // Bounds and validation.
    expect((await member().availability({ start: iso(t), end: iso(t + 32 * 24 * H), resourceIds: busy.id })).status).toBe(400);
    expect((await member().availability({ start: iso(t), end: iso(t), resourceIds: busy.id })).status).toBe(400);
    expect((await member().availability({ start: iso(t), end: iso(t + H), resourceIds: Array.from({ length: 51 }, () => randomUUID()).join(',') })).status).toBe(400);
    expect((await member().availability({ start: iso(t), end: iso(t + H), resourceIds: `${busy.id},${randomUUID()}` })).status).toBe(404);
    expect((await member().availability({ start: iso(t), end: iso(t + H), resourceIds: 'x' })).status).toBe(400);
  });

  it('pages through current resources by name when none are named, and is computed fresh from events (no ledger)', async () => {
    const S = await solo('rv');
    const o = api(S.owner, S.slug);
    const cal = (await o.initDefault()).body.calendar.id;
    const ids: string[] = [];
    for (const name of ['A1', 'A2', 'A3']) ids.push((await o.createResource({ name, type: 'ROOM' })).body.resource.id);
    const t = freshDay();
    const p1 = await o.availability({ start: iso(t), end: iso(t + H), limit: '2' });
    expect(p1.body.resources.map((r: { resource: { name: string } }) => r.resource.name)).toEqual(['A1', 'A2']);
    const p2 = await o.availability({ start: iso(t), end: iso(t + H), limit: '2', cursor: p1.body.nextCursor });
    expect(p2.body.resources.map((r: { resource: { name: string } }) => r.resource.name)).toEqual(['A3']);
    const ev = (await o.create({ calendarId: cal, title: 'x', start: at(iso(t)), end: at(iso(t + H)), resourceIds: [ids[1]] })).body.event;
    expect((await o.availability({ start: iso(t), end: iso(t + H), resourceIds: ids[1] })).body.resources[0].state).toBe('occupied');
    await o.cancel(ev.id, ev.version);
    expect((await o.availability({ start: iso(t), end: iso(t + H), resourceIds: ids[1] })).body.resources[0].state).toBe('available');
  });
});

// =================================================================================================
describe('time zones', () => {
  it('resource conflicts compare instants across calendars in different zones, including non-hour offsets', async () => {
    const m = mgr();
    const zones = ['Australia/Perth', 'Australia/Sydney', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Asia/Kathmandu'];
    const cals: Record<string, string> = {};
    for (const z of zones) cals[z] = (await m.createCalendar({ name: z, timeZone: z })).body.calendar.id;
    const r = await newResource('Shared');
    // 2032-07-14 02:00 UTC = 10:00 Perth = 12:00 Sydney (AEST) = 22:00 NY on the 13th (EDT) = 03:00 London (BST) = 07:30 Kolkata = 07:45 Kathmandu.
    const local: Record<string, string> = {
      'Australia/Perth': '2032-07-14T10:00', 'Australia/Sydney': '2032-07-14T12:00', 'America/New_York': '2032-07-13T22:00',
      'Europe/London': '2032-07-14T03:00', 'Asia/Kolkata': '2032-07-14T07:30', 'Asia/Kathmandu': '2032-07-14T07:45',
    };
    const plusHour = (s: string) => s.replace(/T(\d\d)/, (_, h) => `T${String(Number(h) + 1).padStart(2, '0')}`);
    const first = await member().create({ calendarId: cals['Australia/Perth'], title: 'Perth', start: { local: local['Australia/Perth'], timeZone: 'Australia/Perth' }, end: { local: plusHour(local['Australia/Perth']!), timeZone: 'Australia/Perth' }, resourceIds: [r.id] });
    expect(first.body.event.startAt).toBe('2032-07-14T02:00:00.000Z');
    for (const z of zones.slice(1)) {
      const res = await member().create({ calendarId: cals[z], title: z, start: { local: local[z]!, timeZone: z }, end: { local: plusHour(local[z]!), timeZone: z }, resourceIds: [r.id] });
      expect(res.status, z).toBe(409);
      expect(res.body.conflicts.map((c: { kind: string; eventId: string }) => [c.kind, c.eventId])).toEqual([['resource', first.body.event.id]]);
    }
    // One minute later in Kathmandu, after the Perth hour ends: free (half-open).
    expect((await member().create({ calendarId: cals['Asia/Kathmandu'], title: 'k', start: { local: '2032-07-14T08:45', timeZone: 'Asia/Kathmandu' }, end: { local: '2032-07-14T09:00', timeZone: 'Asia/Kathmandu' }, resourceIds: [r.id] })).status).toBe(201);
  });

  it('daylight saving: skipped times are refused before anything is locked; repeated times need a choice; a midnight-crossing booking blocks both days', async () => {
    const ny = (await mgr().createCalendar({ name: 'NY', timeZone: 'America/New_York' })).body.calendar.id;
    const london = (await mgr().createCalendar({ name: 'LDN', timeZone: 'Europe/London' })).body.calendar.id;
    const r = await newResource();
    const local = (l: string, tz: string, d?: string) => ({ local: l, timeZone: tz, ...(d ? { disambiguation: d } : {}) });
    expect((await member().create({ calendarId: ny, title: 'x', start: local('2032-03-14T02:30', 'America/New_York'), end: local('2032-03-14T04:00', 'America/New_York'), resourceIds: [r.id] })).body.error).toBe('nonexistent_local_time');
    expect((await member().create({ calendarId: ny, title: 'x', start: local('2032-11-07T01:30', 'America/New_York'), end: local('2032-11-07T03:00', 'America/New_York'), resourceIds: [r.id] })).body.error).toBe('ambiguous_local_time');
    const earlier = await member().create({ calendarId: ny, title: 'early', start: local('2032-11-07T01:30', 'America/New_York', 'earlier'), end: local('2032-11-07T01:45', 'America/New_York', 'earlier'), resourceIds: [r.id] });
    expect(earlier.body.event.startAt).toBe('2032-11-07T05:30:00.000Z');
    // The later 01:30 is an hour after: no clash with the earlier one.
    const later = await member().create({ calendarId: ny, title: 'late', start: local('2032-11-07T01:30', 'America/New_York', 'later'), end: local('2032-11-07T01:45', 'America/New_York', 'later'), resourceIds: [r.id] });
    expect(later.status).toBe(201);
    expect(later.body.event.startAt).toBe('2032-11-07T06:30:00.000Z');
    // 23:00–01:00 London crosses midnight: a booking at 00:30 the next day clashes.
    const night = await member().create({ calendarId: london, title: 'night', start: local('2032-08-01T23:00', 'Europe/London'), end: local('2032-08-02T01:00', 'Europe/London'), resourceIds: [r.id] });
    expect(night.status).toBe(201);
    expect((await member().create({ calendarId: london, title: 'x', start: local('2032-08-02T00:30', 'Europe/London'), end: local('2032-08-02T00:45', 'Europe/London'), resourceIds: [r.id] })).status).toBe(409);
  });
});

// =================================================================================================
describe('tenant isolation and database rules', () => {
  it('business A cannot see, change or book business B resources; existence is not leaked', async () => {
    const b = api(B.people.OWNER!, B.slug);
    const rb = (await b.createResource({ name: 'B only', type: 'ROOM' })).body.resource;
    const a = api(A.people.OWNER!, A.slug);
    for (const res of [
      await a.resource(rb.id), await a.resource(randomUUID()), await a.patchResource(rb.id, { version: 1, name: 'x' }),
      await a.archiveResource(rb.id, 1), await a.restoreResource(rb.id, 1),
      await a.availability({ start: '2032-05-01T00:00:00Z', end: '2032-05-01T01:00:00Z', resourceIds: rb.id }),
      await a.events({ from: '2032-05-01T00:00:00Z', to: '2032-05-02T00:00:00Z', resourceId: rb.id }),
    ]) expect(res).toEqual({ status: 404, body: { error: 'not_found' } });
    expect((await a.resources({ status: 'all' })).body.resources.map((r: { id: string }) => r.id)).not.toContain(rb.id);
    expect((await b.resource(rb.id)).body.resource.name).toBe('B only');
  });

  it('cross-tenant assignments fail in the database even for a role that bypasses RLS; assignments cannot be re-pointed or deleted by the app role', async () => {
    const rb = (await api(B.people.OWNER!, B.slug).createResource({ name: 'B', type: 'ROOM' })).body.resource.id;
    const ra = await newResource();
    const ev = (await book(calA, freshDay(), [ra.id])).body.event.id;
    const evB = (await api(B.people.MEMBER!, B.slug).create({ calendarId: calB, title: 'b', start: at('2032-05-03T00:00:00Z'), end: at('2032-05-03T01:00:00Z') })).body.event.id;
    const insert = (businessId: string, eventId: string, resourceId: string) => admin.query(
      'INSERT INTO scheduling_event_resources (id, business_id, event_id, resource_id, created_by_id) VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), businessId, eventId, resourceId, A.people.OWNER!.id]);
    await expect(insert(A.businessId, ev, rb)).rejects.toMatchObject({ code: '23503' });
    await expect(insert(A.businessId, evB, ra.id)).rejects.toMatchObject({ code: '23503' });
    await expect(insert(B.businessId, ev, rb)).rejects.toMatchObject({ code: '23503' });
    // The app role, in A's context: no DELETE on either table, and only the removal columns of an assignment may change.
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.business_id', $1, true)", [A.businessId]);
      for (const sql of [
        'DELETE FROM scheduling_resources WHERE id = $1', 'DELETE FROM scheduling_event_resources WHERE resource_id = $1',
      ]) {
        await app.query('SAVEPOINT s');
        await expect(app.query(sql, [ra.id])).rejects.toMatchObject({ code: '42501' });
        await app.query('ROLLBACK TO SAVEPOINT s');
      }
      for (const col of ['event_id', 'resource_id', 'created_by_id', 'business_id']) {
        await app.query('SAVEPOINT s');
        await expect(app.query(`UPDATE scheduling_event_resources SET ${col} = ${col} WHERE event_id = $1`, [ev])).rejects.toMatchObject({ code: '42501' });
        await app.query('ROLLBACK TO SAVEPOINT s');
      }
      // Writing a row for another business under A's context is refused by the policy.
      await app.query('SAVEPOINT s');
      await expect(app.query("INSERT INTO scheduling_resources (id, business_id, name, resource_type, created_by_id, updated_by_id) VALUES ($1, $2, 'x', 'ROOM', $3, $3)",
        [randomUUID(), B.businessId, A.people.OWNER!.id])).rejects.toThrow(/row-level security/i);
      await app.query('ROLLBACK TO SAVEPOINT s');
      // RLS: only A's rows are visible.
      const seen = (await app.query("SELECT count(*) FILTER (WHERE business_id <> $1)::int AS other, count(*)::int AS n FROM scheduling_event_resources", [A.businessId])).rows[0];
      expect(seen.other).toBe(0);
      expect(seen.n).toBeGreaterThan(0);
    } finally {
      await app.query('ROLLBACK');
    }
    // Without a tenant context nothing is visible.
    expect((await app.query('SELECT count(*)::int AS n FROM scheduling_resources')).rows[0].n).toBe(0);
    const forced = await admin.query(
      "SELECT relname FROM pg_class WHERE relname IN ('scheduling_resources','scheduling_event_resources') AND relrowsecurity AND relforcerowsecurity ORDER BY relname");
    expect(forced.rows.map((x) => x.relname)).toEqual(['scheduling_event_resources', 'scheduling_resources']);
    const grants = await admin.query(
      `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p FROM information_schema.role_table_grants
       WHERE grantee = 'bos_app' AND table_name IN ('scheduling_resources','scheduling_event_resources') GROUP BY table_name ORDER BY table_name`);
    expect(grants.rows).toEqual([{ table_name: 'scheduling_event_resources', p: 'INSERT,SELECT' }, { table_name: 'scheduling_resources', p: 'INSERT,SELECT,UPDATE' }]);
    const cols = await admin.query(
      `SELECT string_agg(column_name, ',' ORDER BY column_name) AS c FROM information_schema.column_privileges
       WHERE grantee = 'bos_app' AND table_name = 'scheduling_event_resources' AND privilege_type = 'UPDATE'`);
    expect(cols.rows[0].c).toBe('removed_at,removed_by_id');
    const roles = await admin.query(
      "SELECT DISTINCT grantee FROM information_schema.role_table_grants WHERE table_name IN ('scheduling_resources','scheduling_event_resources') AND grantee IN ('bos_jobs','bos_auth')");
    expect(roles.rows).toEqual([]);
  });
});

// =================================================================================================
describe('permissions', () => {
  it('manage_resources gates resource management on the server; members view and assign through their event permissions', async () => {
    const r = await newResource();
    const m = member();
    // MEMBER by default: reads, books with resources, but cannot manage resources.
    expect((await m.resources()).status).toBe(200);
    expect((await m.resource(r.id)).status).toBe(200);
    for (const res of [
      await m.createResource({ name: 'x', type: 'ROOM' }), await m.patchResource(r.id, { version: 1, name: 'x' }),
      await m.patchResource(r.id, { version: 1, status: 'INACTIVE' }), await m.archiveResource(r.id, 1), await m.restoreResource(r.id, 1),
    ]) expect(res).toEqual({ status: 403, body: { error: 'forbidden' } });
    const t = freshDay();
    const ev = (await book(calA, t, [r.id])).body.event;
    expect(ev.resources).toHaveLength(1);
    // Read-only: sees resources and availability; cannot assign through any write.
    custom.MEMBER = ['business:read', 'scheduling:read'];
    expect((await m.availability({ start: iso(t), end: iso(t + H), resourceIds: r.id })).status).toBe(200);
    expect((await book(calA, t + 2 * H, [r.id])).status).toBe(403);
    expect((await m.patch(ev.id, { version: ev.version, resourceIds: [] })).status).toBe(403);
    // scheduling:update alone may change an event's resources; it does not grant creating events or managing resources.
    custom.MEMBER = ['scheduling:read', 'scheduling:update'];
    expect((await m.patch(ev.id, { version: ev.version, resourceIds: [] })).status).toBe(200);
    expect((await m.createResource({ name: 'x', type: 'ROOM' })).status).toBe(403);
    // manage_resources alone does not grant booking.
    custom.MEMBER = ['scheduling:read', 'scheduling:manage_resources'];
    expect((await m.createResource({ name: 'ok', type: 'ROOM' })).status).toBe(201);
    expect((await book(calA, t + 4 * H, [r.id])).status).toBe(403);
    // No scheduling keys: no resource reads either.
    custom.MEMBER = ['business:read'];
    for (const res of [await m.resources(), await m.resource(r.id), await m.availability({ start: iso(t), end: iso(t + H), resourceIds: r.id })]) expect(res.status).toBe(403);
    // OWNER, ADMIN and MANAGER manage resources by default.
    for (const role of ['OWNER', 'ADMIN', 'MANAGER']) expect((await api(A.people[role]!, A.slug).createResource({ name: role, type: 'OTHER' })).status).toBe(201);
  });
});

// =================================================================================================
// The extended lock protocol (docs/scheduling-s2.md §5): calendar rows → calendar advisory → resource
// rows → resource advisory → event row, sorted within each step.
describe('concurrency and the lock protocol', () => {
  const resKey = (id: string) => `hashtextextended('scheduling.resource:' || '${id}', 0)`;
  const calKey = (id: string) => `hashtextextended('scheduling.calendar:' || '${id}', 0)`;
  /** Holds one resource's advisory lock in a separate session, runs `work`, and proves it waits for the lock. */
  async function provesItWaits<T>(resourceId: string, work: () => Promise<T>): Promise<T> {
    await holder.query(`SELECT pg_advisory_lock(${resKey(resourceId)})`);
    let pending: Promise<T>;
    try {
      pending = work();
      expect(await finishesOrBlocks(admin, await backendPid(holder), pending)).toBe('blocked');
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(${resKey(resourceId)})`);
    }
    return pending;
  }
  /** Can a third session take this advisory lock right now? (false = someone holds it). Releases it at once. */
  async function lockFree(key: string): Promise<boolean> {
    const ok = (await admin.query(`SELECT pg_try_advisory_lock(${key}) AS ok`)).rows[0].ok as boolean;
    if (ok) await admin.query(`SELECT pg_advisory_unlock(${key})`);
    return ok;
  }
  /** Is this row lockable FOR UPDATE right now without waiting? */
  async function rowFree(table: string, id: string): Promise<boolean> {
    await admin.query('BEGIN');
    try {
      await admin.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id]);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === '55P03') return false;
      throw error;
    } finally {
      await admin.query('ROLLBACK');
    }
  }
  const noDeadlock = (results: { status: number; body: unknown }[]) => {
    for (const r of results) expect(r.status, JSON.stringify(r.body)).not.toBe(503);
  };

  it('every mutation that touches a resource, enforced or not, waits for that resource’s lock', async () => {
    const t = freshDay();
    const [r1, r2] = [await newResource(), await newResource()];
    const m = member();
    const created = await provesItWaits(r1.id, () => book(calA, t, [r1.id]));
    expect(created.status).toBe(201);
    let e = created.body.event;
    const loose = await provesItWaits(r1.id, () => book(calA2, t, [r1.id], { enforceConflicts: false }));
    expect(loose.status).toBe(201);
    const nonBlocking = await provesItWaits(r1.id, () => book(calA2, t + 3 * H, [r1.id], { blocksAvailability: false }));
    expect(nonBlocking.status).toBe(201);
    e = (await provesItWaits(r1.id, () => m.patch(e.id, { version: e.version, start: at(iso(t + 5 * H)), end: at(iso(t + 6 * H)) }))).body.event; // retime: kept resource
    e = (await provesItWaits(r2.id, () => m.patch(e.id, { version: e.version, resourceIds: [r1.id, r2.id] }))).body.event; // add
    e = (await provesItWaits(r1.id, () => m.patch(e.id, { version: e.version, resourceIds: [r2.id] }))).body.event; // remove
    e = (await provesItWaits(r2.id, () => m.patch(e.id, { version: e.version, calendarId: calA2 }))).body.event; // move: resources still locked
    expect(e.calendarId).toBe(calA2);
    expect((await provesItWaits(r2.id, () => m.cancel(e.id, e.version))).body.event.status).toBe('CANCELLED');
    expect((await provesItWaits(r1.id, () => m.archive(loose.body.event.id, 1))).body.event.archivedAt).not.toBeNull();
  });

  it('acquires in the global order: calendar, then resources in id order, before the event row', async () => {
    const t = freshDay();
    const rs = [await newResource(), await newResource(), await newResource()];
    const [lo, mid, hi] = [...rs].sort((a, b) => (a.id < b.id ? -1 : 1));
    // The holder takes the HIGHEST resource. A booking that asks for them in reverse order must already
    // hold the calendar lock and the two lower resources (rows and advisory locks) while it waits.
    await holder.query(`SELECT pg_advisory_lock(${resKey(hi!.id)})`);
    let pending: ReturnType<typeof book>;
    try {
      pending = book(calA2, t, [hi!.id, mid!.id, lo!.id]);
      expect(await finishesOrBlocks(admin, await backendPid(holder), pending)).toBe('blocked');
      expect(await lockFree(calKey(calA2))).toBe(false);
      expect(await lockFree(resKey(lo!.id))).toBe(false);
      expect(await lockFree(resKey(mid!.id))).toBe(false);
      expect(await rowFree('scheduling_resources', lo!.id)).toBe(false); // FOR SHARE on the resource row
      expect(await rowFree('scheduling_resources', hi!.id)).toBe(false); // all rows are taken before any advisory lock
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(${resKey(hi!.id)})`);
    }
    const ev = (await pending).body.event;
    // An edit waiting for a resource lock does not hold its event row yet (step 5 comes after step 4).
    await holder.query(`SELECT pg_advisory_lock(${resKey(lo!.id)})`);
    let edit: ReturnType<ReturnType<typeof member>['patch']>;
    try {
      edit = member().patch(ev.id, { version: ev.version, start: at(iso(t + H)), end: at(iso(t + 2 * H)) });
      expect(await finishesOrBlocks(admin, await backendPid(holder), edit)).toBe('blocked');
      expect(await rowFree('scheduling_events', ev.id)).toBe(true);
      expect(await lockFree(calKey(calA2))).toBe(false);
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(${resKey(lo!.id)})`);
    }
    expect((await edit).status).toBe(200);
  });

  it('concurrent enforced bookings of one resource from different calendars: exactly one succeeds', async () => {
    const t = freshDay() + 10 * H;
    const r = await newResource();
    const extra = (await mgr().createCalendar({ name: 'Third' })).body.calendar.id;
    const cals = [calA, calA2, extra];
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => book(cals[i % 3]!, t + (i % 4) * 0.25 * H, [r.id])));
    noDeadlock(results);
    expect(results.filter((x) => x.status === 201)).toHaveLength(1);
    expect(results.filter((x) => x.status === 409 && x.body.error === 'scheduling_conflict')).toHaveLength(11);
    expect(await occupying(r.id, t, t + 2 * H)).toBe(1);
  });

  it('multi-resource bookings are all or nothing: Room 1 + Employee 1 against Room 1 + Employee 2', async () => {
    for (let round = 0; round < 8; round++) {
      const t = freshDay();
      const [room, emp1, emp2] = [await newResource('Room 1'), await newResource('Employee 1', 'PERSON'), await newResource('Employee 2', 'PERSON')];
      const [a, b] = await Promise.all([book(calA, t, [room.id, emp1.id]), book(calA2, t, [emp2.id, room.id])]);
      noDeadlock([a, b]);
      expect([a.status, b.status].sort(), `round ${round}`).toEqual([201, 409]);
      const loserEmp = a.status === 201 ? emp2 : emp1;
      expect(await occupying(room.id, t, t + H)).toBe(1);
      expect(await occupying(loserEmp.id, t, t + H)).toBe(0); // no partial assignment survived
      const { rows } = await admin.query('SELECT count(*)::int AS n FROM scheduling_event_resources WHERE resource_id = $1', [loserEmp.id]);
      expect(rows[0].n).toBe(0);
    }
  });

  it('bookings naming the same resources in opposite orders never deadlock', async () => {
    const [r1, r2, r3] = [await newResource(), await newResource(), await newResource()];
    for (let round = 0; round < 8; round++) {
      const t = freshDay();
      // Different times: both must succeed.
      const results = await Promise.all([book(calA, t, [r1.id, r2.id, r3.id]), book(calA2, t + 2 * H, [r3.id, r2.id, r1.id]), book(calA, t + 4 * H, [r2.id, r3.id, r1.id])]);
      noDeadlock(results);
      expect(results.map((x) => x.status), `round ${round}`).toEqual([201, 201, 201]);
      // Same time: exactly one.
      const same = await Promise.all([book(calA, t + 6 * H, [r1.id, r2.id]), book(calA2, t + 6 * H, [r2.id, r1.id])]);
      noDeadlock(same);
      expect(same.map((x) => x.status).sort()).toEqual([201, 409]);
    }
  });

  it('two events exchanging resources: no deadlock, and never two occupants of one resource', async () => {
    const [r1, r2] = [await newResource(), await newResource()];
    const m = member();
    for (let round = 0; round < 6; round++) {
      const t = freshDay();
      // Different times: the swap succeeds on both sides.
      let e1 = (await book(calA, t, [r1.id])).body.event;
      let e2 = (await book(calA2, t + 2 * H, [r2.id])).body.event;
      const swapped = await Promise.all([m.patch(e1.id, { version: e1.version, resourceIds: [r2.id] }), m.patch(e2.id, { version: e2.version, resourceIds: [r1.id] })]);
      noDeadlock(swapped);
      expect(swapped.map((x) => x.status)).toEqual([200, 200]);
      // Same time: whichever runs first meets the other's current holding; the invariant always holds.
      e1 = (await book(calA, t + 4 * H, [r1.id])).body.event;
      e2 = (await book(calA2, t + 4 * H, [r2.id])).body.event;
      const clash = await Promise.all([m.patch(e1.id, { version: e1.version, resourceIds: [r2.id] }), m.patch(e2.id, { version: e2.version, resourceIds: [r1.id] })]);
      noDeadlock(clash);
      for (const x of clash) expect([200, 409]).toContain(x.status);
      expect(await occupying(r1.id, t + 4 * H, t + 5 * H)).toBeLessThanOrEqual(1);
      expect(await occupying(r2.id, t + 4 * H, t + 5 * H)).toBeLessThanOrEqual(1);
    }
  });

  it('rescheduling into a slot while another booking of the same resource is created: one occupant', async () => {
    const t = freshDay() + 8 * H;
    const r = await newResource();
    const m = member();
    const movers = [];
    for (let i = 0; i < 5; i++) movers.push((await book(i % 2 ? calA : calA2, t + (2 + i) * 2 * H, [r.id])).body.event);
    const results = await Promise.all([
      ...movers.map((e) => m.patch(e.id, { version: e.version, start: at(iso(t)), end: at(iso(t + H)) })),
      book(calA, t + 0.5 * H, [r.id]),
    ]);
    noDeadlock(results);
    expect(results.filter((x) => x.status === 200 || x.status === 201)).toHaveLength(1);
    expect(await occupying(r.id, t, t + 2 * H)).toBe(1);
  });

  it('a cancellation racing a booking of the freed resource never double-books', async () => {
    const r = await newResource();
    const m = member();
    for (let round = 0; round < 6; round++) {
      const t = freshDay();
      const e = (await book(calA, t, [r.id])).body.event;
      const [cancel, rebook] = await Promise.all([m.cancel(e.id, e.version), book(calA2, t, [r.id])]);
      noDeadlock([cancel, rebook]);
      expect(cancel.status).toBe(200);
      expect([201, 409]).toContain(rebook.status);
      expect(await occupying(r.id, t, t + H)).toBe(rebook.status === 201 ? 1 : 0);
    }
  });

  it('archiving a resource and assigning it are serialised: whichever is second sees the other', async () => {
    const t = freshDay();
    // (a) A booking in flight (holding the row FOR SHARE) makes the archive wait; the booking stands.
    const r = await newResource();
    await holder.query('BEGIN');
    try {
      await holder.query('SELECT 1 FROM scheduling_resources WHERE id = $1 FOR SHARE', [r.id]);
      const archiving = mgr().archiveResource(r.id, 1);
      expect(await finishesOrBlocks(admin, await backendPid(holder), archiving)).toBe('blocked');
      await holder.query('COMMIT');
      expect((await archiving).body.resource.status).toBe('ARCHIVED');
    } catch (error) {
      await holder.query('ROLLBACK');
      throw error;
    }
    // (b) An archive in flight (its UPDATE not yet committed) makes the booking wait; the booking then reads ARCHIVED.
    const r2 = await newResource();
    await holder.query('BEGIN');
    try {
      await holder.query("UPDATE scheduling_resources SET status = 'ARCHIVED', archived_at = now(), version = version + 1 WHERE id = $1", [r2.id]);
      const booking = book(calA, t, [r2.id]);
      expect(await finishesOrBlocks(admin, await backendPid(holder), booking)).toBe('blocked');
      await holder.query('COMMIT');
      expect((await booking).body).toEqual({ error: 'archived_reference' });
    } catch (error) {
      await holder.query('ROLLBACK');
      throw error;
    }
    expect(await occupying(r2.id, t - H, t + 2 * H)).toBe(0);
    // (c) Free-running race: no deadlock; every booking either got in before the archive or was refused.
    for (let round = 0; round < 4; round++) {
      const x = await newResource();
      const day = freshDay();
      const results = await Promise.all([
        mgr().archiveResource(x.id, 1), ...Array.from({ length: 5 }, (_, i) => book(i % 2 ? calA : calA2, day + i * 2 * H, [x.id])),
      ]);
      noDeadlock(results);
      expect(results[0]!.status).toBe(200);
      for (const b of results.slice(1)) expect(b.status === 201 || (b.status === 409 && b.body.error === 'archived_reference'), JSON.stringify(b.body)).toBe(true);
    }
  });

  it('inactivating a resource while it is being booked: never a new assignment of an inactive resource', async () => {
    const r = await newResource();
    await holder.query('BEGIN');
    try {
      await holder.query("UPDATE scheduling_resources SET status = 'INACTIVE', version = version + 1 WHERE id = $1", [r.id]);
      const booking = book(calA, freshDay(), [r.id]);
      expect(await finishesOrBlocks(admin, await backendPid(holder), booking)).toBe('blocked');
      await holder.query('COMMIT');
      expect((await booking).body).toEqual({ error: 'resource_inactive' });
    } catch (error) {
      await holder.query('ROLLBACK');
      throw error;
    }
  });

  it('archiving or cancelling events while their resources are being edited: no deadlock', async () => {
    const m = member();
    const r = await newResource();
    for (let round = 0; round < 8; round++) {
      const t = freshDay();
      const e = (await book(round % 2 ? calA : calA2, t, [r.id])).body.event;
      const current = (await mgr().resource(r.id)).body.resource;
      const results = await Promise.all([
        round % 2 ? m.archive(e.id, e.version) : m.cancel(e.id, e.version),
        mgr().patchResource(r.id, { version: current.version, name: `Renamed ${round}` }),
        mgr().patchResource(r.id, { version: current.version, description: `d${round}` }),
      ]);
      noDeadlock(results);
      expect(results[0]!.status).toBe(200);
      // The two resource edits from the same version: one wins, the other is stale.
      expect(results.slice(1).map((x) => x.status).sort()).toEqual([200, 409]);
    }
  });

  it('moving events between calendars in opposite directions while they hold the same resources never deadlocks', async () => {
    const m = mgr();
    const left = (await m.createCalendar({ name: 'Left' })).body.calendar.id;
    const right = (await m.createCalendar({ name: 'Right' })).body.calendar.id;
    const [r1, r2] = [await newResource(), await newResource()];
    for (let round = 0; round < 8; round++) {
      const t = freshDay();
      const a = (await book(left, t, [r1.id, r2.id])).body.event;
      const b = (await book(right, t + 2 * H, [r2.id, r1.id])).body.event;
      const results = await Promise.all([
        member().patch(a.id, { version: a.version, calendarId: right }),
        member().patch(b.id, { version: b.version, calendarId: left, resourceIds: [r1.id] }),
      ]);
      noDeadlock(results);
      expect(results.map((x) => x.status), `round ${round}`).toEqual([200, 200]);
    }
  });

  it('concurrent edits of one event’s resources from the same version: one wins, the rest are stale', async () => {
    const t = freshDay();
    const rs = [await newResource(), await newResource(), await newResource(), await newResource()];
    const m = member();
    const e = (await book(calA, t, [rs[0]!.id])).body.event;
    const results = await Promise.all([
      m.patch(e.id, { version: e.version, resourceIds: [rs[1]!.id] }), m.patch(e.id, { version: e.version, resourceIds: [rs[2]!.id, rs[0]!.id] }),
      m.patch(e.id, { version: e.version, resourceIds: [] }), m.cancel(e.id, e.version),
    ]);
    noDeadlock(results);
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
    expect(results.filter((x) => x.status === 409 && x.body.error === 'stale')).toHaveLength(3);
    const after = (await m.event(e.id)).body.event;
    expect(after.version).toBe(2);
    expect(sortIds(await liveAssignments(e.id))).toEqual(sortIds(after.resources.map((r: { id: string }) => r.id)));
  });

  it('without the resource lock, check-then-write double-books; with it, the second writer sees the first', async () => {
    // Two application sessions run exactly the service's check and writes for the same resource and time,
    // on DIFFERENT calendars (so no calendar lock can save them). Deterministic interleaving: both check
    // before either writes.
    const r = await newResource();
    const t = freshDay();
    const sessions = [new pg.Client({ connectionString: process.env.DATABASE_URL }), new pg.Client({ connectionString: process.env.DATABASE_URL })];
    await Promise.all(sessions.map((c) => c.connect()));
    const begin = async (c: pg.Client) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [A.businessId, A.people.MEMBER!.id]);
    };
    const check = async (c: pg.Client) => (await c.query(
      `SELECT count(*)::int AS n FROM scheduling_event_resources a JOIN scheduling_events e ON e.business_id = a.business_id AND e.id = a.event_id
       WHERE a.removed_at IS NULL AND a.resource_id = $1 AND e.status = 'SCHEDULED' AND e.archived_at IS NULL AND e.blocks_availability
         AND e.start_at < $3 AND e.end_at > $2`, [r.id, iso(t), iso(t + H)])).rows[0].n as number;
    const write = async (c: pg.Client, calendarId: string) => {
      const id = randomUUID();
      await c.query(`INSERT INTO scheduling_events (id, business_id, calendar_id, title, start_at, end_at, created_by_id, updated_by_id)
                     VALUES ($1, $2, $3, 'race', $4, $5, $6, $6)`, [id, A.businessId, calendarId, iso(t), iso(t + H), A.people.MEMBER!.id]);
      await c.query('INSERT INTO scheduling_event_resources (id, business_id, event_id, resource_id, created_by_id) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), A.businessId, id, r.id, A.people.MEMBER!.id]);
    };
    try {
      // 1. No resource lock: both see the resource free and both commit. The invariant is broken.
      await Promise.all(sessions.map(begin));
      expect([await check(sessions[0]!), await check(sessions[1]!)]).toEqual([0, 0]);
      await write(sessions[0]!, calA);
      await write(sessions[1]!, calA2);
      await Promise.all(sessions.map((c) => c.query('COMMIT')));
      expect(await occupying(r.id, t, t + H)).toBe(2);
      // Clean up the forged double booking (superuser), then repeat with the lock the service takes.
      await admin.query("UPDATE scheduling_events SET status = 'CANCELLED', cancelled_at = now() WHERE title = 'race' AND business_id = $1", [A.businessId]);
      // 2. With the resource advisory lock (step 4): the second session waits, then its check sees the first's commit.
      await Promise.all(sessions.map(begin));
      await sessions[0]!.query(`SELECT pg_advisory_xact_lock(${resKey(r.id)})`);
      expect(await check(sessions[0]!)).toBe(0);
      const second = sessions[1]!.query(`SELECT pg_advisory_xact_lock(${resKey(r.id)})`).then(() => check(sessions[1]!));
      expect(await finishesOrBlocks(admin, await backendPid(sessions[0]!), second)).toBe('blocked');
      await write(sessions[0]!, calA);
      await sessions[0]!.query('COMMIT');
      expect(await second).toBe(1); // it would be refused with 409 scheduling_conflict
      await sessions[1]!.query('ROLLBACK');
      expect(await occupying(r.id, t, t + H)).toBe(1);
    } finally {
      for (const c of sessions) await c.query('ROLLBACK').catch(() => {});
      await Promise.all(sessions.map((c) => c.end()));
    }
  });
});

// =================================================================================================
describe('performance at SMB scale', () => {
  it('300 resources, 6,000 events, 3 assignments each: bounded, index-driven availability and booking checks', async () => {
    const S = await solo('rp');
    const o = api(S.owner, S.slug);
    const cal = (await o.initDefault()).body.calendar.id;
    // Seed directly (superuser) to keep the test fast; the API paths are what is measured.
    await admin.query(
      `INSERT INTO scheduling_resources (id, business_id, name, resource_type, created_by_id, updated_by_id)
       SELECT gen_random_uuid(), $1, 'Res ' || lpad(g::text, 3, '0'), 'ROOM', $2, $2 FROM generate_series(1, 300) g`, [S.businessId, S.owner.id]);
    await admin.query(
      `INSERT INTO scheduling_events (id, business_id, calendar_id, title, start_at, end_at, created_by_id, updated_by_id)
       SELECT gen_random_uuid(), $1, $2, 'Seed', '2030-01-01T00:00:00Z'::timestamptz + g * interval '1 hour',
              '2030-01-01T00:00:00Z'::timestamptz + g * interval '1 hour' + interval '30 minutes', $3, $3 FROM generate_series(1, 6000) g`,
      [S.businessId, cal, S.owner.id]);
    await admin.query(
      `INSERT INTO scheduling_event_resources (id, business_id, event_id, resource_id, created_by_id)
       SELECT gen_random_uuid(), $1, e.id, r.id, $2
       FROM (SELECT id, row_number() OVER (ORDER BY start_at) AS n FROM scheduling_events WHERE business_id = $1) e
       JOIN (SELECT id, row_number() OVER (ORDER BY name) - 1 AS k FROM scheduling_resources WHERE business_id = $1) r
         ON r.k IN ((e.n * 7) % 300, (e.n * 7 + 1) % 300, (e.n * 7 + 2) % 300)`, [S.businessId, S.owner.id]);
    await admin.query('ANALYZE scheduling_events; ANALYZE scheduling_event_resources; ANALYZE scheduling_resources');
    const ids = (await o.resources({ limit: '50' })).body.resources.map((r: { id: string }) => r.id);
    const started = Date.now();
    for (let i = 0; i < 10; i++) {
      const res = await o.availability({ start: '2030-03-01T00:00:00Z', end: '2030-03-02T00:00:00Z', resourceIds: ids.join(',') });
      expect(res.status).toBe(200);
    }
    const perQuery = (Date.now() - started) / 10;
    const booking = Date.now();
    const b = await o.create({ calendarId: cal, title: 'New', start: at('2030-03-01T00:10:00Z'), end: at('2030-03-01T00:20:00Z'), resourceIds: ids.slice(0, 20), enforceConflicts: false });
    expect(b.status).toBe(201);
    const bookingMs = Date.now() - booking;
    // Generous ceilings (CI machines vary); the plan check below is the structural guarantee.
    expect(perQuery).toBeLessThan(1000);
    expect(bookingMs).toBeLessThan(2000);
    // The resource check never scans a whole table: both join sides are reached through indexes.
    const plan = (await admin.query(
      `EXPLAIN (FORMAT JSON) SELECT a.resource_id FROM scheduling_event_resources a
       JOIN scheduling_events e ON e.business_id = a.business_id AND e.id = a.event_id
       WHERE a.business_id = $1 AND a.removed_at IS NULL AND a.resource_id = ANY($2::uuid[])
         AND e.status = 'SCHEDULED' AND e.archived_at IS NULL AND e.blocks_availability
         AND e.start_at < '2030-03-02T00:00:00Z' AND e.start_at > '2030-01-29T00:00:00Z' AND e.end_at > '2030-03-01T00:00:00Z'`,
      [S.businessId, ids])).rows[0]['QUERY PLAN'];
    type Node = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: Node[] };
    const nodes: Node[] = [];
    const walk = (n: Node) => {
      nodes.push(n);
      for (const c of n.Plans ?? []) walk(c);
    };
    walk(plan[0].Plan);
    const scans = nodes.filter((n) => n['Relation Name']).map((n) => `${n['Node Type']}:${n['Relation Name']}:${n['Index Name'] ?? ''}`);
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.filter((x) => x.startsWith('Seq Scan')), scans.join(' | ')).toEqual([]);
    console.log(`[perf] plan: ${scans.join(' | ')}`);
    console.log(`[perf] availability for 50 resources: ${perQuery.toFixed(0)} ms/query; booking with 20 resources: ${bookingMs} ms`);
  }, 120_000);
});
