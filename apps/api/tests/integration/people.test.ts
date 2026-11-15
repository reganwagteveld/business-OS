/**
 * People P1: Workforce Foundation, through the real route handlers against PostgreSQL with the
 * migrations and privileged SQL applied as in production. Two independent businesses and every
 * membership role (docs/people-data-model.md).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Permission, Role } from '@/modules/access';

// Custom permission sets for one role at a time, standing in for narrower roles (someone who
// administers employees but may not see personal details, and the reverse). Everything else is the
// real code path: the route wrapper derives permissions from the verified membership through this.
const custom: Partial<Record<Role, Permission[]>> = {};
vi.mock('@/modules/access', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/access')>();
  return { ...real, permissionsFor: (role: Role) => custom[role] ?? real.permissionsFor(role) };
});

import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as membersRoute from '@/app/api/v1/b/[slug]/members/route';
import * as memberRoute from '@/app/api/v1/b/[slug]/members/[membershipId]/route';
import * as contextRoute from '@/app/api/v1/b/[slug]/route';
import * as customersRoute from '@/app/api/v1/b/[slug]/customers/route';
import * as projectsRoute from '@/app/api/v1/b/[slug]/projects/route';
import * as employeesRoute from '@/app/api/v1/b/[slug]/people/employees/route';
import * as employeeRoute from '@/app/api/v1/b/[slug]/people/employees/[employeeId]/route';
import * as statusRoute from '@/app/api/v1/b/[slug]/people/employees/[employeeId]/status/route';
import * as departmentChangeRoute from '@/app/api/v1/b/[slug]/people/employees/[employeeId]/department/route';
import * as managerChangeRoute from '@/app/api/v1/b/[slug]/people/employees/[employeeId]/manager/route';
import * as historyRoute from '@/app/api/v1/b/[slug]/people/employees/[employeeId]/history/route';
import * as personalRoute from '@/app/api/v1/b/[slug]/people/employees/[employeeId]/personal/route';
import * as departmentsRoute from '@/app/api/v1/b/[slug]/people/departments/route';
import * as departmentRoute from '@/app/api/v1/b/[slug]/people/departments/[departmentId]/route';
import * as archiveDepartmentRoute from '@/app/api/v1/b/[slug]/people/departments/[departmentId]/archive/route';
import * as restoreDepartmentRoute from '@/app/api/v1/b/[slug]/people/departments/[departmentId]/restore/route';
import * as locationsRoute from '@/app/api/v1/b/[slug]/people/locations/route';
import * as locationRoute from '@/app/api/v1/b/[slug]/people/locations/[locationId]/route';
import * as archiveLocationRoute from '@/app/api/v1/b/[slug]/people/locations/[locationId]/archive/route';
import * as restoreLocationRoute from '@/app/api/v1/b/[slug]/people/locations/[locationId]/restore/route';
import { devOutbox } from '@/core/email';

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
const IP_BLOCK = Number(process.env.PEOPLE_TEST_IP_BLOCK ?? 90);
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
  await authRoute.POST(req('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: prefix } }));
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

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const api = (who: User, slug: string) => {
  const base = `/api/v1/b/${slug}/people`;
  const e = (employeeId: string) => ctx({ slug, employeeId });
  const get = (id: string) => employeeRoute.GET(req('GET', `${base}/employees/${id}`, { cookie: who.cookie }), e(id)).then(json);
  /** Sends the current version, as a client showing fresh data would. */
  const fresh = async (id: string, body: Record<string, unknown>) => ({ version: (await get(id)).body.employee?.version ?? 1, ...body });
  return {
    list: (qs = '') => employeesRoute.GET(req('GET', `${base}/employees${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    create: (body: unknown) => employeesRoute.POST(req('POST', `${base}/employees`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    get,
    patch: (id: string, body: unknown) => employeeRoute.PATCH(req('PATCH', `${base}/employees/${id}`, { cookie: who.cookie, body }), e(id)).then(json),
    update: async (id: string, body: Record<string, unknown>) =>
      employeeRoute.PATCH(req('PATCH', `${base}/employees/${id}`, { cookie: who.cookie, body: await fresh(id, body) }), e(id)).then(json),
    statusRaw: (id: string, body: unknown) => statusRoute.POST(req('POST', `${base}/employees/${id}/status`, { cookie: who.cookie, body }), e(id)).then(json),
    status: async (id: string, body: Record<string, unknown>) =>
      statusRoute.POST(req('POST', `${base}/employees/${id}/status`, { cookie: who.cookie, body: await fresh(id, body) }), e(id)).then(json),
    departmentRaw: (id: string, body: unknown) =>
      departmentChangeRoute.POST(req('POST', `${base}/employees/${id}/department`, { cookie: who.cookie, body }), e(id)).then(json),
    department: async (id: string, departmentId: string | null, extra: Record<string, unknown> = {}) =>
      departmentChangeRoute.POST(req('POST', `${base}/employees/${id}/department`, { cookie: who.cookie, body: await fresh(id, { departmentId, ...extra }) }), e(id)).then(json),
    managerRaw: (id: string, body: unknown) => managerChangeRoute.POST(req('POST', `${base}/employees/${id}/manager`, { cookie: who.cookie, body }), e(id)).then(json),
    manager: async (id: string, managerEmployeeId: string | null, extra: Record<string, unknown> = {}) =>
      managerChangeRoute.POST(req('POST', `${base}/employees/${id}/manager`, { cookie: who.cookie, body: await fresh(id, { managerEmployeeId, ...extra }) }), e(id)).then(json),
    history: (id: string) => historyRoute.GET(req('GET', `${base}/employees/${id}/history`, { cookie: who.cookie }), e(id)).then(json),
    personal: (id: string) => personalRoute.GET(req('GET', `${base}/employees/${id}/personal`, { cookie: who.cookie }), e(id)).then(json),
    setPersonal: (id: string, body: unknown) => personalRoute.PATCH(req('PATCH', `${base}/employees/${id}/personal`, { cookie: who.cookie, body }), e(id)).then(json),
    departments: (qs = '') => departmentsRoute.GET(req('GET', `${base}/departments${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    createDepartment: (body: unknown) => departmentsRoute.POST(req('POST', `${base}/departments`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    patchDepartment: (id: string, body: unknown) =>
      departmentRoute.PATCH(req('PATCH', `${base}/departments/${id}`, { cookie: who.cookie, body }), ctx({ slug, departmentId: id })).then(json),
    archiveDepartment: (id: string) =>
      archiveDepartmentRoute.POST(req('POST', `${base}/departments/${id}/archive`, { cookie: who.cookie }), ctx({ slug, departmentId: id })).then(json),
    restoreDepartment: (id: string) =>
      restoreDepartmentRoute.POST(req('POST', `${base}/departments/${id}/restore`, { cookie: who.cookie }), ctx({ slug, departmentId: id })).then(json),
    locations: (qs = '') => locationsRoute.GET(req('GET', `${base}/locations${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    createLocation: (body: unknown) => locationsRoute.POST(req('POST', `${base}/locations`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    patchLocation: (id: string, body: unknown) =>
      locationRoute.PATCH(req('PATCH', `${base}/locations/${id}`, { cookie: who.cookie, body }), ctx({ slug, locationId: id })).then(json),
    archiveLocation: (id: string) =>
      archiveLocationRoute.POST(req('POST', `${base}/locations/${id}/archive`, { cookie: who.cookie }), ctx({ slug, locationId: id })).then(json),
    restoreLocation: (id: string) =>
      restoreLocationRoute.POST(req('POST', `${base}/locations/${id}/restore`, { cookie: who.cookie }), ctx({ slug, locationId: id })).then(json),
    members: () => membersRoute.GET(req('GET', `/api/v1/b/${slug}/members`, { cookie: who.cookie }), ctx({ slug })).then(json),
    removeMember: (membershipId: string) =>
      memberRoute.DELETE(req('DELETE', `/api/v1/b/${slug}/members/${membershipId}`, { cookie: who.cookie }), ctx({ slug, membershipId })).then(json),
    context: () => contextRoute.GET(req('GET', `/api/v1/b/${slug}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    customers: () => customersRoute.GET(req('GET', `/api/v1/b/${slug}/customers`, { cookie: who.cookie }), ctx({ slug })).then(json),
    createCustomer: (body: unknown) => customersRoute.POST(req('POST', `/api/v1/b/${slug}/customers`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    projects: () => projectsRoute.GET(req('GET', `/api/v1/b/${slug}/projects`, { cookie: who.cookie }), ctx({ slug })).then(json),
    createProject: (body: unknown) => projectsRoute.POST(req('POST', `/api/v1/b/${slug}/projects`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
  };
};
const audits = async (targetId: string) =>
  (await admin.query('SELECT action, actor_user_id, business_id, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows;

/** Today in the test businesses' time zone (effective dates are business dates). */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Perth', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const daysFromToday = (n: number) => {
  const d = new Date(`${today()}T00:00:00Z`);
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

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
beforeAll(async () => {
  A = await team('ea');
  B = await team('eb');
}, 120_000);

describe('employees: create, read, update', () => {
  it('creates a pending employee with defaults; history and audit hold no names', async () => {
    const a = api(A.people.ADMIN!, A.slug);
    const created = await a.create({ givenName: '  Priya ', familyName: 'Ramanathan', jobTitle: 'Site lead', workEmail: 'PRIYA@Example.com' });
    expect(created.status).toBe(201);
    const emp = created.body.employee;
    expect(emp).toMatchObject({
      givenName: 'Priya', familyName: 'Ramanathan', displayName: 'Priya Ramanathan', status: 'PENDING', startDate: null, endDate: null,
      department: null, manager: null, location: null, userId: null, employeeNumber: null, workEmail: 'priya@example.com', version: 1,
    });
    expect(Object.keys(emp)).not.toContain('personalEmail');
    const { rows } = await admin.query('SELECT business_id FROM people_employees WHERE id = $1', [emp.id]);
    expect(rows[0].business_id).toBe(A.businessId);
    const history = (await a.history(emp.id)).body;
    expect(history.status).toMatchObject([{ fromStatus: null, toStatus: 'PENDING', effectiveDate: today() }]);
    expect((await audits(emp.id)).map((x) => x.action)).toEqual(['people.employee.created']);
    expect(JSON.stringify(await audits(emp.id))).not.toMatch(/priya|ramanathan/i);
  });

  it('validates input and rejects out-of-scope fields (tax, bank, identity documents, business id, status)', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const ok = { givenName: 'X', familyName: 'Y' };
    for (const body of [
      {}, { givenName: 'X' }, { ...ok, givenName: '' }, { ...ok, familyName: 'x'.repeat(101) }, { ...ok, workEmail: 'not-an-email' },
      { ...ok, employeeNumber: '-bad' }, { ...ok, employeeNumber: 'x'.repeat(31) }, { ...ok, employmentType: 'INTERN' }, { ...ok, status: 'TERMINATED' },
      { ...ok, status: 'ON_LEAVE' }, { ...ok, startDate: '2026-02-30' }, { ...ok, taxFileNumber: '123456782' }, { ...ok, bankAccount: '062-000 1234' },
      { ...ok, passportNumber: 'N1234567' }, { ...ok, dateOfBirth: '1990-01-01' }, { ...ok, businessId: B.businessId }, { ...ok, salary: 100000 },
      { ...ok, latitude: -31.95 },
    ]) {
      expect((await a.create(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    // ACTIVE needs a start date that is not in the future; by default it is today.
    expect(await a.create({ ...ok, status: 'ACTIVE', startDate: daysFromToday(3) })).toMatchObject({ status: 400, body: { error: 'future_effective_date' } });
    expect((await a.create({ ...ok, status: 'ACTIVE' })).body.employee).toMatchObject({ status: 'ACTIVE', startDate: today() });
    // PENDING may carry a planned (future) start date.
    expect((await a.create({ ...ok, startDate: daysFromToday(10) })).body.employee).toMatchObject({ status: 'PENDING', startDate: daysFromToday(10) });
  });

  it('employee numbers are unique per business ignoring case, but independent between businesses', async () => {
    const a = api(A.people.ADMIN!, A.slug);
    const b = api(B.people.ADMIN!, B.slug);
    const first = (await a.create({ givenName: 'N', familyName: 'One', employeeNumber: 'EMP-0042' })).body.employee;
    expect(first.employeeNumber).toBe('EMP-0042');
    expect(await a.create({ givenName: 'N', familyName: 'Two', employeeNumber: 'emp-0042' })).toMatchObject({ status: 409, body: { error: 'duplicate_employee_number' } });
    expect((await b.create({ givenName: 'N', familyName: 'Other', employeeNumber: 'EMP-0042' })).status).toBe(201);
    const second = (await a.create({ givenName: 'N', familyName: 'Three', employeeNumber: 'EMP-0043' })).body.employee;
    expect(await a.update(second.id, { employeeNumber: 'Emp-0042' })).toMatchObject({ status: 409, body: { error: 'duplicate_employee_number' } });
    // A terminated employee still holds their number.
    await a.status(first.id, { status: 'TERMINATED', reason: 'Offer withdrawn' });
    expect((await a.create({ givenName: 'N', familyName: 'Four', employeeNumber: 'EMP-0042' })).status).toBe(409);
    // Changing a number is audited with the old and new value; blank clears it.
    expect((await a.update(second.id, { employeeNumber: 'EMP-0099' })).body.employee.employeeNumber).toBe('EMP-0099');
    expect((await a.update(second.id, { employeeNumber: '' })).body.employee.employeeNumber).toBeNull();
    const numberAudits = (await audits(second.id)).filter((x) => x.action === 'people.employee.number_changed');
    expect(numberAudits.map((x) => x.metadata)).toEqual([{ from: 'EMP-0043', to: 'EMP-0099' }, { from: 'EMP-0099', to: null }]);
    // Simultaneous creates with one number: one wins, the rest get the same stable error (index backstop).
    const raced = await Promise.all([1, 2, 3].map((n) => a.create({ givenName: 'Race', familyName: `N${n}`, employeeNumber: 'RACE-1' })));
    expect(raced.filter((r) => r.status === 201)).toHaveLength(1);
    expect(raced.filter((r) => r.status === 409 && r.body.error === 'duplicate_employee_number')).toHaveLength(2);
    // Database backstop: a race past the service check still fails on the unique index.
    const code = await asApp(A.businessId, (c) => c.query(
      "INSERT INTO people_employees (id, business_id, given_name, family_name, employee_number) VALUES ($1, $2, 'R', 'Race', 'EMP-0042')",
      [randomUUID(), A.businessId],
    ).then(() => null, (err) => err.code));
    expect(code).toBe('23505');
  });

  it('refuses a stale edit and lets exactly one of several simultaneous edits win', async () => {
    const a = api(A.people.ADMIN!, A.slug);
    const emp = (await a.create({ givenName: 'Con', familyName: 'Current' })).body.employee;
    expect((await a.patch(emp.id, { version: 1, jobTitle: 'Planner' })).body.employee.version).toBe(2);
    expect(await a.patch(emp.id, { version: 1, jobTitle: 'Overwrite' })).toMatchObject({ status: 409, body: { error: 'stale' } });
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => a.patch(emp.id, { version: 2, jobTitle: `Edit ${i}` })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error === 'stale')).toHaveLength(4);
    expect((await a.get(emp.id)).body.employee.version).toBe(3);
    // Status, department and manager are not PATCH fields.
    for (const body of [{ version: 3, status: 'ACTIVE' }, { version: 3, departmentId: randomUUID() }, { version: 3, endDate: '2026-01-01' }]) {
      expect((await a.patch(emp.id, body)).status).toBe(400);
    }
  });

  it('lists with search, filters and every sort order, paging with no gaps or repeats', async () => {
    const L = await team('el');
    const a = api(L.people.OWNER!, L.slug);
    const dept = (await a.createDepartment({ name: 'Field' })).body.department;
    const loc = (await a.createLocation({ name: 'Depot' })).body.location;
    const boss = (await a.create({ givenName: 'Bea', familyName: 'Zimmer', status: 'ACTIVE', employeeNumber: 'B1' })).body.employee;
    const specs: [string, string, string | null][] = [
      ['Ana', 'Alvarez', 'A3'], ['ben', 'alvarez', null], ['Cy', 'Brown', 'A1'], ['Dee', 'Chen', 'a2'], ['Eli', 'Chen', null], ['Fay', 'Dunn', 'C9'],
    ];
    const ids: string[] = [boss.id];
    for (const [givenName, familyName, employeeNumber] of specs) {
      ids.push((await a.create({ givenName, familyName, employeeNumber, status: 'ACTIVE', departmentId: dept.id, locationId: loc.id, managerEmployeeId: boss.id })).body.employee.id);
    }
    expect((await a.list('?q=CHEN')).body.employees.map((x: { givenName: string }) => x.givenName).sort()).toEqual(['Dee', 'Eli']);
    expect((await a.list('?q=a2')).body.employees.map((x: { givenName: string }) => x.givenName)).toEqual(['Dee']);
    expect((await a.list(`?departmentId=${dept.id}&limit=100`)).body.employees).toHaveLength(6);
    expect((await a.list(`?locationId=${loc.id}&limit=100`)).body.employees).toHaveLength(6);
    expect((await a.list(`?managerEmployeeId=${boss.id}&limit=100`)).body.employees).toHaveLength(6);
    expect((await a.list(`?managerEmployeeId=${ids[1]}`)).body.employees).toHaveLength(0);
    await a.manager(ids[6]!, null);
    await a.status(ids[6]!, { status: 'TERMINATED' });
    expect((await a.list('?limit=100')).body.employees).toHaveLength(6); // current = not terminated
    expect((await a.list('?status=TERMINATED')).body.employees.map((x: { id: string }) => x.id)).toEqual([ids[6]]);

    const all = async (sort: string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const page: { status: number; body: { employees: { id: string }[]; nextCursor: string | null } } =
          await a.list(`?status=all&sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        expect(page.status).toBe(200);
        seen.push(...page.body.employees.map((x) => x.id));
        cursor = page.body.nextCursor;
        if (!cursor) break;
      }
      return seen;
    };
    for (const sort of ['name', 'number', 'newest']) {
      const seen = await all(sort);
      expect(new Set(seen).size, sort).toBe(7);
      expect(seen.length, sort).toBe(7);
    }
    const byNumber = await all('number');
    expect(byNumber.slice(-2).sort()).toEqual([ids[2], ids[5]].sort()); // unnumbered last
    expect((await a.list('?cursor=bogus')).status).toBe(400);
    expect((await a.list('?sort=salary')).status).toBe(400);
  });
});

describe('tenant isolation', () => {
  it("another business's employees, org units and members are invisible and unusable", async () => {
    const a = api(A.people.OWNER!, A.slug);
    const b = api(B.people.OWNER!, B.slug);
    const deptA = (await a.createDepartment({ name: 'Isolation dept' })).body.department;
    const locA = (await a.createLocation({ name: 'Isolation site' })).body.location;
    const empA = (await a.create({ givenName: 'Iso', familyName: 'Lated', status: 'ACTIVE', departmentId: deptA.id, locationId: locA.id })).body.employee;
    const empB = (await b.create({ givenName: 'Other', familyName: 'Tenant', status: 'ACTIVE' })).body.employee;

    // Reading or changing A's records from B answers 404, exactly like an id that does not exist.
    expect((await b.get(empA.id)).status).toBe(404);
    expect((await b.patch(empA.id, { version: 1, jobTitle: 'Hijack' })).status).toBe(404);
    expect((await b.statusRaw(empA.id, { version: 1, status: 'TERMINATED' })).status).toBe(404);
    expect((await b.history(empA.id)).status).toBe(404);
    expect((await b.personal(empA.id)).status).toBe(404);
    expect((await b.patchDepartment(deptA.id, { version: 1, name: 'Hijack' })).status).toBe(404);
    expect((await b.archiveLocation(locA.id)).status).toBe(404);
    expect((await b.list('?status=all&limit=100')).body.employees.map((x: { id: string }) => x.id)).not.toContain(empA.id);
    expect((await b.departments('?archived=all&limit=100')).body.departments.map((x: { id: string }) => x.id)).not.toContain(deptA.id);

    // A's ids cannot be used inside B: departments, locations, managers and users of another business.
    expect(await b.create({ givenName: 'X', familyName: 'Y', departmentId: deptA.id })).toMatchObject({ status: 400, body: { error: 'invalid_department' } });
    expect(await b.create({ givenName: 'X', familyName: 'Y', locationId: locA.id })).toMatchObject({ status: 400, body: { error: 'invalid_location' } });
    expect(await b.create({ givenName: 'X', familyName: 'Y', managerEmployeeId: empA.id })).toMatchObject({ status: 400, body: { error: 'invalid_manager' } });
    expect(await b.create({ givenName: 'X', familyName: 'Y', userId: A.people.MEMBER!.id })).toMatchObject({ status: 400, body: { error: 'invalid_user' } });
    expect(await b.manager(empB.id, empA.id)).toMatchObject({ status: 400, body: { error: 'invalid_manager' } });
    expect(await b.department(empB.id, deptA.id)).toMatchObject({ status: 400, body: { error: 'invalid_department' } });

    // The database refuses cross-tenant links even if the service were bypassed (composite FKs + RLS).
    const fk = await asApp(B.businessId, (c) => c.query(
      'INSERT INTO people_manager_assignments (id, business_id, employee_id, manager_employee_id, starts_on) VALUES ($1, $2, $3, $4, CURRENT_DATE)',
      [randomUUID(), B.businessId, empB.id, empA.id],
    ).then(() => null, (err) => err.code));
    expect(fk).toBe('23503');
    const rls = await asApp(B.businessId, (c) => c.query(
      "INSERT INTO people_employees (id, business_id, given_name, family_name) VALUES ($1, $2, 'Planted', 'Row')", [randomUUID(), A.businessId],
    ).then(() => null, (err) => err.code));
    expect(rls).toBe('42501');
  });

  it('every People table forces RLS; without a tenant context bos_app sees nothing; no DELETE for anyone at runtime', async () => {
    const tables = ['people_departments', 'people_locations', 'people_employees', 'people_employee_personal_details',
      'people_department_assignments', 'people_manager_assignments', 'people_employment_status_history'];
    const { rows } = await admin.query('SELECT relname FROM pg_class WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity', [tables]);
    expect(rows.map((r) => r.relname).sort()).toEqual([...tables].sort());
    for (const role of ['bos_app', 'bos_jobs', 'bos_auth']) {
      const grants = await admin.query("SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name = ANY($2)", [role, tables]);
      if (role === 'bos_app') {
        expect(grants.rows.filter((g) => g.privilege_type === 'DELETE')).toEqual([]);
        expect(grants.rows.filter((g) => g.table_name === 'people_employment_status_history').map((g) => g.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
      } else {
        expect(grants.rows, role).toEqual([]);
      }
    }
    const counts = await asApp(null, async (c) => (await c.query('SELECT (SELECT count(*) FROM people_employees)::int AS e, (SELECT count(*) FROM people_departments)::int AS d')).rows[0]);
    expect(counts).toEqual({ e: 0, d: 0 });
    const own = await asApp(A.businessId, async (c) => (await c.query('SELECT DISTINCT business_id FROM people_employees')).rows.map((r) => r.business_id));
    expect(own).toEqual([A.businessId]);
  });

  it('employee data never appears in customer, project, member or business-context responses', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const marker = `Zq${randomUUID().slice(0, 8)}`;
    const emp = (await a.create({
      givenName: marker, familyName: `${marker}fam`, employeeNumber: marker, workEmail: `${marker.toLowerCase()}@example.com`, userId: A.people.MEMBER!.id,
    })).body.employee;
    await a.setPersonal(emp.id, { version: 0, personalEmail: `${marker.toLowerCase()}@home.example`, homeAddress: `${marker} Street` });
    await a.createCustomer({ type: 'ORGANISATION', displayName: 'Leak check customer' });
    await a.createProject({ name: 'Leak check project', ownerUserId: A.people.MEMBER!.id });
    for (const res of [await a.customers(), await a.projects(), await a.members(), await a.context()]) {
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(marker);
      expect(text).not.toContain(marker.toLowerCase());
      expect(text).not.toContain(emp.id);
    }
  });
});

describe('permissions', () => {
  it('MEMBER has no People access; MANAGER reads the directory only; ADMIN administers', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const emp = (await owner.create({ givenName: 'Perm', familyName: 'Check', status: 'ACTIVE' })).body.employee;
    const dept = (await owner.createDepartment({ name: 'Permission dept' })).body.department;

    const member = api(A.people.MEMBER!, A.slug);
    for (const res of [
      await member.list(), await member.get(emp.id), await member.history(emp.id), await member.departments(), await member.locations(),
      await member.create({ givenName: 'X', familyName: 'Y' }), await member.personal(emp.id),
    ]) expect(res).toMatchObject({ status: 403, body: { error: 'forbidden' } });

    const manager = api(A.people.MANAGER!, A.slug);
    expect((await manager.list()).status).toBe(200);
    expect((await manager.get(emp.id)).status).toBe(200);
    expect((await manager.history(emp.id)).status).toBe(200);
    expect((await manager.departments()).status).toBe(200);
    for (const res of [
      await manager.create({ givenName: 'X', familyName: 'Y' }), await manager.patch(emp.id, { version: 1, jobTitle: 'No' }),
      await manager.statusRaw(emp.id, { version: 1, status: 'ON_LEAVE' }), await manager.departmentRaw(emp.id, { version: 1, departmentId: dept.id }),
      await manager.managerRaw(emp.id, { version: 1, managerEmployeeId: null }), await manager.personal(emp.id),
      await manager.setPersonal(emp.id, { version: 0, personalPhone: '1' }), await manager.createDepartment({ name: 'No' }),
      await manager.archiveDepartment(dept.id), await manager.createLocation({ name: 'No' }),
    ]) expect(res).toMatchObject({ status: 403, body: { error: 'forbidden' } });

    const adminApi = api(A.people.ADMIN!, A.slug);
    expect((await adminApi.status(emp.id, { status: 'ON_LEAVE', reason: 'Medical' })).status).toBe(200);
    expect((await adminApi.createLocation({ name: 'Admin site' })).status).toBe(201);
    // The reason on status history is sensitive: hidden from the directory, visible with read_sensitive.
    expect((await manager.history(emp.id)).body.status.at(-1)).toMatchObject({ toStatus: 'ON_LEAVE', reason: null });
    expect((await adminApi.history(emp.id)).body.status.at(-1)).toMatchObject({ toStatus: 'ON_LEAVE', reason: 'Medical' });
    expect(JSON.stringify(await audits(emp.id))).not.toMatch(/medical/i);
  });

  it('view and administer are separate: manage without read_sensitive cannot touch personal details, and the reverse cannot edit', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const emp = (await owner.create({ givenName: 'Split', familyName: 'Keys' })).body.employee;
    custom.MANAGER = ['business:read', 'people:read', 'people:manage'];
    const manageOnly = api(A.people.MANAGER!, A.slug);
    expect((await manageOnly.update(emp.id, { jobTitle: 'Allowed' })).status).toBe(200);
    expect((await manageOnly.personal(emp.id)).status).toBe(403);
    expect((await manageOnly.setPersonal(emp.id, { version: 0, personalPhone: '0400 000 000' })).status).toBe(403);
    custom.MANAGER = ['business:read', 'people:read', 'people:read_sensitive'];
    const sensitiveOnly = api(A.people.MANAGER!, A.slug);
    expect((await sensitiveOnly.personal(emp.id)).status).toBe(200);
    expect((await sensitiveOnly.setPersonal(emp.id, { version: 0, personalPhone: '0400 000 000' })).status).toBe(403);
    expect((await sensitiveOnly.patch(emp.id, { version: 2, jobTitle: 'No' })).status).toBe(403);
    // Configuring departments is its own key, too.
    custom.MANAGER = ['business:read', 'people:read', 'people:manage'];
    expect((await api(A.people.MANAGER!, A.slug).createDepartment({ name: 'Needs configure' })).status).toBe(403);
    // No other Zone's keys grant People access.
    custom.MANAGER = ['business:read', 'customers:read', 'customers:write', 'projects:read', 'finance:read', 'members:manage'];
    expect((await api(A.people.MANAGER!, A.slug).list()).status).toBe(403);
  });

  it('personal details: created on first save, audited by field name only, versioned', async () => {
    const a = api(A.people.ADMIN!, A.slug);
    const emp = (await a.create({ givenName: 'Pers', familyName: 'Onal' })).body.employee;
    expect((await a.personal(emp.id)).body.personalDetails).toMatchObject({ personalEmail: null, version: 0, updatedAt: null });
    const saved = await a.setPersonal(emp.id, {
      version: 0, personalEmail: 'Pers@Home.Example', homeAddress: '1 Hidden Lane', emergencyContactName: 'Kin', emergencyContactPhone: '0400 111 222',
    });
    expect(saved.body.personalDetails).toMatchObject({ personalEmail: 'pers@home.example', homeAddress: '1 Hidden Lane', version: 1 });
    expect(await a.setPersonal(emp.id, { version: 0, personalPhone: '1' })).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect((await a.setPersonal(emp.id, { version: 1, homeAddress: null })).body.personalDetails).toMatchObject({ homeAddress: null, personalEmail: 'pers@home.example', version: 2 });
    for (const body of [{ version: 2 }, { version: 2, taxFileNumber: '1' }, { version: 2, personalEmail: 'nope' }, { version: 2, dateOfBirth: '1990-01-01' }]) {
      expect((await a.setPersonal(emp.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    const events = (await audits(emp.id)).filter((x) => x.action === 'people.employee.personal_details_updated');
    expect(events.map((x) => x.metadata)).toEqual([
      { fields: ['emergencyContactName', 'emergencyContactPhone', 'homeAddress', 'personalEmail'] }, { fields: ['homeAddress'] },
    ]);
    expect(JSON.stringify(await audits(emp.id))).not.toMatch(/hidden|home\.example|0400/i);
    // Two first saves racing: exactly one wins.
    const other = (await a.create({ givenName: 'Race', familyName: 'Personal' })).body.employee;
    const results = await Promise.all([1, 2, 3].map((n) => a.setPersonal(other.id, { version: 0, personalPhone: `0400 000 00${n}` })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error === 'stale')).toHaveLength(2);
  });
});

describe('lifecycle', () => {
  it('moves through every allowed transition, keeping start/end dates and a full history', async () => {
    const a = api(A.people.ADMIN!, A.slug);
    const emp = (await a.create({ givenName: 'Life', familyName: 'Cycle', startDate: daysFromToday(30) })).body.employee;
    const activated = (await a.status(emp.id, { status: 'ACTIVE', effectiveDate: today() })).body.employee;
    expect(activated).toMatchObject({ status: 'ACTIVE', startDate: today(), endDate: null });
    expect((await a.status(emp.id, { status: 'ON_LEAVE' })).body.employee.status).toBe('ON_LEAVE');
    expect((await a.status(emp.id, { status: 'ACTIVE' })).body.employee.status).toBe('ACTIVE');
    const terminated = (await a.status(emp.id, { status: 'TERMINATED', reason: 'Resigned' })).body.employee;
    expect(terminated).toMatchObject({ status: 'TERMINATED', endDate: today() });
    // A terminated record is closed: no new assignments or user link; a rehire reopens it.
    expect((await a.update(emp.id, { userId: A.people.MEMBER!.id })).body).toMatchObject({ error: 'terminated' });
    const rehired = (await a.status(emp.id, { status: 'ACTIVE' })).body.employee;
    expect(rehired).toMatchObject({ status: 'ACTIVE', startDate: today(), endDate: null });
    const history = (await a.history(emp.id)).body.status.map((s: { fromStatus: string | null; toStatus: string }) => `${s.fromStatus}>${s.toStatus}`);
    expect(history).toEqual(['null>PENDING', 'PENDING>ACTIVE', 'ACTIVE>ON_LEAVE', 'ON_LEAVE>ACTIVE', 'ACTIVE>TERMINATED', 'TERMINATED>ACTIVE']);
    expect((await audits(emp.id)).filter((x) => x.action === 'people.employee.status_changed')).toHaveLength(5);
    // Rehire to PENDING clears the start date until the new start is planned.
    await a.status(emp.id, { status: 'TERMINATED' });
    expect((await a.status(emp.id, { status: 'PENDING' })).body.employee).toMatchObject({ status: 'PENDING', startDate: null, endDate: null });
    // Withdrawal before start.
    await a.update(emp.id, { startDate: daysFromToday(14) });
    expect((await a.status(emp.id, { status: 'TERMINATED', reason: 'Offer withdrawn' })).body.employee).toMatchObject({ status: 'TERMINATED', startDate: null, endDate: today() });
  });

  it('refuses invalid transitions, future and out-of-order dates, and stale versions', async () => {
    const a = api(A.people.ADMIN!, A.slug);
    const emp = (await a.create({ givenName: 'Bad', familyName: 'Moves', status: 'ACTIVE', startDate: '2026-03-02' })).body.employee;
    expect(await a.status(emp.id, { status: 'PENDING' })).toMatchObject({ status: 409, body: { error: 'invalid_transition' } });
    expect(await a.status(emp.id, { status: 'ACTIVE' })).toMatchObject({ status: 409, body: { error: 'invalid_transition' } });
    expect(await a.status(emp.id, { status: 'ON_LEAVE', effectiveDate: daysFromToday(2) })).toMatchObject({ status: 400, body: { error: 'future_effective_date' } });
    expect(await a.status(emp.id, { status: 'TERMINATED', effectiveDate: '2026-03-01' })).toMatchObject({ status: 400, body: { error: 'effective_date_order' } });
    expect(await a.statusRaw(emp.id, { version: 99, status: 'ON_LEAVE' })).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect((await a.statusRaw(emp.id, { status: 'ON_LEAVE' })).status).toBe(400); // version is required
    expect(await a.update(emp.id, { startDate: '2026-03-03' })).toMatchObject({ status: 409, body: { error: 'start_date_locked' } });
    const pending = (await a.create({ givenName: 'Not', familyName: 'Started' })).body.employee;
    expect(await a.status(pending.id, { status: 'ON_LEAVE' })).toMatchObject({ status: 409, body: { error: 'invalid_transition' } });
    // Two simultaneous transitions from the same version: exactly one is applied and recorded.
    const v = (await a.get(emp.id)).body.employee.version;
    const results = await Promise.all([
      a.statusRaw(emp.id, { version: v, status: 'ON_LEAVE' }), a.statusRaw(emp.id, { version: v, status: 'TERMINATED' }), a.statusRaw(emp.id, { version: v, status: 'ON_LEAVE' }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await a.history(emp.id)).body.status).toHaveLength(2);
  });

  it('the database enforces the state machine and append-only history even when the service is bypassed', async () => {
    const a = api(A.people.ADMIN!, A.slug);
    const emp = (await a.create({ givenName: 'Db', familyName: 'Guard' })).body.employee;
    const code = (sql: string, params: unknown[]) => asApp(A.businessId, (c) => sqlError(c.query(sql, params)));
    expect(await code("UPDATE people_employees SET status = 'ON_LEAVE', start_date = CURRENT_DATE WHERE id = $1", [emp.id])).toBe('PE001');
    expect(await code("UPDATE people_employees SET status = 'ACTIVE' WHERE id = $1", [emp.id])).toBe('23514'); // active needs a start date
    expect(await code("INSERT INTO people_employees (id, business_id, given_name, family_name, status, start_date, end_date) VALUES ($1, $2, 'T', 'T', 'TERMINATED', CURRENT_DATE, CURRENT_DATE)", [randomUUID(), A.businessId])).toBe('PE001');
    expect(await code('UPDATE people_employment_status_history SET reason = $2 WHERE employee_id = $1', [emp.id, 'rewritten'])).toBe('42501');
    expect(await code('DELETE FROM people_employment_status_history WHERE employee_id = $1', [emp.id])).toBe('42501');
    expect(await code('DELETE FROM people_employees WHERE id = $1', [emp.id])).toBe('42501');
    expect(await code('UPDATE people_employees SET created_by_id = NULL WHERE id = $1', [emp.id])).toBe('42501'); // identity columns are not granted
    // Even a role that bypasses RLS and holds every grant hits the guard trigger: history is append-only.
    expect(await sqlError(admin.query('UPDATE people_employment_status_history SET reason = NULL WHERE employee_id = $1', [emp.id]))).toBe('PE004');
    expect(await sqlError(admin.query('DELETE FROM people_employment_status_history WHERE employee_id = $1', [emp.id]))).toBe('PE004');
  });
});

describe('reporting lines', () => {
  it('refuses self-management, terminated managers and cycles; keeps closed lines in history', async () => {
    const a = api(A.people.ADMIN!, A.slug);
    const mk = async (name: string) => (await a.create({ givenName: name, familyName: 'Line', status: 'ACTIVE', startDate: '2026-01-05' })).body.employee;
    const ceo = await mk('Ceo');
    const vp = await mk('Vp');
    const lead = await mk('Lead');
    const dev = await mk('Dev');
    expect((await a.manager(vp.id, ceo.id)).body.employee.manager).toMatchObject({ id: ceo.id, name: 'Ceo Line', status: 'ACTIVE' });
    await a.manager(lead.id, vp.id);
    await a.manager(dev.id, lead.id);
    expect(await a.manager(dev.id, dev.id)).toMatchObject({ status: 400, body: { error: 'invalid_manager' } });
    expect(await a.manager(ceo.id, dev.id)).toMatchObject({ status: 409, body: { error: 'manager_cycle' } });
    expect(await a.manager(vp.id, lead.id)).toMatchObject({ status: 409, body: { error: 'manager_cycle' } });
    // Re-pointing within the tree is fine, and the closed line stays in history.
    expect((await a.manager(dev.id, vp.id)).body.employee.manager.id).toBe(vp.id);
    const lines = (await a.history(dev.id)).body.managers;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ manager: { id: lead.id }, startsOn: today(), endsOn: today() });
    expect(lines[1]).toMatchObject({ manager: { id: vp.id }, endsOn: null });
    // Terminating someone with direct reports is refused until they are reassigned.
    expect(await a.status(lead.id, { status: 'TERMINATED' })).toMatchObject({ status: 200 }); // lead has no reports now
    expect(await a.status(vp.id, { status: 'TERMINATED' })).toMatchObject({ status: 409, body: { error: 'has_direct_reports' } });
    expect(await a.manager(dev.id, lead.id)).toMatchObject({ status: 400, body: { error: 'invalid_manager' } }); // lead is terminated
    // Terminating closes the leaver's own reporting line; the history keeps it.
    expect((await a.get(lead.id)).body.employee.manager).toBeNull();
    expect((await a.history(lead.id)).body.managers).toMatchObject([{ manager: { id: vp.id }, endsOn: today() }]);
    expect(await a.manager(lead.id, vp.id)).toMatchObject({ status: 409, body: { error: 'terminated' } });

    // Database backstops: cycle, self, terminated manager and rewriting a closed line.
    const code = (sql: string, params: unknown[]) => asApp(A.businessId, (c) => sqlError(c.query(sql, params)));
    const ins = 'INSERT INTO people_manager_assignments (id, business_id, employee_id, manager_employee_id, starts_on) VALUES ($1, $2, $3, $4, CURRENT_DATE)';
    expect(await code(ins, [randomUUID(), A.businessId, ceo.id, dev.id])).toBe('PE002');
    expect(await code(ins, [randomUUID(), A.businessId, ceo.id, ceo.id])).toBe('PE002'); // self: the trigger sees a cycle of one (the CHECK is a second backstop)
    expect(await code(ins, [randomUUID(), A.businessId, ceo.id, lead.id])).toBe('PE003');
    expect(await code(ins, [randomUUID(), A.businessId, lead.id, ceo.id])).toBe('PE006');
    expect(await code('UPDATE people_manager_assignments SET ends_on = NULL, ended_at = NULL, ended_by_id = NULL WHERE employee_id = $1', [dev.id])).toBe('PE004');
    expect(await code('UPDATE people_manager_assignments SET manager_employee_id = $2 WHERE employee_id = $1 AND ends_on IS NULL', [dev.id, ceo.id])).toBe('42501');
    expect(await code('DELETE FROM people_manager_assignments WHERE employee_id = $1', [dev.id])).toBe('42501');
  });

  it('two simultaneous changes that would form a cycle: exactly one succeeds', async () => {
    const a = api(A.people.ADMIN!, A.slug);
    for (let round = 0; round < 3; round++) {
      const x = (await a.create({ givenName: `X${round}`, familyName: 'Race', status: 'ACTIVE' })).body.employee;
      const y = (await a.create({ givenName: `Y${round}`, familyName: 'Race', status: 'ACTIVE' })).body.employee;
      const results = await Promise.all([
        a.managerRaw(x.id, { version: x.version, managerEmployeeId: y.id }), a.managerRaw(y.id, { version: y.version, managerEmployeeId: x.id }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body.error).toBe('manager_cycle');
    }
  });

  it('a termination racing a new direct report cannot leave a report under a terminated manager', async () => {
    const a = api(A.people.ADMIN!, A.slug);
    for (let round = 0; round < 3; round++) {
      const boss = (await a.create({ givenName: `Boss${round}`, familyName: 'Race', status: 'ACTIVE' })).body.employee;
      const report = (await a.create({ givenName: `Rep${round}`, familyName: 'Race', status: 'ACTIVE' })).body.employee;
      const [assign, terminate] = await Promise.all([
        a.managerRaw(report.id, { version: report.version, managerEmployeeId: boss.id }), a.statusRaw(boss.id, { version: boss.version, status: 'TERMINATED' }),
      ]);
      expect([assign.status, terminate.status].filter((s) => s === 200)).toHaveLength(1);
      const { rows } = await admin.query(
        "SELECT count(*)::int AS n FROM people_manager_assignments m JOIN people_employees e ON e.id = m.manager_employee_id WHERE m.ends_on IS NULL AND e.status = 'TERMINATED' AND e.business_id = $1",
        [A.businessId],
      );
      expect(rows[0].n).toBe(0);
    }
  });
});

describe('departments and locations', () => {
  it('create, rename, archive (only when empty), restore; names unique among active units', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const ops = (await a.createDepartment({ name: 'Operations', description: 'Runs the place' })).body.department;
    expect(ops).toMatchObject({ name: 'Operations', description: 'Runs the place', archivedAt: null, version: 1 });
    expect(await a.createDepartment({ name: ' operations ' })).toMatchObject({ status: 409, body: { error: 'duplicate_name' } });
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(121) }, { name: 'Ok', parentDepartmentId: randomUUID() }]) {
      expect((await a.createDepartment(body)).status).toBe(400);
    }
    expect((await a.patchDepartment(ops.id, { version: 1, name: 'Ops' })).body.department).toMatchObject({ name: 'Ops', version: 2 });
    expect(await a.patchDepartment(ops.id, { version: 1, name: 'Stale' })).toMatchObject({ status: 409, body: { error: 'stale' } });

    const emp = (await a.create({ givenName: 'Dept', familyName: 'Member', status: 'ACTIVE', departmentId: ops.id })).body.employee;
    expect(emp.department).toMatchObject({ id: ops.id, name: 'Ops', archived: false });
    expect(await a.archiveDepartment(ops.id)).toMatchObject({ status: 409, body: { error: 'in_use' } });
    await a.department(emp.id, null);
    const archived = (await a.archiveDepartment(ops.id)).body.department;
    expect(archived.archivedAt).not.toBeNull();
    expect(await a.archiveDepartment(ops.id)).toMatchObject({ status: 409, body: { error: 'archived' } });
    expect(await a.patchDepartment(ops.id, { version: archived.version, name: 'Edit archived' })).toMatchObject({ status: 409, body: { error: 'archived' } });
    expect(await a.department(emp.id, ops.id)).toMatchObject({ status: 409, body: { error: 'archived_reference' } });
    expect((await a.departments()).body.departments.map((d: { id: string }) => d.id)).not.toContain(ops.id);
    expect((await a.departments('?archived=archived')).body.departments.map((d: { id: string }) => d.id)).toContain(ops.id);
    // A new active "Ops" blocks restoring the archived one until it is renamed.
    const clash = (await a.createDepartment({ name: 'OPS' })).body.department;
    expect(await a.restoreDepartment(ops.id)).toMatchObject({ status: 409, body: { error: 'duplicate_name' } });
    await a.patchDepartment(clash.id, { version: 1, name: 'Ops 2' });
    expect((await a.restoreDepartment(ops.id)).body.department.archivedAt).toBeNull();
    // History still names the department the employee was in.
    expect((await a.history(emp.id)).body.departments).toMatchObject([{ department: { id: ops.id }, endsOn: today() }]);
    expect((await audits(ops.id)).map((x) => x.action)).toEqual([
      'people.department.created', 'people.department.updated', 'people.department.archived', 'people.department.restored',
    ]);
  });

  it('department changes keep every past assignment; locations follow the same rules', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const d1 = (await a.createDepartment({ name: `Hist one ${randomUUID().slice(0, 4)}` })).body.department;
    const d2 = (await a.createDepartment({ name: `Hist two ${randomUUID().slice(0, 4)}` })).body.department;
    const emp = (await a.create({ givenName: 'Moves', familyName: 'Around', status: 'ACTIVE', startDate: '2026-02-02', departmentId: d1.id })).body.employee;
    expect(await a.department(emp.id, d2.id, { effectiveDate: '2026-02-01' })).toMatchObject({ status: 400, body: { error: 'effective_date_order' } });
    expect((await a.department(emp.id, d2.id, { effectiveDate: '2026-06-01' })).body.employee.department.id).toBe(d2.id);
    expect((await a.department(emp.id, d1.id)).body.employee.department.id).toBe(d1.id);
    const unchanged = await a.department(emp.id, d1.id); // same department again: no new history
    expect(unchanged.status).toBe(200);
    expect((await a.history(emp.id)).body.departments.map((x: { department: { id: string }; startsOn: string; endsOn: string | null }) => [x.department.id, x.startsOn, x.endsOn])).toEqual([
      [d1.id, '2026-02-02', '2026-06-01'], [d2.id, '2026-06-01', today()], [d1.id, today(), null],
    ]);
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM people_department_assignments WHERE employee_id = $1', [emp.id]);
    expect(rows[0].n).toBe(3);
    expect((await audits(emp.id)).filter((x) => x.action === 'people.employee.department_changed').map((x) => x.metadata)).toEqual([
      { from: d1.id, to: d2.id, effectiveDate: '2026-06-01' }, { from: d2.id, to: d1.id, effectiveDate: today() },
    ]);

    const site = (await a.createLocation({ name: `Yard ${randomUUID().slice(0, 4)}`, address: '1 Main Rd' })).body.location;
    expect(await a.createLocation({ name: 'Somewhere', latitude: 1 })).toMatchObject({ status: 400 });
    expect((await a.update(emp.id, { locationId: site.id })).body.employee.location).toMatchObject({ id: site.id, archived: false });
    expect(await a.archiveLocation(site.id)).toMatchObject({ status: 409, body: { error: 'in_use' } });
    await a.update(emp.id, { locationId: null });
    expect((await a.archiveLocation(site.id)).body.location.archivedAt).not.toBeNull();
    expect(await a.update(emp.id, { locationId: site.id })).toMatchObject({ status: 409, body: { error: 'archived_reference' } });
    expect((await a.restoreLocation(site.id)).body.location.archivedAt).toBeNull();
    expect((await a.patchLocation(site.id, { version: 3, address: null })).body.location).toMatchObject({ address: null, version: 4 });
    expect((await audits(emp.id)).filter((x) => x.action === 'people.employee.location_changed').map((x) => x.metadata)).toEqual([
      { from: null, to: site.id }, { from: site.id, to: null },
    ]);
  });

  it('an archive racing a new assignment cannot leave anyone in an archived department', async () => {
    const a = api(A.people.OWNER!, A.slug);
    for (let round = 0; round < 3; round++) {
      const dept = (await a.createDepartment({ name: `Race dept ${randomUUID().slice(0, 6)}` })).body.department;
      const emp = (await a.create({ givenName: `Racer${round}`, familyName: 'Dept', status: 'ACTIVE' })).body.employee;
      const [assign, archive] = await Promise.all([a.departmentRaw(emp.id, { version: emp.version, departmentId: dept.id }), a.archiveDepartment(dept.id)]);
      expect([assign.status, archive.status].filter((s) => s === 200)).toHaveLength(1);
      const { rows } = await admin.query(
        'SELECT count(*)::int AS n FROM people_department_assignments a JOIN people_departments d ON d.id = a.department_id WHERE a.ends_on IS NULL AND d.archived_at IS NOT NULL AND d.id = $1',
        [dept.id],
      );
      expect(rows[0].n).toBe(0);
    }
  });
});

describe('user links', () => {
  it('links only active members of this business, one employee each; grants nothing; removal clears the link', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const temp = await newUser('ea-temp');
    await invite(A.slug, A.people.OWNER!, temp, 'MEMBER');
    const emp = (await a.create({ givenName: 'Linked', familyName: 'User', status: 'ACTIVE', userId: temp.id })).body.employee;
    expect(emp.userId).toBe(temp.id);
    expect(await a.create({ givenName: 'Second', familyName: 'Link', userId: temp.id })).toMatchObject({ status: 409, body: { error: 'user_already_linked' } });
    expect(await a.create({ givenName: 'Stranger', familyName: 'Link', userId: randomUUID() })).toMatchObject({ status: 400, body: { error: 'invalid_user' } });
    // Linking grants no People access: the linked MEMBER still cannot read the directory, even their own record.
    const linked = api(temp, A.slug);
    expect((await linked.get(emp.id)).status).toBe(403);
    // Employment status never changes platform access.
    const ctxBefore = (await linked.context()).body;
    await a.status(emp.id, { status: 'ON_LEAVE' });
    expect((await linked.context()).body).toEqual(ctxBefore);
    // Removing the member keeps the employee and clears the link (version bumped, audited).
    const before = (await a.get(emp.id)).body.employee;
    const membership = (await a.members()).body.members.find((m: { userId: string }) => m.userId === temp.id);
    expect((await a.removeMember(membership.id)).status).toBe(200);
    expect((await a.get(emp.id)).body.employee).toMatchObject({ userId: null, version: before.version + 1, status: 'ON_LEAVE' });
    expect((await audits(emp.id)).filter((x) => x.action === 'people.employee.user_unlinked').map((x) => x.metadata)).toEqual([
      { userId: temp.id, reason: 'member_removed' },
    ]);
    // Suspended members cannot be linked.
    await admin.query("UPDATE memberships SET status = 'SUSPENDED' WHERE business_id = $1 AND user_id = $2", [A.businessId, A.people.MANAGER!.id]);
    try {
      expect(await a.update(emp.id, { userId: A.people.MANAGER!.id })).toMatchObject({ status: 400, body: { error: 'invalid_user' } });
    } finally {
      await admin.query("UPDATE memberships SET status = 'ACTIVE' WHERE business_id = $1 AND user_id = $2", [A.businessId, A.people.MANAGER!.id]);
    }
    const relinked = await a.update(emp.id, { userId: A.people.MANAGER!.id });
    expect(relinked.body.employee.userId).toBe(A.people.MANAGER!.id);
    expect((await audits(emp.id)).filter((x) => x.action === 'people.employee.user_linked')).toHaveLength(1);
  });
});
