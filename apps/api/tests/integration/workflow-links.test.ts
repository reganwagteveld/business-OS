import { readFileSync } from 'node:fs';
import { inviteForSignup, admitFixture } from './support/admission';
/**
 * WF-1B-1 (docs/cross-zone-workflows-wf1.md §5, §6.1, §6.5–6.7, §9, §12): the workflow-link migration,
 * Finance link rules and reads, against real PostgreSQL with the migrations applied, through the real
 * route handlers and by direct SQL as bos_app (which bypasses the services, so the database rules are
 * proven on their own).
 *
 * Entry conditions for the production migration (§14, ChatGPT build gates): T-49 (project summary),
 * T-51 (source-quote link vs quote void, H1) and T-52 (the §6.10 lock pairs) are deterministic
 * two-session tests: a barrier session holds a lock, and the test proceeds only once PostgreSQL itself
 * reports the other session waiting on it (pg_blocking_pids), so no test can pass by running serially.
 *
 * WF-1B-1 has no workflows endpoint yet (WF-1B-2). Where a test needs a link to a source quote, it makes
 * it by direct SQL with the shipped lock order (quote FOR SHARE, then the project), which is what the
 * trigger enforces for every writer.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Permission, Role } from '@/modules/access';
import { backendPid, finishesOrBlocks, waitUntilBlocked } from './support/locks';

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
import * as customerProjectsRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/projects/route';
import * as opportunitiesRoute from '@/app/api/v1/b/[slug]/sales/opportunities/route';
import * as opportunityRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/route';
import * as opportunityWin from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/win/route';
import * as projectsRoute from '@/app/api/v1/b/[slug]/projects/route';
import * as projectRoute from '@/app/api/v1/b/[slug]/projects/[projectId]/route';
import * as quotesRoute from '@/app/api/v1/b/[slug]/finance/quotes/route';
import * as quoteRoute from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/route';
import * as quoteIssue from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/issue/route';
import * as quoteAccept from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/accept/route';
import * as quoteVoid from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/void/route';
import * as quoteDiscard from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/discard/route';
import * as quoteConvert from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/convert/route';
import * as invoicesRoute from '@/app/api/v1/b/[slug]/finance/invoices/route';
import * as invoiceRoute from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/route';
import * as invoiceIssue from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/issue/route';
import * as invoiceVoid from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/void/route';
import * as invoiceDiscard from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/discard/route';
import * as invoiceCredit from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/credit-notes/route';
import * as creditNotesRoute from '@/app/api/v1/b/[slug]/finance/credit-notes/route';
import * as creditIssue from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/issue/route';
import * as applicationsRoute from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/applications/route';
import * as paymentsRoute from '@/app/api/v1/b/[slug]/finance/payments/route';
import * as allocationReverse from '@/app/api/v1/b/[slug]/finance/payments/[paymentId]/allocations/[allocationId]/reverse/route';
import * as settingsRoute from '@/app/api/v1/b/[slug]/finance/settings/route';
import * as taxRatesRoute from '@/app/api/v1/b/[slug]/finance/tax-rates/route';
import * as expensesRoute from '@/app/api/v1/b/[slug]/finance/expenses/route';
import * as expenseRoute from '@/app/api/v1/b/[slug]/finance/expenses/[expenseId]/route';
import * as expenseRecord from '@/app/api/v1/b/[slug]/finance/expenses/[expenseId]/record/route';
import * as categoriesRoute from '@/app/api/v1/b/[slug]/finance/expense-categories/route';
import * as summaryRoute from '@/app/api/v1/b/[slug]/finance/projects/[projectId]/summary/route';
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

// Its own address range (CI runs this suite a second time behind the pooler with another block).
const IP_BLOCK = Number(process.env.WORKFLOW_TEST_IP_BLOCK ?? 160);
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

const api = (who: User, slug: string) => {
  const B = `/api/v1/b/${slug}`;
  const F = `${B}/finance`;
  const call = (h: Route, method: string, path: string, params: Record<string, string>, body?: unknown, headers?: Record<string, string>): Promise<R> =>
    h(req(method, path, { cookie: who.cookie, body, headers }), ctx({ slug, ...params })).then(json);
  const doc = (documentId: string) => ({ documentId });
  return {
    createCustomer: (body: unknown) => call(customersRoute.POST, 'POST', `${B}/customers`, {}, body),
    customerProjects: (customerId: string) => call(customerProjectsRoute.GET, 'GET', `${B}/customers/${customerId}/projects`, { customerId }),
    createOpportunity: (body: unknown) => call(opportunitiesRoute.POST, 'POST', `${B}/sales/opportunities`, {}, body),
    getOpportunity: (opportunityId: string) => call(opportunityRoute.GET, 'GET', `${B}/sales/opportunities/${opportunityId}`, { opportunityId }),
    win: (opportunityId: string) => call(opportunityWin.POST, 'POST', `${B}/sales/opportunities/${opportunityId}/win`, { opportunityId }),
    createProject: (body: unknown) => call(projectsRoute.POST, 'POST', `${B}/projects`, {}, body),
    listProjects: (qs = '') => call(projectsRoute.GET, 'GET', `${B}/projects${qs}`, {}),
    getProject: (projectId: string) => call(projectRoute.GET, 'GET', `${B}/projects/${projectId}`, { projectId }),
    patchProject: (projectId: string, body: unknown) => call(projectRoute.PATCH, 'PATCH', `${B}/projects/${projectId}`, { projectId }, body),
    createQuote: (body: unknown) => call(quotesRoute.POST, 'POST', `${F}/quotes`, {}, body),
    patchQuote: (id: string, body: unknown) => call(quoteRoute.PATCH, 'PATCH', `${F}/quotes/${id}`, doc(id), body),
    issueQuote: (id: string, version = 1) => call(quoteIssue.POST, 'POST', `${F}/quotes/${id}/issue`, doc(id), { version }),
    acceptQuote: (id: string, version = 2) => call(quoteAccept.POST, 'POST', `${F}/quotes/${id}/accept`, doc(id), { version }),
    voidQuote: (id: string, version: number) => call(quoteVoid.POST, 'POST', `${F}/quotes/${id}/void`, doc(id), { version, reason: 'Withdrawn' }),
    discardQuote: (id: string, version = 1) => call(quoteDiscard.POST, 'POST', `${F}/quotes/${id}/discard`, doc(id), { version }),
    convert: (id: string, body: unknown = {}) => call(quoteConvert.POST, 'POST', `${F}/quotes/${id}/convert`, doc(id), body),
    listQuotes: (qs = '') => call(quotesRoute.GET, 'GET', `${F}/quotes${qs}`, {}),
    createInvoice: (body: unknown) => call(invoicesRoute.POST, 'POST', `${F}/invoices`, {}, body),
    patchInvoice: (id: string, body: unknown) => call(invoiceRoute.PATCH, 'PATCH', `${F}/invoices/${id}`, doc(id), body),
    issueInvoice: (id: string, version = 1) => call(invoiceIssue.POST, 'POST', `${F}/invoices/${id}/issue`, doc(id), { version }),
    voidInvoice: (id: string, version: number) => call(invoiceVoid.POST, 'POST', `${F}/invoices/${id}/void`, doc(id), { version, reason: 'Mistake' }),
    discardInvoice: (id: string, version = 1) => call(invoiceDiscard.POST, 'POST', `${F}/invoices/${id}/discard`, doc(id), { version }),
    listInvoices: (qs = '') => call(invoicesRoute.GET, 'GET', `${F}/invoices${qs}`, {}),
    listCreditNotes: (qs = '') => call(creditNotesRoute.GET, 'GET', `${F}/credit-notes${qs}`, {}),
    credit: (invoiceId: string, body: unknown) => call(invoiceCredit.POST, 'POST', `${F}/invoices/${invoiceId}/credit-notes`, doc(invoiceId), body),
    issueCredit: (id: string, version = 1) => call(creditIssue.POST, 'POST', `${F}/credit-notes/${id}/issue`, doc(id), { version }),
    applyCredit: (creditNoteId: string, applications: { invoiceId: string; amount: string }[]) =>
      call(applicationsRoute.POST, 'POST', `${F}/credit-notes/${creditNoteId}/applications`, doc(creditNoteId), { applications }),
    pay: (body: unknown) => call(paymentsRoute.POST, 'POST', `${F}/payments`, {}, body, { 'idempotency-key': `pay-${randomUUID()}` }),
    unallocate: (paymentId: string, allocationId: string) =>
      call(allocationReverse.POST, 'POST', `${F}/payments/${paymentId}/allocations/${allocationId}/reverse`, { paymentId, allocationId }, {}),
    patchSettings: (body: unknown) => call(settingsRoute.PATCH, 'PATCH', `${F}/settings`, {}, body),
    createTaxRate: (body: unknown) => call(taxRatesRoute.POST, 'POST', `${F}/tax-rates`, {}, body),
    categories: () => call(categoriesRoute.GET, 'GET', `${F}/expense-categories`, {}),
    createExpense: (body: unknown) => call(expensesRoute.POST, 'POST', `${F}/expenses`, {}, body),
    patchExpense: (id: string, body: unknown) => call(expenseRoute.PATCH, 'PATCH', `${F}/expenses/${id}`, { expenseId: id }, body),
    recordExpense: (id: string, version: number) => call(expenseRecord.POST, 'POST', `${F}/expenses/${id}/record`, { expenseId: id }, { version }),
    summary: (projectId: string) => call(summaryRoute.GET, 'GET', `${F}/projects/${projectId}/summary`, { projectId }),
  };
};
type Api = ReturnType<typeof api>;

// ---- direct SQL as bos_app (the application role, forced RLS, no service in between) ----------------

type Tx = { c: pg.Client; pid: number; q: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>; commit: () => Promise<void>; rollback: () => Promise<void> };

/** Opens a bos_app transaction in a tenant's context (as tenant code runs). Close with commit or rollback. */
async function tx(T: { businessId: string; people: Record<string, User> }): Promise<Tx> {
  const c = new pg.Client({ connectionString: APP_URL });
  await c.connect();
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [T.businessId, T.people.OWNER!.id]);
  const pid = await backendPid(c);
  const end = async (sql: string) => {
    try { await c.query(sql); } finally { await c.end(); }
  };
  return { c, pid, q: (sql, params) => c.query(sql, params), commit: () => end('COMMIT'), rollback: () => end('ROLLBACK') };
}

