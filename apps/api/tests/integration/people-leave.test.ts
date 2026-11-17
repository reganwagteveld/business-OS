/**
 * People P3-A: leave configuration (docs/people-leave-p3.md), through the real route handlers against
 * PostgreSQL with the migrations applied as in production. Two independent businesses and every
 * membership role. Covers: permissions by key; leave types and policies (validation, international
 * rule combinations, lifecycle, optimistic versions, names, revisions); policy assignments (effective
 * dates in the business's time zone, replacement, all-or-nothing batches, terminated employees);
 * the database guards on their own; tenant isolation (API and raw SQL under RLS); deterministic races
 * staged with pg_blocking_pids; and audit content.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LEAVE_TYPE_STARTERS } from '@business-os/contracts';
import type { Permission, Role } from '@/modules/access';

const custom: Partial<Record<Role, Permission[]>> = {};
vi.mock('@/modules/access', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/access')>();
  return { ...real, permissionsFor: (role: Role) => custom[role] ?? real.permissionsFor(role) };
});

import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as employeesRoute from '@/app/api/v1/b/[slug]/people/employees/route';
import * as statusRoute from '@/app/api/v1/b/[slug]/people/employees/[employeeId]/status/route';
import * as employeeLeaveRoute from '@/app/api/v1/b/[slug]/people/employees/[employeeId]/leave-policies/route';
import * as endLeaveRoute from '@/app/api/v1/b/[slug]/people/employees/[employeeId]/leave-policies/end/route';
import * as typesRoute from '@/app/api/v1/b/[slug]/people/leave-types/route';
import * as typeRoute from '@/app/api/v1/b/[slug]/people/leave-types/[leaveTypeId]/route';
import * as archiveTypeRoute from '@/app/api/v1/b/[slug]/people/leave-types/[leaveTypeId]/archive/route';
import * as restoreTypeRoute from '@/app/api/v1/b/[slug]/people/leave-types/[leaveTypeId]/restore/route';
import * as policiesRoute from '@/app/api/v1/b/[slug]/people/leave-policies/route';
import * as policyRoute from '@/app/api/v1/b/[slug]/people/leave-policies/[policyId]/route';
import * as archivePolicyRoute from '@/app/api/v1/b/[slug]/people/leave-policies/[policyId]/archive/route';
import * as restorePolicyRoute from '@/app/api/v1/b/[slug]/people/leave-policies/[policyId]/restore/route';
import * as revisionsRoute from '@/app/api/v1/b/[slug]/people/leave-policies/[policyId]/revisions/route';
import * as assignmentsRoute from '@/app/api/v1/b/[slug]/people/leave-policies/[policyId]/assignments/route';
import { devOutbox } from '@/core/email';
import { backendPid, waitUntilBlocked } from './support/locks';
import { inviteForSignup, admitFixture } from './support/admission';
import { withoutUuids } from './support/uuid';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });

beforeAll(async () => {
  await admin.connect();
});
afterAll(async () => {
  await admin.end();
});
afterEach(() => {
  for (const key of Object.keys(custom)) delete custom[key as Role];
});

// A separate address range from the other suites, so rate-limit counters do not collide.
const IP_BLOCK = Number(process.env.LEAVE_TEST_IP_BLOCK ?? 150);
let ip = 1;
type User = { email: string; cookie: string; id: string };

function req(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.${IP_BLOCK}.${Math.floor(ip / 250)}.${ip++ % 250}` });
  if (opts.origin !== null) headers.set('origin', opts.origin ?? ORIGIN);
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
  await authRoute.GET(req('GET', `${link.pathname}${link.search}`, { origin: null }));
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

/** A business with an OWNER and one member of each other role. */
async function team(label: string, timeZone = 'Australia/Perth') {
  const owner = await newUser(`${label}-owner`);
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const created = await businessesRoute.POST(req('POST', '/api/v1/businesses', {
    cookie: owner.cookie, body: { name: `Business ${label}`, slug, countryCode: 'US', timeZone, locale: 'en-US', currency: 'USD' },
  }));
  expect(created.status).toBe(201);
  const people: Record<string, User> = { OWNER: owner };
  for (const role of ['ADMIN', 'MANAGER', 'MEMBER']) {
    const user = await newUser(`${label}-${role.toLowerCase()}`);
    await invite(slug, owner, user, role);
    people[role] = user;
  }
  const { rows } = await admin.query('SELECT id FROM businesses WHERE slug = $1', [slug]);
  return { slug, people, businessId: rows[0].id as string, timeZone };
}

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const api = (who: User, slug: string) => {
  const base = `/api/v1/b/${slug}/people`;
  const c = who.cookie;
  const t = (leaveTypeId: string) => ctx({ slug, leaveTypeId });
  const p = (policyId: string) => ctx({ slug, policyId });
  const e = (employeeId: string) => ctx({ slug, employeeId });
  return {
    createEmployee: (body: unknown) => employeesRoute.POST(req('POST', `${base}/employees`, { cookie: c, body }), ctx({ slug })).then(json),
    status: (id: string, body: unknown) => statusRoute.POST(req('POST', `${base}/employees/${id}/status`, { cookie: c, body }), e(id)).then(json),
    types: (qs = '') => typesRoute.GET(req('GET', `${base}/leave-types${qs}`, { cookie: c }), ctx({ slug })).then(json),
    createType: (body: unknown) => typesRoute.POST(req('POST', `${base}/leave-types`, { cookie: c, body }), ctx({ slug })).then(json),
    getType: (id: string) => typeRoute.GET(req('GET', `${base}/leave-types/${id}`, { cookie: c }), t(id)).then(json),
    patchType: (id: string, body: unknown) => typeRoute.PATCH(req('PATCH', `${base}/leave-types/${id}`, { cookie: c, body }), t(id)).then(json),
    archiveType: (id: string, version: number) =>
      archiveTypeRoute.POST(req('POST', `${base}/leave-types/${id}/archive`, { cookie: c, body: { version } }), t(id)).then(json),
    restoreType: (id: string, version: number) =>
      restoreTypeRoute.POST(req('POST', `${base}/leave-types/${id}/restore`, { cookie: c, body: { version } }), t(id)).then(json),
    policies: (qs = '') => policiesRoute.GET(req('GET', `${base}/leave-policies${qs}`, { cookie: c }), ctx({ slug })).then(json),
    createPolicy: (body: unknown) => policiesRoute.POST(req('POST', `${base}/leave-policies`, { cookie: c, body }), ctx({ slug })).then(json),
    getPolicy: (id: string) => policyRoute.GET(req('GET', `${base}/leave-policies/${id}`, { cookie: c }), p(id)).then(json),
    patchPolicy: (id: string, body: unknown) => policyRoute.PATCH(req('PATCH', `${base}/leave-policies/${id}`, { cookie: c, body }), p(id)).then(json),
    archivePolicy: (id: string, version: number) =>
      archivePolicyRoute.POST(req('POST', `${base}/leave-policies/${id}/archive`, { cookie: c, body: { version } }), p(id)).then(json),
    restorePolicy: (id: string, version: number) =>
      restorePolicyRoute.POST(req('POST', `${base}/leave-policies/${id}/restore`, { cookie: c, body: { version } }), p(id)).then(json),
    revisions: (id: string) => revisionsRoute.GET(req('GET', `${base}/leave-policies/${id}/revisions`, { cookie: c }), p(id)).then(json),
    assignments: (id: string, qs = '') => assignmentsRoute.GET(req('GET', `${base}/leave-policies/${id}/assignments${qs}`, { cookie: c }), p(id)).then(json),
    assign: (id: string, body: unknown) => assignmentsRoute.POST(req('POST', `${base}/leave-policies/${id}/assignments`, { cookie: c, body }), p(id)).then(json),
    employeeLeave: (id: string) => employeeLeaveRoute.GET(req('GET', `${base}/employees/${id}/leave-policies`, { cookie: c }), e(id)).then(json),
    end: (id: string, body: unknown) => endLeaveRoute.POST(req('POST', `${base}/employees/${id}/leave-policies/end`, { cookie: c, body }), e(id)).then(json),
  };
};
type Api = ReturnType<typeof api>;

