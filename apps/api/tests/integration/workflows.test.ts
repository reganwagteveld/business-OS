import { inviteForSignup, admitFixture } from './support/admission';
/**
 * LC-1 = WF-1B-2 (docs/cross-zone-workflows-wf1.md §6.2–6.4, §6.6, §6.10, §7, §8; docs/customer-lifecycle-audit-wf2.md
 * AC-1.1..1.6): the workflows module and its four routes, plus GET projects?sourceOpportunityId=, against real
 * PostgreSQL with the migrations applied, through the real route handlers.
 *
 * Concurrency (gate G-2, T-36..39) is deterministic: a barrier session holds a lock the service needs, and the
 * test proceeds only once PostgreSQL itself reports the requests waiting behind it (pg_blocking_pids), so no
 * test can pass by running serially. Fault injection (T-31) uses a test-only trigger on workflow_requests, so
 * the service carries no test hook.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Permission, Role } from '@/modules/access';
import { backendPid, waitUntilBlocked } from './support/locks';

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
import * as customerArchive from '@/app/api/v1/b/[slug]/customers/[customerId]/archive/route';
import * as customerProjectsRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/projects/route';
import * as opportunitiesRoute from '@/app/api/v1/b/[slug]/sales/opportunities/route';
import * as opportunityWin from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/win/route';
import * as opportunityLose from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/lose/route';
import * as opportunityReopen from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/reopen/route';
import * as opportunityArchive from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/archive/route';
import * as projectsRoute from '@/app/api/v1/b/[slug]/projects/route';
import * as projectRoute from '@/app/api/v1/b/[slug]/projects/[projectId]/route';
import * as projectArchive from '@/app/api/v1/b/[slug]/projects/[projectId]/archive/route';
import * as quotesRoute from '@/app/api/v1/b/[slug]/finance/quotes/route';
import * as quoteIssue from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/issue/route';
import * as quoteAccept from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/accept/route';
import * as quoteDecline from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/decline/route';
import * as quoteVoid from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/void/route';
import * as quoteConvert from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/convert/route';
import * as settingsRoute from '@/app/api/v1/b/[slug]/finance/settings/route';
import * as summaryRoute from '@/app/api/v1/b/[slug]/finance/projects/[projectId]/summary/route';
import * as fromOpportunityRoute from '@/app/api/v1/b/[slug]/workflows/projects/from-opportunity/route';
import * as fromQuoteRoute from '@/app/api/v1/b/[slug]/workflows/projects/from-quote/route';
import * as linkOpportunityRoute from '@/app/api/v1/b/[slug]/workflows/projects/[projectId]/link-opportunity/route';
import * as linkQuoteRoute from '@/app/api/v1/b/[slug]/workflows/projects/[projectId]/link-quote/route';
import { devOutbox } from '@/core/email';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const APP_URL = process.env.DATABASE_URL!;
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

// Its own address range, so auth rate limits never couple this suite to another.
const IP_BLOCK = Number(process.env.WORKFLOWS_TEST_IP_BLOCK ?? 180);
let ip = 1;
type User = { email: string; cookie: string; id: string };

function req(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.${IP_BLOCK}.${Math.floor(ip / 250)}.${ip++ % 250}`, ...(opts.headers ?? {}) });
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
type R = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Route = (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>;
const key = () => `wf-${randomUUID()}`;

const api = (who: User, slug: string) => {
  const B = `/api/v1/b/${slug}`;
  const F = `${B}/finance`;
  const W = `${B}/workflows/projects`;
  const call = (h: Route, method: string, path: string, params: Record<string, string>, body?: unknown, headers?: Record<string, string>): Promise<R> =>
    h(req(method, path, { cookie: who.cookie, body, headers }), ctx({ slug, ...params })).then(json);
  const doc = (documentId: string) => ({ documentId });
  const opp = (opportunityId: string) => ({ opportunityId });
  return {
    createCustomer: (body: unknown) => call(customersRoute.POST, 'POST', `${B}/customers`, {}, body),
    archiveCustomer: (customerId: string) => call(customerArchive.POST, 'POST', `${B}/customers/${customerId}/archive`, { customerId }),
    customerProjects: (customerId: string, qs = '') => call(customerProjectsRoute.GET, 'GET', `${B}/customers/${customerId}/projects${qs}`, { customerId }),
    createOpportunity: (body: unknown) => call(opportunitiesRoute.POST, 'POST', `${B}/sales/opportunities`, {}, body),
    win: (id: string) => call(opportunityWin.POST, 'POST', `${B}/sales/opportunities/${id}/win`, opp(id)),
    lose: (id: string) => call(opportunityLose.POST, 'POST', `${B}/sales/opportunities/${id}/lose`, opp(id), {}),
    reopen: (id: string) => call(opportunityReopen.POST, 'POST', `${B}/sales/opportunities/${id}/reopen`, opp(id), {}),
    archiveOpportunity: (id: string) => call(opportunityArchive.POST, 'POST', `${B}/sales/opportunities/${id}/archive`, opp(id)),
    createProject: (body: unknown) => call(projectsRoute.POST, 'POST', `${B}/projects`, {}, body),
    listProjects: (qs = '') => call(projectsRoute.GET, 'GET', `${B}/projects${qs}`, {}),
    getProject: (projectId: string) => call(projectRoute.GET, 'GET', `${B}/projects/${projectId}`, { projectId }),
    archiveProject: (projectId: string) => call(projectArchive.POST, 'POST', `${B}/projects/${projectId}/archive`, { projectId }),
    createQuote: (body: unknown) => call(quotesRoute.POST, 'POST', `${F}/quotes`, {}, body),
    issueQuote: (id: string, version = 1) => call(quoteIssue.POST, 'POST', `${F}/quotes/${id}/issue`, doc(id), { version }),
    acceptQuote: (id: string, version = 2) => call(quoteAccept.POST, 'POST', `${F}/quotes/${id}/accept`, doc(id), { version }),
    declineQuote: (id: string, version = 2) => call(quoteDecline.POST, 'POST', `${F}/quotes/${id}/decline`, doc(id), { version }),
    voidQuote: (id: string, version: number) => call(quoteVoid.POST, 'POST', `${F}/quotes/${id}/void`, doc(id), { version, reason: 'Withdrawn' }),
    convert: (id: string) => call(quoteConvert.POST, 'POST', `${F}/quotes/${id}/convert`, doc(id), {}),
    patchSettings: (body: unknown) => call(settingsRoute.PATCH, 'PATCH', `${F}/settings`, {}, body),
    summary: (projectId: string) => call(summaryRoute.GET, 'GET', `${F}/projects/${projectId}/summary`, { projectId }),
    fromOpportunity: (body: unknown, k: string | null = key()) =>
      call(fromOpportunityRoute.POST, 'POST', `${W}/from-opportunity`, {}, body, k === null ? {} : { 'idempotency-key': k }),
    fromQuote: (body: unknown, k: string | null = key()) => call(fromQuoteRoute.POST, 'POST', `${W}/from-quote`, {}, body, k === null ? {} : { 'idempotency-key': k }),
    linkOpportunity: (projectId: string, body: unknown) => call(linkOpportunityRoute.POST, 'POST', `${W}/${projectId}/link-opportunity`, { projectId }, body),
    linkQuote: (projectId: string, body: unknown) => call(linkQuoteRoute.POST, 'POST', `${W}/${projectId}/link-quote`, { projectId }, body),
  };
};
type Api = ReturnType<typeof api>;

// ---- fixtures ------------------------------------------------------------------------------------

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let own: Api;
let seq = 0;

beforeAll(async () => {
  A = await team('lca');
  B = await team('lcb');
  own = api(A.people.OWNER!, A.slug);
  for (const T of [A, B]) {
    expect((await api(T.people.OWNER!, T.slug).patchSettings({
      version: 0, sellerLegalName: 'Seller Pty Ltd', sellerAddress: '9 Seller Street, Perth', defaultPaymentTermsDays: 30,
    })).status).toBe(200);
  }
}, 180_000);

const line = (unitPrice: string) => ({ description: 'Work', quantity: '1', unitPrice });
async function customer(a: Api = own, name = `Customer ${++seq}`): Promise<string> {
  const res = await a.createCustomer({ displayName: name });
  expect(res.status).toBe(201);
  return res.body.customer.id;
}
async function opportunity(customerId: string | null, a: Api = own, title = `Deal ${++seq}`): Promise<string> {
  const res = await a.createOpportunity({ title, ...(customerId ? { customerId } : {}) });
  expect(res.status).toBe(201);
  return res.body.opportunity.id;
}
async function project(customerId: string | null, a: Api = own): Promise<{ id: string; version: number }> {
  const res = await a.createProject({ name: `Project ${++seq}`, ...(customerId ? { customerId } : {}) });
  expect(res.status).toBe(201);
  return { id: res.body.project.id, version: res.body.project.version };
}
type Quote = { id: string; number: string | null; customerId: string; opportunityId: string | null; version: number; projectId: string | null };
/** An ACCEPTED quote (issued and accepted through the API). */
async function acceptedQuote(customerId: string, extra: Record<string, unknown> = {}, a: Api = own): Promise<Quote> {
  const q = (await a.createQuote({ customerId, lines: [line('500')], ...extra })).body.document;
  expect((await a.issueQuote(q.id)).status).toBe(200);
  const accepted = await a.acceptQuote(q.id);
  expect(accepted.status).toBe(200);
  return accepted.body.document;
}
const projectRow = async (id: string) => (await admin.query('SELECT * FROM projects WHERE id = $1', [id])).rows[0];
const count = async (sql: string, params: unknown[]) => (await admin.query(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0].n as number;
const audits = async (projectId: string) =>
  (await admin.query('SELECT action, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [projectId])).rows as { action: string; metadata: Record<string, unknown> }[];

/** A barrier: a bos_app transaction in tenant A's context that holds a lock the service needs. */
async function barrier(T: { businessId: string; people: Record<string, User> } = A) {
  const c = new pg.Client({ connectionString: APP_URL });
  await c.connect();
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [T.businessId, T.people.OWNER!.id]);
  const pid = await backendPid(c);
  const end = async (sql: string) => {
    try { await c.query(sql); } finally { await c.end(); }
  };
  return { pid, q: (sql: string, params?: unknown[]) => c.query(sql, params), commit: () => end('COMMIT'), rollback: () => end('ROLLBACK') };
}

// =====================================================================================================

describe('create project from opportunity (§6.2, AC-1.1, AC-1.2, D-WF1-15, D-WF1-16)', () => {
  it('an OPEN or WON opportunity gives one project with its customer, its title and sourceOpportunityId; LOST and archived are refused', async () => {
    const c = await customer();
    const open = await opportunity(c, own, 'Kitchen refit');
    const res = await own.fromOpportunity({ opportunityId: open, existingProjectCount: 0 });
    expect(res.status).toBe(201);
    expect(res.body.project).toMatchObject({
      name: 'Kitchen refit', customerId: c, status: 'PLANNED', sourceOpportunityId: open,
      sourceOpportunity: { id: open, title: 'Kitchen refit', status: 'OPEN' }, sourceQuoteId: null, sourceQuote: null, version: 1,
    });
    expect((await projectRow(res.body.project.id)).source_opportunity_id).toBe(open);

    const won = await opportunity(c);
    expect((await own.win(won)).status).toBe(200);
    const fromWon = await own.fromOpportunity({ opportunityId: won, existingProjectCount: 0, name: 'Stage 1', status: 'ACTIVE', startDate: '2026-12-01', dueDate: '2026-12-20' });
    expect(fromWon).toMatchObject({ status: 201, body: { project: { name: 'Stage 1', status: 'ACTIVE', startDate: '2026-12-01', dueDate: '2026-12-20', sourceOpportunity: { status: 'WON' } } } });

    const lost = await opportunity(c);
    expect((await own.lose(lost)).status).toBe(200);
    expect(await own.fromOpportunity({ opportunityId: lost, existingProjectCount: 0 })).toMatchObject({ status: 409, body: { error: 'opportunity_lost' } });
    expect((await own.reopen(lost)).status).toBe(200); // reopened: allowed again
    expect((await own.fromOpportunity({ opportunityId: lost, existingProjectCount: 0 })).status).toBe(201);

    const archived = await opportunity(c);
    expect((await own.archiveOpportunity(archived)).status).toBe(200);
    expect(await own.fromOpportunity({ opportunityId: archived, existingProjectCount: 0 })).toMatchObject({ status: 409, body: { error: 'archived_reference' } });

    // An opportunity without a customer gives a customerless project; an archived customer is refused (Projects rule, T-46).
    const loose = await opportunity(null);
    expect(await own.fromOpportunity({ opportunityId: loose, existingProjectCount: 0 })).toMatchObject({ status: 201, body: { project: { customerId: null } } });
    const gone = await customer();
    const oppOfGone = await opportunity(gone);
    expect((await own.archiveCustomer(gone)).status).toBe(200);
    expect(await own.fromOpportunity({ opportunityId: oppOfGone, existingProjectCount: 0 })).toMatchObject({ status: 409, body: { error: 'archived_reference' } });
    expect(await count('projects WHERE source_opportunity_id = ANY($1)', [[lost, archived, oppOfGone]])).toBe(1);
  });

  it('idempotency: same key and body replays 200 with the same project; another body is 409; no key is 400 (T-32, T-33)', async () => {
    const o = await opportunity(await customer());
    const k = key();
    const first = await own.fromOpportunity({ opportunityId: o, existingProjectCount: 0 }, k);
    expect(first.status).toBe(201);
    // The replay is not re-validated against the count (it is the same request), and returns the same project.
    const again = await own.fromOpportunity({ existingProjectCount: 0, opportunityId: o }, k);
    expect(again).toMatchObject({ status: 200, body: { project: { id: first.body.project.id } } });
    expect(await own.fromOpportunity({ opportunityId: o, existingProjectCount: 1 }, k)).toMatchObject({ status: 409, body: { error: 'idempotency_conflict' } });
    expect(await own.fromOpportunity({ opportunityId: o, existingProjectCount: 1 }, null)).toMatchObject({ status: 400, body: { error: 'idempotency_key_required' } });
    expect(await own.fromOpportunity({ opportunityId: o, existingProjectCount: 1 }, 'bad key')).toMatchObject({ status: 400, body: { error: 'invalid_idempotency_key' } });
    expect(await count('projects WHERE source_opportunity_id = $1', [o])).toBe(1);
    expect(await count('workflow_requests WHERE result_id = $1', [first.body.project.id])).toBe(1);
  });

  it('duplicate guard: a stale count is 409 opportunity_projects_changed, a confirmed new count creates another; an expired key cannot duplicate (T-35)', async () => {
    const o = await opportunity(await customer());
    const k = key();
    expect((await own.fromOpportunity({ opportunityId: o, existingProjectCount: 0 }, k)).status).toBe(201);
    expect(await own.fromOpportunity({ opportunityId: o, existingProjectCount: 0 })).toMatchObject({ status: 409, body: { error: 'opportunity_projects_changed' } });
    // The count includes archived projects and the filter with archived=all shows the same number.
    const listed = await own.listProjects(`?sourceOpportunityId=${o}&archived=all`);
    expect(listed.body.projects).toHaveLength(1);
    await own.archiveProject(listed.body.projects[0].id);
    expect((await own.fromOpportunity({ opportunityId: o, existingProjectCount: 0 })).status).toBe(409);
    expect((await own.fromOpportunity({ opportunityId: o, existingProjectCount: 1 })).status).toBe(201); // phased work (D-WF1-03)
    // Simulated key expiry (D-WF1-12): the ledger row is gone, the retry of the first request still cannot duplicate.
    await admin.query("DELETE FROM workflow_requests WHERE idempotency_key = $1", [k]);
    expect(await own.fromOpportunity({ opportunityId: o, existingProjectCount: 0 }, k)).toMatchObject({ status: 409, body: { error: 'opportunity_projects_changed' } });
    expect(await count('projects WHERE source_opportunity_id = $1', [o])).toBe(2);
  });

  it('needs customers:read when the opportunity has a customer (a custom principal with projects and sales keys only)', async () => {
    custom.MEMBER = ['projects:read', 'projects:create', 'sales:read'];
    const member = api(A.people.MEMBER!, A.slug);
    const withCustomer = await opportunity(await customer());
    expect(await member.fromOpportunity({ opportunityId: withCustomer, existingProjectCount: 0 })).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect((await member.fromOpportunity({ opportunityId: await opportunity(null), existingProjectCount: 0 })).status).toBe(201);
  });
});

describe('create project from accepted quote (§6.3, AC-1.3)', () => {
  it('only from ACCEPTED; one project per quote; name from number and customer; opportunity copied from the quote', async () => {
    const c = await customer(own, 'Harbour Cafe');
    const o = await opportunity(c);
    const q = await acceptedQuote(c, { opportunityId: o });
    const res = await own.fromQuote({ quoteId: q.id });
    expect(res.status).toBe(201);
    expect(res.body.project).toMatchObject({
      name: `${q.number} – Harbour Cafe`, customerId: c, sourceQuoteId: q.id, sourceQuote: { id: q.id, number: q.number, status: 'ACCEPTED' },
      sourceOpportunityId: o,
    });
    expect(await own.fromQuote({ quoteId: q.id })).toMatchObject({ status: 409, body: { error: 'quote_has_project' } });

    const draft = (await own.createQuote({ customerId: c, lines: [line('10')] })).body.document;
    expect(await own.fromQuote({ quoteId: draft.id })).toMatchObject({ status: 409, body: { error: 'quote_not_accepted' } });
    expect((await own.issueQuote(draft.id)).status).toBe(200);
    expect(await own.fromQuote({ quoteId: draft.id })).toMatchObject({ status: 409, body: { error: 'quote_not_accepted' } });
    expect((await own.declineQuote(draft.id)).status).toBe(200);
    expect(await own.fromQuote({ quoteId: draft.id })).toMatchObject({ status: 409, body: { error: 'quote_not_accepted' } });
    const voided = await acceptedQuote(c);
    expect((await own.voidQuote(voided.id, voided.version)).status).toBe(200);
    expect(await own.fromQuote({ quoteId: voided.id })).toMatchObject({ status: 409, body: { error: 'quote_not_accepted' } });

    // A quote drafted for a project already belongs to that project.
    const p = await project(c);
    const ofProject = await acceptedQuote(c, { projectId: p.id });
    expect(await own.fromQuote({ quoteId: ofProject.id })).toMatchObject({ status: 409, body: { error: 'quote_has_project' } });
    // A name given wins; an archived customer is refused (T-46).
    const named = await acceptedQuote(c);
    expect(await own.fromQuote({ quoteId: named.id, name: 'Fit-out' })).toMatchObject({ status: 201, body: { project: { name: 'Fit-out' } } });
    const gone = await customer();
    const ofGone = await acceptedQuote(gone);
    expect((await own.archiveCustomer(gone)).status).toBe(200);
    expect(await own.fromQuote({ quoteId: ofGone.id })).toMatchObject({ status: 409, body: { error: 'archived_reference' } });
    // An invoice id is not a quote: 404.
    const invoice = (await own.convert(named.id)).body.document;
    expect((await own.fromQuote({ quoteId: invoice.id })).status).toBe(404);
  });

  it('replays 200 with the same project and refuses another body under the same key', async () => {
    const c = await customer();
    const q = await acceptedQuote(c);
    const k = key();
    const first = await own.fromQuote({ quoteId: q.id }, k);
    expect(first.status).toBe(201);
    expect(await own.fromQuote({ quoteId: q.id }, k)).toMatchObject({ status: 200, body: { project: { id: first.body.project.id } } });
    expect(await own.fromQuote({ quoteId: q.id, name: 'Other' }, k)).toMatchObject({ status: 409, body: { error: 'idempotency_conflict' } });
    // Expired key: the source-quote state guard holds (§8).
    await admin.query('DELETE FROM workflow_requests WHERE idempotency_key = $1', [k]);
    expect(await own.fromQuote({ quoteId: q.id }, k)).toMatchObject({ status: 409, body: { error: 'quote_has_project' } });
  });

  it('AC-1.4: converting the source quote gives a draft invoice on the project, and the summary counts the quote', async () => {
    const c = await customer();
    const q = await acceptedQuote(c);
    const p = (await own.fromQuote({ quoteId: q.id })).body.project.id;
    expect((await own.convert(q.id)).body.document).toMatchObject({ status: 'DRAFT', projectId: p });
    expect((await own.summary(p)).body.summary.currencies[0]).toMatchObject({ acceptedNet: '500.00', quotedNet: '500.00' });
  });
});

describe('link an existing project (§6.4, D-WF1-07, D-WF1-08)', () => {
  it('link-opportunity: set, no-op on the same value, change, clear; refuses LOST, archived, another customer, stale and archived projects', async () => {
    const c = await customer();
    const p = await project(c);
    const o1 = await opportunity(c);
    const o2 = await opportunity(null);
    const set = await own.linkOpportunity(p.id, { version: 1, opportunityId: o1 });
    expect(set).toMatchObject({ status: 200, body: { project: { sourceOpportunityId: o1, version: 2 } } });
    // Same value again: 200, no version bump, no audit (even with an old version).
    expect(await own.linkOpportunity(p.id, { version: 1, opportunityId: o1 })).toMatchObject({ status: 200, body: { project: { version: 2 } } });
    expect(await own.linkOpportunity(p.id, { version: 1, opportunityId: o2 })).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect(await own.linkOpportunity(p.id, { version: 2, opportunityId: o2 })).toMatchObject({ status: 200, body: { project: { sourceOpportunityId: o2, version: 3 } } });
    expect(await own.linkOpportunity(p.id, { version: 3, opportunityId: null })).toMatchObject({ status: 200, body: { project: { sourceOpportunityId: null, version: 4 } } });
    expect((await audits(p.id)).filter((a) => a.action === 'projects.project.opportunity_linked').map((a) => a.metadata)).toEqual([
      { from: null, to: o1 }, { from: o1, to: o2 }, { from: o2, to: null },
    ]);

    const lost = await opportunity(c);
    expect((await own.lose(lost)).status).toBe(200);
    expect(await own.linkOpportunity(p.id, { version: 4, opportunityId: lost })).toMatchObject({ status: 409, body: { error: 'opportunity_lost' } });
    const archived = await opportunity(c);
    expect((await own.archiveOpportunity(archived)).status).toBe(200);
    expect(await own.linkOpportunity(p.id, { version: 4, opportunityId: archived })).toMatchObject({ status: 409, body: { error: 'archived_reference' } });
    const other = await opportunity(await customer());
    expect(await own.linkOpportunity(p.id, { version: 4, opportunityId: other })).toMatchObject({ status: 400, body: { error: 'opportunity_customer_mismatch' } });
    // A customerless project may link any opportunity (customers are compared only when both are set).
    const loose = await project(null);
    expect((await own.linkOpportunity(loose.id, { version: 1, opportunityId: other })).status).toBe(200);
    // Existing links survive a status change (§8): losing o1 leaves nothing to undo, and clearing is always allowed.
    expect((await own.archiveProject(p.id)).status).toBe(200);
    expect(await own.linkOpportunity(p.id, { version: 5, opportunityId: o1 })).toMatchObject({ status: 409, body: { error: 'archived' } });
    expect((await own.linkOpportunity(randomUUID(), { version: 1, opportunityId: o1 })).status).toBe(404);
    expect((await own.linkOpportunity(p.id, { version: 1, opportunityId: randomUUID() })).status).toBe(409); // archived project first
    expect((await own.linkOpportunity(loose.id, { version: 2, opportunityId: randomUUID() })).status).toBe(404);
  });

  it('link-quote: associates an accepted quote once; the opportunity follows the quote; every refusal has its code', async () => {
    const c = await customer();
    const o = await opportunity(c);
    const q = await acceptedQuote(c, { opportunityId: o });
    const p = await project(c);
    const linked = await own.linkQuote(p.id, { version: 1, quoteId: q.id });
    expect(linked).toMatchObject({ status: 200, body: { project: { sourceQuoteId: q.id, sourceOpportunityId: o, version: 2 } } });
    expect(await own.linkQuote(p.id, { version: 1, quoteId: q.id })).toMatchObject({ status: 200, body: { project: { version: 2 } } }); // no-op
    const q2 = await acceptedQuote(c);
    expect(await own.linkQuote(p.id, { version: 2, quoteId: q2.id })).toMatchObject({ status: 409, body: { error: 'project_has_quote' } });
    // The opportunity is now fixed by the quote.
    expect(await own.linkOpportunity(p.id, { version: 2, opportunityId: null })).toMatchObject({ status: 409, body: { error: 'opportunity_set_by_quote' } });
    expect(await own.linkQuote((await project(c)).id, { version: 1, quoteId: q.id })).toMatchObject({ status: 409, body: { error: 'quote_has_project' } });
    expect((await audits(p.id)).map((a) => [a.action, a.metadata]).sort(([x], [y]) => String(x).localeCompare(String(y)))).toEqual([
      ['projects.project.created', expect.anything()],
      ['projects.project.opportunity_linked', { from: null, to: o }],
      ['projects.project.quote_linked', { quoteId: q.id }],
    ]);

    expect(await own.linkQuote((await project(await customer())).id, { version: 1, quoteId: q2.id })).toMatchObject({ status: 400, body: { error: 'project_customer_mismatch' } });
    expect(await own.linkQuote((await project(null)).id, { version: 1, quoteId: q2.id })).toMatchObject({ status: 400, body: { error: 'project_customer_mismatch' } });
    const draft = (await own.createQuote({ customerId: c, lines: [line('10')] })).body.document;
    expect(await own.linkQuote((await project(c)).id, { version: 1, quoteId: draft.id })).toMatchObject({ status: 409, body: { error: 'quote_not_accepted' } });
    const elsewhere = await acceptedQuote(c, { projectId: (await project(c)).id });
    expect(await own.linkQuote((await project(c)).id, { version: 1, quoteId: elsewhere.id })).toMatchObject({ status: 409, body: { error: 'quote_has_project' } });
    // A quote drafted for this very project may become its source.
    const mine = await project(c);
    const forMine = await acceptedQuote(c, { projectId: mine.id });
    expect((await own.linkQuote(mine.id, { version: 1, quoteId: forMine.id })).status).toBe(200);
    // The project already has another opportunity than the quote's.
    const withOpp = await project(c);
    expect((await own.linkOpportunity(withOpp.id, { version: 1, opportunityId: await opportunity(c) })).status).toBe(200);
    const qOfO = await acceptedQuote(c, { opportunityId: o });
    expect(await own.linkQuote(withOpp.id, { version: 2, quoteId: qOfO.id })).toMatchObject({ status: 409, body: { error: 'opportunity_mismatch' } });
    // Stale version, archived project, unknown quote.
    const stale = await project(c);
    expect(await own.linkQuote(stale.id, { version: 7, quoteId: q2.id })).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect((await own.archiveProject(stale.id)).status).toBe(200);
    expect(await own.linkQuote(stale.id, { version: 2, quoteId: q2.id })).toMatchObject({ status: 409, body: { error: 'archived' } });
    expect((await own.linkQuote(stale.id, { version: 2, quoteId: randomUUID() })).status).toBe(404);
  });

  it('AC-1.4: after link-quote, converting that quote yields a draft invoice on the project and the summary counts it', async () => {
    const c = await customer();
    const q = await acceptedQuote(c);
    const p = await project(c);
    expect((await own.linkQuote(p.id, { version: 1, quoteId: q.id })).status).toBe(200);
    expect((await own.convert(q.id)).body.document).toMatchObject({ status: 'DRAFT', projectId: p.id });
    expect((await own.summary(p.id)).body.summary.currencies[0]).toMatchObject({ acceptedNet: '500.00' });
  });
});

describe('reads: GET projects?sourceOpportunityId= (§6.6, AC-1.5)', () => {
  it('returns the projects made from or linked to an opportunity; the filter needs sales:read on both list routes', async () => {
    const c = await customer();
    const o = await opportunity(c);
    const made = (await own.fromOpportunity({ opportunityId: o, existingProjectCount: 0 })).body.project.id;
    const linked = await project(c);
    expect((await own.linkOpportunity(linked.id, { version: 1, opportunityId: o })).status).toBe(200);
    await project(c); // unrelated
    const list = await own.listProjects(`?sourceOpportunityId=${o}&sort=name`);
    expect(list.status).toBe(200);
    expect(list.body.projects.map((p: { id: string }) => p.id).sort()).toEqual([made, linked.id].sort());
    expect((await own.customerProjects(c, `?sourceOpportunityId=${o}`)).body.projects).toHaveLength(2);
    // MEMBER holds sales:read by default.
    expect((await api(A.people.MEMBER!, A.slug).listProjects(`?sourceOpportunityId=${o}`)).body.projects).toHaveLength(2);
    // Without sales:read the filter is refused on both routes; the unfiltered list still works.
    custom.MEMBER = ['projects:read', 'customers:read'];
    const reader = api(A.people.MEMBER!, A.slug);
    expect(await reader.listProjects(`?sourceOpportunityId=${o}`)).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await reader.customerProjects(c, `?sourceOpportunityId=${o}`)).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect((await reader.listProjects()).status).toBe(200);
    // Another business's opportunity id matches nothing here.
    const bOpp = await opportunity(null, api(B.people.OWNER!, B.slug));
    expect((await own.listProjects(`?sourceOpportunityId=${bOpp}`)).body.projects).toEqual([]);
  });
});

describe('authorisation and redaction (§7, T-20..30, AC-1.6, G-FIN)', () => {
  it('role × route matrix from §7 (default roles)', async () => {
    const c = await customer();
    const expected: Record<string, Record<string, number>> = {
      fromOpportunity: { OWNER: 201, ADMIN: 201, MANAGER: 201, MEMBER: 201 },
      fromQuote: { OWNER: 201, ADMIN: 201, MANAGER: 201, MEMBER: 403 },
      linkOpportunity: { OWNER: 200, ADMIN: 200, MANAGER: 200, MEMBER: 200 },
      linkQuote: { OWNER: 200, ADMIN: 200, MANAGER: 200, MEMBER: 403 },
    };
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER']) {
      const a = api(A.people[role]!, A.slug);
      expect((await a.fromOpportunity({ opportunityId: await opportunity(c), existingProjectCount: 0 })).status).toBe(expected.fromOpportunity![role]);
      expect((await a.fromQuote({ quoteId: (await acceptedQuote(c)).id })).status).toBe(expected.fromQuote![role]);
      expect((await a.linkOpportunity((await project(c)).id, { version: 1, opportunityId: await opportunity(c) })).status).toBe(expected.linkOpportunity![role]);
      expect((await a.linkQuote((await project(c)).id, { version: 1, quoteId: (await acceptedQuote(c)).id })).status).toBe(expected.linkQuote![role]);
    }
  });

  it('all-of keys: one Zone\'s key never grants a cross-Zone action (custom principals, T-27..30)', async () => {
    const c = await customer();
    const m = () => api(A.people.MEMBER!, A.slug);
    custom.MEMBER = ['projects:read', 'projects:create', 'customers:read']; // no sales:read
    expect((await m().fromOpportunity({ opportunityId: await opportunity(c), existingProjectCount: 0 })).status).toBe(403);
    custom.MEMBER = ['projects:read', 'projects:create', 'finance:read']; // no customers:read
    expect((await m().fromQuote({ quoteId: (await acceptedQuote(c)).id })).status).toBe(403);
    custom.MEMBER = ['projects:read', 'projects:update']; // no sales:read / finance:read
    const p = await project(c);
    expect((await m().linkOpportunity(p.id, { version: 1, opportunityId: await opportunity(c) })).status).toBe(403);
    expect((await m().linkQuote(p.id, { version: 1, quoteId: (await acceptedQuote(c)).id })).status).toBe(403);
    custom.MEMBER = ['sales:read', 'finance:read', 'customers:read', 'projects:read']; // no projects:create / update
    expect((await m().fromOpportunity({ opportunityId: await opportunity(c), existingProjectCount: 0 })).status).toBe(403);
    expect((await m().linkQuote(p.id, { version: 1, quoteId: (await acceptedQuote(c)).id })).status).toBe(403);
    expect(await count('projects WHERE id = $1 AND source_quote_id IS NULL AND source_opportunity_id IS NULL', [p.id])).toBe(1);
  });

  it('MEMBER responses, replays and errors carry no sourceQuote keys and no quote id (G-4)', async () => {
    const c = await customer();
    const member = api(A.people.MEMBER!, A.slug);
    const o = await opportunity(c);
    const k = key();
    const made = await member.fromOpportunity({ opportunityId: o, existingProjectCount: 0 }, k);
    expect(made.status).toBe(201);
    expect(made.body.project).not.toHaveProperty('sourceQuoteId');
    expect(made.body.project).not.toHaveProperty('sourceQuote');
    expect(made.body.project).toHaveProperty('sourceOpportunityId', o);
    // The owner links a source quote to that project; MEMBER's replay, read and link responses still omit it.
    const q = await acceptedQuote(c, { opportunityId: o });
    expect((await own.linkQuote(made.body.project.id, { version: 1, quoteId: q.id })).status).toBe(200);
    const replay = await member.fromOpportunity({ opportunityId: o, existingProjectCount: 0 }, k);
    expect(replay.status).toBe(200);
    expect(replay.body.project).not.toHaveProperty('sourceQuoteId');
    expect((await member.getProject(made.body.project.id)).body.project).not.toHaveProperty('sourceQuote');
    const refused = await member.linkOpportunity(made.body.project.id, { version: 2, opportunityId: null });
    expect(refused).toEqual({ status: 409, body: { error: 'opportunity_set_by_quote' } });
    expect(JSON.stringify(refused.body)).not.toContain(q.id);
    const fq = await member.fromQuote({ quoteId: q.id });
    expect(fq).toEqual({ status: 403, body: { error: 'forbidden' } });
  });

  it("another business's ids in every route give 404 or 400 and no row (T-01..05)", async () => {
    const b = api(B.people.OWNER!, B.slug);
    const bc = await customer(b);
    const bOpp = await opportunity(bc, b);
    const bQuote = await acceptedQuote(bc, {}, b);
    const bProject = await project(bc, b);
    const c = await customer();
    const p = await project(c);
    const before = await count('projects', []);
    expect((await own.fromOpportunity({ opportunityId: bOpp, existingProjectCount: 0 })).status).toBe(404);
    expect((await own.fromQuote({ quoteId: bQuote.id })).status).toBe(404);
    expect((await own.linkOpportunity(p.id, { version: 1, opportunityId: bOpp })).status).toBe(404);
    expect((await own.linkQuote(p.id, { version: 1, quoteId: bQuote.id })).status).toBe(404);
    expect((await own.linkOpportunity(bProject.id, { version: 1, opportunityId: null })).status).toBe(404);
    expect((await own.linkQuote(bProject.id, { version: 1, quoteId: (await acceptedQuote(c)).id })).status).toBe(404);
    expect(await count('projects', [])).toBe(before);
    expect(await projectRow(p.id)).toMatchObject({ source_opportunity_id: null, source_quote_id: null, version: 1 });
    expect(await projectRow(bProject.id)).toMatchObject({ source_opportunity_id: null, source_quote_id: null, version: 1 });
    // A malformed id or an unknown field is refused before any work.
    expect((await own.linkQuote('not-a-uuid', { version: 1, quoteId: bQuote.id })).status).toBe(404);
    expect((await own.fromOpportunity({ opportunityId: bOpp, existingProjectCount: 0, businessId: A.businessId })).status).toBe(400);
  });
});