/** One statement in its own committed bos_app transaction. Resolves to the SQLSTATE on failure. */
async function sql(T: Parameters<typeof tx>[0], text: string, params: unknown[] = []): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string; message: string }> {
  const t = await tx(T);
  try {
    const res = await t.q(text, params);
    await t.commit();
    return { ok: true, rows: res.rows };
  } catch (error) {
    await t.rollback().catch(() => undefined);
    const e = error as { code?: string; message?: string };
    return { ok: false, code: e.code ?? '?', message: e.message ?? '' };
  }
}
const codeOf = async (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? '?');

/** link-quote's shipped lock order (§6.10 P3): the quote FOR SHARE, then the project row (the trigger re-takes the quote lock). */
async function linkQuote(t: Tx, projectId: string, quoteId: string) {
  await t.q('SELECT id FROM finance_documents WHERE id = $1 FOR SHARE', [quoteId]);
  await t.q('UPDATE projects SET source_quote_id = $2 WHERE id = $1', [projectId, quoteId]);
}

/** from-quote's shipped lock order (§6.10 P4), as WF-1B-2 will run it: the quote FOR NO KEY UPDATE, then insert the project. */
async function projectFromQuote(t: Tx, quote: { id: string; customerId: string; opportunityId?: string | null }) {
  await t.q('SELECT id FROM finance_documents WHERE id = $1 FOR NO KEY UPDATE', [quote.id]);
  const id = randomUUID();
  await t.q(
    `INSERT INTO projects (id, business_id, name, customer_id, source_quote_id, source_opportunity_id, updated_at)
     VALUES ($1, current_setting('app.business_id')::uuid, 'From quote', $2, $3, $4, now())`,
    [id, quote.customerId, quote.id, quote.opportunityId ?? null],
  );
  return id;
}

// ---- fixtures ------------------------------------------------------------------------------------

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let own: Api;
let gst: string;
let travel: string;
let seq = 0;

beforeAll(async () => {
  A = await team('wfa');
  B = await team('wfb');
  own = api(A.people.OWNER!, A.slug);
  for (const T of [A, B]) {
    expect((await api(T.people.OWNER!, T.slug).patchSettings({
      version: 0, sellerLegalName: 'Seller Pty Ltd', sellerAddress: '9 Seller Street, Perth', defaultPaymentTermsDays: 30,
    })).status).toBe(200);
  }
  gst = (await own.createTaxRate({ name: 'GST', ratePercent: '10' })).body.taxRate.id;
  travel = (await own.categories()).body.categories[0].id;
}, 180_000);

const line = (unitPrice: string, taxed = false) => ({ description: 'Work', quantity: '1', unitPrice, ...(taxed ? { taxRateId: gst } : {}) });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Perth', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function customer(a: Api = own, name = `Customer ${++seq}`): Promise<string> {
  const res = await a.createCustomer({ displayName: name });
  expect(res.status).toBe(201);
  return res.body.customer.id;
}
async function project(customerId: string | null, a: Api = own): Promise<string> {
  const res = await a.createProject({ name: `Project ${++seq}`, ...(customerId ? { customerId } : {}) });
  expect(res.status).toBe(201);
  return res.body.project.id;
}
/** An ACCEPTED quote (issued and accepted through the API). */
async function acceptedQuote(customerId: string, extra: Record<string, unknown> = {}, a: Api = own, lines = [line('500', true)]) {
  const q = (await a.createQuote({ customerId, lines, ...extra })).body.document;
  expect((await a.issueQuote(q.id)).status).toBe(200);
  const accepted = await a.acceptQuote(q.id);
  expect(accepted.status).toBe(200);
  return accepted.body.document as { id: string; customerId: string; opportunityId: string | null; version: number; projectId: string | null };
}
const quoteRow = async (id: string) => (await admin.query('SELECT * FROM finance_documents WHERE id = $1', [id])).rows[0];
const projectRow = async (id: string) => (await admin.query('SELECT * FROM projects WHERE id = $1', [id])).rows[0];

// =====================================================================================================

