/**
 * Finance F6-1 (docs/finance-billing-f6.md §3, §5): recurring invoice schedules, the billing worker,
 * idempotency, leases, concurrency, failure history, permissions and tenant isolation, through the
 * real route handlers and worker against PostgreSQL with the migrations and privileged SQL applied as
 * in production.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Lets a test make one audit write fail, to prove a period's draft and its run commit or roll back together.
const auditFailure = { action: null as string | null, times: 0 };
vi.mock('@/core/audit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/core/audit')>();
  const maybeFail = (action: string) => {
    if (auditFailure.action === action && auditFailure.times > 0) {
      auditFailure.times--;
      throw new Error('audit store unavailable');
    }
  };
  return {
    ...real,
    recordAudit: async (...args: Parameters<typeof real.recordAudit>) => { maybeFail(args[2]); return real.recordAudit(...args); },
    recordSystemAudit: async (...args: Parameters<typeof real.recordSystemAudit>) => { maybeFail(args[1]); return real.recordSystemAudit(...args); },
  };
});

import { addCalendarMonths, billingPeriodDate, todayInZone } from '@business-os/contracts';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as customersRoute from '@/app/api/v1/b/[slug]/customers/route';
import * as contactsRoute from '@/app/api/v1/b/[slug]/contacts/route';
import * as taxRatesRoute from '@/app/api/v1/b/[slug]/finance/tax-rates/route';
import * as taxRateRoute from '@/app/api/v1/b/[slug]/finance/tax-rates/[taxRateId]/route';
import * as invoiceRoute from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/route';
import * as invoiceIssue from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/issue/route';
import * as recurringListRoute from '@/app/api/v1/b/[slug]/finance/recurring-invoices/route';
import * as recurringRoute from '@/app/api/v1/b/[slug]/finance/recurring-invoices/[recurringId]/route';
import * as pauseRoute from '@/app/api/v1/b/[slug]/finance/recurring-invoices/[recurringId]/pause/route';
import * as resumeRoute from '@/app/api/v1/b/[slug]/finance/recurring-invoices/[recurringId]/resume/route';
import * as cancelRoute from '@/app/api/v1/b/[slug]/finance/recurring-invoices/[recurringId]/cancel/route';
import * as generateRoute from '@/app/api/v1/b/[slug]/finance/recurring-invoices/[recurringId]/generate/route';
import * as previewRoute from '@/app/api/v1/b/[slug]/finance/recurring-invoices/[recurringId]/preview/route';
import * as runsRoute from '@/app/api/v1/b/[slug]/finance/recurring-invoices/[recurringId]/runs/route';
import * as retryRoute from '@/app/api/v1/b/[slug]/finance/recurring-invoices/[recurringId]/runs/[runId]/retry/route';
import * as skipRoute from '@/app/api/v1/b/[slug]/finance/recurring-invoices/[recurringId]/runs/[runId]/skip/route';
import * as jobRoute from '@/app/api/internal/jobs/finance-billing/route';
import { runBillingPass } from '@/app/api/_lib/billing-worker';
import { withTenant } from '@/core/db';
import { claimRecurringRun, executeRecurringRun, failRecurringRun, planDueRuns, TEMPLATES_PER_PLAN_BATCH } from '@/modules/finance';
import { devOutbox } from '@/core/email';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
const app = new pg.Client({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await admin.connect();
  await app.connect();
});
afterAll(async () => {
  await admin.end();
  await app.end();
});
afterEach(() => {
  auditFailure.action = null;
  auditFailure.times = 0;
});

let ip = 1;
const IP_BLOCK = Number(process.env.BILLING_TEST_IP_BLOCK ?? 96);
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

const ZONE = 'Australia/Perth';
async function team(label: string, currency = 'AUD') {
  const owner = await newUser(`${label}-owner`);
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const created = await businessesRoute.POST(req('POST', '/api/v1/businesses', {
    cookie: owner.cookie, body: { name: `Business ${label}`, slug, countryCode: 'AU', timeZone: ZONE, locale: 'en-AU', currency },
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
  const F = `/api/v1/b/${slug}/finance`;
  const R = `${F}/recurring-invoices`;
  const r = (recurringId: string) => ctx({ slug, recurringId });
  const post = (route: { POST: (q: Request, c: ReturnType<typeof ctx>) => Promise<Response> }, path: string, c: ReturnType<typeof ctx>, body: unknown = {}) =>
    route.POST(req('POST', path, { cookie: who.cookie, body }), c).then(json);
  return {
    createCustomer: (body: unknown) => post(customersRoute, `/api/v1/b/${slug}/customers`, ctx({ slug }), body),
    createContact: (body: unknown) => post(contactsRoute, `/api/v1/b/${slug}/contacts`, ctx({ slug }), body),
    createTaxRate: (body: unknown) => post(taxRatesRoute, `${F}/tax-rates`, ctx({ slug }), body),
    patchTaxRate: (taxRateId: string, body: unknown) => taxRateRoute.PATCH(req('PATCH', `${F}/tax-rates/${taxRateId}`, { cookie: who.cookie, body }), ctx({ slug, taxRateId })).then(json),
    invoice: (documentId: string) => invoiceRoute.GET(req('GET', `${F}/invoices/${documentId}`, { cookie: who.cookie }), ctx({ slug, documentId })).then(json),
    issue: (documentId: string, body: unknown) => post(invoiceIssue, `${F}/invoices/${documentId}/issue`, ctx({ slug, documentId }), body),
    list: (qs = '') => recurringListRoute.GET(req('GET', `${R}${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    create: (body: unknown) => post(recurringListRoute, R, ctx({ slug }), body),
    get: (id: string) => recurringRoute.GET(req('GET', `${R}/${id}`, { cookie: who.cookie }), r(id)).then(json),
    patch: (id: string, body: unknown) => recurringRoute.PATCH(req('PATCH', `${R}/${id}`, { cookie: who.cookie, body }), r(id)).then(json),
    pause: (id: string, version: number) => post(pauseRoute, `${R}/${id}/pause`, r(id), { version }),
    resume: (id: string, version: number) => post(resumeRoute, `${R}/${id}/resume`, r(id), { version }),
    cancel: (id: string, version: number) => post(cancelRoute, `${R}/${id}/cancel`, r(id), { version, reason: 'Contract ended' }),
    generate: (id: string, version: number) => post(generateRoute, `${R}/${id}/generate`, r(id), { version }),
    preview: (id: string, qs = '') => previewRoute.GET(req('GET', `${R}/${id}/preview${qs}`, { cookie: who.cookie }), r(id)).then(json),
    runs: (id: string, qs = '') => runsRoute.GET(req('GET', `${R}/${id}/runs${qs}`, { cookie: who.cookie }), r(id)).then(json),
    retry: (id: string, runId: string) => post(retryRoute, `${R}/${id}/runs/${runId}/retry`, ctx({ slug, recurringId: id, runId })),
    skip: (id: string, runId: string) => post(skipRoute, `${R}/${id}/runs/${runId}/skip`, ctx({ slug, recurringId: id, runId })),
  };
};

const audits = async (targetId: string) =>
  (await admin.query('SELECT action, actor_user_id, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows;
const draftsOf = async (templateId: string) =>
  (await admin.query(
    `SELECT d.id, d.status, d.number, d.created_by_id, d.customer_id, d.currency_code, d.total::text, d.due_date::text, d.idempotency_key, r.period_index
       FROM finance_recurring_runs r JOIN finance_documents d ON d.business_id = r.business_id AND d.id = r.document_id
      WHERE r.template_id = $1 ORDER BY r.period_index`, [templateId])).rows;
const runRows = async (templateId: string) =>
  (await admin.query('SELECT id, period_index, period_date::text, status, attempts, max_attempts, error_code, trigger FROM finance_recurring_runs WHERE template_id = $1 ORDER BY period_index', [templateId])).rows;
const seriesNext = async (businessId: string) =>
  (await admin.query(`SELECT next_value::text FROM finance_number_series WHERE business_id = $1 AND kind = 'INVOICE'`, [businessId])).rows[0]?.next_value ?? null;
const pass = () => runBillingPass({ deadlineMs: 30_000, leaseSeconds: 60 });
/** Makes every PENDING run of a template due now (instead of waiting for its backoff). */
const dueNow = (templateId: string) => admin.query(`UPDATE finance_recurring_runs SET run_after = now() - interval '1 second' WHERE template_id = $1 AND status = 'PENDING'`, [templateId]);

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let custA: string;
let custA2: string;
let custB: string;
let gst: string;
const TODAY = todayInZone(ZONE);
const monthsAgo = (n: number) => addCalendarMonths(TODAY, -n);
const line = (unitPrice: string, taxRateId?: string) => ({ description: 'Monthly retainer', quantity: '1', unitPrice, ...(taxRateId ? { taxRateId } : {}) });
const template = (o: Record<string, unknown> = {}) => ({
  name: 'Retainer', customerId: custA, frequency: 'MONTHLY', startDate: monthsAgo(2), paymentTermsDays: 14, lines: [line('100.00', gst)], ...o,
});