describe('transactions and audit (T-31, T-43)', () => {
  it('audit rows are exact; none on replay or no-op', async () => {
    const c = await customer();
    const o = await opportunity(c);
    const k = key();
    const p = (await own.fromOpportunity({ opportunityId: o, existingProjectCount: 0 }, k)).body.project.id;
    await own.fromOpportunity({ opportunityId: o, existingProjectCount: 0 }, k); // replay
    expect((await audits(p)).sort((x, y) => x.action.localeCompare(y.action))).toEqual([
      { action: 'projects.project.created', metadata: { status: 'PLANNED', customerId: c, ownerUserId: null } },
      { action: 'projects.project.created_from_opportunity', metadata: { opportunityId: o } },
    ]);
    const q = await acceptedQuote(c, { opportunityId: o });
    const fromQ = (await own.fromQuote({ quoteId: q.id })).body.project.id;
    const fromQAudits = (await audits(fromQ)).sort((x, y) => x.action.localeCompare(y.action));
    expect(fromQAudits.map((a) => a.action)).toEqual(['projects.project.created', 'projects.project.created_from_quote']);
    expect(fromQAudits[1]!.metadata).toEqual({ quoteId: q.id, opportunityId: o });
    // The workflow_requests row records the actor and the result.
    const ledger = (await admin.query('SELECT operation, result_type, result_id, actor_user_id FROM workflow_requests WHERE idempotency_key = $1', [k])).rows;
    expect(ledger).toEqual([{ operation: 'project.from_opportunity', result_type: 'project', result_id: p, actor_user_id: A.people.OWNER!.id }]);
  });

  it('a failure after the project insert rolls back the project, its key and its audit rows (fault injection)', async () => {
    const k = `fault-${randomUUID()}`;
    await admin.query(`
      CREATE OR REPLACE FUNCTION lc1_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.idempotency_key LIKE 'fault-%' THEN RAISE EXCEPTION 'injected fault'; END IF;
        RETURN NEW;
      END $$`);
    await admin.query('CREATE TRIGGER lc1_test_fault BEFORE INSERT ON workflow_requests FOR EACH ROW EXECUTE FUNCTION lc1_test_fault()');
    try {
      const c = await customer();
      const o = await opportunity(c);
      const q = await acceptedQuote(c);
      const auditsBefore = await count('audit_events WHERE business_id = $1', [A.businessId]);
      expect((await own.fromOpportunity({ opportunityId: o, existingProjectCount: 0 }, k)).status).toBe(500);
      const k2 = `fault-${randomUUID()}`;
      expect((await own.fromQuote({ quoteId: q.id }, k2)).status).toBe(500);
      expect(await count('projects WHERE source_opportunity_id = $1 OR source_quote_id = $2', [o, q.id])).toBe(0);
      expect(await count('workflow_requests WHERE idempotency_key = ANY($1)', [[k, k2]])).toBe(0);
      expect(await count('audit_events WHERE business_id = $1', [A.businessId])).toBe(auditsBefore);
    } finally {
      await admin.query('DROP TRIGGER IF EXISTS lc1_test_fault ON workflow_requests');
      await admin.query('DROP FUNCTION IF EXISTS lc1_test_fault()');
    }
    // The same key works once the fault is gone: nothing was left behind.
    const o2 = await opportunity(null);
    expect((await own.fromOpportunity({ opportunityId: o2, existingProjectCount: 0 }, k)).status).toBe(201);
  });
});