describe('migration shape (T-01..05, T-47 catalogue)', () => {
  it('creates validated constraints, the guard trigger and a forced-RLS workflow_requests table with least privilege', async () => {
    const constraints = (await admin.query(`
      SELECT conname, convalidated FROM pg_constraint
       WHERE conname = ANY($1) ORDER BY conname`, [[
      'finance_documents_project_customer_fkey', 'finance_expenses_project_customer_fkey', 'finance_recurring_templates_project_customer_fkey',
      'projects_source_opportunity_fkey', 'projects_source_quote_fkey', 'projects_source_quote_kind', 'projects_source_quote_customer',
      'workflow_requests_operation', 'workflow_requests_result_type', 'workflow_requests_idempotency_key', 'workflow_requests_request_hash',
    ]])).rows;
    expect(constraints).toHaveLength(11);
    expect(constraints.every((r) => r.convalidated)).toBe(true);
    const indexes = (await admin.query(`SELECT indexname FROM pg_indexes WHERE indexname = ANY($1) ORDER BY indexname`, [[
      'finance_documents_kind_customer_key', 'projects_customer_key', 'projects_source_quote_key', 'workflow_requests_key',
    ]])).rows.map((r) => r.indexname);
    expect(indexes).toEqual(['finance_documents_kind_customer_key', 'projects_customer_key', 'projects_source_quote_key', 'workflow_requests_key']);
    const trigger = (await admin.query(`
      SELECT t.tgname, p.prosecdef FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgname = 'projects_guard_links'`)).rows;
    expect(trigger).toEqual([{ tgname: 'projects_guard_links', prosecdef: false }]); // SECURITY INVOKER
    const rls = (await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'workflow_requests'`)).rows[0];
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const grants = (await admin.query(`
      SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'workflow_requests' AND grantee = 'bos_app' ORDER BY privilege_type`)).rows.map((r) => r.privilege_type);
    expect(grants).toEqual(['INSERT', 'SELECT']);
  });

  it('isolates workflow_requests by business, pins the actor to the session user, and never lets tenant code change or remove a key', async () => {
    const row = (businessId: string, actor = A.people.OWNER!.id) => [randomUUID(), businessId, `k-${randomUUID()}`, 'a'.repeat(64), randomUUID(), actor];
    const insert = `INSERT INTO workflow_requests (id, business_id, operation, idempotency_key, request_hash, result_type, result_id, actor_user_id)
                    VALUES ($1, $2, 'project.from_quote', $3, $4, 'project', $5, $6)`;
    const mine = row(A.businessId);
    expect((await sql(A, insert, mine)).ok).toBe(true);
    // Same key and operation again: one row per key.
    expect(await sql(A, insert, [randomUUID(), A.businessId, mine[2], 'b'.repeat(64), randomUUID(), A.people.OWNER!.id])).toMatchObject({ ok: false, code: '23505' });
    // Another business's id, or another actor: refused by RLS.
    expect(await sql(A, insert, row(B.businessId))).toMatchObject({ ok: false, code: '42501' });
    expect(await sql(A, insert, row(A.businessId, A.people.ADMIN!.id))).toMatchObject({ ok: false, code: '42501' });
    // Invisible to the other business; no UPDATE or DELETE for bos_app.
    expect(await sql(B, 'SELECT id FROM workflow_requests WHERE id = $1', [mine[0]])).toEqual({ ok: true, rows: [] });
    expect(await sql(A, 'SELECT id FROM workflow_requests WHERE id = $1', [mine[0]])).toEqual({ ok: true, rows: [{ id: mine[0] }] });
    expect(await sql(A, "UPDATE workflow_requests SET request_hash = $2 WHERE id = $1", [mine[0], 'c'.repeat(64)])).toMatchObject({ ok: false, code: '42501' });
    expect(await sql(A, 'DELETE FROM workflow_requests WHERE id = $1', [mine[0]])).toMatchObject({ ok: false, code: '42501' });
    // CHECKs: unknown operation, bad hash.
    expect(await sql(A, insert.replace("'project.from_quote'", "'project.delete'"), row(A.businessId))).toMatchObject({ ok: false, code: '23514' });
    expect(await sql(A, insert, [randomUUID(), A.businessId, 'k2', 'not-a-hash', randomUUID(), A.people.OWNER!.id])).toMatchObject({ ok: false, code: '23514' });
  });

  it("refuses another business's opportunity, quote, project and customer in every new link (T-01..05)", async () => {
    const b = api(B.people.OWNER!, B.slug);
    const bCustomer = await customer(b);
    const bProject = await project(bCustomer, b);
    const bOpp = (await b.createOpportunity({ title: 'B deal', customerId: bCustomer })).body.opportunity.id;
    const bQuote = await acceptedQuote(bCustomer, {}, b, [line('10')]);
    const aCustomer = await customer();
    const aProject = await project(aCustomer);
    // API: B's ids on A's Finance documents and filters.
    expect((await own.createInvoice({ customerId: aCustomer, projectId: bProject })).body.error).toBe('invalid_project');
    expect((await own.createQuote({ customerId: aCustomer, opportunityId: bOpp })).body.error).toBe('invalid_opportunity');
    expect((await own.listQuotes(`?opportunityId=${bOpp}`))).toMatchObject({ status: 200, body: { documents: [] } });
    expect((await own.summary(bProject)).status).toBe(404);
    // Direct SQL as bos_app in A: B's opportunity and B's quote on A's project.
    expect(await sql(A, 'UPDATE projects SET source_opportunity_id = $2 WHERE id = $1', [aProject, bOpp])).toMatchObject({ ok: false, code: '23503' });
    expect(await sql(A, 'UPDATE projects SET source_quote_id = $2 WHERE id = $1', [aProject, bQuote.id])).toMatchObject({ ok: false, code: 'WF002' });
    // A's document pointing at B's project directly.
    expect(await sql(A, `INSERT INTO finance_documents (id, business_id, kind, customer_id, project_id, currency_code, currency_scale, updated_at)
      VALUES ($1, current_setting('app.business_id')::uuid, 'INVOICE', $2, $3, 'AUD', 2, now())`, [randomUUID(), aCustomer, bProject])).toMatchObject({ ok: false, code: '23503' });
    expect((await projectRow(aProject)).source_opportunity_id).toBeNull();
  });
});

describe('I1 customer consistency (T-10..16, T-53)', () => {
  it('a document links only a project of its own customer; customerless projects carry no document', async () => {
    const c1 = await customer();
    const c2 = await customer();
    const p1 = await project(c1);
    const internal = await project(null);
    expect((await own.createQuote({ customerId: c2, projectId: p1 }))).toMatchObject({ status: 400, body: { error: 'project_customer_mismatch' } });
    expect((await own.createInvoice({ customerId: c1, projectId: internal }))).toMatchObject({ status: 400, body: { error: 'project_customer_mismatch' } });
    const ok = await own.createInvoice({ customerId: c1, projectId: p1 });
    expect(ok.status).toBe(201);
    // Draft edits: a new project of another customer, or a new customer while keeping the project.
    expect((await own.patchInvoice(ok.body.document.id, { version: 1, projectId: internal })).body.error).toBe('project_customer_mismatch');
    expect((await own.patchInvoice(ok.body.document.id, { version: 1, customerId: c2 })).body.error).toBe('project_customer_mismatch');
    expect((await own.patchInvoice(ok.body.document.id, { version: 1, customerId: c2, projectId: null })).status).toBe(200);
    // Database backstop without the service: 23503 on the I1 FK.
    const insert = `INSERT INTO finance_documents (id, business_id, kind, customer_id, project_id, currency_code, currency_scale, updated_at)
                    VALUES ($1, current_setting('app.business_id')::uuid, 'QUOTE', $2, $3, 'AUD', 2, now())`;
    const bad = await sql(A, insert, [randomUUID(), c2, p1]);
    expect(bad).toMatchObject({ ok: false, code: '23503' });
    expect((bad as { message: string }).message).toContain('finance_documents_project_customer_fkey');
    expect(await sql(A, insert, [randomUUID(), c1, internal])).toMatchObject({ ok: false, code: '23503' });
    // Recurring templates (customer always set): same FK.
    const template = `INSERT INTO finance_recurring_templates (id, business_id, name, customer_id, project_id, currency_code, currency_scale, frequency,
        start_date, time_zone, lines, next_period_index, next_run_on, updated_at)
      VALUES ($1, current_setting('app.business_id')::uuid, 'Retainer', $2, $3, 'AUD', 2, 'MONTHLY', '2026-12-01', 'Australia/Perth',
        '[{"description":"Retainer","quantity":"1","unitPrice":"10","discountAmount":"0","taxRateId":null}]'::jsonb, 0, '2026-12-01', now())`;
    expect(await sql(A, template, [randomUUID(), c2, p1])).toMatchObject({ ok: false, code: '23503' });
    expect(await sql(A, template, [randomUUID(), c1, p1])).toMatchObject({ ok: true });
  });

  it('expenses: MATCH SIMPLE lets an expense without a customer link any project; one with a customer only that customer\'s (T-53)', async () => {
    const c1 = await customer();
    const c2 = await customer();
    const p1 = await project(c1);
    const internal = await project(null);
    const base = { categoryId: travel, description: 'Fuel', incurredOn: '2026-01-10', taxTreatment: 'NO_TAX', amount: '20' };
    expect((await own.createExpense({ ...base, projectId: p1 })).status).toBe(201);
    expect((await own.createExpense({ ...base, projectId: internal })).status).toBe(201);
    expect((await own.createExpense({ ...base, projectId: internal, customerId: c1 })).body.error).toBe('project_customer_mismatch');
    expect((await own.createExpense({ ...base, projectId: p1, customerId: c2 })).body.error).toBe('project_customer_mismatch');
    const linked = await own.createExpense({ ...base, projectId: p1, customerId: c1 });
    expect(linked.status).toBe(201);
    expect((await own.patchExpense(linked.body.expense.id, { version: 1, customerId: c2 })).body.error).toBe('project_customer_mismatch');
    // Direct SQL: same rules in the database.
    const insert = `INSERT INTO finance_expenses (id, business_id, category_id, description, incurred_on, currency_code, currency_scale, tax_treatment,
        subtotal, tax_amount, amount, project_id, customer_id, updated_at)
      VALUES ($1, current_setting('app.business_id')::uuid, $2, 'x', '2026-01-10', 'AUD', 2, 'NO_TAX', 1, 0, 1, $3, $4, now())`;
    expect(await sql(A, insert, [randomUUID(), travel, p1, null])).toMatchObject({ ok: true });
    expect(await sql(A, insert, [randomUUID(), travel, internal, null])).toMatchObject({ ok: true });
    expect(await sql(A, insert, [randomUUID(), travel, p1, c2])).toMatchObject({ ok: false, code: '23503' });
    // A customerless expense never locks a project's customer.
    const free = await project(c1);
    expect((await own.createExpense({ ...base, projectId: free })).status).toBe(201);
    const p = (await own.getProject(free)).body.project;
    expect((await own.patchProject(free, { version: p.version, customerId: c2 })).status).toBe(200);
  });

  it('locks a project\'s customer while a document (any status), a customer expense, a schedule or a source quote links it (W1-D6)', async () => {
    const c1 = await customer();
    const c2 = await customer();
    const change = async (projectId: string) => {
      const p = (await own.getProject(projectId)).body.project;
      return own.patchProject(projectId, { version: p.version, customerId: c2 });
    };
    // Draft document.
    const withDraft = await project(c1);
    await own.createInvoice({ customerId: c1, projectId: withDraft });
    const locked = await change(withDraft);
    expect(locked).toMatchObject({ status: 409, body: { error: 'project_customer_locked' } });
    expect(JSON.stringify(locked.body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // no ids in the error (G-FIN)
    // Unlinking the customer is a change too.
    const p0 = (await own.getProject(withDraft)).body.project;
    expect((await own.patchProject(withDraft, { version: p0.version, customerId: null })).body.error).toBe('project_customer_locked');
    // A void (discarded) document still locks it.
    const withVoid = await project(c1);
    const d = (await own.createQuote({ customerId: c1, projectId: withVoid })).body.document;
    expect((await own.discardQuote(d.id)).status).toBe(200);
    expect((await change(withVoid)).body.error).toBe('project_customer_locked');
    // An expense with a customer.
    const withExpense = await project(c1);
    await own.createExpense({ categoryId: travel, description: 'x', incurredOn: '2026-01-10', taxTreatment: 'NO_TAX', amount: '5', projectId: withExpense, customerId: c1 });
    expect((await change(withExpense)).body.error).toBe('project_customer_locked');
    // A source quote (linked by SQL until WF-1B-2's link-quote).
    const withSource = await project(c1);
    const q = await acceptedQuote(c1, {}, own, [line('10')]);
    expect(await sql(A, 'UPDATE projects SET source_quote_id = $2 WHERE id = $1', [withSource, q.id])).toMatchObject({ ok: true });
    expect((await change(withSource)).body.error).toBe('project_customer_locked');
    // Database backstops without the service.
    const refDoc = await sql(A, 'UPDATE projects SET customer_id = $2 WHERE id = $1', [withDraft, c2]);
    expect(refDoc).toMatchObject({ ok: false, code: '23503' });
    expect((refDoc as { message: string }).message).toMatch(/update or delete on table "projects".*finance_documents_project_customer_fkey/);
    expect(await sql(A, 'UPDATE projects SET customer_id = $2 WHERE id = $1', [withSource, c2])).toMatchObject({ ok: false, code: '23503' });
    expect(await sql(A, 'UPDATE projects SET customer_id = NULL WHERE id = $1', [withSource])).toMatchObject({ ok: false, code: '23514' });
    // A project nothing links still changes freely.
    const free = await project(c1);
    expect((await change(free)).status).toBe(200);
  });

  it('the §10.2 preflight queries find a seeded violation, and the migration\'s own VALIDATE, run as bos_owner, fails on it (T-53)', async () => {
    const c1 = await customer();
    const c2 = await customer();
    const p1 = await project(c1);
    const preflight = `
      SELECT (SELECT count(*) FROM finance_documents d JOIN projects p ON p.business_id = d.business_id AND p.id = d.project_id
               WHERE p.customer_id IS DISTINCT FROM d.customer_id AND d.business_id = $1)::int AS documents,
             (SELECT count(*) FROM finance_expenses e JOIN projects p ON p.business_id = e.business_id AND p.id = e.project_id
               WHERE e.customer_id IS NOT NULL AND p.customer_id IS DISTINCT FROM e.customer_id AND e.business_id = $1)::int AS expenses,
             (SELECT count(*) FROM finance_recurring_templates r JOIN projects p ON p.business_id = r.business_id AND p.id = r.project_id
               WHERE p.customer_id IS DISTINCT FROM r.customer_id AND r.business_id = $1)::int AS templates`;
    // Seed a pre-migration-style violation and COMMIT it, so the migration role's own session can see it
    // (FK triggers off for this administrative session only). It is removed in finally.
    const badDoc = randomUUID();
    const okExpense = randomUUID();
    await admin.query('BEGIN');
    await admin.query("SET LOCAL session_replication_role = 'replica'");
    await admin.query(`INSERT INTO finance_documents (id, business_id, kind, customer_id, project_id, currency_code, currency_scale, updated_at)
      VALUES ($1, $2, 'QUOTE', $3, $4, 'AUD', 2, now())`, [badDoc, A.businessId, c2, p1]);
    await admin.query(`INSERT INTO finance_expenses (id, business_id, category_id, description, incurred_on, currency_code, currency_scale, tax_treatment,
      subtotal, tax_amount, amount, project_id, customer_id, updated_at)
      VALUES ($1, $2, $3, 'x', '2026-01-10', 'AUD', 2, 'NO_TAX', 1, 0, 1, $4, NULL, now())`, [okExpense, A.businessId, travel, p1]);
    await admin.query('COMMIT');
    const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await owner.connect();
    try {
      expect((await admin.query(preflight, [A.businessId])).rows[0]).toEqual({ documents: 1, expenses: 0, templates: 0 });
      const migration = readFileSync(new URL('../../prisma/migrations/20261207000000_workflow_links/migration.sql', import.meta.url), 'utf8');
      const block = migration.slice(migration.indexOf('-- >>> validate-i1'), migration.indexOf('-- <<< validate-i1'));
      expect(block).toContain('VALIDATE CONSTRAINT');
      const readd = (name: string, table: string) => `ALTER TABLE ${table} DROP CONSTRAINT ${name};
        ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY (business_id, project_id, customer_id)
          REFERENCES projects (business_id, id, customer_id) ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;`;
      const readdAll = readd('finance_documents_project_customer_fkey', 'finance_documents')
        + readd('finance_expenses_project_customer_fkey', 'finance_expenses')
        + readd('finance_recurring_templates_project_customer_fkey', 'finance_recurring_templates');
      expect((await owner.query('SELECT current_user AS u')).rows[0].u).toBe('bos_owner');
      // The hazard the block exists for: under FORCE, the owner's VALIDATE sees no rows and passes.
      await owner.query('BEGIN');
      try {
        await owner.query(readdAll);
        await expect(owner.query('ALTER TABLE finance_documents VALIDATE CONSTRAINT finance_documents_project_customer_fkey')).resolves.toBeDefined();
      } finally {
        await owner.query('ROLLBACK');
      }
      // The migration's block, verbatim, as the migration role: it refuses the violating row.
      await owner.query('BEGIN');
      try {
        await owner.query(readdAll);
        await expect(owner.query(block)).rejects.toMatchObject({ code: '23503' });
      } finally {
        await owner.query('ROLLBACK');
      }
      // On clean data the block passes and leaves FORCE in place.
      await admin.query('BEGIN');
      await admin.query("SET LOCAL session_replication_role = 'replica'");
      await admin.query('DELETE FROM finance_documents WHERE id = $1', [badDoc]);
      await admin.query('COMMIT');
      await owner.query('BEGIN');
      try {
        await owner.query(readdAll);
        await owner.query(block);
        const forced = await owner.query(`SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('projects', 'finance_documents', 'finance_expenses',
          'finance_recurring_templates') AND relnamespace = 'public'::regnamespace AND relrowsecurity AND relforcerowsecurity`);
        expect(forced.rows[0].n).toBe(4);
      } finally {
        await owner.query('ROLLBACK');
      }
    } finally {
      await owner.end();
      await admin.query('BEGIN');
      await admin.query("SET LOCAL session_replication_role = 'replica'");
      await admin.query('DELETE FROM finance_documents WHERE id = $1', [badDoc]);
      await admin.query('DELETE FROM finance_expenses WHERE id = $1', [okExpense]);
      await admin.query('COMMIT');
    }
    expect((await admin.query(preflight, [A.businessId])).rows[0]).toEqual({ documents: 0, expenses: 0, templates: 0 });
    expect((await admin.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname LIKE '%project_customer_fkey' AND convalidated`)).rows[0].n).toBe(3);
    expect((await admin.query(`SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('projects', 'finance_documents', 'finance_expenses',
      'finance_recurring_templates') AND relnamespace = 'public'::regnamespace AND relforcerowsecurity`)).rows[0].n).toBe(4);
  });
});