beforeAll(async () => {
  A = await team('ba');
  B = await team('bb', 'EUR');
  const owner = api(A.people.OWNER!, A.slug);
  custA = (await owner.createCustomer({ displayName: 'Acme' })).body.customer.id;
  custA2 = (await owner.createCustomer({ displayName: 'Globex' })).body.customer.id;
  custB = (await api(B.people.OWNER!, B.slug).createCustomer({ displayName: 'B customer' })).body.customer.id;
  gst = (await owner.createTaxRate({ name: 'GST', ratePercent: '10' })).body.taxRate.id;
}, 180_000);

describe('schedules: permissions, validation and calendar rules', () => {
  it('OWNER and ADMIN manage schedules; MANAGER reads them; MEMBER has no finance access', async () => {
    const created = await api(A.people.ADMIN!, A.slug).create(template({ name: 'Admin schedule', startDate: addCalendarMonths(TODAY, 1) }));
    expect(created.status).toBe(201);
    expect(created.body.recurringInvoice).toMatchObject({
      status: 'ACTIVE', nextPeriodIndex: 0, nextRunOn: addCalendarMonths(TODAY, 1), currencyCode: 'AUD', currencyScale: 2, timeZone: ZONE,
      generatedCount: 0, createdById: A.people.ADMIN!.id, lines: [{ description: 'Monthly retainer', quantity: '1', unitPrice: '100.00', discountAmount: '0.00', taxRateId: gst }],
    });
    const id = created.body.recurringInvoice.id;
    const manager = api(A.people.MANAGER!, A.slug);
    expect((await manager.get(id)).status).toBe(200);
    expect((await manager.preview(id)).status).toBe(200);
    expect((await manager.create(template())).status).toBe(403);
    expect((await manager.pause(id, 1)).status).toBe(403);
    expect((await manager.generate(id, 1)).status).toBe(403);
    const member = api(A.people.MEMBER!, A.slug);
    expect((await member.list()).status).toBe(403);
    expect((await member.get(id)).status).toBe(403);
    expect((await audits(id)).map((a) => a.action)).toEqual(['finance.recurring.created']);
  });

  it('validates like a draft: tax rates and contacts of this business, real zones, end after start, archived rates refused', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const bRate = (await api(B.people.OWNER!, B.slug).createTaxRate({ name: 'VAT', ratePercent: '20' })).body.taxRate.id;
    expect((await own.create(template({ lines: [line('10', bRate)] }))).body).toMatchObject({ error: 'invalid_tax_rate' });
    expect((await own.create(template({ customerId: custB }))).body).toMatchObject({ error: 'invalid_customer' });
    const otherContact = (await own.createContact({ displayName: 'G', customerId: custA2 })).body.contact.id;
    expect((await own.create(template({ contactId: otherContact }))).body).toMatchObject({ error: 'contact_customer_mismatch' });
    expect((await own.create(template({ timeZone: 'Mars/Olympus' }))).status).toBe(400);
    expect((await own.create(template({ endDate: monthsAgo(3) }))).status).toBe(400);
    expect((await own.create(template({ lines: [] }))).status).toBe(400);
    expect((await own.create(template({ lines: [{ ...line('10'), discountAmount: '0.001' }] }))).body).toMatchObject({ error: 'invalid_amount' });
    const old = (await own.createTaxRate({ name: 'Old', ratePercent: '5' })).body.taxRate.id;
    await own.patchTaxRate(old, { archived: true });
    expect((await own.create(template({ lines: [line('10', old)] }))).body).toMatchObject({ error: 'archived_reference' });
  });

  it('month-end anchors clamp to shorter months and never drift (D-F6-6)', async () => {
    expect([0, 1, 2, 3, 12, 13].map((i) => billingPeriodDate('2027-01-31', 'MONTHLY', 1, i))).toEqual(
      ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2028-01-31', '2028-02-29']);
    expect([0, 1, 2].map((i) => billingPeriodDate('2027-11-30', 'QUARTERLY', 1, i))).toEqual(['2027-11-30', '2028-02-29', '2028-05-30']);
    expect([0, 1].map((i) => billingPeriodDate('2028-02-29', 'ANNUAL', 1, i))).toEqual(['2028-02-29', '2029-02-28']);
    expect([0, 1, 2].map((i) => billingPeriodDate('2027-12-27', 'WEEKLY', 2, i))).toEqual(['2027-12-27', '2028-01-10', '2028-01-24']);
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template({ startDate: '2099-01-31', name: 'Month end' }))).body.recurringInvoice;
    const preview = await own.preview(t.id, '?count=3');
    expect(preview.body.preview).toMatchObject({
      currencyCode: 'AUD', subtotal: '100.00', taxTotal: '10.00', total: '110.00', problem: null,
      periods: [
        { periodIndex: 0, periodDate: '2099-01-31', dueDate: '2099-02-14' },
        { periodIndex: 1, periodDate: '2099-02-28', dueDate: '2099-03-14' },
        { periodIndex: 2, periodDate: '2099-03-31', dueDate: '2099-04-14' },
      ],
    });
  });
});

