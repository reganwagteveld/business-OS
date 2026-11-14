/**
 * Scheduling S0 spike (docs/scheduling-data-model.md, ADR 0006). Proves, against real PostgreSQL behind
 * the transaction-mode pooler in CI, that the Scheduling design holds before any S1 code exists:
 *
 *   C*  conflict prevention: btree_gist exclusion constraint + generated columns copied by composite
 *       FKs ON UPDATE CASCADE (variant A), under forced RLS as bos_app, including under concurrency;
 *   P*  busy-only privacy enforced by a restrictive RLS policy;
 *   E*  no privilege escalation into private details (visibility, organizer, participants, relinking);
 *   W*  the scoped tenant client cannot write generated or copied columns;
 *   R*  privileged erasure, member removal and capacity (RESERVATION) preparation.
 *
 * Fixture: tests/isolation/fixtures/scheduling-spike-schema.sql (own schemas, never the Phase 1b fixture's).
 * Connections: SPIKE_ADMIN_URL (administrative, direct) and SPIKE_APP_URL (bos_app, through the pooler).
 * Models carry @@schema and raw SQL is schema-qualified, so no search_path setting is needed.
 */
import { randomUUID as uuid } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma-scheduling/client';
import { createWithTenant, TenantScopeError } from '@/core/db/with-tenant';

const adminUrl = process.env.SPIKE_ADMIN_URL;
const appUrl = process.env.SPIKE_APP_URL;
if (!adminUrl || !appUrl) throw new Error('Scheduling spike needs SPIKE_ADMIN_URL and SPIKE_APP_URL (see db-context.test.ts).');

const admin = new pg.Client({ connectionString: adminUrl });
const app = new PrismaClient({ adapter: new PrismaPg({ connectionString: appUrl, max: 60, idleTimeoutMillis: 120_000 }) });
const MODELS = { scheduleResource: 'businessId', scheduleEvent: 'businessId', scheduleEventDetails: 'businessId', scheduleEventResource: 'businessId' } as const;
const runner = createWithTenant({ clients: { app }, models: MODELS });
type Db = Parameters<Parameters<typeof runner>[1]>[0];

/** One tenant unit of work as `userId`, like the API's withTenant. */
const as = <T>(businessId: string, userId: string | null, work: (db: Db) => Promise<T>) =>
  runner({ businessId, userId }, work);

/** SQLSTATE of a failure, unwrapped from Prisma's driver-adapter error; 'ok' when it succeeded. */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof TenantScopeError) return 'tenant_scope';
    const err = e as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } }; cause?: { originalCode?: string } };
    return err.meta?.driverAdapterError?.cause?.originalCode ?? err.cause?.originalCode ?? err.meta?.code ?? err.code ?? 'error';
  }
}

// --- Seed -------------------------------------------------------------------------------------
const A = uuid(), B = uuid();
const alice = uuid(), bob = uuid(), carol = uuid(), erin = uuid(), dave = uuid();
const rBob = uuid(), rCarol = uuid(), rErin = uuid(), rRoom = uuid(), rVan = uuid(), rTables = uuid(), rDave = uuid();
const customerA = uuid(), contactA = uuid(), projectA = uuid(), taskA = uuid(), customerB = uuid();