describe('source-quote guard trigger by direct SQL (T-47, G-TRG)', () => {
  it('refuses wrong kind, other customer, a second project per quote, non-accepted quotes, another project\'s quote, a disagreeing opportunity and any change once set', async () => {
    const c1 = await customer();
    const c2 = await customer();
    const opp = (await own.createOpportunity({ title: 'Deal', customerId: c1 })).body.opportunity.id;
    const opp2 = (await own.createOpportunity({ title: 'Other deal', customerId: c1 })).body.opportunity.id;
    const accepted = await acceptedQuote(c1, { opportunityId: opp }, own, [line('10')]);
    const set = (projectId: string, quoteId: string) => sql(A, 'UPDATE projects SET source_quote_id = $2 WHERE id = $1', [projectId, quoteId]);

    const invoice = (await own.createInvoice({ customerId: c1, lines: [line('10')] })).body.document;
    await own.issueInvoice(invoice.id);
    expect(await set(await project(c1), invoice.id)).toMatchObject({ ok: false, code: 'WF002' }); // wrong kind
    // Other customer: the composite FK refuses it (a quote without an opportunity, so WF004 does not fire first).
    const plain = await acceptedQuote(c1, {}, own, [line('10')]);
    expect(await set(await project(c2), plain.id)).toMatchObject({ ok: false, code: '23503' });
    const draft = (await own.createQuote({ customerId: c1, lines: [line('10')] })).body.document;
    expect(await set(await project(c1), draft.id)).toMatchObject({ ok: false, code: 'WF002' }); // draft
    const issued = (await own.createQuote({ customerId: c1, lines: [line('10')] })).body.document;
    await own.issueQuote(issued.id);
    expect(await set(await project(c1), issued.id)).toMatchObject({ ok: false, code: 'WF002' }); // issued, not accepted
    // Drafted for another project.
    const owner = await project(c1);
    const forOther = await acceptedQuote(c1, { projectId: owner }, own, [line('10')]);
    expect(await set(await project(c1), forOther.id)).toMatchObject({ ok: false, code: 'WF003' });
    expect(await set(owner, forOther.id)).toMatchObject({ ok: true }); // its own project may take it
    // Opportunity must agree with the quote's.
    const first = await project(c1);
    expect(await sql(A, 'UPDATE projects SET source_opportunity_id = $2, source_quote_id = $3 WHERE id = $1', [first, opp2, accepted.id]))
      .toMatchObject({ ok: false, code: 'WF004' });
    expect(await set(first, accepted.id)).toMatchObject({ ok: false, code: 'WF004' }); // NULL opportunity also disagrees
    expect(await sql(A, 'UPDATE projects SET source_opportunity_id = $2, source_quote_id = $3 WHERE id = $1', [first, opp, accepted.id])).toMatchObject({ ok: true });
    expect(await sql(A, 'UPDATE projects SET source_opportunity_id = $2 WHERE id = $1', [first, opp2])).toMatchObject({ ok: false, code: 'WF004' });
    // One project per quote.
    const second = await project(c1);
    expect(await sql(A, 'UPDATE projects SET source_opportunity_id = $2, source_quote_id = $3 WHERE id = $1', [second, opp, accepted.id]))
      .toMatchObject({ ok: false, code: '23505' });
    // Set once: never changed or cleared.
    const other = await acceptedQuote(c1, { opportunityId: opp }, own, [line('10')]);
    expect(await set(first, other.id)).toMatchObject({ ok: false, code: 'WF001' });
    expect(await sql(A, 'UPDATE projects SET source_quote_id = NULL WHERE id = $1', [first])).toMatchObject({ ok: false, code: 'WF001' });
    // CHECKs: kind pinned; a customerless project never has a source quote (the FK alone would skip it).
    expect(await sql(A, "UPDATE projects SET source_quote_kind = 'INVOICE' WHERE id = $1", [second])).toMatchObject({ ok: false, code: '23514' });
    const internal = await project(null);
    expect(await set(internal, plain.id)).toMatchObject({ ok: false, code: '23514' });
    // Insert with a source quote follows the same rules.
    expect(await sql(A, `INSERT INTO projects (id, business_id, name, customer_id, source_quote_id, updated_at)
      VALUES ($1, current_setting('app.business_id')::uuid, 'X', $2, $3, now())`, [randomUUID(), c1, draft.id])).toMatchObject({ ok: false, code: 'WF002' });
    expect((await projectRow(first)).source_quote_id).toBe(accepted.id);
  });

  it('maps the trigger codes and FK backstops to stable API errors', async () => {
    // A customer edit on a quote-linked project that slipped past the service check would hit the FK: the
    // route answers 409 project_customer_locked (T-52 exercises it under a real race); here the mapping
    // of every WF code is checked through the module that owns it.
    const routes = readFileSync(new URL('../../src/app/api/_lib/routes.ts', import.meta.url), 'utf8');
    for (const [code, error] of [['WF001', 'project_has_quote'], ['WF002', 'quote_not_accepted'], ['WF003', 'quote_has_project'], ['WF004', 'opportunity_mismatch']]) {
      expect(routes).toContain(`${code}: [409, '${error}']`);
    }
  });
});