describe('generation by the worker', () => {
  it('generates one DRAFT per due period, as the system, never taking an invoice number; a repeat pass changes nothing', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template())).body.recurringInvoice;
    const numberBefore = await seriesNext(A.businessId);
    const first = await pass();
    expect(first.generated).toBeGreaterThanOrEqual(3);
    const drafts = await draftsOf(t.id);
    expect(drafts.map((d) => d.period_index)).toEqual([0, 1, 2]);
    for (const [i, d] of drafts.entries()) {
      expect(d).toMatchObject({ status: 'DRAFT', number: null, created_by_id: null, customer_id: custA, currency_code: 'AUD', total: '110.0000' });
      expect(d.idempotency_key).toBe(`system recurring ${t.id}:${i}`);
    }
    // Due date = period date + 14 days.
    expect(drafts[0].due_date).toBe(new Date(Date.parse(`${t.startDate}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10));
    expect(await seriesNext(A.businessId)).toBe(numberBefore);
    const after = (await own.get(t.id)).body.recurringInvoice;
    expect(after).toMatchObject({ status: 'ACTIVE', nextPeriodIndex: 3, nextRunOn: addCalendarMonths(t.startDate, 3), generatedCount: 3, failedCount: 0, version: 1 });
    // Audit: system entries with no actor, naming the schedule and period; no amounts beyond the total.
    const created = await audits(drafts[0].id);
    expect(created).toEqual([expect.objectContaining({ action: 'finance.system.document.created', actor_user_id: null })]);
    expect(created[0].metadata).toMatchObject({ recurringTemplateId: t.id, periodIndex: '0', total: '110.00' });
    const runs = (await own.runs(t.id)).body.runs;
    expect(runs.map((r: { periodIndex: number }) => r.periodIndex)).toEqual([2, 1, 0]);
    expect(runs[0]).toMatchObject({ status: 'GENERATED', attempts: 1, trigger: 'SCHEDULE', documentStatus: 'DRAFT', documentNumber: null, errorCode: null });
    expect((await audits(runs[0].id)).map((a) => a.action)).toEqual(['finance.system.recurring.generated']);

    await pass();
    expect((await draftsOf(t.id)).length).toBe(3);
  });

  it('generated, issued and sent are separate: issuing a generated draft is an ordinary, separate issue by a person', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template({ startDate: TODAY, name: 'Issue later' }))).body.recurringInvoice;
    await pass();
    const [draft] = await draftsOf(t.id);
    expect(draft.status).toBe('DRAFT');
    const issued = await own.issue(draft.id, { version: 1, issueDate: TODAY });
    expect(issued.status).toBe(200);
    expect(issued.body.document.number).toMatch(/\d/);
    const runs = (await own.runs(t.id)).body.runs;
    expect(runs[0]).toMatchObject({ status: 'GENERATED', documentStatus: 'ISSUED', documentNumber: issued.body.document.number });
  });

  it('two workers at once never generate a period twice', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template({ startDate: addCalendarMonths(TODAY, -5), name: 'Race' }))).body.recurringInvoice;
    const results = await Promise.all([pass(), pass(), pass()]);
    expect(results.reduce((s, r) => s + r.generated, 0)).toBeGreaterThanOrEqual(6);
    const drafts = await draftsOf(t.id);
    expect(drafts.map((d) => d.period_index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(drafts.map((d) => d.id)).size).toBe(6);
    expect((await admin.query(`SELECT count(*)::int AS n FROM finance_documents WHERE idempotency_key LIKE $1`, [`system recurring ${t.id}:%`])).rows[0].n).toBe(6);
  });

  it('plans at most 12 periods per pass and catches up the rest on the next pass (D-F6-5)', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template({ frequency: 'WEEKLY', startDate: new Date(Date.parse(`${TODAY}T00:00:00Z`) - 20 * 7 * 86_400_000).toISOString().slice(0, 10), name: 'Weekly catch-up' }))).body.recurringInvoice;
    await runBillingPass({ deadlineMs: 30_000, runsPerBusiness: 100 });
    expect((await runRows(t.id)).length).toBe(12);
    await runBillingPass({ deadlineMs: 30_000, runsPerBusiness: 100 });
    expect((await runRows(t.id)).length).toBe(21);
    expect((await draftsOf(t.id)).length).toBe(21);
    expect((await own.get(t.id)).body.recurringInvoice.nextRunOn > TODAY).toBe(true);
  });

  it('a worker whose lease expired writes nothing; the period is reclaimed and generated exactly once', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template({ startDate: TODAY, name: 'Lease' }))).body.recurringInvoice;
    const unit = { businessId: A.businessId, userId: null };
    // Plan without executing: a pass with no run budget.
    await runBillingPass({ deadlineMs: 30_000, runsPerBusiness: 0 });
    const stale = (await withTenant(unit, (db) => claimRecurringRun(db, { leaseSeconds: 10 })))!;
    expect(stale).not.toBeNull();
    await admin.query(`UPDATE finance_recurring_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [stale.runId]);
    // The expired holder can neither generate nor record a failure.
    expect(await withTenant(unit, (db) => executeRecurringRun(db, stale))).toBe('lease_lost');
    expect(await withTenant(unit, (db) => failRecurringRun(db, stale, new Error('x')))).toBe('lease_lost');
    expect((await draftsOf(t.id)).length).toBe(0);
    const fresh = (await withTenant(unit, (db) => claimRecurringRun(db)))!;
    expect(fresh.runId).toBe(stale.runId);
    expect(fresh.leaseId).not.toBe(stale.leaseId);
    expect(await withTenant(unit, (db) => executeRecurringRun(db, fresh))).toBe('generated');
    expect(await withTenant(unit, (db) => executeRecurringRun(db, stale))).toBe('lease_lost');
    expect((await draftsOf(t.id)).length).toBe(1);
    expect((await runRows(t.id))[0]).toMatchObject({ status: 'GENERATED', attempts: 2 });
  });

  it('a transient failure rolls back the draft with it and is retried with backoff; nothing is half-created', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template({ startDate: TODAY, name: 'Transient' }))).body.recurringInvoice;
    auditFailure.action = 'finance.system.recurring.generated';
    auditFailure.times = 1;
    const result = await pass();
    expect(result.retrying).toBeGreaterThanOrEqual(1);
    expect((await draftsOf(t.id)).length).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM finance_documents WHERE idempotency_key = $1`, [`system recurring ${t.id}:0`])).rows[0].n).toBe(0);
    const [run] = await runRows(t.id);
    expect(run).toMatchObject({ status: 'PENDING', attempts: 1, error_code: 'internal_error' });
    expect((await audits(run.id)).map((a) => a.action)).toEqual(['finance.system.recurring.retrying']);
    await pass();
    expect((await runRows(t.id))[0].status).toBe('PENDING'); // still backing off
    await dueNow(t.id);
    await pass();
    expect((await runRows(t.id))[0]).toMatchObject({ status: 'GENERATED', attempts: 2, error_code: null });
    expect((await draftsOf(t.id)).length).toBe(1);
  });

  it('a failure that needs a person (archived tax rate) fails at once, keeps its history, and generates after the fix and a retry', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const rate = (await own.createTaxRate({ name: 'Temp', ratePercent: '7.5' })).body.taxRate.id;
    const t = (await own.create(template({ startDate: TODAY, name: 'Needs fix', lines: [line('40', rate)] }))).body.recurringInvoice;
    await own.patchTaxRate(rate, { archived: true });
    const numberBefore = await seriesNext(A.businessId);
    expect((await pass()).failed).toBeGreaterThanOrEqual(1);
    const [run] = await runRows(t.id);
    expect(run).toMatchObject({ status: 'FAILED', attempts: 1, error_code: 'archived_reference' });
    expect((await own.get(t.id)).body.recurringInvoice).toMatchObject({ failedCount: 1, status: 'ACTIVE' });
    expect((await own.preview(t.id)).body.preview.problem).toBe('archived_reference');
    await pass();
    expect((await runRows(t.id))[0].status).toBe('FAILED'); // a failed run is never retried on its own
    expect((await api(A.people.MANAGER!, A.slug).retry(t.id, run.id)).status).toBe(403);
    await own.patchTaxRate(rate, { archived: false });
    const retried = await own.retry(t.id, run.id);
    expect(retried.status).toBe(200);
    expect(retried.body.run).toMatchObject({ status: 'PENDING', maxAttempts: 5 });
    await pass();
    expect((await runRows(t.id))[0]).toMatchObject({ status: 'GENERATED', attempts: 2 });
    expect(await seriesNext(A.businessId)).toBe(numberBefore);
    expect((await audits(run.id)).map((a) => a.action)).toEqual(['finance.system.recurring.failed', 'finance.recurring.run_retried', 'finance.system.recurring.generated']);
  });

  it('a person can skip a failed period; skipped is final', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const rate = (await own.createTaxRate({ name: 'Temp2', ratePercent: '3' })).body.taxRate.id;
    const t = (await own.create(template({ startDate: TODAY, name: 'Skip me', lines: [line('5', rate)] }))).body.recurringInvoice;
    await own.patchTaxRate(rate, { archived: true });
    await pass();
    const [run] = await runRows(t.id);
    expect((await own.skip(t.id, run.id)).body.run).toMatchObject({ status: 'SKIPPED' });
    expect((await own.retry(t.id, run.id)).body).toMatchObject({ error: 'invalid_state' });
    expect((await own.skip(t.id, run.id)).body).toMatchObject({ error: 'invalid_state' });
  });
});

describe('pause, resume, cancel, end date and generate now', () => {
  it('a paused schedule generates nothing; resuming bills from the first period on or after today, not the paused ones', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template({ startDate: addCalendarMonths(TODAY, -3), name: 'Paused' }))).body.recurringInvoice;
    const paused = await own.pause(t.id, 1);
    expect(paused.body.recurringInvoice).toMatchObject({ status: 'PAUSED', version: 2 });
    expect(paused.body.recurringInvoice.pausedAt).not.toBeNull();
    await pass();
    expect((await runRows(t.id)).length).toBe(0);
    expect((await own.pause(t.id, 2)).body).toMatchObject({ error: 'invalid_state' });
    expect((await own.resume(t.id, 1)).body).toMatchObject({ error: 'stale' });
    const resumed = (await own.resume(t.id, 2)).body.recurringInvoice;
    expect(resumed).toMatchObject({ status: 'ACTIVE', nextPeriodIndex: 3, nextRunOn: TODAY, pausedAt: null });
    expect((await audits(t.id)).find((a) => a.action === 'finance.recurring.resumed').metadata).toMatchObject({ skippedPeriods: '3' });
    await pass();
    expect((await draftsOf(t.id)).map((d) => d.period_index)).toEqual([3]);
  });

  it('pausing skips periods already planned but not generated, so resuming never produces older drafts (D-F6-12)', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template({ startDate: monthsAgo(2), name: 'Planned then paused' }))).body.recurringInvoice;
    await runBillingPass({ deadlineMs: 30_000, runsPerBusiness: 0 }); // the worker planned three periods but generated none
    expect((await runRows(t.id)).map((r) => r.status)).toEqual(['PENDING', 'PENDING', 'PENDING']);
    const paused = (await own.pause(t.id, 1)).body.recurringInvoice;
    expect(paused.status).toBe('PAUSED');
    expect((await runRows(t.id)).map((r) => [r.status, r.error_code])).toEqual(Array(3).fill(['SKIPPED', 'template_paused']));
    expect((await audits(t.id)).find((a) => a.action === 'finance.recurring.paused').metadata).toMatchObject({ skippedRuns: '3' });
    const resumed = (await own.resume(t.id, paused.version)).body.recurringInvoice;
    expect(resumed).toMatchObject({ status: 'ACTIVE', nextPeriodIndex: 3, nextRunOn: addCalendarMonths(monthsAgo(2), 3) });
    await pass();
    await pass();
    expect(await draftsOf(t.id)).toEqual([]); // no catch-up drafts for the periods before or during the pause
    expect((await runRows(t.id)).length).toBe(3);
    // A person can still bill a period on purpose.
    const made = await own.generate(t.id, resumed.version);
    expect(made.status).toBe(201);
    expect((await draftsOf(t.id)).map((d) => d.period_index)).toEqual([3]);
  });

  it('cancelling is final and skips periods that were planned but not generated', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template({ startDate: TODAY, name: 'Cancel' }))).body.recurringInvoice;
    await runBillingPass({ deadlineMs: 30_000, runsPerBusiness: 0 }); // planned, not generated
    expect((await runRows(t.id))[0].status).toBe('PENDING');
    const cancelled = (await own.cancel(t.id, 1)).body.recurringInvoice;
    expect(cancelled).toMatchObject({ status: 'CANCELLED', nextRunOn: null });
    expect((await runRows(t.id))[0]).toMatchObject({ status: 'SKIPPED', error_code: 'template_cancelled' });
    await pass();
    expect((await draftsOf(t.id)).length).toBe(0);
    for (const res of [await own.resume(t.id, 2), await own.pause(t.id, 2), await own.patch(t.id, { version: 2, name: 'x' }), await own.generate(t.id, 2)]) {
      expect(res.body).toMatchObject({ error: 'invalid_state' });
    }
    expect((await audits(t.id)).find((a) => a.action === 'finance.recurring.cancelled').metadata).toMatchObject({ hasReason: 'true', skippedRuns: '1' });
  });

  it('a schedule ends after the last period on or before its end date', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template({ startDate: addCalendarMonths(TODAY, -2), endDate: addCalendarMonths(TODAY, -1), name: 'Ends' }))).body.recurringInvoice;
    await pass();
    expect((await draftsOf(t.id)).map((d) => d.period_index)).toEqual([0, 1]);
    expect((await own.get(t.id)).body.recurringInvoice).toMatchObject({ status: 'ENDED', nextRunOn: null });
    expect((await audits(t.id)).map((a) => a.action)).toContain('finance.system.recurring.ended');
  });

  it('generate now makes the next period\'s draft as the person, then the schedule moves on', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template({ startDate: addCalendarMonths(TODAY, 1), name: 'Now' }))).body.recurringInvoice;
    const res = await own.generate(t.id, 1);
    expect(res.status).toBe(201);
    expect(res.body.run).toMatchObject({ periodIndex: 0, status: 'GENERATED', trigger: 'MANUAL', requestedById: A.people.OWNER!.id, documentStatus: 'DRAFT' });
    expect(res.body.recurringInvoice).toMatchObject({ nextPeriodIndex: 1, nextRunOn: addCalendarMonths(t.startDate, 1), version: 2 });
    const [draft] = await draftsOf(t.id);
    expect(draft.created_by_id).toBe(A.people.OWNER!.id);
    expect((await audits(draft.id))[0]).toMatchObject({ action: 'finance.document.created', actor_user_id: A.people.OWNER!.id });
    expect((await own.generate(t.id, 1)).body).toMatchObject({ error: 'stale' });
  });

  it('schedule identity is fixed once a period exists; lines and notes still change for later periods', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template({ startDate: addCalendarMonths(TODAY, 2), name: 'Edit' }))).body.recurringInvoice;
    // Before any period: the schedule can be changed freely and its next run follows.
    const moved = (await own.patch(t.id, { version: 1, frequency: 'QUARTERLY', startDate: addCalendarMonths(TODAY, 3) })).body.recurringInvoice;
    expect(moved).toMatchObject({ frequency: 'QUARTERLY', nextRunOn: addCalendarMonths(TODAY, 3), version: 2 });
    await own.generate(t.id, 2);
    for (const body of [{ frequency: 'MONTHLY' }, { customerId: custA2 }, { currencyCode: 'USD' }, { startDate: TODAY }, { intervalCount: 2 }]) {
      expect((await own.patch(t.id, { version: 3, ...body })).body).toMatchObject({ error: 'schedule_fixed' });
    }
    const edited = await own.patch(t.id, { version: 3, notes: 'From now on', lines: [line('120.00')] });
    expect(edited.status).toBe(200);
    expect(edited.body.recurringInvoice.lines[0].unitPrice).toBe('120.00');
    const [first] = await draftsOf(t.id);
    expect(first.total).toBe('110.0000'); // the generated draft is untouched
    expect((await own.patch(t.id, { version: 4, endDate: addCalendarMonths(TODAY, 1) })).body).toMatchObject({ error: 'invalid_dates' });
    expect((await audits(t.id)).filter((a) => a.action === 'finance.recurring.updated').map((a) => a.metadata.fields)).toEqual([
      ['frequency', 'startDate'], ['lines', 'notes'],
    ]);
  });
});

describe('tenant isolation and database guards', () => {
  it('another business sees nothing: 404 on every path, empty lists, and the worker never crosses businesses', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template({ startDate: TODAY, name: 'Private' }))).body.recurringInvoice;
    await pass();
    const [run] = await runRows(t.id);
    const other = api(B.people.OWNER!, B.slug);
    for (const res of [await other.get(t.id), await other.preview(t.id), await other.runs(t.id), await other.pause(t.id, 1), await other.cancel(t.id, 1),
      await other.generate(t.id, 1), await other.retry(t.id, run.id), await other.skip(t.id, run.id), await other.patch(t.id, { version: 1, name: 'x' })]) {
      expect(res.status).toBe(404);
    }
    expect((await other.list()).body.recurringInvoices).toEqual([]);
    // B's own schedule produces drafts only in B, in B's currency, for B's customer.
    const bt = (await other.create({ name: 'B', customerId: custB, frequency: 'MONTHLY', startDate: TODAY, lines: [{ description: 'x', quantity: '1', unitPrice: '9' }] })).body.recurringInvoice;
    await pass();
    const bDrafts = await draftsOf(bt.id);
    expect(bDrafts).toEqual([expect.objectContaining({ customer_id: custB, currency_code: 'EUR' })]);
    const { rows } = await admin.query('SELECT DISTINCT r.business_id::text FROM finance_recurring_runs r WHERE r.template_id = ANY($1::uuid[])', [[t.id, bt.id]]);
    expect(rows.map((r) => r.business_id).sort()).toEqual([A.businessId, B.businessId].sort());
    for (const id of [t.id, bt.id]) {
      const own2 = (await admin.query('SELECT business_id::text FROM finance_recurring_templates WHERE id = $1', [id])).rows[0].business_id;
      expect((await admin.query('SELECT DISTINCT d.business_id::text FROM finance_recurring_runs r JOIN finance_documents d ON d.id = r.document_id WHERE r.template_id = $1', [id])).rows)
        .toEqual([{ business_id: own2 }]);
    }
  });

  it('as bos_app: RLS hides other businesses, there is no DELETE, and the guards hold without the services', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const t = (await own.create(template({ startDate: TODAY, name: 'Guards' }))).body.recurringInvoice;
    await pass();
    const [run] = await runRows(t.id);
    const asTenant = async <T>(businessId: string, userId: string | null, fn: () => Promise<T>) => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)`, [businessId, userId ?? '']);
        return await fn();
      } finally {
        await app.query('ROLLBACK');
      }
    };
    const code = async (sql: string, params: unknown[] = []) => {
      await app.query('SAVEPOINT s');
      try {
        await app.query(sql, params);
        await app.query('RELEASE SAVEPOINT s');
        return 'ok';
      } catch (e) {
        await app.query('ROLLBACK TO SAVEPOINT s');
        return (e as { code?: string }).code;
      }
    };
    await asTenant(B.businessId, B.people.OWNER!.id, async () => {
      expect((await app.query('SELECT id FROM finance_recurring_templates WHERE id = $1', [t.id])).rows).toEqual([]);
      expect((await app.query('SELECT id FROM finance_recurring_runs WHERE id = $1', [run.id])).rows).toEqual([]);
      expect((await app.query(`UPDATE finance_recurring_templates SET name = 'x' WHERE id = $1`, [t.id])).rowCount).toBe(0);
    });
    await asTenant(A.businessId, A.people.OWNER!.id, async () => {
      expect(await code('DELETE FROM finance_recurring_templates WHERE id = $1', [t.id])).toBe('42501');
      expect(await code('DELETE FROM finance_recurring_runs WHERE id = $1', [run.id])).toBe('42501');
      // A generated run is final; a run's identity is fixed; planning never moves backwards.
      expect(await code(`UPDATE finance_recurring_runs SET status = 'PENDING', document_id = NULL, finished_at = NULL WHERE id = $1`, [run.id])).toBe('FN032');
      expect(await code(`UPDATE finance_recurring_templates SET next_period_index = 0 WHERE id = $1`, [t.id])).toBe('FN030');
      expect(await code(`UPDATE finance_recurring_templates SET frequency = 'ANNUAL' WHERE id = $1`, [t.id])).toBe('FN030');
      expect(await code(`UPDATE finance_recurring_templates SET status = 'CANCELLED', next_run_on = NULL WHERE id = $1`, [t.id])).toBe('ok');
      expect(await code(`UPDATE finance_recurring_templates SET status = 'ACTIVE' WHERE id = $1`, [t.id])).toBe('FN031');
      // A run can only point at a DRAFT invoice of its template's customer and currency.
      const other = (await app.query(`SELECT id FROM finance_documents WHERE customer_id = $1 AND kind = 'INVOICE' LIMIT 1`, [custA2])).rows[0];
      const pending = randomUUID();
      await app.query(`INSERT INTO finance_recurring_runs (id, business_id, template_id, period_index, period_date) VALUES ($1, $2, $3, 999, $4)`, [pending, A.businessId, t.id, TODAY]);
      await app.query(`UPDATE finance_recurring_runs SET status = 'RUNNING', attempts = 1, lease_id = gen_random_uuid(), lease_expires_at = now() + interval '1 minute' WHERE id = $1`, [pending]);
      if (other) {
        expect(await code(`UPDATE finance_recurring_runs SET status = 'GENERATED', document_id = $2, lease_id = NULL, lease_expires_at = NULL, finished_at = now() WHERE id = $1`, [pending, other.id])).toBe('FN033');
      }
      expect(await code(`INSERT INTO finance_recurring_runs (id, business_id, template_id, period_index, period_date, status) VALUES (gen_random_uuid(), $1, $2, 1000, $3, 'GENERATED')`, [A.businessId, t.id, TODAY])).toBe('FN032');
      // The period key is unique.
      expect(await code(`INSERT INTO finance_recurring_runs (id, business_id, template_id, period_index, period_date) VALUES (gen_random_uuid(), $1, $2, 0, $3)`, [A.businessId, t.id, TODAY])).toBe('23505');
    });
  });

  it('system audit entries need a unit of work with no session user and a finance.system action', async () => {
    const write = async (userId: string | null, actor: string | null, action: string) => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)`, [A.businessId, userId ?? '']);
        await app.query(`INSERT INTO audit_events (id, business_id, actor_user_id, action, target_type, target_id) VALUES (gen_random_uuid(), $1, $2, $3, 'x', gen_random_uuid())`, [A.businessId, actor, action]);
        return 'ok';
      } catch (e) {
        return (e as { code?: string }).code;
      } finally {
        await app.query('ROLLBACK');
      }
    };
    expect(await write(null, null, 'finance.system.recurring.generated')).toBe('ok');
    expect(await write(A.people.OWNER!.id, null, 'finance.system.recurring.generated')).toBe('42501');
    expect(await write(null, null, 'finance.document.issued')).toBe('42501');
    expect(await write(null, null, 'members.role_changed')).toBe('42501');
  });

  it('the due-business function returns ids only, is callable only by bos_app, and reads no other column', async () => {
    const own = api(A.people.OWNER!, A.slug);
    await own.create(template({ startDate: TODAY, name: 'Due' }));
    const due = (await app.query('SELECT * FROM app_private.finance_billing_due(500)')).rows;
    expect(Object.keys(due[0] ?? { business_id: 1 })).toEqual(['business_id']);
    expect(due.map((r) => r.business_id)).toContain(A.businessId);
    const fn = (await admin.query(`SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app_private' AND p.proname = 'finance_billing_due'`)).rows[0];
    expect(fn).toMatchObject({ prosecdef: true, owner: 'bos_definer' });
    expect(fn.acl).toContain('bos_app=X');
    expect(fn.acl).not.toMatch(/(^|[{,])=X/); // not PUBLIC
    // The function's join to businesses relies on 001_trusted_paths.sql (002 refuses to apply without it).
    const biz = (await admin.query(`SELECT has_column_privilege('bos_definer', 'public.businesses', 'id', 'SELECT') AS id_read,
        has_column_privilege('bos_definer', 'public.businesses', 'country_code', 'SELECT') AS other_read,
        EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'businesses' AND policyname = 'definer_business_read') AS policy`)).rows[0];
    expect(biz).toEqual({ id_read: true, other_read: false, policy: true });
    const cols = (await admin.query(`SELECT table_name, column_name FROM information_schema.column_privileges WHERE grantee = 'bos_definer' AND table_name LIKE 'finance_recurring_%' ORDER BY 1, 2`)).rows;
    expect(cols.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      'finance_recurring_runs.business_id', 'finance_recurring_runs.lease_expires_at', 'finance_recurring_runs.run_after', 'finance_recurring_runs.status',
      'finance_recurring_runs.template_id', 'finance_recurring_templates.business_id', 'finance_recurring_templates.id', 'finance_recurring_templates.next_run_on',
      'finance_recurring_templates.status', 'finance_recurring_templates.time_zone',
    ]);
    await pass();
  });
});

