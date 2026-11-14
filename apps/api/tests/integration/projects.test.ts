/**
 * Projects Zone backend (PR 18): projects and tasks through the real route handlers, against
 * PostgreSQL with the migrations and privileged SQL applied as in production. Two independent
 * businesses and every membership role (docs/projects-data-model.md).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Permission, Role } from '@/modules/access';

// Custom permission sets for one role at a time, standing in for the narrower roles the platform will
// offer later (a read-only viewer, someone without Projects). Everything else is the real code path:
// the route wrapper derives permissions from the verified membership through this function.
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
import * as customerRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/route';
import * as archiveCustomerRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/archive/route';
import * as customerProjectsRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/projects/route';
import * as projectsRoute from '@/app/api/v1/b/[slug]/projects/route';
import * as summaryRoute from '@/app/api/v1/b/[slug]/projects/summary/route';
import * as projectRoute from '@/app/api/v1/b/[slug]/projects/[projectId]/route';
import * as archiveRoute from '@/app/api/v1/b/[slug]/projects/[projectId]/archive/route';
import * as restoreRoute from '@/app/api/v1/b/[slug]/projects/[projectId]/restore/route';
import * as tasksRoute from '@/app/api/v1/b/[slug]/projects/[projectId]/tasks/route';
import * as taskRoute from '@/app/api/v1/b/[slug]/projects/[projectId]/tasks/[taskId]/route';
import * as archiveTaskRoute from '@/app/api/v1/b/[slug]/projects/[projectId]/tasks/[taskId]/archive/route';
import * as restoreTaskRoute from '@/app/api/v1/b/[slug]/projects/[projectId]/tasks/[taskId]/restore/route';
import { devOutbox } from '@/core/email';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
const app = new pg.Client({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await Promise.all([admin.connect(), app.connect()]);
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});
afterEach(() => {
  for (const key of Object.keys(custom)) delete custom[key as Role];
});

// A separate address range from the other suites, so rate-limit counters do not collide.
let ip = 1;
type User = { email: string; cookie: string; id: string };

function req(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.64.${Math.floor(ip / 250)}.${ip++ % 250}` });
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
  const base = `/api/v1/b/${slug}/projects`;
  const p = (projectId: string) => ctx({ slug, projectId });
  const t = (projectId: string, taskId: string) => ctx({ slug, projectId, taskId });
  return {
    list: (qs = '') => projectsRoute.GET(req('GET', `${base}${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    create: (body: unknown) => projectsRoute.POST(req('POST', base, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    summary: () => summaryRoute.GET(req('GET', `${base}/summary`, { cookie: who.cookie }), ctx({ slug })).then(json),
    get: (id: string) => projectRoute.GET(req('GET', `${base}/${id}`, { cookie: who.cookie }), p(id)).then(json),
    patch: (id: string, body: unknown) => projectRoute.PATCH(req('PATCH', `${base}/${id}`, { cookie: who.cookie, body }), p(id)).then(json),
    /** PATCH based on the current version, as a client showing fresh data would. */
    update: async (id: string, body: Record<string, unknown>) => {
      const current = await projectRoute.GET(req('GET', `${base}/${id}`, { cookie: who.cookie }), p(id)).then(json);
      return projectRoute.PATCH(req('PATCH', `${base}/${id}`, { cookie: who.cookie, body: { version: current.body.project?.version ?? 1, ...body } }), p(id)).then(json);
    },
    archive: (id: string) => archiveRoute.POST(req('POST', `${base}/${id}/archive`, { cookie: who.cookie }), p(id)).then(json),
    restore: (id: string) => restoreRoute.POST(req('POST', `${base}/${id}/restore`, { cookie: who.cookie }), p(id)).then(json),
    tasks: (id: string, qs = '') => tasksRoute.GET(req('GET', `${base}/${id}/tasks${qs}`, { cookie: who.cookie }), p(id)).then(json),
    createTask: (id: string, body: unknown) => tasksRoute.POST(req('POST', `${base}/${id}/tasks`, { cookie: who.cookie, body }), p(id)).then(json),
    patchTask: (id: string, taskId: string, body: unknown) => taskRoute.PATCH(req('PATCH', `${base}/${id}/tasks/${taskId}`, { cookie: who.cookie, body }), t(id, taskId)).then(json),
    archiveTask: (id: string, taskId: string) => archiveTaskRoute.POST(req('POST', `${base}/${id}/tasks/${taskId}/archive`, { cookie: who.cookie }), t(id, taskId)).then(json),
    restoreTask: (id: string, taskId: string) => restoreTaskRoute.POST(req('POST', `${base}/${id}/tasks/${taskId}/restore`, { cookie: who.cookie }), t(id, taskId)).then(json),
    customerProjects: (customerId: string, qs = '') =>
      customerProjectsRoute.GET(req('GET', `/api/v1/b/${slug}/customers/${customerId}/projects${qs}`, { cookie: who.cookie }), ctx({ slug, customerId })).then(json),
    createCustomer: (body: unknown) => customersRoute.POST(req('POST', `/api/v1/b/${slug}/customers`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    updateCustomer: (customerId: string, body: unknown) => customerRoute.PATCH(req('PATCH', `/api/v1/b/${slug}/customers/${customerId}`, { cookie: who.cookie, body }), ctx({ slug, customerId })).then(json),
    archiveCustomer: (customerId: string) => archiveCustomerRoute.POST(req('POST', `/api/v1/b/${slug}/customers/${customerId}/archive`, { cookie: who.cookie }), ctx({ slug, customerId })).then(json),
    members: () => membersRoute.GET(req('GET', `/api/v1/b/${slug}/members`, { cookie: who.cookie }), ctx({ slug })).then(json),
    removeMember: (membershipId: string) => memberRoute.DELETE(req('DELETE', `/api/v1/b/${slug}/members/${membershipId}`, { cookie: who.cookie }), ctx({ slug, membershipId })).then(json),
    context: () => contextRoute.GET(req('GET', `/api/v1/b/${slug}`, { cookie: who.cookie }), ctx({ slug })).then(json),
  };
};
const audits = async (targetId: string) =>
  (await admin.query('SELECT action, actor_user_id, business_id, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows;

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
beforeAll(async () => {
  A = await team('pa');
  B = await team('pb');
}, 120_000);

describe('projects: create, read, update', () => {
  it('creates an internal project with defaults; only a name is required; authorship comes from the session', async () => {
    const a = api(A.people.MEMBER!, A.slug);
    const created = await a.create({ name: '  Office relocation  ' });
    expect(created.status).toBe(201);
    expect(created.body.project).toMatchObject({
      name: 'Office relocation', status: 'PLANNED', priority: 'MEDIUM', customerId: null, customer: null, ownerUserId: null, startDate: null, dueDate: null,
      completedAt: null, taskCounts: { total: 0, done: 0 }, version: 1, createdById: A.people.MEMBER!.id, archivedAt: null,
    });
    const id = created.body.project.id;
    expect((await a.get(id)).body.project.name).toBe('Office relocation');
    const { rows } = await admin.query('SELECT business_id FROM projects WHERE id = $1', [id]);
    expect(rows[0].business_id).toBe(A.businessId);
    expect((await audits(id)).map((e) => e.action)).toEqual(['projects.project.created']);
    expect(JSON.stringify(await audits(id))).not.toMatch(/relocation/i); // names stay out of the audit log
  });

  it('validates names, statuses, priorities, dates and unknown fields', async () => {
    const a = api(A.people.OWNER!, A.slug);
    for (const body of [
      {}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(201) }, { name: 'X', status: 'DONE' }, { name: 'X', priority: 'CRITICAL' },
      { name: 'X', dueDate: '2026-02-30' }, { name: 'X', startDate: 'tomorrow' }, { name: 'X', startDate: '2026-12-10', dueDate: '2026-12-01' },
      { name: 'X', businessId: B.businessId }, { name: 'X', completedAt: '2026-01-01T00:00:00Z' }, { name: 'X', description: 'x'.repeat(5001) },
    ]) {
      expect((await a.create(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    const ok = (await a.create({ name: 'Dated', startDate: '2026-12-01', dueDate: '2026-12-01' })).body.project;
    expect(ok).toMatchObject({ startDate: '2026-12-01', dueDate: '2026-12-01' });
    // A patch that would put the due date before the existing start date is refused by the server.
    expect(await a.update(ok.id, { dueDate: '2026-11-30' })).toMatchObject({ status: 400, body: { error: 'invalid_dates' } });
    expect((await a.update(ok.id, { startDate: null, dueDate: '2026-11-30' })).body.project).toMatchObject({ startDate: null, dueDate: '2026-11-30' });
    expect((await a.patch(ok.id, { version: 3 })).status).toBe(400); // nothing to update
  });

  it('keeps completedAt in step with status, entering and leaving COMPLETED', async () => {
    const a = api(A.people.MANAGER!, A.slug);
    const p = (await a.create({ name: 'Staff onboarding', status: 'ACTIVE' })).body.project;
    const done = (await a.update(p.id, { status: 'COMPLETED' })).body.project;
    expect(done.completedAt).not.toBeNull();
    expect((await a.update(p.id, { priority: 'HIGH' })).body.project.completedAt).toBe(done.completedAt); // unchanged while still completed
    expect((await a.update(p.id, { status: 'ACTIVE' })).body.project.completedAt).toBeNull();
    const direct = (await a.create({ name: 'Created done', status: 'COMPLETED' })).body.project;
    expect(direct.completedAt).not.toBeNull();
    const actions = (await audits(p.id)).map((e) => e.action);
    expect(actions.filter((x) => x === 'projects.project.status_changed')).toHaveLength(2);
  });

  it('refuses a stale edit and lets exactly one of several simultaneous edits win', async () => {
    const ana = api(A.people.MANAGER!, A.slug);
    const ben = api(A.people.MEMBER!, A.slug);
    const p = (await ana.create({ name: 'Shared' })).body.project;
    expect((await ana.patch(p.id, { version: 1, priority: 'HIGH' })).body.project.version).toBe(2);
    expect(await ben.patch(p.id, { version: 1, name: 'Overwrite' })).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect((await ana.get(p.id)).body.project).toMatchObject({ name: 'Shared', priority: 'HIGH' });
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => ana.patch(p.id, { version: 2, name: `Edit ${i}` })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error === 'stale')).toHaveLength(4);
    expect((await ana.get(p.id)).body.project.version).toBe(3);
  });

  it('owners must be active members of this business; removing a member clears their projects and tasks', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const p = (await a.create({ name: 'Owned', ownerUserId: A.people.MEMBER!.id })).body.project;
    expect(p.ownerUserId).toBe(A.people.MEMBER!.id);
    expect(await a.create({ name: 'Foreign owner', ownerUserId: B.people.OWNER!.id })).toMatchObject({ status: 400, body: { error: 'invalid_owner' } });
    expect(await a.update(p.id, { ownerUserId: randomUUID() })).toMatchObject({ status: 400, body: { error: 'invalid_owner' } });
    // A temporary member owns a project and a task, then is removed: both records stay, unassigned.
    const temp = await newUser('pa-temp');
    await invite(A.slug, A.people.OWNER!, temp, 'MEMBER');
    const owned = (await a.create({ name: 'Temp owned', ownerUserId: temp.id })).body.project;
    const task = (await a.createTask(owned.id, { title: 'Temp task', assigneeUserId: temp.id })).body.task;
    const membership = (await a.members()).body.members.find((m: { userId: string }) => m.userId === temp.id);
    expect((await a.removeMember(membership.id)).status).toBe(200);
    expect((await a.get(owned.id)).body.project).toMatchObject({ ownerUserId: null, version: 2 });
    expect((await a.tasks(owned.id)).body.tasks[0]).toMatchObject({ id: task.id, assigneeUserId: null, version: 2 });
    // Suspended members cannot be given new work either.
    await admin.query("UPDATE memberships SET status = 'SUSPENDED' WHERE business_id = $1 AND user_id = $2", [A.businessId, A.people.ADMIN!.id]);
    try {
      expect(await a.create({ name: 'Suspended owner', ownerUserId: A.people.ADMIN!.id })).toMatchObject({ status: 400, body: { error: 'invalid_owner' } });
    } finally {
      await admin.query("UPDATE memberships SET status = 'ACTIVE' WHERE business_id = $1 AND user_id = $2", [A.businessId, A.people.ADMIN!.id]);
    }
  });
});

describe('listing, filters, sorting and pagination', () => {
  let L: Awaited<ReturnType<typeof team>>;
  beforeAll(async () => {
    L = await team('pl');
  }, 60_000);

  it('searches by name, filters by status, and pages every sort order with no gaps or repeats', async () => {
    const a = api(L.people.OWNER!, L.slug);
    const specs = [
      ['Alpha', 'ACTIVE', '2026-12-03'], ['bravo', 'PLANNED', null], ['Charlie', 'ACTIVE', '2026-12-01'], ['Delta', 'ON_HOLD', '2026-12-01'],
      ['Echo', 'COMPLETED', null], ['Foxtrot', 'CANCELLED', '2027-01-15'], ['Golf', 'ACTIVE', null],
    ] as const;
    const ids: Record<string, string> = {};
    for (const [name, status, dueDate] of specs) ids[name] = (await a.create({ name, status, dueDate })).body.project.id;

    expect((await a.list('?q=ALP')).body.projects.map((p: { name: string }) => p.name)).toEqual(['Alpha']);
    expect((await a.list('?status=ACTIVE&sort=name')).body.projects.map((p: { name: string }) => p.name)).toEqual(['Alpha', 'Charlie', 'Golf']);

    const all = async (sort: string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const page: { status: number; body: { projects: { id: string; name: string }[]; nextCursor: string | null } } = await a.list(`?sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        expect(page.status).toBe(200);
        seen.push(...page.body.projects.map((p) => p.name));
        cursor = page.body.nextCursor;
        if (!cursor) break;
      }
      return seen;
    };
    expect((await all('newest'))).toEqual(['Golf', 'Foxtrot', 'Echo', 'Delta', 'Charlie', 'bravo', 'Alpha']);
    const byName = await all('name');
    expect(byName).toHaveLength(7);
    expect(new Set(byName).size).toBe(7);
    const due = await all('due');
    expect(due.slice(0, 4)).toEqual([...['Charlie', 'Delta'].sort((x, y) => (ids[x]! < ids[y]! ? -1 : 1)), 'Alpha', 'Foxtrot']);
    expect(new Set(due.slice(4))).toEqual(new Set(['bravo', 'Echo', 'Golf'])); // undated last

    // Cursors are bound to their list and sort; tampering is refused, never silently restarted.
    const first = await a.list('?sort=name&limit=2');
    expect((await a.list(`?sort=due&cursor=${first.body.nextCursor}`)).body.error).toBe('invalid_cursor');
    expect((await a.list('?cursor=bm9wZQ')).body.error).toBe('invalid_cursor');
    for (const qs of ['?limit=0', '?limit=101', '?sort=random', '?status=DONE', '?archived=maybe', '?customerId=nope', `?q=${'x'.repeat(101)}`, '?businessId=x']) {
      expect((await a.list(qs)).status, qs).toBe(400);
    }
  });

  it('counts real projects by status and shows real task progress', async () => {
    const a = api(L.people.OWNER!, L.slug);
    const { body } = await a.summary();
    expect(body.summary).toEqual({ active: 7, byStatus: { PLANNED: 1, ACTIVE: 3, ON_HOLD: 1, COMPLETED: 1, CANCELLED: 1 } });
    const p = (await a.create({ name: 'Progress' })).body.project;
    const t = [];
    for (const title of ['One', 'Two', 'Three']) t.push((await a.createTask(p.id, { title })).body.task);
    await a.patchTask(p.id, t[0].id, { version: 1, status: 'DONE' });
    await a.archiveTask(p.id, t[2].id);
    const listed = (await a.list('?q=Progress')).body.projects[0];
    expect(listed.taskCounts).toEqual({ total: 2, done: 1 });
    expect((await a.get(p.id)).body.project.taskCounts).toEqual({ total: 2, done: 1 });
  });
});

describe('tasks', () => {
  it('creates tasks in order, validates them, and keeps completedAt in step with Done', async () => {
    const a = api(A.people.MEMBER!, A.slug);
    const p = (await a.create({ name: 'Renovation' })).body.project;
    const one = (await a.createTask(p.id, { title: 'Get quotes', priority: 'HIGH', dueDate: '2026-12-01', assigneeUserId: A.people.MANAGER!.id })).body.task;
    const two = (await a.createTask(p.id, { title: 'Pick supplier' })).body.task;
    expect(one).toMatchObject({ projectId: p.id, status: 'TODO', priority: 'HIGH', dueDate: '2026-12-01', assigneeUserId: A.people.MANAGER!.id, completedAt: null, version: 1 });
    expect(two.position).toBeGreaterThan(one.position);
    expect((await a.tasks(p.id)).body.tasks.map((t: { id: string }) => t.id)).toEqual([one.id, two.id]);

    for (const body of [{}, { title: '' }, { title: 'x'.repeat(201) }, { title: 'X', status: 'COMPLETED' }, { title: 'X', dueDate: '2026-13-01' }, { title: 'X', projectId: p.id }, { title: 'X', position: 1 }]) {
      expect((await a.createTask(p.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await a.createTask(p.id, { title: 'X', assigneeUserId: B.people.MEMBER!.id })).toMatchObject({ status: 400, body: { error: 'invalid_assignee' } });

    const done = (await a.patchTask(p.id, one.id, { version: 1, status: 'DONE' })).body.task;
    expect(done).toMatchObject({ status: 'DONE', version: 2 });
    expect(done.completedAt).not.toBeNull();
    expect((await a.patchTask(p.id, one.id, { version: 2, title: 'Got quotes' })).body.task.completedAt).toBe(done.completedAt);
    const reopened = (await a.patchTask(p.id, one.id, { version: 3, status: 'IN_PROGRESS' })).body.task;
    expect(reopened).toMatchObject({ status: 'IN_PROGRESS', completedAt: null });
    expect(await a.patchTask(p.id, one.id, { version: 1, status: 'BLOCKED' })).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect((await a.tasks(p.id, '?status=IN_PROGRESS')).body.tasks.map((t: { id: string }) => t.id)).toEqual([one.id]);
    expect((await audits(one.id)).map((e) => e.action)).toContain('projects.task.status_changed');
  });

  it('simultaneous task updates from the same version: one wins, the rest are refused', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const p = (await a.create({ name: 'Race' })).body.project;
    const t = (await a.createTask(p.id, { title: 'Contended' })).body.task;
    const results = await Promise.all(['DONE', 'BLOCKED', 'IN_PROGRESS', 'DONE'].map((status) => a.patchTask(p.id, t.id, { version: 1, status })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const final = (await a.tasks(p.id)).body.tasks[0];
    expect(final.version).toBe(2);
    expect(final.completedAt === null).toBe(final.status !== 'DONE');
  });

  it('a task is only reachable through its own project', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const p1 = (await a.create({ name: 'P1' })).body.project;
    const p2 = (await a.create({ name: 'P2' })).body.project;
    const t = (await a.createTask(p1.id, { title: 'Belongs to P1' })).body.task;
    expect((await a.patchTask(p2.id, t.id, { version: 1, title: 'Moved?' })).status).toBe(404);
    expect((await a.archiveTask(p2.id, t.id)).status).toBe(404);
    expect((await a.tasks(randomUUID())).status).toBe(404);
    expect((await a.createTask(randomUUID(), { title: 'Orphan' })).status).toBe(404);
  });

  it('archiving a project keeps its tasks and makes the project and its tasks read-only until restored', async () => {
    const a = api(A.people.MANAGER!, A.slug);
    const p = (await a.create({ name: 'Archivable' })).body.project;
    const t1 = (await a.createTask(p.id, { title: 'Kept 1' })).body.task;
    await a.createTask(p.id, { title: 'Kept 2' });
    const archived = (await a.archive(p.id)).body.project;
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.taskCounts).toEqual({ total: 2, done: 0 });
    expect((await a.tasks(p.id)).body.tasks).toHaveLength(2); // still readable
    expect((await admin.query('SELECT count(*)::int AS n FROM project_tasks WHERE project_id = $1', [p.id])).rows[0].n).toBe(2);
    expect(await a.update(p.id, { name: 'Changed' })).toMatchObject({ status: 409, body: { error: 'archived' } });
    expect(await a.createTask(p.id, { title: 'New' })).toMatchObject({ status: 409, body: { error: 'project_archived' } });
    expect(await a.patchTask(p.id, t1.id, { version: 1, status: 'DONE' })).toMatchObject({ status: 409, body: { error: 'project_archived' } });
    expect(await a.archiveTask(p.id, t1.id)).toMatchObject({ status: 409, body: { error: 'project_archived' } });
    expect((await a.archive(p.id)).body.error).toBe('archived');
    expect((await a.list('?q=Archivable')).body.projects).toHaveLength(0);
    expect((await a.list('?q=Archivable&archived=archived')).body.projects).toHaveLength(1);
    expect((await a.restore(p.id)).body.project.archivedAt).toBeNull();
    expect((await a.patchTask(p.id, t1.id, { version: 1, status: 'DONE' })).status).toBe(200);
  });

  it('removing a task archives it (out of the list and progress), and it can be restored', async () => {
    const a = api(A.people.MEMBER!, A.slug);
    const p = (await a.create({ name: 'Removal policy' })).body.project;
    const t = (await a.createTask(p.id, { title: 'Mistake' })).body.task;
    expect((await a.archiveTask(p.id, t.id)).body.task.archivedAt).not.toBeNull();
    expect((await a.tasks(p.id)).body.tasks).toHaveLength(0);
    expect((await a.tasks(p.id, '?archived=archived')).body.tasks).toHaveLength(1);
    expect(await a.patchTask(p.id, t.id, { version: 2, title: 'Edit archived' })).toMatchObject({ status: 409, body: { error: 'archived' } });
    expect((await a.restoreTask(p.id, t.id)).body.task.archivedAt).toBeNull();
    expect((await a.restoreTask(p.id, t.id)).body.error).toBe('not_archived');
  });
});

describe('Customer Zone integration', () => {
  it('links one existing customer, shows its current name, lists a customer\'s projects, and survives customer archiving', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const c = (await a.createCustomer({ displayName: 'Acme Pty Ltd' })).body.customer;
    const p1 = (await a.create({ name: 'Acme fit-out', customerId: c.id })).body.project;
    const p2 = (await a.create({ name: 'Acme support', customerId: c.id })).body.project;
    await a.create({ name: 'Internal only' });
    expect(p1.customer).toEqual({ id: c.id, displayName: 'Acme Pty Ltd', archived: false });
    const { rows } = await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'projects' AND column_name ~ 'name|email|phone|address'");
    expect(rows.map((r) => r.column_name)).toEqual(['name']); // no copied customer details

    await a.updateCustomer(c.id, { displayName: 'Acme Group' });
    expect((await a.get(p1.id)).body.project.customer.displayName).toBe('Acme Group');

    const listed = await a.customerProjects(c.id, '?sort=name');
    expect(listed.body.projects.map((p: { id: string }) => p.id)).toEqual([p1.id, p2.id]);
    expect((await a.list(`?customerId=${c.id}`)).body.projects).toHaveLength(2);
    expect((await a.customerProjects(randomUUID())).status).toBe(404);

    await a.archiveCustomer(c.id);
    expect((await a.get(p1.id)).body.project).toMatchObject({ customerId: c.id, customer: { archived: true } });
    expect((await a.customerProjects(c.id)).body.projects).toHaveLength(2);
    // A newly linked customer must be active.
    expect(await a.create({ name: 'Late link', customerId: c.id })).toMatchObject({ status: 409, body: { error: 'archived_reference' } });
    expect((await a.update(p1.id, { name: 'Still editable with its archived customer' })).status).toBe(200);
    expect((await a.update(p1.id, { customerId: null })).body.project.customerId).toBeNull();
  });

  it('customer lookups and links respect Customer Zone read permission', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const c = (await a.createCustomer({ displayName: 'Private customer' })).body.customer;
    const p = (await a.create({ name: 'Linked', customerId: c.id })).body.project;
    custom.MEMBER = ['business:read', 'members:read', 'projects:read', 'projects:create', 'projects:update', 'projects:manage_tasks'];
    const m = api(A.people.MEMBER!, A.slug);
    const seen = (await m.get(p.id)).body.project;
    expect(seen).toMatchObject({ customerId: c.id, customer: null }); // linked, but no name from a Zone they cannot read
    expect(JSON.stringify((await m.list('?q=Linked')).body)).not.toMatch(/Private customer/);
    expect((await m.customerProjects(c.id)).status).toBe(403);
    expect((await m.create({ name: 'Try link', customerId: c.id })).status).toBe(403);
    expect((await m.update(p.id, { customerId: null })).status).toBe(403);
    expect((await m.update(p.id, { name: 'Renamed without touching the customer' })).status).toBe(200);
  });
});

describe('permissions', () => {
  it('role matrix: every role works on projects and tasks; only OWNER, ADMIN and MANAGER archive', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const p = (await owner.create({ name: 'Matrix' })).body.project;
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER']) {
      const who = api(A.people[role]!, A.slug);
      expect((await who.get(p.id)).status, role).toBe(200);
      expect((await who.create({ name: `By ${role}` })).status, role).toBe(201);
      expect((await who.update(p.id, { description: `Edited by ${role}` })).status, role).toBe(200);
      expect((await who.createTask(p.id, { title: `Task by ${role}` })).status, role).toBe(201);
      const context = (await who.context()).body.membership.permissions as string[];
      expect(context.includes('projects:archive'), role).toBe(role !== 'MEMBER');
    }
    const member = api(A.people.MEMBER!, A.slug);
    expect(await member.archive(p.id)).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect((await owner.get(p.id)).body.project.archivedAt).toBeNull();
    expect((await api(A.people.MANAGER!, A.slug).archive(p.id)).status).toBe(200);
    expect((await member.restore(p.id)).status).toBe(403);
  });

  it('read-only access can read but not create, edit, archive or touch tasks', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const p = (await owner.create({ name: 'Read only target' })).body.project;
    const t = (await owner.createTask(p.id, { title: 'Untouchable' })).body.task;
    custom.MEMBER = ['business:read', 'members:read', 'customers:read', 'projects:read'];
    const viewer = api(A.people.MEMBER!, A.slug);
    expect((await viewer.get(p.id)).status).toBe(200);
    expect((await viewer.tasks(p.id)).status).toBe(200);
    expect((await viewer.create({ name: 'No' })).status).toBe(403);
    expect((await viewer.patch(p.id, { version: 1, name: 'No' })).status).toBe(403);
    expect((await viewer.archive(p.id)).status).toBe(403);
    expect((await viewer.createTask(p.id, { title: 'No' })).status).toBe(403);
    expect((await viewer.patchTask(p.id, t.id, { version: 1, status: 'DONE' })).status).toBe(403);
    expect((await viewer.archiveTask(p.id, t.id)).status).toBe(403);
    expect((await owner.get(p.id)).body.project.version).toBe(1);
  });

  it('project update permission does not include task management, and vice versa', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const p = (await owner.create({ name: 'Split permissions' })).body.project;
    custom.MEMBER = ['business:read', 'members:read', 'projects:read', 'projects:update'];
    expect((await api(A.people.MEMBER!, A.slug).createTask(p.id, { title: 'No' })).status).toBe(403);
    custom.MEMBER = ['business:read', 'members:read', 'projects:read', 'projects:manage_tasks'];
    const tasker = api(A.people.MEMBER!, A.slug);
    expect((await tasker.createTask(p.id, { title: 'Yes' })).status).toBe(201);
    expect((await tasker.update(p.id, { name: 'No' })).status).toBe(403);
  });

  it('without projects:read nothing is reachable, not even the summary', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const p = (await owner.create({ name: 'Hidden' })).body.project;
    const c = (await owner.createCustomer({ displayName: 'Customer of hidden' })).body.customer;
    custom.MEMBER = ['business:read', 'members:read', 'customers:read', 'customers:write'];
    const none = api(A.people.MEMBER!, A.slug);
    for (const res of [await none.list(), await none.get(p.id), await none.summary(), await none.tasks(p.id), await none.customerProjects(c.id)]) {
      expect(res).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    }
  });

  it('being the owner or assignee grants nothing: an assigned read-only member still cannot change the work', async () => {
    const owner = api(A.people.OWNER!, A.slug);
    const p = (await owner.create({ name: 'Assigned', ownerUserId: A.people.MEMBER!.id })).body.project;
    const t = (await owner.createTask(p.id, { title: 'Assigned task', assigneeUserId: A.people.MEMBER!.id })).body.task;
    custom.MEMBER = ['business:read', 'members:read', 'projects:read'];
    const assignee = api(A.people.MEMBER!, A.slug);
    expect((await assignee.update(p.id, { status: 'ACTIVE' })).status).toBe(403);
    expect((await assignee.patchTask(p.id, t.id, { version: 1, status: 'DONE' })).status).toBe(403);
    expect((await assignee.archive(p.id)).status).toBe(403);
  });
});

describe('tenant isolation', () => {
  it('business B cannot list, read, modify, archive or reach the tasks of A\'s projects; answers match a missing id', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const p = (await a.create({ name: 'A secret plan' })).body.project;
    const t = (await a.createTask(p.id, { title: 'A secret task' })).body.task;
    const b = api(B.people.OWNER!, B.slug);
    expect(JSON.stringify((await b.list('?archived=all&limit=100')).body)).not.toMatch(/secret/);
    expect((await b.summary()).body.summary.active).toBe(0);
    const missing = randomUUID();
    for (const [mine, theirs] of [
      [await b.get(p.id), await b.get(missing)],
      [await b.patch(p.id, { version: 1, name: 'Hijack' }), await b.patch(missing, { version: 1, name: 'Hijack' })],
      [await b.archive(p.id), await b.archive(missing)],
      [await b.tasks(p.id), await b.tasks(missing)],
      [await b.createTask(p.id, { title: 'Inject' }), await b.createTask(missing, { title: 'Inject' })],
      [await b.patchTask(p.id, t.id, { version: 1, status: 'DONE' }), await b.patchTask(missing, t.id, { version: 1, status: 'DONE' })],
      [await b.archiveTask(p.id, t.id), await b.archiveTask(missing, missing)],
    ]) {
      expect(mine).toEqual({ status: 404, body: { error: 'not_found' } });
      expect(theirs).toEqual(mine);
    }
    // A's slug with B's session is not a door either.
    expect((await api(B.people.OWNER!, A.slug).get(p.id)).status).toBe(404);
    expect((await a.get(p.id)).body.project).toMatchObject({ name: 'A secret plan', version: 1 });
    expect((await a.tasks(p.id)).body.tasks[0]).toMatchObject({ title: 'A secret task', version: 1 });
  });

  it('A cannot link B\'s customer or assign B\'s member, through the API or through raw SQL', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const bCustomer = (await api(B.people.OWNER!, B.slug).createCustomer({ displayName: 'B customer' })).body.customer;
    expect((await a.create({ name: 'Cross link', customerId: bCustomer.id })).status).toBe(404);
    expect((await a.customerProjects(bCustomer.id)).status).toBe(404);
    expect((await a.create({ name: 'Cross owner', ownerUserId: B.people.OWNER!.id })).body.error).toBe('invalid_owner');
    const p = (await a.create({ name: 'Raw SQL target' })).body.project;

    const run = async (sql: string, params: unknown[]) => {
      await app.query('BEGIN');
      try {
        await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [A.businessId, A.people.OWNER!.id]);
        await app.query(sql, params);
        await app.query('COMMIT');
      } catch (error) {
        await app.query('ROLLBACK');
        throw error;
      }
    };
    await expect(run('UPDATE projects SET customer_id = $1 WHERE id = $2', [bCustomer.id, p.id])).rejects.toThrow(/foreign key/);
    await expect(run('UPDATE projects SET owner_user_id = $1 WHERE id = $2', [B.people.OWNER!.id, p.id])).rejects.toThrow(/foreign key/);
    await expect(run("INSERT INTO projects (id, business_id, name) VALUES ($1, $2, 'Smuggled')", [randomUUID(), B.businessId])).rejects.toThrow(/row-level security/);
    await expect(run("INSERT INTO project_tasks (id, business_id, project_id, title, position, assignee_user_id) VALUES ($1, $2, $3, 'x', 1, $4)", [randomUUID(), A.businessId, p.id, B.people.OWNER!.id])).rejects.toThrow(/foreign key/);
    const bProject = (await api(B.people.OWNER!, B.slug).create({ name: 'B project' })).body.project;
    await expect(run("INSERT INTO project_tasks (id, business_id, project_id, title, position) VALUES ($1, $2, $3, 'x', 1)", [randomUUID(), A.businessId, bProject.id])).rejects.toThrow(/foreign key/);
    await expect(run("UPDATE projects SET status = 'COMPLETED' WHERE id = $1", [p.id])).rejects.toThrow(/check constraint/); // needs completed_at
    await expect(run("UPDATE projects SET start_date = '2026-12-10', due_date = '2026-12-01' WHERE id = $1", [p.id])).rejects.toThrow(/check constraint/);
    for (const table of ['projects', 'project_tasks']) {
      await expect(run(`DELETE FROM ${table} WHERE business_id = $1`, [A.businessId]), table).rejects.toThrow(/permission denied/);
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table}`); // outside any tenant context
      expect(rows[0].n, table).toBe(0);
    }
    const { rows } = await admin.query("SELECT relname FROM pg_class WHERE relname IN ('projects','project_tasks') AND relrowsecurity AND relforcerowsecurity");
    expect(rows).toHaveLength(2);
  });

  it('a person in both businesses sees only the active business\'s projects, switching cleanly', async () => {
    const both = await newUser('p-both');
    await invite(A.slug, A.people.OWNER!, both, 'MEMBER');
    await invite(B.slug, B.people.OWNER!, both, 'MEMBER');
    const inA = (await api(both, A.slug).create({ name: 'Made in A' })).body.project;
    const inB = (await api(both, B.slug).create({ name: 'Made in B' })).body.project;
    const listA = (await api(both, A.slug).list('?limit=100&archived=all')).body.projects.map((p: { id: string }) => p.id);
    const listB = (await api(both, B.slug).list('?limit=100&archived=all')).body.projects.map((p: { id: string }) => p.id);
    expect(listA).toContain(inA.id);
    expect(listA).not.toContain(inB.id);
    expect(listB).toContain(inB.id);
    expect(listB).not.toContain(inA.id);
    expect((await api(both, B.slug).get(inA.id)).status).toBe(404);
    expect((await api(both, A.slug).get(inB.id)).status).toBe(404);
  });
});

describe('PR 18 audit: archive and task changes at the same time', () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** A second bos_app connection in A's tenant context, used to hold row locks at chosen moments. */
  async function holder() {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [A.businessId, A.people.OWNER!.id]);
    return c;
  }
  const settled = async (p: Promise<unknown>) => Promise.race([p.then(() => true), pause(50).then(() => false)]);

  it('a task change that already passed the project check holds the project: the archive waits for it, never the other way round', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const p = (await a.create({ name: 'Race: edit then archive' })).body.project;
    const t = (await a.createTask(p.id, { title: 'In flight' })).body.task;
    const h = await holder();
    const order: string[] = [];
    try {
      await h.query('SELECT 1 FROM project_tasks WHERE id = $1 FOR UPDATE', [t.id]); // the task write will wait here
      const edit = a.patchTask(p.id, t.id, { version: 1, status: 'DONE' }).then((r) => (order.push('task'), r));
      await pause(300); // the edit has checked its project and is now waiting on the task row
      const archive = a.archive(p.id).then((r) => (order.push('archive'), r));
      await pause(300);
      expect(await settled(archive)).toBe(false); // must not commit while a task change is in flight
      await h.query('COMMIT');
      const [e, ar] = await Promise.all([edit, archive]);
      expect(e.status).toBe(200);
      expect(ar.status).toBe(200);
      expect(order).toEqual(['task', 'archive']);
    } finally {
      await h.end();
    }
  });

  it('an archive in flight blocks task creates, edits, archives and restores, which are then refused; no task changes', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const p = (await a.create({ name: 'Race: archive then task changes' })).body.project;
    const live = (await a.createTask(p.id, { title: 'Live' })).body.task;
    const gone = (await a.createTask(p.id, { title: 'Gone' })).body.task;
    await a.archiveTask(p.id, gone.id);
    const before = (await admin.query('SELECT id, version, status, archived_at FROM project_tasks WHERE project_id = $1 ORDER BY id', [p.id])).rows;
    const attempts: [string, () => Promise<{ status: number; body: { error?: string } }>][] = [
      ['create', () => a.createTask(p.id, { title: 'Sneaked in' })],
      ['update', () => a.patchTask(p.id, live.id, { version: 1, status: 'DONE' })],
      ['archive', () => a.archiveTask(p.id, live.id)],
      ['restore', () => a.restoreTask(p.id, gone.id)],
    ];
    for (const [name, attempt] of attempts) {
      const h = await holder();
      try {
        await h.query('UPDATE projects SET archived_at = now(), version = version + 1 WHERE id = $1', [p.id]); // archive, not yet committed
        const pending = attempt();
        await pause(300);
        expect(await settled(pending), name).toBe(false); // waits for the archive to finish
        await h.query('COMMIT');
        expect(await pending, name).toMatchObject({ status: 409, body: { error: 'project_archived' } });
      } finally {
        await h.end();
      }
      await admin.query('UPDATE projects SET archived_at = NULL WHERE id = $1', [p.id]); // reopen for the next attempt
    }
    const after = (await admin.query('SELECT id, version, status, archived_at FROM project_tasks WHERE project_id = $1 ORDER BY id', [p.id])).rows;
    expect(after).toEqual(before);
  });

  it('removing a member while they are being assigned: the assignment is cleared, never left pointing at a removed member', async () => {
    const a = api(A.people.OWNER!, A.slug);
    const temp = await newUser('pa-race');
    await invite(A.slug, A.people.OWNER!, temp, 'MEMBER');
    const p = (await a.create({ name: 'Race: removal' })).body.project;
    const t = (await a.createTask(p.id, { title: 'About to be assigned' })).body.task;
    const membership = (await a.members()).body.members.find((m: { userId: string }) => m.userId === temp.id);
    const h = await holder();
    try {
      await h.query('UPDATE project_tasks SET assignee_user_id = $1 WHERE id = $2', [temp.id, t.id]); // assignment in flight
      const removal = a.removeMember(membership.id);
      await pause(300);
      await h.query('COMMIT');
      expect((await removal).status).toBe(200);
    } finally {
      await h.end();
    }
    expect((await admin.query('SELECT assignee_user_id FROM project_tasks WHERE id = $1', [t.id])).rows[0].assignee_user_id).toBeNull();
    expect((await admin.query('SELECT count(*)::int AS n FROM memberships WHERE id = $1', [membership.id])).rows[0].n).toBe(0);
  });
});