describe('Finance redaction and authorisation (T-20..30, D-WF1-05, D-WF1-11)', () => {
  let c1: string;
  let linked: string;
  let opp: string;
  let quote: { id: string };
  beforeAll(async () => {
    c1 = await customer();
    opp = (await own.createOpportunity({ title: 'Redaction deal', customerId: c1 })).body.opportunity.id;
    quote = await acceptedQuote(c1, { opportunityId: opp }, own, [line('10')]);
    linked = await project(c1);
    expect(await sql(A, 'UPDATE projects SET source_opportunity_id = $2, source_quote_id = $3 WHERE id = $1', [linked, opp, quote.id])).toMatchObject({ ok: true });
  });

  it('finance readers see the source quote; everyone else gets no sourceQuote keys at all (absent, not null)', async () => {
    const o = (await own.getProject(linked)).body.project;
    expect(o).toMatchObject({ sourceQuoteId: quote.id, sourceQuote: { id: quote.id, status: 'ACCEPTED' }, sourceOpportunityId: opp, sourceOpportunity: { id: opp, title: 'Redaction deal', status: 'OPEN' } });
    expect(o.sourceQuote.number).toMatch(/\S/);
    const member = api(A.people.MEMBER!, A.slug);
    for (const res of [await member.getProject(linked), await member.listProjects(), await member.customerProjects(c1)]) {
      expect(res.status).toBe(200);
      const items = res.body.project ? [res.body.project] : res.body.projects;
      const mine = items.find((p: { id: string }) => p.id === linked);
      expect(mine).toBeDefined();
      expect(mine).not.toHaveProperty('sourceQuoteId');
      expect(mine).not.toHaveProperty('sourceQuote');
      expect(mine).toMatchObject({ sourceOpportunityId: opp });
      expect(JSON.stringify(res.body)).not.toContain(quote.id);
    }
    // An edit's response follows the same rule.
    const v = (await member.getProject(linked)).body.project.version;
    const edited = await member.patchProject(linked, { version: v, description: 'Edited' });
    expect(edited.status).toBe(200);
    expect(edited.body.project).not.toHaveProperty('sourceQuote');
    // A custom principal with every Projects key but no Sales or Finance read sees neither link.
    custom.MEMBER = ['business:read', 'projects:read', 'projects:create', 'projects:update', 'customers:read'];
    const narrow = (await member.getProject(linked)).body.project;
    for (const key of ['sourceQuoteId', 'sourceQuote', 'sourceOpportunityId', 'sourceOpportunity']) expect(narrow).not.toHaveProperty(key);
    // Unlinked projects show explicit nulls to readers who may see them.
    const plain = (await own.getProject(await project(c1))).body.project;
    expect(plain).toMatchObject({ sourceQuoteId: null, sourceQuote: null, sourceOpportunityId: null, sourceOpportunity: null });
  });

  it('project summary: finance:read AND projects:read; MEMBER and one-key principals are refused (T-27..30)', async () => {
    for (const role of ['OWNER', 'ADMIN', 'MANAGER'] as const) expect((await api(A.people[role]!, A.slug).summary(linked)).status).toBe(200);
    expect((await api(A.people.MEMBER!, A.slug).summary(linked))).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    custom.MANAGER = ['business:read', 'finance:read'];
    expect((await api(A.people.MANAGER!, A.slug).summary(linked)).status).toBe(403);
    custom.MANAGER = ['business:read', 'projects:read'];
    expect((await api(A.people.MANAGER!, A.slug).summary(linked)).status).toBe(403);
    expect((await own.summary(randomUUID())).status).toBe(404);
    expect((await own.summary('not-a-uuid')).status).toBe(404);
  });

  it('naming an opportunity or project on a Finance document, or filtering by opportunity, needs that Zone\'s read key (D-WF1-11)', async () => {
    const mgr = api(A.people.MANAGER!, A.slug);
    const p = await project(c1);
    // Default MANAGER holds finance:write, sales:read and projects:read.
    expect((await mgr.createQuote({ customerId: c1, opportunityId: opp, projectId: p })).status).toBe(201);
    const financeOnly: Permission[] = ['business:read', 'finance:read', 'finance:write', 'customers:read'];
    custom.MANAGER = financeOnly;
    expect((await mgr.createQuote({ customerId: c1, opportunityId: opp })).status).toBe(403);
    expect((await mgr.createInvoice({ customerId: c1, projectId: p })).status).toBe(403);
    expect((await mgr.listQuotes(`?opportunityId=${opp}`)).status).toBe(403);
    expect((await mgr.listInvoices(`?opportunityId=${opp}`)).status).toBe(403);
    expect((await mgr.listCreditNotes(`?opportunityId=${opp}`)).status).toBe(403);
    const plain = await mgr.createInvoice({ customerId: c1 });
    expect(plain.status).toBe(201); // no link named: finance keys suffice
    expect((await mgr.patchInvoice(plain.body.document.id, { version: 1, projectId: null })).status).toBe(403);
    expect((await mgr.patchInvoice(plain.body.document.id, { version: 1, notes: 'ok' })).status).toBe(200);
    custom.MANAGER = [...financeOnly, 'sales:read'];
    expect((await mgr.createQuote({ customerId: c1, opportunityId: opp })).status).toBe(201);
    expect((await mgr.createQuote({ customerId: c1, opportunityId: opp, projectId: p })).status).toBe(403);
    custom.MANAGER = [...financeOnly, 'projects:read'];
    expect((await mgr.createInvoice({ customerId: c1, projectId: p })).status).toBe(201);
  });

  it('lists documents by opportunity', async () => {
    const opp2 = (await own.createOpportunity({ title: 'Filter deal', customerId: c1 })).body.opportunity.id;
    const q1 = (await own.createQuote({ customerId: c1, opportunityId: opp2 })).body.document.id;
    const i1 = (await own.createInvoice({ customerId: c1, opportunityId: opp2 })).body.document.id;
    await own.createQuote({ customerId: c1 });
    expect((await own.listQuotes(`?opportunityId=${opp2}`)).body.documents.map((d: { id: string }) => d.id)).toEqual([q1]);
    expect((await own.listInvoices(`?opportunityId=${opp2}`)).body.documents.map((d: { id: string }) => d.id)).toEqual([i1]);
  });
});