const audits = async (targetId: string) =>
  (await admin.query('SELECT action, actor_user_id, business_id, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows;

const todayIn = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const shift = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Runs SQL as bos_app inside a transaction with the tenant context set, and rolls back. */
async function asApp<T>(businessId: string | null, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    if (businessId) await c.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
    return await work(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}
const sqlError = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
};

const ANNUAL_GRANT = { unit: 'DAYS', granularity: 'HALF_DAY', entitlementMethod: 'GRANT', entitlementAmount: '20', yearStart: 'CALENDAR' } as const;

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let own: Api;
let n = 0;
const uniq = (label: string) => `${label} ${++n}`;
async function leaveType(extra: Record<string, unknown> = {}) {
  const res = await own.createType({ name: uniq('Type'), category: 'ANNUAL', paid: true, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.leaveType as { id: string; version: number; category: string; sensitive: boolean };
}
async function policy(extra: Record<string, unknown> = {}, typeId?: string) {
  const res = await own.createPolicy({ leaveTypeId: typeId ?? (await leaveType()).id, name: uniq('Policy'), ...ANNUAL_GRANT, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.policy as { id: string; version: number; leaveType: { id: string } };
}
async function employee(extra: Record<string, unknown> = {}, who: Api = own) {
  const res = await who.createEmployee({ givenName: 'Leave', familyName: uniq('Tester'), status: 'ACTIVE', ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.employee as { id: string; version: number };
}

beforeAll(async () => {
  A = await team('la');
  B = await team('lb', 'America/New_York');
  own = api(A.people.OWNER!, A.slug);
}, 120_000);

describe('permissions (people:read to view, people:configure for types and policies, people:manage to assign)', () => {
  it('OWNER and ADMIN configure; MANAGER only reads; MEMBER has no access', async () => {
    const admin_ = api(A.people.ADMIN!, A.slug);
    const manager = api(A.people.MANAGER!, A.slug);
    const member = api(A.people.MEMBER!, A.slug);
    const type = (await admin_.createType({ name: uniq('Admin type'), category: 'SICK', paid: true })).body.leaveType;
    expect(type).toMatchObject({ category: 'SICK', sensitive: true, status: 'ACTIVE', version: 1 });
    expect((await manager.getType(type.id)).status).toBe(200);
    expect((await manager.types()).status).toBe(200);
    expect((await manager.createType({ name: 'x', category: 'OTHER', paid: false })).status).toBe(403);
    expect((await manager.patchType(type.id, { version: 1, name: 'y' })).status).toBe(403);
    expect((await manager.archiveType(type.id, 1)).status).toBe(403);
    expect((await manager.createPolicy({ leaveTypeId: type.id, name: 'm', ...ANNUAL_GRANT })).status).toBe(403);
    expect((await member.types()).status).toBe(403);
    expect((await member.getType(type.id)).status).toBe(403);
    expect((await member.policies()).status).toBe(403);
    const pol = await policy({}, type.id);
    const emp = await employee();
    expect((await manager.assign(pol.id, { employeeIds: [emp.id] })).status).toBe(403);
    expect((await manager.end(emp.id, { leaveTypeId: type.id })).status).toBe(403);
    expect((await manager.employeeLeave(emp.id)).status).toBe(200);
    expect((await member.employeeLeave(emp.id)).status).toBe(403);
  });

  it('people:manage assigns without people:configure, and people:configure configures without people:manage', async () => {
    const pol = await policy();
    const emp = await employee();
    custom.MANAGER = ['people:read', 'people:manage'];
    const manager = api(A.people.MANAGER!, A.slug);
    expect((await manager.assign(pol.id, { employeeIds: [emp.id] })).status).toBe(200);
    expect((await manager.createType({ name: uniq('No'), category: 'OTHER', paid: false })).status).toBe(403);
    expect((await manager.patchPolicy(pol.id, { version: pol.version, name: 'No' })).status).toBe(403);
    custom.MANAGER = ['people:read', 'people:configure'];
    expect((await manager.createType({ name: uniq('Yes'), category: 'OTHER', paid: false })).status).toBe(201);
    expect((await manager.assign(pol.id, { employeeIds: [(await employee()).id] })).status).toBe(403);
  });
});

describe('leave types', () => {
  it('creates the starter set (names and categories only), with sensitive defaults by category', async () => {
    const fresh = await team('ls');
    const o = api(fresh.people.OWNER!, fresh.slug);
    expect((await o.types()).body.leaveTypes).toEqual([]); // nothing is seeded
    for (const starter of LEAVE_TYPE_STARTERS) expect((await o.createType(starter)).status).toBe(201);
    const list = (await o.types()).body.leaveTypes as { name: string; category: string; sensitive: boolean; paid: boolean }[];
    expect(list.map((x) => x.name)).toEqual([...LEAVE_TYPE_STARTERS.map((s) => s.name)].sort());
    expect(list.find((x) => x.category === 'SICK')).toMatchObject({ sensitive: true, paid: true });
    expect(list.find((x) => x.category === 'UNPAID')).toMatchObject({ sensitive: false, paid: false });
    // Without an explicit flag, sensitivity follows the category; an explicit flag wins.
    expect((await o.createType({ name: 'Carer', category: 'CARER', paid: true })).body.leaveType.sensitive).toBe(true);
    expect((await o.createType({ name: 'Study', category: 'STUDY', paid: true })).body.leaveType.sensitive).toBe(false);
    expect((await o.createType({ name: 'Sick (open)', category: 'SICK', paid: true, sensitive: false })).body.leaveType.sensitive).toBe(false);
  });

  it('validates input and rejects unknown fields', async () => {
    for (const body of [
      {}, { name: '', category: 'ANNUAL', paid: true }, { name: 'x'.repeat(121), category: 'ANNUAL', paid: true }, { name: 'x', category: 'HOLIDAY', paid: true },
      { name: 'x', category: 'ANNUAL' }, { name: 'x', category: 'ANNUAL', paid: true, businessId: B.businessId },
      { name: 'x', category: 'ANNUAL', paid: true, entitlementDays: 20 }, { name: 'x', category: 'ANNUAL', paid: true, status: 'INACTIVE' },
    ]) {
      expect((await own.createType(body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('current names are unique ignoring case and spaces; an archived name can be reused, and restoring then clashes', async () => {
    const name = uniq('Annual');
    const first = (await own.createType({ name, category: 'ANNUAL', paid: true })).body.leaveType;
    expect(await own.createType({ name: `  ${name.toUpperCase()} `, category: 'ANNUAL', paid: true })).toMatchObject({ status: 409, body: { error: 'duplicate_name' } });
    // Another business may use the same name.
    expect((await api(B.people.OWNER!, B.slug).createType({ name, category: 'ANNUAL', paid: true })).status).toBe(201);
    expect((await own.archiveType(first.id, 1)).body.leaveType.archivedAt).not.toBeNull();
    const second = (await own.createType({ name, category: 'ANNUAL', paid: true })).body.leaveType;
    expect(second.id).not.toBe(first.id);
    expect(await own.restoreType(first.id, 2)).toMatchObject({ status: 409, body: { error: 'duplicate_name' } });
  });

  it('edits with optimistic versions; deactivate and reactivate; archive is read-only; restore', async () => {
    const t = await leaveType();
    expect(await own.patchType(t.id, { version: 1, name: uniq('Renamed'), paid: false, status: 'INACTIVE' })).toMatchObject({
      status: 200, body: { leaveType: { version: 2, paid: false, status: 'INACTIVE' } },
    });
    expect(await own.patchType(t.id, { version: 1, description: 'stale' })).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect((await own.patchType(t.id, { version: 2 })).status).toBe(400); // nothing to update
    // An unchanged value is not a change: the version stays.
    expect((await own.patchType(t.id, { version: 2, paid: false })).body.leaveType.version).toBe(2);
    expect((await own.archiveType(t.id, 1)).body).toEqual({ error: 'stale' });
    expect((await own.archiveType(t.id, 2)).body.leaveType).toMatchObject({ version: 3 });
    expect((await own.archiveType(t.id, 3)).body).toEqual({ error: 'archived' });
    expect(await own.patchType(t.id, { version: 3, name: 'x' })).toMatchObject({ status: 409, body: { error: 'archived' } });
    expect((await own.restoreType(t.id, 3)).body.leaveType).toMatchObject({ version: 4, archivedAt: null, status: 'INACTIVE' });
    expect((await own.restoreType(t.id, 4)).body).toEqual({ error: 'not_archived' });
  });

  it('a type with a current policy cannot be archived until the policy is archived', async () => {
    const p = await policy();
    expect(await own.archiveType(p.leaveType.id, 1)).toMatchObject({ status: 409, body: { error: 'in_use' } });
    expect((await own.archivePolicy(p.id, 1)).status).toBe(200);
    expect((await own.archiveType(p.leaveType.id, 1)).status).toBe(200);
    // A policy cannot be created under, or restored into, an archived type.
    expect(await own.createPolicy({ leaveTypeId: p.leaveType.id, name: uniq('Late'), ...ANNUAL_GRANT })).toMatchObject({ status: 409, body: { error: 'archived_reference' } });
    expect(await own.restorePolicy(p.id, 2)).toMatchObject({ status: 409, body: { error: 'archived_reference' } });
  });

  it('lists with search, status and category filters, keyset pages, and a cursor bound to its filters', async () => {
    const fresh = await team('lp');
    const o = api(fresh.people.OWNER!, fresh.slug);
    for (const [name, category] of [['Alpha', 'ANNUAL'], ['Bravo', 'SICK'], ['Charlie', 'ANNUAL'], ['Delta', 'UNPAID'], ['Echo', 'ANNUAL']] as const) {
      await o.createType({ name, category, paid: category !== 'UNPAID' });
    }
    const delta = (await o.types('?q=delt')).body.leaveTypes[0];
    await o.archiveType(delta.id, 1);
    const echo = (await o.types('?q=echo')).body.leaveTypes[0];
    await o.patchType(echo.id, { version: 1, status: 'INACTIVE' });
    const names = async (qs: string) => ((await o.types(qs)).body.leaveTypes as { name: string }[]).map((x) => x.name);
    expect(await names('')).toEqual(['Alpha', 'Bravo', 'Charlie', 'Echo']);
    expect(await names('?status=active')).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(await names('?status=inactive')).toEqual(['Echo']);
    expect(await names('?status=archived')).toEqual(['Delta']);
    expect(await names('?status=all&category=ANNUAL')).toEqual(['Alpha', 'Charlie', 'Echo']);
    const first = (await o.types('?limit=2')).body;
    expect(first.leaveTypes.map((x: { name: string }) => x.name)).toEqual(['Alpha', 'Bravo']);
    const second = (await o.types(`?limit=2&cursor=${first.nextCursor}`)).body;
    expect(second.leaveTypes.map((x: { name: string }) => x.name)).toEqual(['Charlie', 'Echo']);
    expect(second.nextCursor).toBeNull();
    expect(await o.types(`?limit=2&status=all&cursor=${first.nextCursor}`)).toMatchObject({ status: 400, body: { error: 'invalid_cursor' } });
    expect((await o.types('?cursor=not-a-cursor')).status).toBe(400);
  });
});

describe('leave policies: international rule combinations', () => {
  it('stores untracked, granted, accruing and hourly policies exactly; nothing is derived from a country', async () => {
    const unpaid = await own.createPolicy({ leaveTypeId: (await leaveType({ category: 'UNPAID', paid: false })).id, name: uniq('Unpaid'), unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'NONE' });
    expect(unpaid.body.policy).toMatchObject({
      entitlementMethod: 'NONE', entitlementAmount: null, yearStart: null, carryover: 'NONE', negativeBalanceLimit: '0', requiresApproval: true,
      allowBackdated: false, currentAssignments: 0, version: 1,
    });
    const annual = await own.createPolicy({
      leaveTypeId: (await leaveType()).id, name: uniq('Annual (Germany, full time)'), countryCode: 'de', ...ANNUAL_GRANT, entitlementAmount: '30',
      carryover: 'CAPPED', carryoverCap: '5', minimumNoticeDays: 14,
    });
    expect(annual.body.policy).toMatchObject({ countryCode: 'DE', entitlementAmount: '30', carryover: 'CAPPED', carryoverCap: '5', minimumNoticeDays: 14 });
    const accrual = await own.createPolicy({
      leaveTypeId: (await leaveType()).id, name: uniq('Annual accrual (financial year)'), unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'ACCRUAL',
      entitlementAmount: '15.25', accrualFrequency: 'MONTHLY', yearStart: 'CUSTOM', yearStartMonth: 7, yearStartDay: 1, maxBalance: '40', negativeBalanceLimit: '2.5',
      carryover: 'UNLIMITED',
    });
    expect(accrual.body.policy).toMatchObject({
      entitlementAmount: '15.25', accrualFrequency: 'MONTHLY', yearStart: 'CUSTOM', yearStartMonth: 7, yearStartDay: 1, maxBalance: '40', negativeBalanceLimit: '2.5',
    });
    const hourly = await own.createPolicy({
      leaveTypeId: (await leaveType({ category: 'SICK' })).id, name: uniq('Sick hours (anniversary)'), unit: 'HOURS', granularity: 'QUARTER_HOUR',
      entitlementMethod: 'GRANT', entitlementAmount: '76.0000', yearStart: 'ANNIVERSARY', allowBackdated: true, requiresApproval: false, waitingPeriodDays: 90,
    });
    expect(hourly.body.policy).toMatchObject({ unit: 'HOURS', granularity: 'QUARTER_HOUR', entitlementAmount: '76', allowBackdated: true, waitingPeriodDays: 90 });
  });

  it('refuses inconsistent combinations with a plain explanation (invalid_policy), and bad shapes (invalid_input)', async () => {
    const typeId = (await leaveType()).id;
    const base = { leaveTypeId: typeId, name: 'Bad' };
    for (const body of [
      { ...base, unit: 'DAYS', granularity: 'HOUR', entitlementMethod: 'NONE' },
      { ...base, unit: 'HOURS', granularity: 'HALF_DAY', entitlementMethod: 'NONE' },
      { ...base, unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'NONE', entitlementAmount: '5' },
      { ...base, unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'NONE', negativeBalanceLimit: '1' },
      { ...base, unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'GRANT', yearStart: 'CALENDAR' },
      { ...base, unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'GRANT', entitlementAmount: '0', yearStart: 'CALENDAR' },
      { ...base, unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'GRANT', entitlementAmount: '20' },
      { ...base, unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'GRANT', entitlementAmount: '20', yearStart: 'CALENDAR', accrualFrequency: 'MONTHLY' },
      { ...base, unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'ACCRUAL', entitlementAmount: '20', yearStart: 'CALENDAR' },
      { ...base, unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'GRANT', entitlementAmount: '20', yearStart: 'CUSTOM', yearStartMonth: 2, yearStartDay: 29 },
      { ...base, unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'GRANT', entitlementAmount: '20', yearStart: 'CUSTOM', yearStartMonth: 4 },
      { ...base, unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'GRANT', entitlementAmount: '20', yearStart: 'CALENDAR', yearStartMonth: 1, yearStartDay: 1 },
      { ...base, unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'GRANT', entitlementAmount: '20', yearStart: 'CALENDAR', carryover: 'CAPPED' },
      { ...base, unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'GRANT', entitlementAmount: '20', yearStart: 'CALENDAR', carryoverCap: '3' },
    ]) {
      const res = await own.createPolicy(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error, JSON.stringify(body)).toBe('invalid_policy');
      expect(res.body.message).toMatch(/\w/);
    }
    for (const body of [
      { ...base, ...ANNUAL_GRANT, entitlementAmount: '-1' }, { ...base, ...ANNUAL_GRANT, entitlementAmount: '1.23456' }, { ...base, ...ANNUAL_GRANT, entitlementAmount: 20 },
      { ...base, ...ANNUAL_GRANT, unit: 'WEEKS' }, { ...base, ...ANNUAL_GRANT, countryCode: 'USA' }, { ...base, ...ANNUAL_GRANT, minimumNoticeDays: 400 },
      { ...base, ...ANNUAL_GRANT, leaveTypeId: 'nope' }, { ...base, ...ANNUAL_GRANT, payRate: '30' }, { ...base, ...ANNUAL_GRANT, legalMinimum: true },
    ]) {
      expect((await own.createPolicy(body)).status, JSON.stringify(body)).toBe(400);
    }
    // Another business's leave type is not a choice.
    const bType = (await api(B.people.OWNER!, B.slug).createType({ name: uniq('B type'), category: 'ANNUAL', paid: true })).body.leaveType.id;
    expect(await own.createPolicy({ ...base, ...ANNUAL_GRANT, leaveTypeId: bType })).toMatchObject({ status: 400, body: { error: 'invalid_leave_type' } });
  });

  it('edits rules with optimistic versions; the leave type and unit are fixed; switching to no balance clears the balance rules', async () => {
    const p = await policy({ carryover: 'CAPPED', carryoverCap: '5', maxBalance: '30', negativeBalanceLimit: '1' });
    expect((await own.patchPolicy(p.id, { version: 1, unit: 'HOURS' })).status).toBe(400);
    expect((await own.patchPolicy(p.id, { version: 1, leaveTypeId: (await leaveType()).id })).status).toBe(400);
    expect((await own.patchPolicy(p.id, { version: 1, granularity: 'HOUR' })).body.error).toBe('invalid_policy');
    const raised = await own.patchPolicy(p.id, { version: 1, entitlementAmount: '22.5', carryover: 'UNLIMITED' });
    expect(raised.body.policy).toMatchObject({ version: 2, entitlementAmount: '22.5', carryover: 'UNLIMITED', carryoverCap: null });
    // The same value written differently is not a change.
    expect((await own.patchPolicy(p.id, { version: 2, entitlementAmount: '22.50' })).body.policy.version).toBe(2);
    expect(await own.patchPolicy(p.id, { version: 1, name: 'stale' })).toMatchObject({ status: 409, body: { error: 'stale' } });
    const none = await own.patchPolicy(p.id, { version: 2, entitlementMethod: 'NONE' });
    expect(none.body.policy).toMatchObject({
      version: 3, entitlementMethod: 'NONE', entitlementAmount: null, yearStart: null, carryover: 'NONE', maxBalance: null, negativeBalanceLimit: '0',
    });
    // Sending a balance rule together with "no balance" is a contradiction, not silently dropped.
    expect((await own.patchPolicy(p.id, { version: 3, entitlementMethod: 'NONE', maxBalance: '3' })).body.error).toBe('invalid_policy');
    const accrue = await own.patchPolicy(p.id, { version: 3, entitlementMethod: 'ACCRUAL', entitlementAmount: '10', accrualFrequency: 'FORTNIGHTLY', yearStart: 'ANNIVERSARY' });
    expect(accrue.body.policy).toMatchObject({ version: 4, entitlementMethod: 'ACCRUAL', accrualFrequency: 'FORTNIGHTLY', yearStart: 'ANNIVERSARY' });
    const grant = await own.patchPolicy(p.id, { version: 4, entitlementMethod: 'GRANT' });
    expect(grant.body.policy).toMatchObject({ version: 5, accrualFrequency: null });
  });

  it('records every version of the rules as an append-only revision', async () => {
    const p = await policy();
    await own.patchPolicy(p.id, { version: 1, entitlementAmount: '25' });
    await own.patchPolicy(p.id, { version: 2, status: 'INACTIVE' });
    await own.archivePolicy(p.id, 3);
    const revisions = (await own.revisions(p.id)).body.revisions as { version: number; rules: Record<string, unknown>; recordedById: string }[];
    expect(revisions.map((r) => r.version)).toEqual([4, 3, 2, 1]);
    expect(revisions[3]!.rules).toMatchObject({ entitlement_amount: 20, status: 'ACTIVE', archived_at: null, unit: 'DAYS' });
    expect(revisions[2]!.rules).toMatchObject({ entitlement_amount: 25 });
    expect(revisions[1]!.rules).toMatchObject({ status: 'INACTIVE' });
    expect(revisions[0]!.rules.archived_at).not.toBeNull();
    expect(revisions.every((r) => r.recordedById === A.people.OWNER!.id)).toBe(true);
    expect(revisions[0]!.rules).not.toHaveProperty('business_id');
    // Readers see revisions too; another business's id is 404.
    expect((await api(A.people.MANAGER!, A.slug).revisions(p.id)).status).toBe(200);
    expect((await api(B.people.OWNER!, B.slug).revisions(p.id)).status).toBe(404);
  });

  it('lists by leave type and status, with names unique among current policies', async () => {
    const t = await leaveType();
    const name = uniq('Unique policy');
    const p1 = await policy({ name }, t.id);
    expect(await own.createPolicy({ leaveTypeId: t.id, name: name.toLowerCase(), ...ANNUAL_GRANT })).toMatchObject({ status: 409, body: { error: 'duplicate_name' } });
    const p2 = await policy({}, t.id);
    await own.patchPolicy(p2.id, { version: 1, status: 'INACTIVE' });
    const ids = async (qs: string) => ((await own.policies(qs)).body.policies as { id: string }[]).map((x) => x.id).sort();
    expect(await ids(`?leaveTypeId=${t.id}`)).toEqual([p1.id, p2.id].sort());
    expect(await ids(`?leaveTypeId=${t.id}&status=active`)).toEqual([p1.id]);
    expect(await ids(`?leaveTypeId=${t.id}&status=inactive`)).toEqual([p2.id]);
    expect(await ids(`?leaveTypeId=${t.id}&status=archived`)).toEqual([]);
  });
});

describe('policy assignments (effective-dated, business time zone)', () => {
  it('assigns a batch, leaves employees already on it unchanged, and replaces another policy of the same type', async () => {
    const t = await leaveType();
    const p1 = await policy({}, t.id);
    const p2 = await policy({}, t.id);
    const [e1, e2, e3] = [await employee(), await employee(), await employee()];
    const yesterday = shift(todayIn(A.timeZone), -1);
    const first = await own.assign(p1.id, { employeeIds: [e1.id, e2.id], effectiveDate: yesterday });
    expect(first.body).toMatchObject({ assigned: 2, unchanged: 0 });
    expect(first.body.assignments).toHaveLength(2);
    expect((await own.getPolicy(p1.id)).body.policy.currentAssignments).toBe(2);
    const second = await own.assign(p2.id, { employeeIds: [e2.id, e3.id] });
    expect(second.body).toMatchObject({ assigned: 2, unchanged: 0 });
    const again = await own.assign(p2.id, { employeeIds: [e2.id, e3.id] });
    expect(again.body).toMatchObject({ assigned: 0, unchanged: 2 });
    const history = (await own.employeeLeave(e2.id)).body.assignments as { policy: { id: string }; startsOn: string; endsOn: string | null }[];
    expect(history).toMatchObject([
      { policy: { id: p2.id }, startsOn: todayIn(A.timeZone), endsOn: null },
      { policy: { id: p1.id }, startsOn: yesterday, endsOn: todayIn(A.timeZone) },
    ]);
    expect((await own.getPolicy(p1.id)).body.policy.currentAssignments).toBe(1);
    const current = (await own.assignments(p2.id)).body.assignments as { employee: { id: string } }[];
    expect(current.map((x) => x.employee.id).sort()).toEqual([e2.id, e3.id].sort());
    expect((await own.assignments(p1.id, '?include=all')).body.assignments).toHaveLength(2);
  });

  it('effective dates are business dates: today in the business time zone is allowed, tomorrow is not, and history cannot be rewritten', async () => {
    const p = await policy();
    const e = await employee();
    const bOwner = api(B.people.OWNER!, B.slug);
    const bType = (await bOwner.createType({ name: uniq('NY type'), category: 'ANNUAL', paid: true })).body.leaveType.id;
    const bPolicy = (await bOwner.createPolicy({ leaveTypeId: bType, name: uniq('NY'), ...ANNUAL_GRANT })).body.policy.id;
    const bEmp = await employee({}, bOwner);
    // Perth and New York can be on different calendar days at the same instant: each uses its own today.
    expect((await own.assign(p.id, { employeeIds: [e.id], effectiveDate: shift(todayIn(A.timeZone), 1) })).body.error).toBe('future_effective_date');
    expect((await bOwner.assign(bPolicy, { employeeIds: [bEmp.id], effectiveDate: shift(todayIn(B.timeZone), 1) })).body.error).toBe('future_effective_date');
    expect((await bOwner.assign(bPolicy, { employeeIds: [bEmp.id], effectiveDate: todayIn(B.timeZone) })).status).toBe(200);
    expect((await own.assign(p.id, { employeeIds: [e.id], effectiveDate: '2026-01-10' })).status).toBe(200);
    const other = await policy({}, p.leaveType.id);
    // A replacement cannot start before the current assignment did.
    expect(await own.assign(other.id, { employeeIds: [e.id], effectiveDate: '2026-01-09' })).toMatchObject({ status: 400, body: { error: 'effective_date_order' } });
    expect(await own.end(e.id, { leaveTypeId: p.leaveType.id, effectiveDate: '2026-01-01' })).toMatchObject({ status: 400, body: { error: 'effective_date_order' } });
    expect((await own.assign(other.id, { employeeIds: [e.id], effectiveDate: '2026-02-30' })).status).toBe(400);
  });

  it('is all or nothing: an unknown, another business\'s or a terminated employee fails the batch and writes nothing', async () => {
    const p = await policy();
    const ok = await employee();
    const bEmp = await employee({}, api(B.people.OWNER!, B.slug));
    const gone = await employee();
    expect((await own.status(gone.id, { status: 'TERMINATED', version: gone.version })).status).toBe(200);
    expect((await own.assign(p.id, { employeeIds: [ok.id, randomUUID()] })).status).toBe(404);
    expect((await own.assign(p.id, { employeeIds: [ok.id, bEmp.id] })).status).toBe(404);
    expect(await own.assign(p.id, { employeeIds: [ok.id, gone.id] })).toMatchObject({ status: 409, body: { error: 'terminated' } });
    expect((await own.assign(p.id, { employeeIds: [ok.id, ok.id] })).status).toBe(400);
    expect((await own.assign(p.id, { employeeIds: [] })).status).toBe(400);
    expect((await admin.query('SELECT count(*)::int AS n FROM people_leave_policy_assignments WHERE policy_id = $1', [p.id])).rows[0].n).toBe(0);
    expect((await audits(ok.id)).filter((x) => String(x.action).startsWith('people.leave'))).toEqual([]);
  });

  it('only active, unarchived policies are assignable; an assigned policy cannot be archived; ending an assignment frees it', async () => {
    const p = await policy();
    const e = await employee();
    await own.patchPolicy(p.id, { version: 1, status: 'INACTIVE' });
    expect(await own.assign(p.id, { employeeIds: [e.id] })).toMatchObject({ status: 409, body: { error: 'inactive_reference' } });
    await own.patchPolicy(p.id, { version: 2, status: 'ACTIVE' });
    expect((await own.assign(p.id, { employeeIds: [e.id] })).status).toBe(200);
    // Deactivating keeps current assignments; archiving is refused while anyone is assigned.
    expect((await own.patchPolicy(p.id, { version: 3, status: 'INACTIVE' })).status).toBe(200);
    expect(await own.archivePolicy(p.id, 4)).toMatchObject({ status: 409, body: { error: 'in_use' } });
    const ended = await own.end(e.id, { leaveTypeId: p.leaveType.id });
    expect(ended.body.assignments[0]).toMatchObject({ policy: { id: p.id }, endsOn: todayIn(A.timeZone) });
    expect(await own.end(e.id, { leaveTypeId: p.leaveType.id })).toMatchObject({ status: 409, body: { error: 'not_assigned' } });
    expect((await own.archivePolicy(p.id, 4)).status).toBe(200);
    expect(await own.assign(p.id, { employeeIds: [e.id] })).toMatchObject({ status: 409, body: { error: 'archived_reference' } });
  });

  it('employee lifecycle: termination keeps the assignment as history and blocks new ones; rehire allows them again', async () => {
    const p = await policy();
    const other = await policy({}, p.leaveType.id);
    const e = await employee();
    await own.assign(p.id, { employeeIds: [e.id] });
    // Leave assignments are their own records: they never bump the employee's version (no stale employee forms).
    const terminated = await own.status(e.id, { status: 'TERMINATED', version: e.version });
    expect(terminated.status, JSON.stringify(terminated.body)).toBe(200);
    expect((await own.employeeLeave(e.id)).body.assignments[0]).toMatchObject({ policy: { id: p.id }, endsOn: null, employee: { status: 'TERMINATED' } });
    expect(await own.assign(other.id, { employeeIds: [e.id] })).toMatchObject({ status: 409, body: { error: 'terminated' } });
    expect((await own.status(e.id, { status: 'ACTIVE', version: terminated.body.employee.version })).status).toBe(200);
    expect((await own.assign(other.id, { employeeIds: [e.id] })).body).toMatchObject({ assigned: 1 });
  });

  it('pages a policy\'s assignments with a cursor bound to the policy and filter', async () => {
    const p = await policy();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await employee()).id);
    await own.assign(p.id, { employeeIds: ids });
    const first = (await own.assignments(p.id, '?limit=2')).body;
    const second = (await own.assignments(p.id, `?limit=2&cursor=${first.nextCursor}`)).body;
    const third = (await own.assignments(p.id, `?limit=2&cursor=${second.nextCursor}`)).body;
    expect(third.nextCursor).toBeNull();
    const seen = [...first.assignments, ...second.assignments, ...third.assignments].map((x: { employee: { id: string } }) => x.employee.id);
    expect(seen.sort()).toEqual([...ids].sort());
    expect((await own.assignments(p.id, `?include=all&cursor=${first.nextCursor}`)).body.error).toBe('invalid_cursor');
    expect((await own.assignments((await policy()).id, `?cursor=${first.nextCursor}`)).body.error).toBe('invalid_cursor');
  });
});

describe('tenant isolation', () => {
  it('another business\'s types, policies and employees answer 404 through every route', async () => {
    const p = await policy();
    const e = await employee();
    await own.assign(p.id, { employeeIds: [e.id] });
    const b = api(B.people.OWNER!, B.slug);
    expect((await b.getType(p.leaveType.id)).status).toBe(404);
    expect((await b.patchType(p.leaveType.id, { version: 1, name: 'x' })).status).toBe(404);
    expect((await b.archiveType(p.leaveType.id, 1)).status).toBe(404);
    expect((await b.getPolicy(p.id)).status).toBe(404);
    expect((await b.patchPolicy(p.id, { version: 1, name: 'x' })).status).toBe(404);
    expect((await b.archivePolicy(p.id, 1)).status).toBe(404);
    expect((await b.assignments(p.id)).status).toBe(404);
    expect((await b.assign(p.id, { employeeIds: [e.id] })).status).toBe(404);
    expect((await b.employeeLeave(e.id)).status).toBe(404);
    expect((await b.end(e.id, { leaveTypeId: p.leaveType.id })).status).toBe(404);
    const bPolicyIds = ((await b.policies('?status=all')).body.policies as { id: string }[]).map((x) => x.id);
    expect(bPolicyIds).not.toContain(p.id);
    // A's policy given B's employee, from A: B's employee is invisible (404), nothing is written.
    const bEmp = await employee({}, b);
    expect((await own.assign(p.id, { employeeIds: [bEmp.id] })).status).toBe(404);
  });

  it('under RLS, bos_app sees only its own business\'s leave rows and cannot write into another business', async () => {
    const p = await policy();
    const e = await employee();
    await own.assign(p.id, { employeeIds: [e.id] });
    await asApp(B.businessId, async (c) => {
      for (const table of ['people_leave_types', 'people_leave_policies', 'people_leave_policy_revisions', 'people_leave_policy_assignments']) {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [A.businessId]);
        expect(rows[0].n, table).toBe(0);
      }
      expect(await sqlError(c.query(
        `INSERT INTO people_leave_types (id, business_id, name, category, paid) VALUES ($1, $2, 'x', 'ANNUAL', true)`, [randomUUID(), A.businessId],
      ))).toBe('42501');
    });
    await asApp(null, async (c) => {
      expect((await c.query('SELECT count(*)::int AS n FROM people_leave_policies')).rows[0].n).toBe(0);
    });
  });

  it('all four tables have forced RLS, the tenant policy, and no DELETE, TRUNCATE or identity-column UPDATE for bos_app', async () => {
    const tables = ['people_leave_types', 'people_leave_policies', 'people_leave_policy_revisions', 'people_leave_policy_assignments'];
    const { rows } = await admin.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1) AND c.relrowsecurity AND c.relforcerowsecurity`, [tables]);
    expect(rows.map((r) => r.relname).sort()).toEqual([...tables].sort());
    const policies = await admin.query(`SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = ANY($1)`, [tables]);
    expect(policies.rows).toHaveLength(4);
    for (const table of tables) {
      for (const privilege of ['DELETE', 'TRUNCATE']) {
        expect((await admin.query(`SELECT has_table_privilege('bos_app', $1, $2) AS ok`, [table, privilege])).rows[0].ok, `${table} ${privilege}`).toBe(false);
      }
    }
    for (const [table, column] of [
      ['people_leave_types', 'business_id'], ['people_leave_types', 'created_at'], ['people_leave_policies', 'leave_type_id'], ['people_leave_policies', 'unit'],
      ['people_leave_policy_revisions', 'rules'], ['people_leave_policy_assignments', 'policy_id'], ['people_leave_policy_assignments', 'starts_on'],
    ]) {
      expect((await admin.query(`SELECT has_column_privilege('bos_app', $1, $2, 'UPDATE') AS ok`, [table, column])).rows[0].ok, `${table}.${column}`).toBe(false);
    }
  });
});

describe('database guards on their own (bos_app, tenant context set)', () => {
  it('versions advance by one, archived rows are read-only, and type and unit are fixed', async () => {
    const p = await policy();
    await asApp(A.businessId, async (c) => {
      expect(await sqlError(c.query(`UPDATE people_leave_policies SET name = 'x', version = version + 2 WHERE id = $1`, [p.id]))).toBe('PE009');
    });
    await asApp(A.businessId, async (c) => {
      expect(await sqlError(c.query(`UPDATE people_leave_policies SET name = 'x' WHERE id = $1`, [p.id]))).toBe('PE009');
    });
    await asApp(A.businessId, async (c) => {
      expect(await sqlError(c.query(`UPDATE people_leave_policies SET archived_at = now(), name = 'sneaky', version = version + 1 WHERE id = $1`, [p.id]))).toBe('PE010');
    });
    await asApp(A.businessId, async (c) => {
      expect(await sqlError(c.query(`UPDATE people_leave_types SET archived_at = now(), version = version + 1 WHERE id = $1`, [p.leaveType.id]))).toBe('PE008');
    });
    await own.archivePolicy(p.id, 1);
    await asApp(A.businessId, async (c) => {
      expect(await sqlError(c.query(`UPDATE people_leave_policies SET entitlement_amount = 1, version = version + 1 WHERE id = $1`, [p.id]))).toBe('PE010');
    });
  });

  it('CHECKs hold every rule combination, even if the service is bypassed', async () => {
    const t = await leaveType();
    const insert = (cols: Record<string, unknown>) => asApp(A.businessId, (c) => {
      const all = { id: randomUUID(), business_id: A.businessId, leave_type_id: t.id, name: uniq('raw'), unit: 'DAYS', granularity: 'FULL_DAY', entitlement_method: 'NONE', ...cols };
      const keys = Object.keys(all);
      return sqlError(c.query(`INSERT INTO people_leave_policies (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(all)));
    });
    expect(await insert({})).toBeNull();
    for (const cols of [
      { granularity: 'HOUR' }, { unit: 'HOURS' }, { entitlement_amount: 5 }, { entitlement_method: 'GRANT' }, { entitlement_method: 'GRANT', entitlement_amount: 5 },
      { entitlement_method: 'GRANT', entitlement_amount: 5, year_start: 'CUSTOM', year_start_month: 2, year_start_day: 29 },
      { entitlement_method: 'ACCRUAL', entitlement_amount: 5, year_start: 'CALENDAR' }, { negative_balance_limit: 1 }, { carryover: 'UNLIMITED' },
      { country_code: 'us' }, { minimum_notice_days: -1 }, { status: 'DRAFT' },
    ]) {
      expect(await insert(cols), JSON.stringify(cols)).toBe('23514');
    }
    expect(await insert({ entitlement_method: 'GRANT', entitlement_amount: 5, year_start: 'CUSTOM', year_start_month: 6, year_start_day: 30 })).toBeNull();
  });

  it('revisions can only state what the policy really is, and are never changed or deleted', async () => {
    const p = await policy();
    await asApp(A.businessId, async (c) => {
      // Ahead of the policy: refused.
      expect(await sqlError(c.query(`INSERT INTO people_leave_policy_revisions (business_id, policy_id, version, rules) VALUES ($1, $2, 2, '{}')`, [A.businessId, p.id]))).toBe('PE004');
    });
    await asApp(A.businessId, async (c) => {
      // The current version already has its revision.
      expect(await sqlError(c.query(`INSERT INTO people_leave_policy_revisions (business_id, policy_id, version, rules) VALUES ($1, $2, 1, '{"entitlement_amount": 999}')`, [A.businessId, p.id]))).toBe('23505');
    });
    await asApp(A.businessId, async (c) => {
      expect(await sqlError(c.query(`UPDATE people_leave_policy_revisions SET rules = '{}' WHERE policy_id = $1`, [p.id]))).toBe('42501');
    });
    await asApp(A.businessId, async (c) => {
      expect(await sqlError(c.query(`DELETE FROM people_leave_policy_revisions WHERE policy_id = $1`, [p.id]))).toBe('42501');
    });
    const { rows } = await admin.query('SELECT rules FROM people_leave_policy_revisions WHERE policy_id = $1', [p.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].rules.entitlement_amount).toBe(20);
  });

  it('assignments are created open, closed once, never overlap and are never deleted', async () => {
    const p = await policy();
    const e = await employee();
    await own.assign(p.id, { employeeIds: [e.id], effectiveDate: '2026-03-01' });
    const id = (await admin.query('SELECT id FROM people_leave_policy_assignments WHERE employee_id = $1', [e.id])).rows[0].id;
    const raw = (starts: string) => asApp(A.businessId, (c) => sqlError(c.query(
      `INSERT INTO people_leave_policy_assignments (id, business_id, employee_id, leave_type_id, policy_id, starts_on) VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), A.businessId, e.id, p.leaveType.id, p.id, starts],
    )));
    expect(await raw('2026-03-05')).toBe('PE011'); // the open row covers it
    await own.end(e.id, { leaveTypeId: p.leaveType.id, effectiveDate: '2026-03-10' });
    expect(await raw('2026-03-09')).toBe('PE011'); // before the closed row ended
    await asApp(A.businessId, async (c) => {
      expect(await sqlError(c.query(`UPDATE people_leave_policy_assignments SET ends_on = '2026-03-20', ended_at = now() WHERE id = $1`, [id]))).toBe('PE004');
    });
    await asApp(A.businessId, async (c) => {
      expect(await sqlError(c.query(`DELETE FROM people_leave_policy_assignments WHERE id = $1`, [id]))).toBe('42501');
    });
    // Another leave type's policy cannot be smuggled in under this type (composite FK on policy + type).
    const foreign = await policy();
    await asApp(A.businessId, async (c) => {
      expect(await sqlError(c.query(
        `INSERT INTO people_leave_policy_assignments (id, business_id, employee_id, leave_type_id, policy_id, starts_on) VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), A.businessId, e.id, p.leaveType.id, foreign.id, '2026-04-01'],
      ))).toBe('23503');
    });
    expect(await raw('2026-03-10')).toBeNull();
  });
});

describe('concurrency (deterministic: each race is staged with pg_blocking_pids)', () => {
  async function holdRow(table: string, id: string) {
    const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    const pid = await backendPid(holder);
    return { holder, pid, release: async () => { await holder.query('COMMIT'); await holder.end(); } };
  }

  it('two edits of the same policy at the same version: exactly one wins, the other is stale', async () => {
    const p = await policy();
    const lock = await holdRow('people_leave_policies', p.id);
    const one = own.patchPolicy(p.id, { version: 1, entitlementAmount: '21' });
    const two = api(A.people.ADMIN!, A.slug).patchPolicy(p.id, { version: 1, entitlementAmount: '22' });
    await waitUntilBlocked(admin, lock.pid, { count: 2 });
    await lock.release();
    const results = await Promise.all([one, two]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe('stale');
    expect((await own.getPolicy(p.id)).body.policy.version).toBe(2);
    expect((await own.revisions(p.id)).body.revisions).toHaveLength(2);
  });

  it('archiving a policy while it is being assigned: the assignment waits, then is refused (archived_reference)', async () => {
    const p = await policy();
    const e = await employee();
    const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('UPDATE people_leave_policies SET archived_at = now(), version = version + 1 WHERE id = $1', [p.id]);
    const pid = await backendPid(holder);
    const assigning = own.assign(p.id, { employeeIds: [e.id] });
    await waitUntilBlocked(admin, pid, { count: 1 });
    await holder.query('COMMIT');
    await holder.end();
    expect(await assigning).toMatchObject({ status: 409, body: { error: 'archived_reference' } });
    expect((await admin.query('SELECT count(*)::int AS n FROM people_leave_policy_assignments WHERE policy_id = $1', [p.id])).rows[0].n).toBe(0);
  });

  it('archiving a policy while an assignment holds it: the archive waits, then is refused (in_use)', async () => {
    const p = await policy();
    const e = await employee();
    const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(
      `INSERT INTO people_leave_policy_assignments (id, business_id, employee_id, leave_type_id, policy_id, starts_on) VALUES ($1, $2, $3, $4, $5, current_date - 1)`,
      [randomUUID(), A.businessId, e.id, p.leaveType.id, p.id],
    );
    const pid = await backendPid(holder);
    const archiving = own.archivePolicy(p.id, 1);
    await waitUntilBlocked(admin, pid, { count: 1 });
    await holder.query('COMMIT');
    await holder.end();
    expect(await archiving).toMatchObject({ status: 409, body: { error: 'in_use' } });
  });

  it('terminating an employee while a policy is being assigned: the assignment waits, then is refused (terminated)', async () => {
    const p = await policy();
    const e = await employee();
    const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT set_config('app.business_id', $1, true)`, [A.businessId]);
    await holder.query(`UPDATE people_employees SET status = 'TERMINATED', end_date = start_date, version = version + 1 WHERE id = $1`, [e.id]);
    const pid = await backendPid(holder);
    const assigning = own.assign(p.id, { employeeIds: [e.id] });
    await waitUntilBlocked(admin, pid, { count: 1 });
    await holder.query('COMMIT');
    await holder.end();
    expect(await assigning).toMatchObject({ status: 409, body: { error: 'terminated' } });
  });

  it('two administrators assigning different policies of one type to the same employee at once: one wins, the other is stale', async () => {
    const t = await leaveType();
    const p1 = await policy({}, t.id);
    const p2 = await policy({}, t.id);
    const e = await employee();
    const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(
      `INSERT INTO people_leave_policy_assignments (id, business_id, employee_id, leave_type_id, policy_id, starts_on) VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), A.businessId, e.id, t.id, p1.id, todayIn(A.timeZone)],
    );
    const pid = await backendPid(holder);
    const racing = own.assign(p2.id, { employeeIds: [e.id] });
    await waitUntilBlocked(admin, pid, { count: 1 });
    await holder.query('COMMIT');
    await holder.end();
    expect(await racing).toMatchObject({ status: 409, body: { error: 'stale' } });
    const open = await admin.query('SELECT policy_id FROM people_leave_policy_assignments WHERE employee_id = $1 AND ends_on IS NULL', [e.id]);
    expect(open.rows).toEqual([{ policy_id: p1.id }]);
  });

  // End versus replacement (ChatGPT P3-A audit, item 1). Both sides read the open row, then close it with a
  // conditional update; the holder plays whichever side commits first, on the same business day the row
  // started (a same-day replacement leaves a zero-length [d, d) row, which the CHECK allows).
  async function openToday(e: { id: string }, typeId: string, policyId: string) {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO people_leave_policy_assignments (id, business_id, employee_id, leave_type_id, policy_id, starts_on) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, A.businessId, e.id, typeId, policyId, todayIn(A.timeZone)],
    );
    return id;
  }
  const openRows = async (employeeId: string) =>
    (await admin.query('SELECT policy_id FROM people_leave_policy_assignments WHERE employee_id = $1 AND ends_on IS NULL', [employeeId])).rows;

  it('ending an assignment while a same-day replacement commits first: the end waits, then is refused (stale) and the replacement stays', async () => {
    const t = await leaveType();
    const p1 = await policy({}, t.id);
    const p2 = await policy({}, t.id);
    const e = await employee();
    const first = await openToday(e, t.id, p1.id);
    const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await holder.connect();
    await holder.query('BEGIN');
    // The replacement, mid-flight: the old row closed today and the new one open from today.
    await holder.query(`UPDATE people_leave_policy_assignments SET ends_on = $2, ended_at = now() WHERE id = $1`, [first, todayIn(A.timeZone)]);
    await holder.query(
      `INSERT INTO people_leave_policy_assignments (id, business_id, employee_id, leave_type_id, policy_id, starts_on) VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), A.businessId, e.id, t.id, p2.id, todayIn(A.timeZone)],
    );
    const pid = await backendPid(holder);
    const ending = own.end(e.id, { leaveTypeId: t.id });
    await waitUntilBlocked(admin, pid, { count: 1 });
    await holder.query('COMMIT');
    await holder.end();
    expect(await ending).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect(await openRows(e.id)).toEqual([{ policy_id: p2.id }]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'people.leave_policy.unassigned' AND target_id = $1`, [e.id])).rows[0].n).toBe(0);
    // Re-read and retry: the end now applies to the replacement.
    expect((await own.end(e.id, { leaveTypeId: t.id })).status).toBe(200);
    expect(await openRows(e.id)).toEqual([]);
  });

  it('replacing an assignment while a same-day end commits first: the assignment waits, then is refused (stale) and nothing is left open', async () => {
    const t = await leaveType();
    const p1 = await policy({}, t.id);
    const p2 = await policy({}, t.id);
    const e = await employee();
    const first = await openToday(e, t.id, p1.id);
    const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(`UPDATE people_leave_policy_assignments SET ends_on = $2, ended_at = now() WHERE id = $1`, [first, todayIn(A.timeZone)]);
    const pid = await backendPid(holder);
    const assigning = own.assign(p2.id, { employeeIds: [e.id] });
    await waitUntilBlocked(admin, pid, { count: 1 });
    await holder.query('COMMIT');
    await holder.end();
    expect(await assigning).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect(await openRows(e.id)).toEqual([]);
    // Re-read and retry: with nothing open, the assignment simply starts.
    expect((await own.assign(p2.id, { employeeIds: [e.id] })).body).toMatchObject({ assigned: 1 });
    expect(await openRows(e.id)).toEqual([{ policy_id: p2.id }]);
  });

  it('two ends of the same assignment at once: one ends it, the other is stale', async () => {
    const t = await leaveType();
    const p1 = await policy({}, t.id);
    const e = await employee();
    const first = await openToday(e, t.id, p1.id);
    const lock = await holdRow('people_leave_policy_assignments', first);
    const one = own.end(e.id, { leaveTypeId: t.id });
    const two = api(A.people.ADMIN!, A.slug).end(e.id, { leaveTypeId: t.id });
    await waitUntilBlocked(admin, lock.pid, { count: 2 });
    await lock.release();
    const results = await Promise.all([one, two]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe('stale');
    expect(await openRows(e.id)).toEqual([]);
  });

  it('archiving a leave type while a policy is being created under it: the create waits, then is refused (archived_reference)', async () => {
    const t = await leaveType();
    const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('UPDATE people_leave_types SET archived_at = now(), version = version + 1 WHERE id = $1', [t.id]);
    const pid = await backendPid(holder);
    const creating = own.createPolicy({ leaveTypeId: t.id, name: uniq('Racing'), ...ANNUAL_GRANT });
    await waitUntilBlocked(admin, pid, { count: 1 });
    await holder.query('COMMIT');
    await holder.end();
    expect(await creating).toMatchObject({ status: 409, body: { error: 'archived_reference' } });
    expect((await admin.query('SELECT count(*)::int AS n FROM people_leave_policies WHERE leave_type_id = $1', [t.id])).rows[0].n).toBe(0);
  });
});