describe('large backlogs', () => {
  it('plans a big backlog in bounded batches, each its own short transaction, and plans every period exactly once', async () => {
    const C = await team('bc');
    const own = api(C.people.OWNER!, C.slug);
    const cust = (await own.createCustomer({ displayName: 'Backlog customer' })).body.customer.id;
    const count = 2 * TEMPLATES_PER_PLAN_BATCH + 5;
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const res = await own.create({ name: `Backlog ${i}`, customerId: cust, frequency: 'MONTHLY', startDate: addCalendarMonths(TODAY, -15), lines: [line('10.00')] });
      expect(res.status).toBe(201);
      ids.push(res.body.recurringInvoice.id);
    }
    const summary = await runBillingPass({ deadlineMs: 30_000, runsPerBusiness: 0 });
    expect(summary.businessErrors).toBe(0);
    expect(summary.planBatches).toBeGreaterThanOrEqual(3);
    const rows = (await admin.query(`SELECT template_id, count(*)::int AS n, count(DISTINCT period_index)::int AS d, min(period_index) AS lo, max(period_index) AS hi
      FROM finance_recurring_runs WHERE business_id = $1 GROUP BY 1`, [C.businessId])).rows;
    expect(rows.length).toBe(count);
    for (const r of rows) expect([r.n, r.d, r.lo, r.hi]).toEqual([12, 12, 0, 11]); // 12 per pass (D-F6-5), no duplicates
    expect((await admin.query('SELECT count(*)::int AS n FROM finance_documents WHERE business_id = $1', [C.businessId])).rows[0].n).toBe(0);
    // One planning call never takes more than its batch, and says whether more is waiting (each
    // template still has 4 of its 16 due periods left after the 12 of this pass).
    const next = await withTenant({ businessId: C.businessId, userId: null }, (db) => planDueRuns(db, { templateLimit: 3 }));
    expect(next).toMatchObject({ planned: 12, more: true });

    // The due function finds the business while work is waiting; an archived business is never listed.
    expect((await app.query('SELECT business_id FROM app_private.finance_billing_due(500)')).rows.map((r) => r.business_id)).toContain(C.businessId);
    await admin.query('UPDATE businesses SET archived_at = now() WHERE id = $1', [C.businessId]);
    try {
      expect((await app.query('SELECT business_id FROM app_private.finance_billing_due(500)')).rows.map((r) => r.business_id)).not.toContain(C.businessId);
    } finally {
      await admin.query('UPDATE businesses SET archived_at = NULL WHERE id = $1', [C.businessId]);
    }
    // Leave nothing for later passes in this file.
    for (const id of ids) expect((await own.pause(id, 1)).status).toBe(200);
    expect((await admin.query(`SELECT count(*)::int AS n FROM finance_recurring_runs WHERE business_id = $1 AND status <> 'SKIPPED'`, [C.businessId])).rows[0].n).toBe(0);
  }, 180_000);
});

describe('the cron entry point', () => {
  it('refuses without the configured secret and runs a pass with it', async () => {
    const call = (auth?: string) => jobRoute.GET(new Request(`${BASE}/api/internal/jobs/finance-billing`, { headers: auth ? { authorization: auth } : {} }));
    const { getEnv } = await import('@/core/config/env');
    const env = getEnv() as { CRON_SECRET?: string };
    const saved = env.CRON_SECRET;
    try {
      env.CRON_SECRET = undefined;
      expect((await call('Bearer anything')).status).toBe(503);
      env.CRON_SECRET = 'x'.repeat(40);
      expect((await call()).status).toBe(401);
      expect((await call(`Bearer ${'y'.repeat(40)}`)).status).toBe(401);
      const ok = await call(`Bearer ${'x'.repeat(40)}`);
      expect(ok.status).toBe(200);
      const body = await ok.json();
      expect(Object.keys(body.summary).sort()).toEqual(['businessErrors', 'businesses', 'ended', 'failed', 'generated', 'leaseLost', 'planBatches', 'planned', 'retrying', 'skipped', 'stoppedAtDeadline']);
      expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no ids leave the job
    } finally {
      env.CRON_SECRET = saved;
    }
  });
});