describe('financial boundaries (T-40, T-41, T-42)', () => {
  it('leaves every issued document byte-identical and the opportunity untouched through quote, convert and link actions', async () => {
    const c1 = await customer();
    const opp = (await own.createOpportunity({ title: 'Estimate deal', customerId: c1, amount: '999.99' })).body.opportunity;
    const oppBefore = (await admin.query('SELECT * FROM opportunities WHERE id = $1', [opp.id])).rows[0];
    // T-41: create, edit, issue, accept and convert a quote from the opportunity.
    const q = (await own.createQuote({ customerId: c1, opportunityId: opp.id, lines: [line('100', true)] })).body.document;
    expect(q).toMatchObject({ status: 'DRAFT', number: null, opportunityId: opp.id }); // T-42
    expect(q.lines).toHaveLength(1); // the opportunity amount never becomes a line
    expect((await own.patchQuote(q.id, { version: 1, notes: 'Scope' })).status).toBe(200);
    expect((await own.issueQuote(q.id, 2)).status).toBe(200);
    expect((await own.acceptQuote(q.id, 3)).status).toBe(200);
    const issuedBefore = await quoteRow(q.id);
    const p = await project(c1);
    expect(await sql(A, 'UPDATE projects SET source_opportunity_id = $2, source_quote_id = $3 WHERE id = $1', [p, opp.id, q.id])).toMatchObject({ ok: true });
    const draft = await own.convert(q.id);
    expect(draft.body.document).toMatchObject({ status: 'DRAFT', number: null, projectId: p, sourceQuoteId: q.id, opportunityId: opp.id }); // T-42, D-WF1-10
    // Refused link attempts and reads change nothing either.
    expect(await sql(A, 'UPDATE projects SET source_quote_id = NULL WHERE id = $1', [p])).toMatchObject({ ok: false });
    expect((await own.summary(p)).status).toBe(200);
    expect(await quoteRow(q.id)).toEqual(issuedBefore); // T-40: every column, content hash and version included
    expect((await admin.query('SELECT * FROM opportunities WHERE id = $1', [opp.id])).rows[0]).toEqual(oppBefore); // T-41
    // A won opportunity is not touched by any of this either.
    expect((await own.win(opp.id)).status).toBe(200);
    expect((await own.getOpportunity(opp.id)).body.opportunity.amount).toBe('999.99');
    // T-42: a document can never be inserted as anything but a draft.
    expect(await sql(A, `INSERT INTO finance_documents (id, business_id, kind, status, customer_id, currency_code, currency_scale, updated_at)
      VALUES ($1, current_setting('app.business_id')::uuid, 'INVOICE', 'ISSUED', $2, 'AUD', 2, now())`, [randomUUID(), c1])).toMatchObject({ ok: false, code: 'FN010' });
  });
});

describe('convert puts the source quote\'s project on the draft (T-48, D-WF1-10)', () => {
  it('fills the project from projects.source_quote_id, keeps a quote\'s own project, and the P8-vs-P3 gap is visible and correctable', async () => {
    const c1 = await customer();
    // A quote drafted for a project keeps that project (unchanged semantics).
    const p0 = await project(c1);
    const own0 = await acceptedQuote(c1, { projectId: p0 }, own, [line('10')]);
    expect((await own.convert(own0.id)).body.document.projectId).toBe(p0);
    // A quote without a project and without a source project: no project.
    const loose = await acceptedQuote(c1, {}, own, [line('10')]);
    expect((await own.convert(loose.id)).body.document.projectId).toBeNull();
    // The gap: a link-quote that commits after convert read the (unlinked) state.
    const p = await project(c1);
    const linker = await tx(A);
    await linkQuote(linker, p, loose.id);
    // convert runs while the link is uncommitted: it does not wait (KEY SHARE is compatible with FOR SHARE) and sees no source project.
    const gapDraft = await own.convert(loose.id);
    expect(gapDraft.status).toBe(201);
    expect(gapDraft.body.document.projectId).toBeNull();
    await linker.commit();
    // The correction path: the person sets the project on the draft (I1 checked), and the summary counts it.
    const fixed = await own.patchInvoice(gapDraft.body.document.id, { version: 1, projectId: p });
    expect(fixed).toMatchObject({ status: 200, body: { document: { projectId: p } } });
    expect((await own.issueInvoice(gapDraft.body.document.id, 2)).status).toBe(200);
    const s = (await own.summary(p)).body.summary;
    expect(s.counts.invoices.ISSUED).toBe(1);
    expect(s.currencies[0]).toMatchObject({ currencyCode: 'AUD', invoicedNet: '10.00', quotedNet: '10.00', acceptedNet: '10.00' });
    // From now on, converting the source quote fills the project.
    expect((await own.convert(loose.id)).body.document.projectId).toBe(p);
  });
});