describe('audit', () => {
  it('records references, categories and field names only: never names, descriptions or amounts', async () => {
    const t = (await own.createType({ name: 'Secret sabbatical', description: 'Do not leak', category: 'OTHER', paid: false })).body.leaveType;
    const p = (await own.createPolicy({ leaveTypeId: t.id, name: 'Hidden policy', description: 'Private text', ...ANNUAL_GRANT, entitlementAmount: '4321' })).body.policy;
    await own.patchPolicy(p.id, { version: 1, entitlementAmount: '1234', name: 'Renamed hidden' });
    await own.patchType(t.id, { version: 1, status: 'INACTIVE' });
    const e = await employee();
    await own.assign(p.id, { employeeIds: [e.id] });
    await own.end(e.id, { leaveTypeId: t.id });
    const typeRows = await audits(t.id);
    const policyRows = await audits(p.id);
    const employeeRows = (await audits(e.id)).filter((x) => String(x.action).startsWith('people.leave'));
    expect(typeRows.map((r) => r.action)).toEqual(['people.leave_type.created', 'people.leave_type.updated']);
    expect(typeRows[1].metadata).toEqual({ fields: ['status'], statusFrom: 'ACTIVE', statusTo: 'INACTIVE' });
    expect(policyRows.map((r) => r.action)).toEqual(['people.leave_policy.created', 'people.leave_policy.updated']);
    expect(policyRows[0].metadata).toEqual({ leaveTypeId: t.id, unit: 'DAYS', entitlementMethod: 'GRANT' });
    expect(policyRows[1].metadata).toEqual({ leaveTypeId: t.id, fields: ['entitlementAmount', 'name'] });
    expect(employeeRows.map((r) => r.action)).toEqual(['people.leave_policy.assigned', 'people.leave_policy.unassigned']);
    expect(employeeRows[0].metadata).toEqual({ policyId: p.id, leaveTypeId: t.id, effectiveDate: todayIn(A.timeZone), replacedPolicyId: null });
    expect([...typeRows, ...policyRows, ...employeeRows].every((r) => r.business_id === A.businessId && r.actor_user_id === A.people.OWNER!.id)).toBe(true);
    // UUIDs stripped: a random actor/business uuid can contain '4321' or '1234' by chance.
    const text = withoutUuids(JSON.stringify([...typeRows, ...policyRows, ...employeeRows]));
    for (const secret of ['Secret', 'leak', 'Hidden', 'Private', '4321', '1234', 'Renamed', 'Leave Tester']) expect(text).not.toContain(secret);
  });

  it('a failed change writes no audit entry and changes nothing (one unit of work)', async () => {
    const p = await policy();
    const before = (await audits(p.id)).length;
    expect((await own.patchPolicy(p.id, { version: 9, name: 'Nope' })).status).toBe(409);
    expect((await own.patchPolicy(p.id, { version: 1, granularity: 'HOUR' })).status).toBe(400);
    expect((await audits(p.id)).length).toBe(before);
    expect((await own.revisions(p.id)).body.revisions).toHaveLength(1);
  });
});