async function seed() {
  await admin.query(readFileSync(resolve(__dirname, 'fixtures/scheduling-spike-schema.sql'), 'utf8'));
  const q = (sql: string, params: unknown[]) => admin.query(sql, params);
  await q(`INSERT INTO scheduling_spike.businesses (id, slug) VALUES ($1, 'sched-a'), ($2, 'sched-b')`, [A, B]);
  for (const [b, u] of [[A, alice], [A, bob], [A, carol], [A, erin], [B, dave]] as const) {
    await q(`INSERT INTO scheduling_spike.memberships (id, business_id, user_id) VALUES ($1, $2, $3)`, [uuid(), b, u]);
  }
  for (const [id, b, kind, user, name] of [
    [rBob, A, 'MEMBER', bob, 'Bob'], [rCarol, A, 'MEMBER', carol, 'Carol'], [rErin, A, 'MEMBER', erin, 'Erin'],
    [rRoom, A, 'PLACE', null, 'Room 1'], [rVan, A, 'EQUIPMENT', null, 'Van'], [rTables, A, 'PLACE', null, 'Patio tables'], [rDave, B, 'MEMBER', dave, 'Dave'],
  ] as const) {
    await q(`INSERT INTO scheduling_spike.schedule_resources (id, business_id, kind, user_id, name) VALUES ($1, $2, $3, $4, $5)`, [id, b, kind, user, name]);
  }
  await q(`INSERT INTO scheduling_spike.customers (id, business_id, display_name) VALUES ($1, $2, 'A customer'), ($3, $4, 'B customer')`, [customerA, A, customerB, B]);
  await q(`INSERT INTO scheduling_spike.contacts (id, business_id, customer_id, display_name) VALUES ($1, $2, $3, 'A contact')`, [contactA, A, customerA]);
  await q(`INSERT INTO scheduling_spike.projects (id, business_id, name) VALUES ($1, $2, 'P')`, [projectA, A]);
  await q(`INSERT INTO scheduling_spike.project_tasks (id, business_id, project_id, title) VALUES ($1, $2, $3, 'T')`, [taskA, A, projectA]);
}

// --- Service-style writes (what the S1 service will do) ---------------------------------------
let day = 0;
/** A fresh UTC day per scenario, so scenarios never collide. */
const nextDay = () => new Date(Date.UTC(2030, 0, 1 + day++));
const at = (d: Date, h: number, m = 0) => new Date(d.getTime() + (h * 60 + m) * 60_000);