describe('T-49 project summary per currency (§6.6.1)', () => {
  it('counts each quote once, separates payments from credit, ignores drafts and voids, and reconciles per currency', async () => {
    const c = await customer();
    const P = await project(c);
    const issued = async (doc: { id: string }, kind: 'quote' | 'invoice' | 'credit', version = 1) => {
      const res = kind === 'quote' ? await own.issueQuote(doc.id, version) : kind === 'invoice' ? await own.issueInvoice(doc.id, version) : await own.issueCredit(doc.id, version);
      expect(res.status).toBe(200);
      return res.body.document;
    };
    // Quotes. Q1: linked while draft, issued. Q2: no project, accepted, then P's source quote (linked after issue).
    const q1 = await issued((await own.createQuote({ customerId: c, projectId: P, lines: [line('1000', true)] })).body.document, 'quote');
    const q2 = await acceptedQuote(c, {}, own, [line('500', true)]);
    expect(await sql(A, 'UPDATE projects SET source_quote_id = $2 WHERE id = $1', [P, q2.id])).toMatchObject({ ok: true });
    await own.createQuote({ customerId: c, projectId: P, lines: [line('7777')] }); // draft: counted, never summed
    const discarded = (await own.createQuote({ customerId: c, projectId: P, lines: [line('8888')] })).body.document;
    await own.discardQuote(discarded.id);
    // Invoices (AUD). I1 converted from the source quote (D-WF1-10 puts P on it), part-paid; a reversed allocation is excluded.
    const i1draft = (await own.convert(q2.id, { dueDate: '2099-01-01' })).body.document;
    expect(i1draft.projectId).toBe(P);
    const i1 = await issued(i1draft, 'invoice');
    expect((await own.pay({ customerId: c, amount: '200', receivedOn: today(), method: 'BANK_TRANSFER', allocations: [{ invoiceId: i1.id, amount: '200' }] })).status).toBe(201);
    const reversed = await own.pay({ customerId: c, amount: '100', receivedOn: today(), method: 'CASH', allocations: [{ invoiceId: i1.id, amount: '100' }] });
    expect((await own.unallocate(reversed.body.payment.id, reversed.body.payment.allocations[0].id)).status).toBe(200);
    // I2 with a fully applied credit note; CN2 on I1 issued but unapplied.
    const i2 = await issued((await own.createInvoice({ customerId: c, projectId: P, dueDate: '2099-01-01', lines: [line('300', true)] })).body.document, 'invoice');
    const cn1 = await issued((await own.credit(i2.id, { lines: [line('100', true)] })).body.document, 'credit');
    expect((await own.applyCredit(cn1.id, [{ invoiceId: i2.id, amount: '110' }])).status).toBe(200);
    await issued((await own.credit(i1.id, { lines: [line('50', true)] })).body.document, 'credit');
    // I3 issued then voided; a discarded draft.
    const i3 = await issued((await own.createInvoice({ customerId: c, projectId: P, dueDate: '2099-01-01', lines: [line('4444')] })).body.document, 'invoice');
    expect((await own.voidInvoice(i3.id, i3.version)).status).toBe(200);
    // USD: one issued invoice, part-paid; one discarded draft.
    const usd = await issued((await own.createInvoice({ customerId: c, projectId: P, currencyCode: 'USD', dueDate: '2099-01-01', lines: [line('200')] })).body.document, 'invoice');
    expect((await own.pay({ customerId: c, currencyCode: 'USD', amount: '50', receivedOn: today(), method: 'CARD', allocations: [{ invoiceId: usd.id, amount: '50' }] })).status).toBe(201);
    const usdDraft = (await own.createInvoice({ customerId: c, projectId: P, currencyCode: 'USD', lines: [line('1')] })).body.document;
    await own.discardInvoice(usdDraft.id);
    // Expenses: recorded (counted, net) and draft (not counted).
    const e1 = (await own.createExpense({ categoryId: travel, description: 'Materials', incurredOn: '2026-01-10', taxTreatment: 'NO_TAX', amount: '80', projectId: P })).body.expense;
    expect((await own.recordExpense(e1.id, e1.version)).status).toBe(200);
    await own.createExpense({ categoryId: travel, description: 'Draft', incurredOn: '2026-01-10', taxTreatment: 'NO_TAX', amount: '999', projectId: P });

    const res = await own.summary(P);
    expect(res.status).toBe(200);
    const s = res.body.summary;
    expect(s.projectId).toBe(P);
    expect(s.currencies.map((x: { currencyCode: string }) => x.currencyCode)).toEqual(['AUD', 'USD']);
    expect(s.currencies[0]).toEqual({
      currencyCode: 'AUD', currencyScale: 2,
      quotedNet: '1500.00', acceptedNet: '500.00',
      invoicedNet: '800.00', invoicedGross: '880.00',
      creditedNet: '150.00', creditedGross: '165.00', billedNet: '650.00',
      paymentsAllocated: '200.00', creditApplied: '110.00', outstanding: '570.00', unappliedCredit: '55.00',
      expensesNet: '80.00',
    });
    expect(s.currencies[1]).toEqual({
      currencyCode: 'USD', currencyScale: 2, quotedNet: '0.00', acceptedNet: '0.00', invoicedNet: '200.00', invoicedGross: '200.00',
      creditedNet: '0.00', creditedGross: '0.00', billedNet: '200.00', paymentsAllocated: '50.00', creditApplied: '0.00', outstanding: '150.00',
      unappliedCredit: '0.00', expensesNet: '0.00',
    });
    // The reconciliation identity, per currency.
    for (const x of s.currencies) {
      expect(Number(x.paymentsAllocated) + Number(x.creditApplied) + Number(x.outstanding)).toBeCloseTo(Number(x.invoicedGross), 2);
    }
    expect(s.counts).toEqual({
      quotes: { DRAFT: 1, ISSUED: 1, ACCEPTED: 1, DECLINED: 0, EXPIRED: 0, VOID: 1 },
      invoices: { DRAFT: 0, ISSUED: 3, ACCEPTED: 0, DECLINED: 0, EXPIRED: 0, VOID: 2 },
      creditNotes: { DRAFT: 0, ISSUED: 2, ACCEPTED: 0, DECLINED: 0, EXPIRED: 0, VOID: 0 },
    });
    expect(q1.status).toBe('ISSUED');
  });

  it('counts a quote that is both draft-linked and the source quote once, and drops a voided source quote', async () => {
    const c = await customer();
    const P = await project(c);
    const both = await acceptedQuote(c, { projectId: P }, own, [line('250')]);
    expect(await sql(A, 'UPDATE projects SET source_quote_id = $2 WHERE id = $1', [P, both.id])).toMatchObject({ ok: true });
    let s = (await own.summary(P)).body.summary;
    expect(s.currencies).toEqual([expect.objectContaining({ currencyCode: 'AUD', quotedNet: '250.00', acceptedNet: '250.00' })]);
    expect(s.counts.quotes.ACCEPTED).toBe(1);
    expect((await own.voidQuote(both.id, both.version)).status).toBe(200);
    s = (await own.summary(P)).body.summary;
    expect(s.currencies[0]).toMatchObject({ quotedNet: '0.00', acceptedNet: '0.00' });
    expect(s.counts.quotes).toMatchObject({ ACCEPTED: 0, VOID: 1 });
    // The project keeps its link and finance readers see the quote as void (§8).
    expect((await own.getProject(P)).body.project.sourceQuote).toMatchObject({ id: both.id, status: 'VOID' });
    // An empty project has no currency rows.
    expect((await own.summary(await project(c))).body.summary).toMatchObject({ currencies: [], counts: { quotes: { DRAFT: 0 } } });
  });
});

describe('T-51 source-quote link vs quote void (H1), deterministic two-session', () => {
  let c: string;
  beforeAll(async () => {
    c = await customer();
  });
  const setup = async () => ({ p: await project(c), q: await acceptedQuote(c, {}, own, [line('10')]) });
  /** The void as Finance runs it: lock the quote FOR NO KEY UPDATE (lockDocuments), then change its status. */
  const voidBySql = async (t: Tx, quoteId: string) => {
    await t.q('SELECT id FROM finance_documents WHERE id = $1 FOR NO KEY UPDATE', [quoteId]);
    await t.q("UPDATE finance_documents SET status = 'VOID', void_reason = 'race', version = version + 1 WHERE id = $1", [quoteId]);
  };

  it('(a) a void that committed first is seen: the link is refused', async () => {
    const { p, q } = await setup();
    expect((await own.voidQuote(q.id, q.version)).status).toBe(200);
    const t = await tx(A);
    expect(await codeOf(linkQuote(t, p, q.id))).toBe('WF002');
    await t.rollback();
    expect((await projectRow(p)).source_quote_id).toBeNull();
  });

  it('(b) a void holding the quote makes the link wait; when it commits the link sees VOID and is refused', async () => {
    const { p, q } = await setup();
    const voider = await tx(A);
    await voidBySql(voider, q.id);
    const linker = await tx(A);
    const link = codeOf(linkQuote(linker, p, q.id));
    await waitUntilBlocked(admin, voider.pid); // the barrier: PostgreSQL reports the link waiting on the void
    await voider.commit();
    expect(await link).toBe('WF002');
    await linker.rollback();
    expect((await projectRow(p)).source_quote_id).toBeNull();
  });

  it('(c) a void that rolls back lets the waiting link through', async () => {
    const { p, q } = await setup();
    const voider = await tx(A);
    await voidBySql(voider, q.id);
    const linker = await tx(A);
    const link = codeOf(linkQuote(linker, p, q.id));
    await waitUntilBlocked(admin, voider.pid);
    await voider.rollback();
    expect(await link).toBe('ok');
    await linker.commit();
    expect((await projectRow(p)).source_quote_id).toBe(q.id);
  });

  it('(d) a link that locked first makes the API void wait; the void then succeeds and the project keeps its link', async () => {
    const { p, q } = await setup();
    const linker = await tx(A);
    await linkQuote(linker, p, q.id);
    const voiding = own.voidQuote(q.id, q.version);
    expect(await finishesOrBlocks(admin, linker.pid, voiding)).toBe('blocked');
    await linker.commit();
    expect((await voiding).status).toBe(200);
    expect((await projectRow(p)).source_quote_id).toBe(q.id);
    expect((await quoteRow(q.id)).status).toBe('VOID');
  });

  it('(d′) the trigger itself takes the quote lock: a direct UPDATE without the service\'s FOR SHARE still blocks a void', async () => {
    const { p, q } = await setup();
    const linker = await tx(A);
    await linker.q('UPDATE projects SET source_quote_id = $2 WHERE id = $1', [p, q.id]);
    const voider = await tx(A);
    const voiding = codeOf(voidBySql(voider, q.id));
    await waitUntilBlocked(admin, linker.pid);
    await linker.commit();
    expect(await voiding).toBe('ok');
    await voider.commit();
    expect((await projectRow(p)).source_quote_id).toBe(q.id);
  });

  it('(e) direct-SQL link vs from-quote on one quote: at most one link, the loser rolls back cleanly (both orders)', async () => {
    // Order 1: from-quote (P4) holds the quote; the direct link (P9) locks its project, then waits in the trigger.
    {
      const { p, q } = await setup();
      const p4 = await tx(A);
      await p4.q('SELECT id FROM finance_documents WHERE id = $1 FOR NO KEY UPDATE', [q.id]);
      const p9 = await tx(A);
      const link = codeOf(p9.q('UPDATE projects SET source_quote_id = $2 WHERE id = $1', [p, q.id]));
      await waitUntilBlocked(admin, p4.pid);
      const created = await codeOf(p4.q(`INSERT INTO projects (id, business_id, name, customer_id, source_quote_id, updated_at)
        VALUES ($1, current_setting('app.business_id')::uuid, 'From quote', $2, $3, now())`, [randomUUID(), c, q.id]));
      expect(created).toBe('ok');
      await p4.commit();
      // Observed: the BEFORE trigger takes the quote lock before the unique entry exists, so P9 holds no
      // index entry P4 needs and no cycle forms (§6.10 predicted a possible 40P01). P9 loses on the key.
      expect(await link).toBe('23505');
      await p9.rollback();
      expect((await admin.query('SELECT count(*)::int AS n FROM projects WHERE source_quote_id = $1', [q.id])).rows[0].n).toBe(1);
      expect((await projectRow(p)).source_quote_id).toBeNull();
    }
    // Order 2: the direct link commits its row first (holding the quote FOR SHARE); from-quote waits, then hits the key.
    {
      const { p, q } = await setup();
      const p9 = await tx(A);
      await p9.q('UPDATE projects SET source_quote_id = $2 WHERE id = $1', [p, q.id]);
      const p4 = await tx(A);
      const created = codeOf(projectFromQuote(p4, { id: q.id, customerId: c }));
      await waitUntilBlocked(admin, p9.pid);
      await p9.commit();
      expect(await created).toBe('23505');
      await p4.rollback();
      expect((await admin.query('SELECT count(*)::int AS n FROM projects WHERE source_quote_id = $1', [q.id])).rows[0].n).toBe(1);
      expect((await projectRow(p)).source_quote_id).toBe(q.id);
    }
  });
});