describe('concurrency, deterministic two-session (§6.10, gate G-2, T-34, T-36..39)', () => {
  /** The service's idempotency lock (requests.ts claimKey), taken by the barrier first. */
  const KEY_LOCK = `SELECT pg_advisory_xact_lock(hashtextextended('workflows.idempotency:' || current_setting('app.business_id', true) || ':' || $1::text || ':' || $2::text, 0))`;

  it('the same key twice at once: one 201, one 200 replay of the same project (T-34)', async () => {
    const o = await opportunity(null);
    const k = key();
    const gate = await barrier();
    await gate.q(KEY_LOCK, ['project.from_opportunity', k]);
    const one = own.fromOpportunity({ opportunityId: o, existingProjectCount: 0 }, k);
    const two = own.fromOpportunity({ opportunityId: o, existingProjectCount: 0 }, k);
    await waitUntilBlocked(admin, gate.pid, { count: 2 });
    await gate.rollback();
    const results = await Promise.all([one, two]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(results[0]!.body.project.id).toBe(results[1]!.body.project.id);
    expect(await count('projects WHERE source_opportunity_id = $1', [o])).toBe(1);
  });

  it('from-opportunity × 2 with count 0 and different keys: the opportunity lock serialises them, one 201, one 409 (P7 vs P7)', async () => {
    const o = await opportunity(null);
    const gate = await barrier();
    await gate.q(`SELECT pg_advisory_xact_lock(hashtextextended('workflows.opportunity_projects:' || current_setting('app.business_id', true) || ':' || $1::text, 0))`, [o]);
    const one = own.fromOpportunity({ opportunityId: o, existingProjectCount: 0 });
    const two = own.fromOpportunity({ opportunityId: o, existingProjectCount: 0 });
    await waitUntilBlocked(admin, gate.pid, { count: 2 });
    await gate.rollback();
    const results = await Promise.all([one, two]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body).toEqual({ error: 'opportunity_projects_changed' });
    expect(await count('projects WHERE source_opportunity_id = $1', [o])).toBe(1);
  });

  it('from-quote × 2 with different keys: the quote lock serialises them, one 201, one 409 quote_has_project (P4 vs P4)', async () => {
    const c = await customer();
    const q = await acceptedQuote(c);
    const gate = await barrier();
    await gate.q('SELECT id FROM finance_documents WHERE id = $1 FOR NO KEY UPDATE', [q.id]);
    const one = own.fromQuote({ quoteId: q.id });
    const two = own.fromQuote({ quoteId: q.id });
    await waitUntilBlocked(admin, gate.pid, { count: 2 });
    await gate.rollback();
    const results = await Promise.all([one, two]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body).toEqual({ error: 'quote_has_project' });
    expect(await count('projects WHERE source_quote_id = $1', [q.id])).toBe(1);
  });

  it('from-quote vs void: a void in flight makes from-quote wait and then refuse; a from-quote holding the quote makes the void wait (P4 vs P5)', async () => {
    const c = await customer();
    // Void first: the barrier is the void itself (Finance's lock order: quote FOR NO KEY UPDATE, then status).
    {
      const q = await acceptedQuote(c);
      const voider = await barrier();
      await voider.q('SELECT id FROM finance_documents WHERE id = $1 FOR NO KEY UPDATE', [q.id]);
      await voider.q("UPDATE finance_documents SET status = 'VOID', void_reason = 'race', version = version + 1 WHERE id = $1", [q.id]);
      const creating = own.fromQuote({ quoteId: q.id });
      await waitUntilBlocked(admin, voider.pid);
      await voider.commit();
      expect(await creating).toEqual({ status: 409, body: { error: 'quote_not_accepted' } });
      expect(await count('projects WHERE source_quote_id = $1', [q.id])).toBe(0);
    }
    // from-quote first: it holds the quote and waits on the customer row (FK KEY SHARE vs the barrier's FOR UPDATE);
    // the API void queues behind it on the quote. Release: the project commits with its link, then the void succeeds.
    {
      const q = await acceptedQuote(c);
      const gate = await barrier();
      await gate.q('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [c]);
      const creating = own.fromQuote({ quoteId: q.id });
      await waitUntilBlocked(admin, gate.pid);
      const voiding = own.voidQuote(q.id, q.version);
      await waitUntilBlocked(admin, gate.pid, { count: 2 }); // the void waits on from-quote, which waits on the barrier
      await gate.rollback();
      const [created, voided] = await Promise.all([creating, voiding]);
      expect(created.status).toBe(201);
      expect(voided.status).toBe(200);
      expect(await projectRow(created.body.project.id)).toMatchObject({ source_quote_id: q.id });
      // §8: the project keeps its source quote after the void and shows it as VOID to finance readers.
      expect((await own.getProject(created.body.project.id)).body.project.sourceQuote).toMatchObject({ status: 'VOID' });
    }
  });

  it('link-quote vs void: a void in flight makes the link wait and refuse; a link holding the quote makes the void wait (P3 vs P5)', async () => {
    const c = await customer();
    {
      const q = await acceptedQuote(c);
      const p = await project(c);
      const voider = await barrier();
      await voider.q('SELECT id FROM finance_documents WHERE id = $1 FOR NO KEY UPDATE', [q.id]);
      await voider.q("UPDATE finance_documents SET status = 'VOID', void_reason = 'race', version = version + 1 WHERE id = $1", [q.id]);
      const linking = own.linkQuote(p.id, { version: 1, quoteId: q.id });
      await waitUntilBlocked(admin, voider.pid);
      await voider.commit();
      expect(await linking).toEqual({ status: 409, body: { error: 'quote_not_accepted' } });
      expect(await projectRow(p.id)).toMatchObject({ source_quote_id: null, version: 1 });
    }
    {
      const q = await acceptedQuote(c);
      const p = await project(c);
      // The link takes the quote FOR SHARE, then waits on the project row the barrier holds.
      const gate = await barrier();
      await gate.q('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [p.id]);
      const linking = own.linkQuote(p.id, { version: 1, quoteId: q.id });
      await waitUntilBlocked(admin, gate.pid);
      const voiding = own.voidQuote(q.id, q.version);
      await waitUntilBlocked(admin, gate.pid, { count: 2 });
      await gate.rollback();
      const [linked, voided] = await Promise.all([linking, voiding]);
      expect(linked.status).toBe(200);
      expect(voided.status).toBe(200);
      expect(await projectRow(p.id)).toMatchObject({ source_quote_id: q.id });
    }
  });

  it('link-quote × 2 on one project: both hold the quote FOR SHARE, the project row orders them, the loser is 409 stale, never 40P01 (P3 vs P3)', async () => {
    const c = await customer();
    const q = await acceptedQuote(c);
    const p = await project(c);
    const gate = await barrier();
    await gate.q('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [p.id]);
    const one = own.linkQuote(p.id, { version: 1, quoteId: q.id });
    const two = own.linkQuote(p.id, { version: 1, quoteId: q.id });
    await waitUntilBlocked(admin, gate.pid, { count: 2 });
    await gate.rollback();
    const results = await Promise.all([one, two]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body).toEqual({ error: 'stale' });
  });

  it('link-quote on two projects for one quote at once: one links, the other gets 409 quote_has_project (P3 vs P3, unique key)', async () => {
    const c = await customer();
    const q = await acceptedQuote(c);
    const p1 = await project(c);
    const p2 = await project(c);
    // Both pass their checks while neither has committed (the barrier holds both project rows), then race on the key.
    const gate = await barrier();
    await gate.q('SELECT id FROM projects WHERE id = ANY($1) FOR UPDATE', [[p1.id, p2.id]]);
    const one = own.linkQuote(p1.id, { version: 1, quoteId: q.id });
    const two = own.linkQuote(p2.id, { version: 1, quoteId: q.id });
    await waitUntilBlocked(admin, gate.pid, { count: 2 });
    await gate.rollback();
    const results = await Promise.all([one, two]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body).toEqual({ error: 'quote_has_project' });
    expect(await count('projects WHERE source_quote_id = $1', [q.id])).toBe(1);
  });

  it('create-from-opportunity vs link, unlink, link-quote and from-quote: every path that changes the count holds the opportunity lock (audit of #169)', async () => {
    // Each case: the barrier holds a row the changing path needs AFTER it took the opportunity lock, so that path
    // holds the lock while it waits; from-opportunity then queues on the lock. Without the lock in the changing
    // path, from-opportunity would not wait and would create with a stale count.
    const run = async (hold: { sql: string; params: unknown[] }, change: () => Promise<R>, o: string, seenCount: number) => {
      const gate = await barrier();
      await gate.q(hold.sql, hold.params);
      const changing = change();
      await waitUntilBlocked(admin, gate.pid);
      const creating = own.fromOpportunity({ opportunityId: o, existingProjectCount: seenCount });
      await waitUntilBlocked(admin, gate.pid, { count: 2 }); // create waits on the change, which waits on the barrier
      await gate.rollback();
      return Promise.all([changing, creating]);
    };
    const c = await customer();
    // Link an existing project to o while a create saw 0.
    {
      const o = await opportunity(c);
      const p = await project(c);
      const [linked, created] = await run({ sql: 'SELECT id FROM projects WHERE id = $1 FOR UPDATE', params: [p.id] },
        () => own.linkOpportunity(p.id, { version: 1, opportunityId: o }), o, 0);
      expect(linked.status).toBe(200);
      expect(created).toEqual({ status: 409, body: { error: 'opportunity_projects_changed' } });
      expect(await count('projects WHERE source_opportunity_id = $1', [o])).toBe(1);
    }
    // Unlink (clear) while a create saw 1: the count drops to 0, so the create is refused, not silently accepted.
    {
      const o = await opportunity(c);
      const p = await project(c);
      expect((await own.linkOpportunity(p.id, { version: 1, opportunityId: o })).status).toBe(200);
      const [cleared, created] = await run({ sql: 'SELECT id FROM projects WHERE id = $1 FOR UPDATE', params: [p.id] },
        () => own.linkOpportunity(p.id, { version: 2, opportunityId: null }), o, 1);
      expect(cleared.status).toBe(200);
      expect(created).toEqual({ status: 409, body: { error: 'opportunity_projects_changed' } });
    }
    // Move a project from o1 to o2: both sets change (both locked, in id order).
    {
      const o1 = await opportunity(c);
      const o2 = await opportunity(c);
      const p = await project(c);
      expect((await own.linkOpportunity(p.id, { version: 1, opportunityId: o1 })).status).toBe(200);
      const [moved, created] = await run({ sql: 'SELECT id FROM projects WHERE id = $1 FOR UPDATE', params: [p.id] },
        () => own.linkOpportunity(p.id, { version: 2, opportunityId: o2 }), o1, 1);
      expect(moved.status).toBe(200);
      expect(created).toEqual({ status: 409, body: { error: 'opportunity_projects_changed' } });
      expect(await count('projects WHERE source_opportunity_id = $1', [o2])).toBe(1);
    }
    // link-quote that sets the project's opportunity from the quote.
    {
      const o = await opportunity(c);
      const q = await acceptedQuote(c, { opportunityId: o });
      const p = await project(c);
      const [linked, created] = await run({ sql: 'SELECT id FROM projects WHERE id = $1 FOR UPDATE', params: [p.id] },
        () => own.linkQuote(p.id, { version: 1, quoteId: q.id }), o, 0);
      expect(linked).toMatchObject({ status: 200, body: { project: { sourceOpportunityId: o } } });
      expect(created).toEqual({ status: 409, body: { error: 'opportunity_projects_changed' } });
    }
    // from-quote whose quote carries the opportunity (it waits on the customer row FK after taking the lock).
    {
      const o = await opportunity(c);
      const q = await acceptedQuote(c, { opportunityId: o });
      const [fromQuote, created] = await run({ sql: 'SELECT id FROM customers WHERE id = $1 FOR UPDATE', params: [c] },
        () => own.fromQuote({ quoteId: q.id }), o, 0);
      expect(fromQuote.status).toBe(201);
      expect(created).toEqual({ status: 409, body: { error: 'opportunity_projects_changed' } });
      expect(await count('projects WHERE source_opportunity_id = $1', [o])).toBe(1);
    }
  });

  it('a link that moved while link-opportunity waited for the opportunity lock is 409 stale (re-read under the lock)', async () => {
    const c = await customer();
    const o1 = await opportunity(c);
    const o2 = await opportunity(c);
    const p = await project(c);
    const gate = await barrier();
    await gate.q(`SELECT pg_advisory_xact_lock(hashtextextended('workflows.opportunity_projects:' || current_setting('app.business_id', true) || ':' || $1::text, 0))`, [o1]);
    const first = own.linkOpportunity(p.id, { version: 1, opportunityId: o1 });
    await waitUntilBlocked(admin, gate.pid);
    // Meanwhile the project is linked to o2 directly (as a concurrent request that committed would have).
    await admin.query('UPDATE projects SET source_opportunity_id = $2, version = version + 1 WHERE id = $1', [p.id, o2]);
    await gate.rollback();
    expect(await first).toEqual({ status: 409, body: { error: 'stale' } });
    expect((await projectRow(p.id)).source_opportunity_id).toBe(o2);
  });

  it('lock order matters: a writer that takes the project before the quote deadlocks with one that takes the quote first (harness, T-36)', async () => {
    const c = await customer();
    const q = await acceptedQuote(c);
    const p = await project(c);
    // Wrong order: project, then quote. Opposite order with a conflicting quote lock: quote, then project.
    const wrong = await barrier();
    const right = await barrier();
    await wrong.q('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [p.id]);
    await right.q('SELECT id FROM finance_documents WHERE id = $1 FOR NO KEY UPDATE', [q.id]);
    const w = wrong.q('SELECT id FROM finance_documents WHERE id = $1 FOR SHARE', [q.id]).then(() => 'ok', (e: { code?: string }) => e.code);
    await waitUntilBlocked(admin, right.pid);
    const r = right.q('SELECT id FROM projects WHERE id = $1 FOR NO KEY UPDATE', [p.id]).then(() => 'ok', (e: { code?: string }) => e.code);
    const codes = await Promise.all([w, r]);
    expect(codes.sort()).toEqual(['40P01', 'ok']);
    await wrong.rollback();
    await right.rollback();
    // The shipped order (every service path takes the quote before the project) has no such cycle: the link-quote
    // tests above run quote-first against each other and against the void, and none returns 503 retryable.
  });
});