interface NewEvent { start: Date; end: Date; resources?: string[]; visibility?: 'STANDARD' | 'PRIVATE'; status?: 'CONFIRMED' | 'CANCELLED'; title?: string; contactId?: string; customerId?: string; role?: 'REQUIRED' | 'OPTIONAL'; blocks?: boolean; organizer?: string | null }
async function createEvent(db: Db, businessId: string, me: string | null, e: NewEvent) {
  const id = uuid();
  await db.scheduleEvent.create({
    data: {
      id, businessId, kind: 'APPOINTMENT', startsAt: e.start, endsAt: e.end, timeZone: 'America/New_York',
      visibility: e.visibility ?? 'STANDARD', status: e.status ?? 'CONFIRMED', blocksTime: e.blocks ?? true,
      organizerUserId: e.organizer === undefined ? me : e.organizer,
    },
  });
  await db.scheduleEventDetails.create({ data: { businessId, eventId: id, title: e.title ?? 'Visit', customerId: e.customerId ?? null, contactId: e.contactId ?? null } });
  for (const r of e.resources ?? []) await assign(db, businessId, id, r, e.role);
  return id;
}
/** Assignments are inserted by raw SQL that copies the range, occupancy and exclusivity from their sources. */
const assign = (db: Db, businessId: string, eventId: string, resourceId: string, role: 'REQUIRED' | 'OPTIONAL' = 'REQUIRED') => db.$queryRaw`
  INSERT INTO scheduling_spike.schedule_event_resources (id, business_id, event_id, resource_id, role, during, occupying, exclusive)
  SELECT ${uuid()}::uuid, e.business_id, e.id, s.id, ${role}::scheduling_spike."ScheduleAssignmentRole", e.during, e.occupying, s.exclusive
  FROM scheduling_spike.schedule_events e JOIN scheduling_spike.schedule_resources s ON s.business_id = e.business_id AND s.id = ${resourceId}::uuid
  WHERE e.business_id = ${businessId}::uuid AND e.id = ${eventId}::uuid
  RETURNING id`.then((rows) => {
  if ((rows as unknown[]).length !== 1) throw Object.assign(new Error('not found'), { code: 'not_found' });
});
const book = (e: NewEvent, me = alice, businessId = A) => as(businessId, me, (db) => createEvent(db, businessId, me, e));
const setTime = (id: string, start: Date, end: Date, me = alice) => as(A, me, (db) => db.scheduleEvent.updateMany({ where: { id }, data: { startsAt: start, endsAt: end, version: { increment: 1 } } }));
const setStatus = (id: string, status: 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW', me = alice) =>
  as(A, me, (db) => db.scheduleEvent.updateMany({ where: { id }, data: { status, version: { increment: 1 } } }));
const copyOf = async (eventId: string) =>
  (await admin.query(`SELECT lower(during) AS start, occupying, exclusive FROM scheduling_spike.schedule_event_resources WHERE event_id = $1 AND removed_at IS NULL`, [eventId])).rows as { start: Date; occupying: boolean; exclusive: boolean }[];
const titleSeenBy = (eventId: string, me: string | null) => as(A, me, (db) => db.scheduleEventDetails.findFirst({ where: { eventId } })).then((r) => r?.title ?? null);

beforeAll(async () => {
  await admin.connect();
  await seed();
  // Open the pool before the concurrency tests. Over a remote, TLS pooler (Neon) a cold connection can
  // take longer than Prisma's 2 s interactive-transaction maxWait, which would fail a test with P2028
  // for a reason unrelated to what it checks. Locally and in CI this is instant.
  await Promise.all(Array.from({ length: 60 }, () => app.$queryRaw`SELECT 1`));
}, 120_000);
afterAll(async () => {
  await app.$disconnect();
  await admin.end();
});

describe('C: conflict prevention (variant A, forced RLS, bos_app)', () => {
  it('C1: btree_gist is installed by the privileged pre-step and the exclusion constraint exists', async () => {
    const { rows } = await admin.query(`SELECT extversion FROM pg_extension WHERE extname = 'btree_gist'`);
    expect(rows).toHaveLength(1);
    const c = await admin.query(`SELECT contype FROM pg_constraint WHERE conname = 'schedule_no_double_booking'`);
    expect(c.rows[0]?.contype).toBe('x');
    const rls = await admin.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'scheduling_spike' AND c.relname LIKE 'schedule_%' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity`);
    expect(rls.rows[0].n).toBe(4);
  });

  it('C2: overlap refused, back-to-back allowed, other resources and other businesses unaffected', async () => {
    const d = nextDay();
    await book({ start: at(d, 9), end: at(d, 10), resources: [rBob] });
    expect(await outcome(book({ start: at(d, 10), end: at(d, 11), resources: [rBob] }))).toBe('ok');
    expect(await outcome(book({ start: at(d, 9, 30), end: at(d, 10, 30), resources: [rBob] }))).toBe('23P01');
    expect(await outcome(book({ start: at(d, 9), end: at(d, 10), resources: [rRoom] }))).toBe('ok');
    expect(await outcome(book({ start: at(d, 9), end: at(d, 10), resources: [rDave] }, dave, B))).toBe('ok');
  });

  it('C3: cross-tenant references fail even if the app layer were bypassed', async () => {
    const d = nextDay();
    expect(await outcome(book({ start: at(d, 9), end: at(d, 10), resources: [rDave] }))).toBe('not_found');
    expect(await outcome(book({ start: at(d, 9), end: at(d, 10), customerId: customerB }))).toBe('23503');
    expect(await outcome(as(A, alice, (db) => db.scheduleEvent.create({ data: { id: uuid(), businessId: B, kind: 'JOB', startsAt: d, endsAt: at(d, 1), timeZone: 'UTC' } })))).toBe('tenant_scope');
  });

  it('C4: optional attendees and non-blocking entries may overlap', async () => {
    const d = nextDay();
    await book({ start: at(d, 9), end: at(d, 10), resources: [rBob] });
    expect(await outcome(book({ start: at(d, 9), end: at(d, 10), resources: [rBob], role: 'OPTIONAL' }))).toBe('ok');
    expect(await outcome(book({ start: at(d, 8), end: at(d, 17), resources: [rBob], blocks: false }))).toBe('ok');
  });

  it('C5: reschedule, cancel and reopen keep the copies in step and are re-checked', async () => {
    const d = nextDay();
    await book({ start: at(d, 9), end: at(d, 10), resources: [rVan] });
    const e2 = await book({ start: at(d, 12), end: at(d, 13), resources: [rVan] });
    expect(await outcome(setTime(e2, at(d, 9, 30), at(d, 10, 30)))).toBe('23P01');
    expect((await copyOf(e2))[0]!.start.getTime()).toBe(at(d, 12).getTime());
    expect(await outcome(setTime(e2, at(d, 14), at(d, 15)))).toBe('ok');
    expect((await copyOf(e2))[0]!.start.getTime()).toBe(at(d, 14).getTime());
    expect(await outcome(setStatus(e2, 'CANCELLED'))).toBe('ok');
    expect((await copyOf(e2))[0]!.occupying).toBe(false);
    await book({ start: at(d, 14, 30), end: at(d, 15, 30), resources: [rVan] });
    expect(await outcome(setStatus(e2, 'CONFIRMED'))).toBe('23P01');
    const done = await book({ start: at(d, 18), end: at(d, 19), resources: [rVan] });
    expect(await outcome(setStatus(done, 'COMPLETED'))).toBe('ok');
    expect(await outcome(book({ start: at(d, 18), end: at(d, 19), resources: [rVan] }))).toBe('23P01');
  });

  it('C6: 50 concurrent bookings of one slot: exactly one wins', async () => {
    const d = nextDay();
    const results = await Promise.all(Array.from({ length: 50 }, () => outcome(book({ start: at(d, 9), end: at(d, 10), resources: [rRoom] }))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === '23P01')).toHaveLength(49);
  });

  it('C7: 20 concurrent reschedules and 20 concurrent reopens into one slot: exactly one wins each', async () => {
    const d = nextDay();
    const movers: string[] = [];
    for (let i = 0; i < 20; i++) movers.push(await book({ start: at(d, i), end: at(d, i, 30), resources: [rVan] }));
    const target = nextDay();
    const moved = await Promise.all(movers.map((id) => outcome(setTime(id, at(target, 9), at(target, 10)))));
    expect(moved.filter((r) => r === 'ok')).toHaveLength(1);
    expect(moved.filter((r) => r === '23P01')).toHaveLength(19);
    const d2 = nextDay();
    const cancelled: string[] = [];
    for (let i = 0; i < 20; i++) cancelled.push(await book({ start: at(d2, 9), end: at(d2, 10), resources: [rVan], status: 'CANCELLED' }));
    const reopened = await Promise.all(cancelled.map((id) => outcome(setStatus(id, 'CONFIRMED'))));
    expect(reopened.filter((r) => r === 'ok')).toHaveLength(1);
    expect(reopened.filter((r) => r === '23P01')).toHaveLength(19);
  }, 180_000); // 40 sequential setup bookings: slow over a remote pooler, instant locally
});

describe('C (history): soft-removed assignments', () => {
  it('C8: a soft-removed assignment stays as history and frees the slot', async () => {
    const d = nextDay();
    const ev = await book({ start: at(d, 9), end: at(d, 10), resources: [rCarol] });
    expect(await outcome(book({ start: at(d, 9), end: at(d, 10), resources: [rCarol] }))).toBe('23P01');
    await as(A, alice, (db) => db.scheduleEventResource.updateMany({ where: { eventId: ev, resourceId: rCarol }, data: { removedAt: new Date(), removedById: alice, removalReason: 'EDITED' } }));
    expect(await outcome(book({ start: at(d, 9), end: at(d, 10), resources: [rCarol] }))).toBe('ok');
    expect(await outcome(as(A, alice, (db) => assign(db, A, ev, rCarol)))).toBe('23P01');
    expect((await admin.query(`SELECT count(*)::int AS n FROM scheduling_spike.schedule_event_resources WHERE event_id = $1`, [ev])).rows[0].n).toBe(1);
  });
});

describe('P: busy-only privacy (restrictive RLS)', () => {
  it('P1: organizer and participants see details; everyone else sees only the busy block; other tenants see nothing', async () => {
    const d = nextDay();
    const ev = await book({ start: at(d, 9), end: at(d, 12), resources: [rBob], visibility: 'PRIVATE', title: 'Medical appointment' });
    expect(await titleSeenBy(ev, alice)).toBe('Medical appointment');
    expect(await titleSeenBy(ev, bob)).toBe('Medical appointment');
    expect(await titleSeenBy(ev, carol)).toBeNull();
    expect(await as(A, carol, (db) => db.scheduleEvent.count({ where: { id: ev } }))).toBe(1);
    expect(await titleSeenBy(ev, null)).toBeNull();
    expect(await as(B, dave, (db) => db.scheduleEvent.count({ where: { id: ev } }))).toBe(0);
    expect(await as(A, carol, (db) => db.scheduleEventDetails.updateMany({ where: { eventId: ev }, data: { title: 'x' } }))).toEqual({ count: 0 });
  });
});

describe('E: no escalation into private details', () => {
  async function privateEntry() {
    const d = nextDay();
    const id = await book({ start: at(d, 9), end: at(d, 12), resources: [rBob], visibility: 'PRIVATE', title: 'Secret' });
    return { id, d };
  }

  it('E1: a manager who cannot see the details cannot make the entry STANDARD', async () => {
    const { id } = await privateEntry();
    expect(await outcome(as(A, carol, (db) => db.scheduleEvent.updateMany({ where: { id }, data: { visibility: 'STANDARD' } })))).toBe('42501');
    expect(await titleSeenBy(id, carol)).toBeNull();
    // The organizer may.
    expect(await outcome(as(A, alice, (db) => db.scheduleEvent.updateMany({ where: { id }, data: { visibility: 'STANDARD' } })))).toBe('ok');
    expect(await titleSeenBy(id, carol)).toBe('Secret');
  });

  it('E2: a manager cannot transfer the organizer role to themselves or to anyone else', async () => {
    const { id } = await privateEntry();
    expect(await outcome(as(A, carol, (db) => db.scheduleEvent.updateMany({ where: { id }, data: { organizerUserId: carol } })))).toBe('42501');
    expect(await outcome(as(A, carol, (db) => db.scheduleEvent.updateMany({ where: { id }, data: { organizerUserId: erin } })))).toBe('42501');
    expect(await titleSeenBy(id, carol)).toBeNull();
    // The organizer may hand it on; the new organizer then sees it.
    expect(await outcome(as(A, alice, (db) => db.scheduleEvent.updateMany({ where: { id }, data: { organizerUserId: erin } })))).toBe('ok');
    expect(await titleSeenBy(id, erin)).toBe('Secret');
  });

  it('E3: nobody can create an entry naming someone else as organizer', async () => {
    const d = nextDay();
    expect(await outcome(book({ start: at(d, 9), end: at(d, 10), visibility: 'PRIVATE', organizer: alice }, carol))).toBe('42501');
    // The time row alone is refused too (not only the details row), so nobody can be made organizer of an entry they did not create.
    expect(await outcome(as(A, carol, (db) => db.scheduleEvent.create({ data: { id: uuid(), businessId: A, kind: 'INTERNAL', startsAt: at(d, 11), endsAt: at(d, 12), timeZone: 'UTC', organizerUserId: alice } })))).toBe('42501');
  });

  it('E4: a manager cannot add a member (themselves or another) to a private entry; places and equipment are fine', async () => {
    const { id } = await privateEntry();
    expect(await outcome(as(A, carol, (db) => assign(db, A, id, rCarol)))).toBe('42501');
    expect(await outcome(as(A, carol, (db) => assign(db, A, id, rErin, 'OPTIONAL')))).toBe('42501');
    expect(await outcome(as(A, carol, (db) => assign(db, A, id, rRoom)))).toBe('ok');
    expect(await titleSeenBy(id, carol)).toBeNull();
  });

  it('E5: a member resource can never be re-pointed at another person', async () => {
    expect(await outcome(as(A, carol, (db) => db.scheduleResource.updateMany({ where: { id: rBob }, data: { userId: carol } })))).toBe('42501');
  });

  it('E6: removing a participant is one-way and narrows access; a removed assignment cannot be revived', async () => {
    const { id } = await privateEntry();
    expect(await outcome(as(A, carol, (db) => db.scheduleEventResource.updateMany({ where: { eventId: id, resourceId: rBob }, data: { removedAt: new Date(), removedById: carol, removalReason: 'EDITED' } })))).toBe('ok');
    expect(await titleSeenBy(id, bob)).toBeNull();
    expect(await outcome(as(A, carol, (db) => db.scheduleEventResource.updateMany({ where: { eventId: id, resourceId: rBob }, data: { removedAt: null, removedById: null, removalReason: null } })))).toBe('42501');
  });

  it('E7: a manager can still reschedule and cancel a private entry without seeing it', async () => {
    const { id, d } = await privateEntry();
    expect(await outcome(setTime(id, at(d, 13), at(d, 14), carol))).toBe('ok');
    expect(await outcome(setStatus(id, 'CANCELLED', carol))).toBe('ok');
    expect(await titleSeenBy(id, carol)).toBeNull();
  });
});

describe('W: the scoped tenant client cannot write generated or copied columns', () => {
  it('W1: generated columns are refused by the database (428C9)', async () => {
    const d = nextDay();
    const id = await book({ start: at(d, 9), end: at(d, 10) });
    expect(await outcome(as(A, alice, (db) => db.scheduleEvent.updateMany({ where: { id }, data: { occupying: false } })))).toBe('428C9');
  });

  it('W2: assignment copies, role and links cannot be updated; nothing can be deleted', async () => {
    const d = nextDay();
    const id = await book({ start: at(d, 9), end: at(d, 10), resources: [rRoom] });
    for (const data of [{ occupying: false }, { exclusive: false }, { resourceId: rVan }, { role: 'OPTIONAL' as const }]) {
      expect(await outcome(as(A, alice, (db) => db.scheduleEventResource.updateMany({ where: { eventId: id }, data })))).toBe('42501');
    }
    expect(await outcome(as(A, alice, (db) => db.scheduleEventResource.deleteMany({ where: { eventId: id } })))).toBe('42501');
    expect(await outcome(as(A, alice, (db) => db.scheduleEvent.deleteMany({ where: { id } })))).toBe('42501');
  });

  it('W3: a forged copy on insert fails its foreign key; a model create cannot supply the range at all', async () => {
    const d = nextDay();
    const id = await book({ start: at(d, 9), end: at(d, 10) });
    const forged = as(A, alice, (db) => db.$queryRaw`INSERT INTO scheduling_spike.schedule_event_resources (id, business_id, event_id, resource_id, during, occupying, exclusive)
      VALUES (${uuid()}::uuid, ${A}::uuid, ${id}::uuid, ${rRoom}::uuid, tstzrange('2001-01-01', '2001-01-02'), false, true)`);
    expect(await outcome(forged)).toBe('23503');
    // Type level (checked by `pnpm typecheck`): Prisma 7.10.1 generates no `create` for a model with a
    // required Unsupported column, so service code cannot insert an assignment except through raw SQL.
    // Runtime: the delegate still exists on the proxy, and calling it fails before any row is written.
    const viaModel = as(A, alice, (db) =>
      // @ts-expect-error no create on ScheduleEventResource (finding F4)
      db.scheduleEventResource.create({ data: { id: uuid(), businessId: A, eventId: id, resourceId: rRoom, occupying: true, exclusive: true } }));
    expect(await outcome(viaModel)).not.toBe('ok');
    expect((await admin.query(`SELECT count(*)::int AS n FROM scheduling_spike.schedule_event_resources WHERE event_id = $1`, [id])).rows[0].n).toBe(0);
    // The range on the event is not writable through the client types either.
    // @ts-expect-error `during` is Unsupported, so it is not part of any input type
    const typeOnly: Parameters<Db['scheduleEvent']['updateMany']>[0]['data'] = { during: '[2001-01-01,2001-01-02)' };
    void typeOnly;
  });

  it('W4: Prisma reads: generated occupancy comes back, the range is not exposed, assignments are read with a second query', async () => {
    const d = nextDay();
    const id = await book({ start: at(d, 9), end: at(d, 10), resources: [rRoom] });
    const ev = await as(A, alice, (db) => db.scheduleEvent.findFirst({ where: { id }, include: { details: true } }));
    expect(ev?.occupying).toBe(true);
    expect(ev && 'during' in ev).toBe(false);
    expect(ev?.details?.title).toBe('Visit');
    const assignments = await as(A, alice, (db) => db.scheduleEventResource.findMany({ where: { eventId: id }, select: { resourceId: true, occupying: true } }));
    expect(assignments).toEqual([{ resourceId: rRoom, occupying: true }]);
  });
});

describe('R: erasure, member removal and capacity preparation', () => {
  it('R1: privileged erasure scrubs private details its caller cannot see, in the current business only, returning a count', async () => {
    const d = nextDay();
    const ev = await book({ start: at(d, 9), end: at(d, 10), resources: [rBob], visibility: 'PRIVATE', title: 'Therapy with A contact', contactId: contactA, customerId: customerA });
    const scrub = (b: string, me: string | null) => as(b, me, (db) => db.$queryRaw<{ n: number }[]>`SELECT scheduling_spike_private.scrub_event_details('contact', ${contactA}::uuid) AS n`);
    expect(await outcome(scrub(A, null))).toBe('42501');
    expect((await scrub(B, dave))[0]!.n).toBe(0);
    expect((await scrub(A, carol))[0]!.n).toBeGreaterThanOrEqual(1);
    const row = (await admin.query(`SELECT title, contact_id FROM scheduling_spike.schedule_event_details WHERE event_id = $1`, [ev])).rows[0];
    expect(row).toEqual({ title: 'Appointment', contact_id: null });
    expect(await titleSeenBy(ev, carol)).toBeNull();
  });

  it('R2: member removal: future assignments soft-removed, organizer cleared, resource archived, then the membership can go', async () => {
    const d = nextDay();
    const past = new Date(Date.UTC(2020, 0, 1, 9));
    await book({ start: past, end: at(past, 1), resources: [rErin] });
    const future = await book({ start: at(d, 9), end: at(d, 10), resources: [rErin] }, erin);
    expect(await outcome(admin.query(`DELETE FROM scheduling_spike.memberships WHERE business_id = $1 AND user_id = $2`, [A, erin]))).toBe('23503');
    await as(A, carol, async (db) => {
      await db.scheduleEventResource.updateMany({ where: { resourceId: rErin, removedAt: null, eventId: { in: [future] } }, data: { removedAt: new Date(), removedById: carol, removalReason: 'MEMBER_REMOVED' } });
      await db.scheduleEvent.updateMany({ where: { organizerUserId: erin }, data: { organizerUserId: null, version: { increment: 1 } } });
      await db.scheduleResource.updateMany({ where: { id: rErin }, data: { archivedAt: new Date(), userId: null, version: { increment: 1 } } });
    });
    expect(await outcome(admin.query(`DELETE FROM scheduling_spike.memberships WHERE business_id = $1 AND user_id = $2`, [A, erin]))).toBe('ok');
    const history = (await admin.query(`SELECT count(*)::int AS n FROM scheduling_spike.schedule_event_resources WHERE resource_id = $1`, [rErin])).rows[0].n;
    expect(history).toBe(2);
  });

  it('R3: a non-exclusive (capacity) resource allows overlaps; making it exclusive again is refused while overlaps exist', async () => {
    const d = nextDay();
    await as(A, carol, (db) => db.scheduleResource.updateMany({ where: { id: rTables }, data: { exclusive: false } }));
    expect(await outcome(book({ start: at(d, 19), end: at(d, 21), resources: [rTables] }))).toBe('ok');
    expect(await outcome(book({ start: at(d, 19, 30), end: at(d, 21), resources: [rTables] }))).toBe('ok');
    expect(await outcome(as(A, carol, (db) => db.scheduleResource.updateMany({ where: { id: rTables }, data: { exclusive: true } })))).toBe('23P01');
  });
});