describe('T-52 §6.10 lock pairs, deterministic two-session (G-2)', () => {
  let c1: string;
  let c2: string;
  beforeAll(async () => {
    c1 = await customer();
    c2 = await customer();
  });
  const docInsert = `INSERT INTO finance_documents (id, business_id, kind, customer_id, project_id, currency_code, currency_scale, updated_at)
                     VALUES ($1, current_setting('app.business_id')::uuid, 'INVOICE', $2, $3, 'AUD', 2, now())`;

  it('P2 customer change first, P1 draft link waits on the project and then fails I1 (400 project_customer_mismatch)', async () => {
    const p = await project(c1);
    const p2 = await tx(A);
    await p2.q('UPDATE projects SET customer_id = $2 WHERE id = $1', [p, c2]);
    const linking = own.createInvoice({ customerId: c1, projectId: p }); // the service check still sees c1 (committed)
    expect(await finishesOrBlocks(admin, p2.pid, linking)).toBe('blocked');
    await p2.commit();
    expect(await linking).toMatchObject({ status: 400, body: { error: 'project_customer_mismatch' } });
    expect((await admin.query('SELECT count(*)::int AS n FROM finance_documents WHERE project_id = $1', [p])).rows[0].n).toBe(0);
  });

  it('P1 draft link first (uncommitted): P2 waits on its KEY SHARE; the referenced-side NO ACTION check then sees the committed link (409 project_customer_locked)', async () => {
    const p = await project(c1);
    const p1 = await tx(A);
    await p1.q(docInsert, [randomUUID(), c1, p]);
    const v = (await own.getProject(p)).body.project.version;
    const changing = own.patchProject(p, { version: v, customerId: c2 }); // service check sees no committed link
    expect(await finishesOrBlocks(admin, p1.pid, changing)).toBe('blocked');
    await p1.commit();
    expect(await changing).toMatchObject({ status: 409, body: { error: 'project_customer_locked' } });
    expect((await projectRow(p)).customer_id).toBe(c1);
  });

  it('P1 draft link uncommitted then rolled back: the waiting customer change succeeds (NO ACTION ignores the never-committed row)', async () => {
    const p = await project(c1);
    const p1 = await tx(A);
    await p1.q(docInsert, [randomUUID(), c1, p]);
    const v = (await own.getProject(p)).body.project.version;
    const changing = own.patchProject(p, { version: v, customerId: c2 });
    expect(await finishesOrBlocks(admin, p1.pid, changing)).toBe('blocked');
    await p1.rollback();
    expect((await changing).status).toBe(200);
    expect((await projectRow(p)).customer_id).toBe(c2);
  });

  it('P2 vs P3 link-quote, both orders: whoever has the project first wins, the other fails on the FK, never 40P01', async () => {
    // link-quote first: the customer change waits on the project row, then its FK on the source quote fails.
    {
      const p = await project(c1);
      const q = await acceptedQuote(c1, {}, own, [line('10')]);
      const p3 = await tx(A);
      await linkQuote(p3, p, q.id);
      const v = (await own.getProject(p)).body.project.version;
      const changing = own.patchProject(p, { version: v, customerId: c2 });
      expect(await finishesOrBlocks(admin, p3.pid, changing)).toBe('blocked');
      await p3.commit();
      expect(await changing).toMatchObject({ status: 409, body: { error: 'project_customer_locked' } });
      expect(await projectRow(p)).toMatchObject({ customer_id: c1, source_quote_id: q.id });
    }
    // customer change first: link-quote takes the quote, waits on the project, then fails the FK (quote customer ≠ new customer).
    {
      const p = await project(c1);
      const q = await acceptedQuote(c1, {}, own, [line('10')]);
      const p2 = await tx(A);
      await p2.q('UPDATE projects SET customer_id = $2 WHERE id = $1', [p, c2]);
      const p3 = await tx(A);
      const link = codeOf(linkQuote(p3, p, q.id));
      await waitUntilBlocked(admin, p2.pid);
      await p2.commit();
      expect(await link).toBe('23503');
      await p3.rollback();
      expect(await projectRow(p)).toMatchObject({ customer_id: c2, source_quote_id: null });
    }
  });

  it('P2 customer change vs P5 void of the source quote: no wait (KEY SHARE vs FOR NO KEY UPDATE), the change fails on the FK', async () => {
    const p = await project(c1);
    const q = await acceptedQuote(c1, {}, own, [line('10')]);
    expect(await sql(A, 'UPDATE projects SET source_quote_id = $2 WHERE id = $1', [p, q.id])).toMatchObject({ ok: true });
    const voider = await tx(A);
    await voider.q('SELECT id FROM finance_documents WHERE id = $1 FOR NO KEY UPDATE', [q.id]);
    await voider.q("UPDATE finance_documents SET status = 'VOID', void_reason = 'x', version = version + 1 WHERE id = $1", [q.id]);
    const p2 = await tx(A);
    const change = codeOf(p2.q('UPDATE projects SET customer_id = $2 WHERE id = $1', [p, c2]));
    expect(await finishesOrBlocks(admin, voider.pid, change)).toBe('finished');
    expect(await change).toBe('23503');
    await p2.rollback();
    await voider.commit();
    expect(await projectRow(p)).toMatchObject({ customer_id: c1, source_quote_id: q.id });
  });

  it('P4 from-quote vs P3 link-quote on one quote, both orders: the quote lock orders them, the later one hits the key, never 40P01', async () => {
    // link-quote first.
    {
      const p = await project(c1);
      const q = await acceptedQuote(c1, {}, own, [line('10')]);
      const p3 = await tx(A);
      await linkQuote(p3, p, q.id);
      const p4 = await tx(A);
      const created = codeOf(projectFromQuote(p4, { id: q.id, customerId: c1 }));
      await waitUntilBlocked(admin, p3.pid);
      await p3.commit();
      expect(await created).toBe('23505');
      await p4.rollback();
    }
    // from-quote first.
    {
      const p = await project(c1);
      const q = await acceptedQuote(c1, {}, own, [line('10')]);
      const p4 = await tx(A);
      await projectFromQuote(p4, { id: q.id, customerId: c1 });
      const p3 = await tx(A);
      const link = codeOf(linkQuote(p3, p, q.id));
      await waitUntilBlocked(admin, p4.pid);
      await p4.commit();
      expect(await link).toBe('23505');
      await p3.rollback();
      expect((await admin.query('SELECT count(*)::int AS n FROM projects WHERE source_quote_id = $1', [q.id])).rows[0].n).toBe(1);
    }
  });

  it('P3 link-quote vs P3 on one quote for two projects: the second waits on the first\'s key entry and then gets 23505', async () => {
    const q = await acceptedQuote(c1, {}, own, [line('10')]);
    const [pa, pb] = [await project(c1), await project(c1)];
    const first = await tx(A);
    await linkQuote(first, pa, q.id);
    const second = await tx(A);
    const link = codeOf(linkQuote(second, pb, q.id));
    await waitUntilBlocked(admin, first.pid);
    await first.commit();
    expect(await link).toBe('23505');
    await second.rollback();
  });
});
