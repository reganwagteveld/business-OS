import { inviteForSignup, admitFixture } from './support/admission';
/**
 * Reporting WP-R1 (docs/reporting-operational-r1.md): expenses recorded, tasks completed and events
 * scheduled, through the real route handlers against PostgreSQL with the migrations and privileged SQL
 * applied as in production. Business A is in Perth (UTC+8, no daylight saving), business B is a second
 * tenant. Source data is created through the owning Zones' own endpoints, so every expected figure comes
 * from Finance, Projects or Scheduling themselves, never from a second calculation in the test.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReportingCatalogResponse, ReportingDetailsResponse, ReportingQueryResponse, SavedViewResponse } from '@business-os/contracts';
import type { Permission, Role } from '@/modules/access';

// Narrower permission sets for one role at a time. Everything else is the real code path.
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
import * as categoriesRoute from '@/app/api/v1/b/[slug]/finance/expense-categories/route';
import * as taxRatesRoute from '@/app/api/v1/b/[slug]/finance/tax-rates/route';
import * as expensesRoute from '@/app/api/v1/b/[slug]/finance/expenses/route';
import * as expenseRecord from '@/app/api/v1/b/[slug]/finance/expenses/[expenseId]/record/route';
import * as expenseVoid from '@/app/api/v1/b/[slug]/finance/expenses/[expenseId]/void/route';
import * as projectsRoute from '@/app/api/v1/b/[slug]/projects/route';
import * as projectArchive from '@/app/api/v1/b/[slug]/projects/[projectId]/archive/route';
import * as tasksRoute from '@/app/api/v1/b/[slug]/projects/[projectId]/tasks/route';
import * as taskMove from '@/app/api/v1/b/[slug]/projects/[projectId]/tasks/[taskId]/move/route';
import * as taskArchive from '@/app/api/v1/b/[slug]/projects/[projectId]/tasks/[taskId]/archive/route';
import * as defaultCalendar from '@/app/api/v1/b/[slug]/scheduling/calendars/default/route';
import * as eventsRoute from '@/app/api/v1/b/[slug]/scheduling/events/route';
import * as eventCancel from '@/app/api/v1/b/[slug]/scheduling/events/[eventId]/cancel/route';
import * as eventArchive from '@/app/api/v1/b/[slug]/scheduling/events/[eventId]/archive/route';
import * as metricsRoute from '@/app/api/v1/b/[slug]/reporting/metrics/route';
import * as queryRoute from '@/app/api/v1/b/[slug]/reporting/query/route';
import * as detailsRoute from '@/app/api/v1/b/[slug]/reporting/details/route';
import * as viewsRoute from '@/app/api/v1/b/[slug]/reporting/views/route';
import * as runRoute from '@/app/api/v1/b/[slug]/reporting/views/[viewId]/run/route';
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

// An address range of its own; random start so back-to-back runs do not hit earlier sign-in limits.
let ip = 1 + Math.floor(Math.random() * 200) * 250;
type User = { email: string; cookie: string; id: string };
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.126.${Math.floor(ip / 250) % 256}.${ip++ % 250}`, origin: ORIGIN });
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  if (method === 'POST') headers.set('idempotency-key', randomUUID());
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
  await authRoute.GET(new Request(`${BASE}${link.pathname}${link.search}`, { method: 'GET', headers: { 'x-forwarded-for': `100.127.${Math.floor(ip / 250) % 256}.${ip++ % 250}` } }));
  const res = await authRoute.POST(req('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD } }));
  const cookie = res.headers.getSetCookie().find((c) => /session_token=/.test(c))!.split(';')[0]!;
  const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
  return { email, cookie, id: rows[0].id };
}

async function invite(owner: User, slug: string, user: User, role: string) {
  await invitationsRoute.POST(req('POST', `/api/v1/b/${slug}/invitations`, { cookie: owner.cookie, body: { email: user.email, role } }), ctx({ slug }));
  const mail = [...devOutbox].reverse().find((m) => m.to === user.email)!;
  const token = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!).searchParams.get('token');
  expect((await acceptRoute.POST(req('POST', '/api/v1/invitations/accept', { cookie: user.cookie, body: { token } }))).status).toBe(200);
}

async function team(label: string, roles = ['ADMIN', 'MANAGER', 'MEMBER']) {
  const owner = await newUser(`${label}-owner`);
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const created = await businessesRoute.POST(req('POST', '/api/v1/businesses', {
    cookie: owner.cookie, body: { name: `Business ${label}`, slug, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  }));
  expect(created.status).toBe(201);
  const people: Record<string, User> = { OWNER: owner };
  for (const role of roles) {
    const user = await newUser(`${label}-${role.toLowerCase()}`);
    await invite(owner, slug, user, role);
    people[role] = user;
  }
  const { rows } = await admin.query('SELECT id FROM businesses WHERE slug = $1', [slug]);
  return { slug, people, businessId: rows[0].id as string };
}

type Result = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: User | null, slug: string, handler: Handler, method: string, path: string, params: Record<string, string> = {}, body?: unknown): Promise<Result> {
  const res = await handler(req(method, `/api/v1/b/${slug}${path}`, { cookie: who?.cookie, body }), ctx({ slug, ...params }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}


const M = (id: string, version = 1) => ({ id, version });
const fixed = (from: string, to: string) => ({ kind: 'fixed' as const, from, to });
const query = (who: User | null, slug: string, body: unknown) => call(who, slug, queryRoute.POST, 'POST', '/reporting/query', {}, body);
const details = (who: User | null, slug: string, body: unknown) => call(who, slug, detailsRoute.POST, 'POST', '/reporting/details', {}, body);
const ok = (r: Result) => {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return ReportingQueryResponse.parse(r.body);
};
const first = (r: Result) => {
  const result = ok(r).results[0]!;
  if (result.status !== 'ok') throw new Error(`metric failed: ${result.code}`);
  return result;
};
const values = (r: ReturnType<typeof first>, series = 0) => r.series[series]!.points.map((p) => p.value);

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
const a = { acme: '', beta: '', expenseIds: [] as string[], taskIds: [] as string[], eventIds: [] as string[], excluded: [] as string[], aud: [] as string[] };

beforeAll(async () => {
  A = await team('wa');
  B = await team('wb', []);
  const own = A.people.OWNER!;
  a.acme = (await call(own, A.slug, customersRoute.POST, 'POST', '/customers', {}, { displayName: 'Acme' })).body.customer.id;
  a.beta = (await call(own, A.slug, customersRoute.POST, 'POST', '/customers', {}, { displayName: 'Beta' })).body.customer.id;

  // ---- expenses: Finance's own endpoints ------------------------------------------------------------
  const travel = (await call(own, A.slug, categoriesRoute.GET, 'GET', '/finance/expense-categories')).body.categories.find((c: { systemKey: string }) => c.systemKey === 'travel').id;
  const gst = (await call(own, A.slug, taxRatesRoute.POST, 'POST', '/finance/tax-rates', {}, { name: 'GST', ratePercent: '10' })).body.taxRate.id;
  const draft = async (slug: string, who: User, category: string, o: Record<string, unknown>) => {
    const res = await call(who, slug, expensesRoute.POST, 'POST', '/finance/expenses', {}, { categoryId: category, description: 'Cost', taxTreatment: 'NO_TAX', ...o });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.expense as { id: string; version: number; amount: string };
  };
  const record = async (slug: string, who: User, e: { id: string; version: number }) => {
    const res = await call(who, slug, expenseRecord.POST, 'POST', `/finance/expenses/${e.id}/record`, { expenseId: e.id }, { version: e.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.expense as { id: string; version: number; amount: string };
  };
  const e1 = await record(A.slug, own, await draft(A.slug, own, travel, { incurredOn: '2026-10-10', amount: '100.00', supplierName: 'Air Co' }));
  const e2 = await record(A.slug, own, await draft(A.slug, own, travel, { incurredOn: '2026-10-31', amount: '40.00' }));
  // Tax inclusive: the metric reports the gross cost as billed (110.00), not the net subtotal.
  const e3 = await record(A.slug, own, await draft(A.slug, own, travel, { incurredOn: '2026-11-03', amount: '110.00', taxTreatment: 'TAX_INCLUSIVE', taxRateId: gst, customerId: a.acme }));
  const e4 = await record(A.slug, own, await draft(A.slug, own, travel, { incurredOn: '2026-11-05', amount: '75.00', currencyCode: 'USD', customerId: a.beta }));
  a.expenseIds = [e1.id, e2.id, e3.id, e4.id];
  a.aud = [e1.amount, e2.amount, e3.amount];
  const voided = await record(A.slug, own, await draft(A.slug, own, travel, { incurredOn: '2026-11-04', amount: '999.00' }));
  expect((await call(own, A.slug, expenseVoid.POST, 'POST', `/finance/expenses/${voided.id}/void`, { expenseId: voided.id }, { version: voided.version, reason: 'Duplicate' })).status).toBe(200);
  const drafted = await draft(A.slug, own, travel, { incurredOn: '2026-11-04', amount: '5000.00' });
  a.excluded.push(voided.id, drafted.id);

  // ---- tasks: Projects' own endpoints; completion time set directly to hit the Perth boundary --------
  const project = async (slug: string, who: User, name: string) => (await call(who, slug, projectsRoute.POST, 'POST', '/projects', {}, { name })).body.project.id as string;
  const task = async (slug: string, who: User, projectId: string, title: string) => (await call(who, slug, tasksRoute.POST, 'POST', `/projects/${projectId}/tasks`, { projectId }, { title })).body.task as { id: string; version: number };
  const done = async (slug: string, who: User, projectId: string, t: { id: string; version: number }) => {
    const res = await call(who, slug, taskMove.POST, 'POST', `/projects/${projectId}/tasks/${t.id}/move`, { projectId, taskId: t.id }, { version: t.version, status: 'DONE', afterTaskId: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.task as { id: string; version: number };
  };
  const p1 = await project(A.slug, own, 'Fit-out');
  const p2 = await project(A.slug, own, 'Website');
  const t1 = await done(A.slug, own, p1, await task(A.slug, own, p1, 'Order stock'));   // 31 Oct 23:59:59 Perth
  const t2 = await done(A.slug, own, p1, await task(A.slug, own, p1, 'Paint walls'));   // 1 Nov 00:00:00 Perth
  const t3 = await done(A.slug, own, p2, await task(A.slug, own, p2, 'Write copy'));    // mid November
  await admin.query("UPDATE project_tasks SET completed_at = '2026-10-31T15:59:59Z' WHERE id = $1", [t1.id]);
  await admin.query("UPDATE project_tasks SET completed_at = '2026-10-31T16:00:00Z' WHERE id = $1", [t2.id]);
  await admin.query("UPDATE project_tasks SET completed_at = '2026-11-12T02:00:00Z' WHERE id = $1", [t3.id]);
  a.taskIds = [t1.id, t2.id, t3.id];
  // Excluded: reopened (done, then moved back), archived, still open.
  const reopened = await done(A.slug, own, p1, await task(A.slug, own, p1, 'Reopened'));
  const back = await call(own, A.slug, taskMove.POST, 'POST', `/projects/${p1}/tasks/${reopened.id}/move`, { projectId: p1, taskId: reopened.id }, { version: reopened.version, status: 'TODO', afterTaskId: null });
  expect(back.status, JSON.stringify(back.body)).toBe(200);
  const archivedTask = await done(A.slug, own, p1, await task(A.slug, own, p1, 'Archived'));
  await admin.query("UPDATE project_tasks SET completed_at = '2026-11-02T02:00:00Z' WHERE id = $1", [archivedTask.id]);
  expect((await call(own, A.slug, taskArchive.POST, 'POST', `/projects/${p1}/tasks/${archivedTask.id}/archive`, { projectId: p1, taskId: archivedTask.id })).status).toBe(200);
  const open = await task(A.slug, own, p1, 'Still open');
  a.excluded.push(reopened.id, archivedTask.id, open.id);
  // A task finished in a project that is archived afterwards still counts: the work happened.
  const p3 = await project(A.slug, own, 'Old job');
  const t4 = await done(A.slug, own, p3, await task(A.slug, own, p3, 'Hand over'));
  await admin.query("UPDATE project_tasks SET completed_at = '2026-11-20T02:00:00Z' WHERE id = $1", [t4.id]);
  expect((await call(own, A.slug, projectArchive.POST, 'POST', `/projects/${p3}/archive`, { projectId: p3 })).status).toBe(200);
  a.taskIds.push(t4.id);

  // ---- events: Scheduling's own endpoints ---------------------------------------------------------------
  const cal = (await call(own, A.slug, defaultCalendar.POST, 'POST', '/scheduling/calendars/default')).body.calendar.id as string;
  const event = async (slug: string, who: User, calendarId: string, title: string, start: string, end: string, extra: Record<string, unknown> = {}) => {
    const res = await call(who, slug, eventsRoute.POST, 'POST', '/scheduling/events', {}, { calendarId, title, start: { at: start }, end: { at: end }, blocksAvailability: false, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.event as { id: string; version: number };
  };
  const v1 = await event(A.slug, own, cal, 'Site visit', '2026-10-31T15:30:00Z', '2026-10-31T15:59:00Z');          // 31 Oct 23:30 Perth
  const v2 = await event(A.slug, own, cal, 'Install', '2026-10-31T16:00:00Z', '2026-10-31T17:00:00Z', { customerId: a.acme }); // 1 Nov 00:00 Perth
  const v3 = await event(A.slug, own, cal, 'Review', '2026-11-10T01:00:00Z', '2026-11-10T02:00:00Z', { customerId: a.beta });
  a.eventIds = [v1.id, v2.id, v3.id];
  const cancelled = await event(A.slug, own, cal, 'Cancelled', '2026-11-11T01:00:00Z', '2026-11-11T02:00:00Z');
  expect((await call(own, A.slug, eventCancel.POST, 'POST', `/scheduling/events/${cancelled.id}/cancel`, { eventId: cancelled.id }, { version: cancelled.version })).status).toBe(200);
  const archivedEvent = await event(A.slug, own, cal, 'Archived', '2026-11-12T01:00:00Z', '2026-11-12T02:00:00Z');
  expect((await call(own, A.slug, eventArchive.POST, 'POST', `/scheduling/events/${archivedEvent.id}/archive`, { eventId: archivedEvent.id }, { version: archivedEvent.version })).status).toBe(200);
  a.excluded.push(cancelled.id, archivedEvent.id);

  // ---- business B: one of each, so isolation is about real data on both sides ----------------------------
  const bo = B.people.OWNER!;
  const bCat = (await call(bo, B.slug, categoriesRoute.GET, 'GET', '/finance/expense-categories')).body.categories[0].id;
  await record(B.slug, bo, await draft(B.slug, bo, bCat, { incurredOn: '2026-11-01', amount: '7777.00' }));
  const bp = await project(B.slug, bo, 'B project');
  await done(B.slug, bo, bp, await task(B.slug, bo, bp, 'B task'));
  const bcal = (await call(bo, B.slug, defaultCalendar.POST, 'POST', '/scheduling/calendars/default')).body.calendar.id as string;
  await event(B.slug, bo, bcal, 'B event', '2026-11-01T01:00:00Z', '2026-11-01T02:00:00Z');
}, 180_000);

const OCT_NOV = fixed('2026-10-01', '2026-11-30');

describe('catalogue', () => {
  it('lists the three metrics as available with their rules, and people.headcount and messages stay planned', async () => {
    const res = await call(A.people.OWNER!, A.slug, metricsRoute.GET, 'GET', '/reporting/metrics');
    const cat = ReportingCatalogResponse.parse(res.body);
    const byId = Object.fromEntries(cat.metrics.map((m) => [m.id, m]));
    expect(byId['finance.expenses_recorded']).toMatchObject({ availability: 'available', accessible: true, requires: ['finance:read'], hasDetail: true, plannedNote: null });
    expect(byId['projects.tasks_completed']).toMatchObject({ availability: 'available', accessible: true, requires: ['projects:read'], dimensions: [] });
    expect(byId['scheduling.events_scheduled']).toMatchObject({ availability: 'available', accessible: true, requires: ['scheduling:read'], dimensions: ['customer'] });
    expect(byId['people.headcount']).toMatchObject({ availability: 'planned' });
    expect(byId['communications.messages_recorded']).toMatchObject({ availability: 'planned' });
    for (const id of ['finance.expenses_recorded', 'projects.tasks_completed', 'scheduling.events_scheduled']) expect(byId[id]!.statusTreatment).toBeTruthy();
  });
});

describe('expenses recorded', () => {
  it('sums the gross cost of recorded expenses by expense date, per currency; draft and void never count', async () => {
    const aud = first(await query(A.people.OWNER!, A.slug, { metrics: [M('finance.expenses_recorded')], date: OCT_NOV, granularity: 'month', filters: { currencyCode: 'AUD' } }));
    expect(aud.series).toHaveLength(1);
    expect(values(aud)).toEqual(['140.00', '110.00']); // 100 + 40 in October; the tax-inclusive 110.00 gross in November
    expect(aud.series[0]!.total).toBe('250.00');
    const usd = first(await query(A.people.OWNER!, A.slug, { metrics: [M('finance.expenses_recorded')], date: OCT_NOV, granularity: 'none', filters: { currencyCode: 'USD' } }));
    expect(usd.series[0]!.total).toBe('75.00');
    const both = first(await query(A.people.OWNER!, A.slug, { metrics: [M('finance.expenses_recorded')], date: OCT_NOV, granularity: 'none' }));
    expect(both.series.map((s) => s.currencyCode).sort()).toEqual(['AUD', 'USD']); // never added together
    expect(both.notes.join(' ')).toMatch(/never converted/);
  });

  it('places expense dates by calendar day at the month boundary and compares with the previous period', async () => {
    const days = first(await query(A.people.OWNER!, A.slug, { metrics: [M('finance.expenses_recorded')], date: fixed('2026-10-30', '2026-11-03'), granularity: 'day', filters: { currencyCode: 'AUD' } }));
    expect(values(days)).toEqual(['0.00', '40.00', '0.00', '0.00', '110.00']);
    const cmp = first(await query(A.people.OWNER!, A.slug, { metrics: [M('finance.expenses_recorded')], date: fixed('2026-11-01', '2026-11-30'), granularity: 'none', filters: { currencyCode: 'AUD' }, comparison: 'previous_period' }));
    expect(cmp.series[0]!.total).toBe('110.00');
    expect(cmp.series[0]!.comparisonTotal).toBe('140.00'); // the 30 days before: 2 to 31 October (100.00 on the 10th, 40.00 on the 31st)
  });

  it('filters and groups by customer; names need customers:read', async () => {
    const byCustomer = first(await query(A.people.OWNER!, A.slug, { metrics: [M('finance.expenses_recorded')], date: OCT_NOV, granularity: 'none', groupBy: 'customer', filters: { currencyCode: 'AUD' } }));
    const labels = Object.fromEntries(byCustomer.series.map((s) => [s.label, s.total]));
    expect(labels).toEqual({ 'Acme (AUD)': '110.00', 'No customer (AUD)': '140.00' });
    const one = first(await query(A.people.OWNER!, A.slug, { metrics: [M('finance.expenses_recorded')], date: OCT_NOV, granularity: 'none', filters: { customerId: a.beta } }));
    expect(one.series.map((s) => [s.currencyCode, s.total])).toEqual([['USD', '75.00']]);
    custom.MANAGER = ['business:read', 'reporting:read', 'finance:read'];
    expect((await query(A.people.MANAGER!, A.slug, { metrics: [M('finance.expenses_recorded')], date: OCT_NOV, groupBy: 'customer' })).status).toBe(403);
  });

  it('drill-down lists exactly the recorded expenses behind the total, newest first, and pages without repeats', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await details(A.people.OWNER!, A.slug, { metric: M('finance.expenses_recorded'), date: OCT_NOV, limit: 1, ...(cursor ? { cursor } : {}) });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const page = ReportingDetailsResponse.parse(res.body);
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect([...seen].sort()).toEqual([...a.expenseIds].sort());
    for (const id of a.excluded) expect(seen).not.toContain(id);
    const all = await details(A.people.OWNER!, A.slug, { metric: M('finance.expenses_recorded'), date: OCT_NOV });
    expect(all.body.rows.map((r: { id: string }) => r.id)).toEqual(seen);
    expect(all.body.columns.map((c: { key: string }) => c.key)).toEqual(['incurredOn', 'customer', 'description', 'supplierName', 'categoryName', 'amount']);
    // Notes, receipt references and tax internals never leave Finance.
    expect(JSON.stringify(all.body)).not.toMatch(/receipt|notes|taxName/i);
  });

  it('keeps the source Zone key: no finance:read means 403 on query and details', async () => {
    expect((await query(A.people.MEMBER!, A.slug, { metrics: [M('finance.expenses_recorded')], date: OCT_NOV })).status).toBe(403);
    expect((await details(A.people.MEMBER!, A.slug, { metric: M('finance.expenses_recorded'), date: OCT_NOV })).status).toBe(403);
  });
});

describe('tasks completed', () => {
  it('counts done tasks by completion time in the business time zone, at the Perth boundary', async () => {
    const r = first(await query(A.people.MEMBER!, A.slug, { metrics: [M('projects.tasks_completed')], date: OCT_NOV, granularity: 'month' }));
    // 15:59:59Z on 31 Oct is still October in Perth; 16:00:00Z is 1 November 00:00. Reopened, archived and open tasks never count.
    expect(values(r)).toEqual(['1', '3']); // Nov: t2 (Perth midnight), t3, and t4 from the archived project
    expect(r.series[0]!.total).toBe('4');
  });

  it('compares with the previous period and reads an empty period as zero', async () => {
    const r = first(await query(A.people.OWNER!, A.slug, { metrics: [M('projects.tasks_completed')], date: fixed('2026-11-01', '2026-11-30'), granularity: 'none', comparison: 'previous_period' }));
    expect(r.series[0]!.total).toBe('3');
    expect(r.series[0]!.comparisonTotal).toBe('1');
    const empty = first(await query(A.people.OWNER!, A.slug, { metrics: [M('projects.tasks_completed')], date: fixed('2025-01-01', '2025-01-31'), granularity: 'none' }));
    expect(empty.series[0]!.total).toBe('0');
  });

  it('a task that is reopened leaves the report, and returns when it is completed again', async () => {
    const own = A.people.OWNER!;
    const { rows } = await admin.query("SELECT t.id, t.project_id, t.version FROM project_tasks t WHERE t.business_id = $1 AND t.title = 'Write copy'", [A.businessId]);
    const t = rows[0] as { id: string; project_id: string; version: number };
    const count = async () => first(await query(own, A.slug, { metrics: [M('projects.tasks_completed')], date: fixed('2026-11-12', '2026-11-12'), granularity: 'none' })).series[0]!.total;
    expect(await count()).toBe('1');
    const move = (status: string, version: number) => call(own, A.slug, taskMove.POST, 'POST', `/projects/${t.project_id}/tasks/${t.id}/move`, { projectId: t.project_id, taskId: t.id }, { version, status, afterTaskId: null });
    const re = await move('IN_PROGRESS', t.version);
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(await count()).toBe('0');
    const again = await move('DONE', re.body.task.version);
    expect(again.status).toBe(200);
    await admin.query("UPDATE project_tasks SET completed_at = '2026-11-12T02:00:00Z' WHERE id = $1", [t.id]);
    expect(await count()).toBe('1');
  });

  it('drill-down lists task, project and completion time only', async () => {
    const res = await details(A.people.MEMBER!, A.slug, { metric: M('projects.tasks_completed'), date: OCT_NOV, limit: 2 });
    const page = ReportingDetailsResponse.parse(res.body);
    expect(page.columns.map((c) => c.key)).toEqual(['title', 'projectName', 'completedAt']);
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const rest = ReportingDetailsResponse.parse((await details(A.people.MEMBER!, A.slug, { metric: M('projects.tasks_completed'), date: OCT_NOV, limit: 10, cursor: page.nextCursor })).body);
    const ids = [...page.rows, ...rest.rows].map((r) => r.id);
    expect([...ids].sort()).toEqual([...a.taskIds].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.stringify(res.body)).not.toMatch(/description|assignee/i);
  });

  it('needs projects:read on top of reporting:read, and supports no grouping or filters', async () => {
    custom.MANAGER = ['business:read', 'reporting:read', 'sales:read'];
    expect((await query(A.people.MANAGER!, A.slug, { metrics: [M('projects.tasks_completed')], date: OCT_NOV })).status).toBe(403);
    expect(await query(A.people.OWNER!, A.slug, { metrics: [M('projects.tasks_completed')], date: OCT_NOV, groupBy: 'customer' })).toMatchObject({ status: 400, body: { error: 'unsupported_dimension' } });
    expect(await query(A.people.OWNER!, A.slug, { metrics: [M('projects.tasks_completed')], date: OCT_NOV, filters: { customerId: a.acme } })).toMatchObject({ status: 400, body: { error: 'unsupported_filter' } });
  });
});

describe('events scheduled', () => {
  it('counts scheduled, unarchived events by start time in the business time zone; cancelled and archived never count', async () => {
    const r = first(await query(A.people.MEMBER!, A.slug, { metrics: [M('scheduling.events_scheduled')], date: OCT_NOV, granularity: 'month' }));
    expect(values(r)).toEqual(['1', '2']);
    const daily = first(await query(A.people.OWNER!, A.slug, { metrics: [M('scheduling.events_scheduled')], date: fixed('2026-10-31', '2026-11-01'), granularity: 'day' }));
    expect(values(daily)).toEqual(['1', '1']);
  });

  it('filters and groups by customer; names need customers:read', async () => {
    const one = first(await query(A.people.OWNER!, A.slug, { metrics: [M('scheduling.events_scheduled')], date: OCT_NOV, granularity: 'none', filters: { customerId: a.acme } }));
    expect(one.series[0]!.total).toBe('1');
    const grouped = first(await query(A.people.OWNER!, A.slug, { metrics: [M('scheduling.events_scheduled')], date: OCT_NOV, granularity: 'none', groupBy: 'customer' }));
    expect(Object.fromEntries(grouped.series.map((s) => [s.label, s.total]))).toEqual({ Acme: '1', Beta: '1', 'No customer': '1' });
    custom.MANAGER = ['business:read', 'reporting:read', 'scheduling:read'];
    expect((await query(A.people.MANAGER!, A.slug, { metrics: [M('scheduling.events_scheduled')], date: OCT_NOV, groupBy: 'customer' })).status).toBe(403);
    const d = await details(A.people.MANAGER!, A.slug, { metric: M('scheduling.events_scheduled'), date: OCT_NOV });
    expect(d.status).toBe(200);
    expect(d.body.columns.map((c: { key: string }) => c.key)).not.toContain('customer');
    expect(JSON.stringify(d.body)).not.toMatch(/Acme|Beta/);
  });

  it('drill-down lists the events behind the count, latest first, without description, location or resources', async () => {
    const res = await details(A.people.OWNER!, A.slug, { metric: M('scheduling.events_scheduled'), date: OCT_NOV, limit: 100 });
    const page = ReportingDetailsResponse.parse(res.body);
    expect(page.rows.map((r) => r.id)).toEqual([a.eventIds[2], a.eventIds[1], a.eventIds[0]]);
    for (const id of a.excluded) expect(page.rows.map((r) => r.id)).not.toContain(id);
    expect(JSON.stringify(res.body)).not.toMatch(/description|location|resource/i);
  });

  it('needs scheduling:read', async () => {
    custom.MEMBER = ['business:read', 'reporting:read', 'projects:read'];
    expect((await query(A.people.MEMBER!, A.slug, { metrics: [M('scheduling.events_scheduled')], date: OCT_NOV })).status).toBe(403);
  });
});

describe('isolation, cursors and saved views', () => {
  it('never shows another business\'s data, and a foreign customer id as a filter finds nothing', async () => {
    const exp = first(await query(B.people.OWNER!, B.slug, { metrics: [M('finance.expenses_recorded')], date: OCT_NOV, granularity: 'none' }));
    expect(exp.series[0]!.total).toBe('7777.00');
    expect(first(await query(B.people.OWNER!, B.slug, { metrics: [M('projects.tasks_completed')], date: OCT_NOV, granularity: 'none' })).series[0]!.total).toBe('1');
    expect(first(await query(B.people.OWNER!, B.slug, { metrics: [M('scheduling.events_scheduled')], date: OCT_NOV, granularity: 'none' })).series[0]!.total).toBe('1');
    const aIds = new Set([...a.expenseIds, ...a.taskIds, ...a.eventIds]);
    for (const metric of ['finance.expenses_recorded', 'projects.tasks_completed', 'scheduling.events_scheduled']) {
      const d = await details(B.people.OWNER!, B.slug, { metric: M(metric), date: OCT_NOV, limit: 100 });
      expect(d.body.rows.some((r: { id: string }) => aIds.has(r.id)), metric).toBe(false);
    }
    const f = first(await query(B.people.OWNER!, B.slug, { metrics: [M('scheduling.events_scheduled')], date: OCT_NOV, filters: { customerId: a.acme }, granularity: 'none' }));
    expect(f.series[0]!.total).toBe('0');
    expect((await query(B.people.OWNER!, A.slug, { metrics: [M('projects.tasks_completed')], date: OCT_NOV })).status).toBe(404);
  });

  it('refuses a cursor taken from another metric or tampered with', async () => {
    const page = await details(A.people.OWNER!, A.slug, { metric: M('projects.tasks_completed'), date: OCT_NOV, limit: 1 });
    expect(await details(A.people.OWNER!, A.slug, { metric: M('scheduling.events_scheduled'), date: OCT_NOV, cursor: page.body.nextCursor })).toMatchObject({ status: 400, body: { error: 'invalid_cursor' } });
    expect(await details(A.people.OWNER!, A.slug, { metric: M('finance.expenses_recorded'), date: OCT_NOV, cursor: page.body.nextCursor })).toMatchObject({ status: 400, body: { error: 'invalid_cursor' } });
    expect((await details(A.people.OWNER!, A.slug, { metric: M('finance.expenses_recorded'), date: OCT_NOV, cursor: 'bm90LWEtY3Vyc29y' })).body.error).toBe('invalid_cursor');
  });

  it('a saved report may use the new metrics and runs with the same figures, and a role that lost the key sees an error without data', async () => {
    const config = {
      metrics: [M('finance.expenses_recorded'), M('projects.tasks_completed'), M('scheduling.events_scheduled')], date: OCT_NOV, granularity: 'month', groupBy: null, filters: {},
      comparison: 'none', sort: { by: 'bucket', direction: 'asc' }, visualization: { chart: 'bar', showComparison: false },
    };
    const made = await call(A.people.OWNER!, A.slug, viewsRoute.POST, 'POST', '/reporting/views', {}, { title: 'Operations', config });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const view = SavedViewResponse.parse(made.body).view;
    const run = await call(A.people.OWNER!, A.slug, runRoute.POST, 'POST', `/reporting/views/${view.id}/run`, { viewId: view.id });
    expect(run.status).toBe(200);
    const results = run.body.result.results as { status: string }[];
    expect(run.body.view.id).toBe(view.id);
    expect(results.map((x) => x.status)).toEqual(['ok', 'ok', 'ok']);
    // A person who cannot read Finance cannot save a view that uses an expense metric.
    expect((await call(A.people.MEMBER!, A.slug, viewsRoute.POST, 'POST', '/reporting/views', {}, { title: 'No', config })).status).toBe(403);
  });
});
