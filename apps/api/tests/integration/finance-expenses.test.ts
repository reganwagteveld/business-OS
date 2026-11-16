import { inviteForSignup, admitFixture } from './support/admission';
/**
 * Finance Zone F3 (docs/finance-data-model.md §19): expense categories, expenses, tax treatments,
 * payments made against expenses (direction PAID in the F2 payments ledger) and
 * payables, through the real route handlers against PostgreSQL with the migrations applied as in
 * production. Database-level checks (guards, counters and races without the services) run through the
 * admin connection and bos_app transactions at the end of the file (X1–X6).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Permission, Role } from '@/modules/access';

const custom: Partial<Record<Role, Permission[]>> = {};
vi.mock('@/modules/access', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/access')>();
  return { ...real, permissionsFor: (role: Role) => custom[role] ?? real.permissionsFor(role) };
});
const auditFailure = { action: null as string | null };
vi.mock('@/core/audit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/core/audit')>();
  return {
    ...real,
    recordAudit: async (...args: Parameters<typeof real.recordAudit>) => {
      if (auditFailure.action && args[2] === auditFailure.action) throw new Error('audit store unavailable');
      return real.recordAudit(...args);
    },
  };
});

import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as customersRoute from '@/app/api/v1/b/[slug]/customers/route';
import * as customerRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/route';
import * as projectsRoute from '@/app/api/v1/b/[slug]/projects/route';
import * as projectArchive from '@/app/api/v1/b/[slug]/projects/[projectId]/archive/route';
import * as taxRatesRoute from '@/app/api/v1/b/[slug]/finance/tax-rates/route';
import * as taxRateRoute from '@/app/api/v1/b/[slug]/finance/tax-rates/[taxRateId]/route';
import * as categoriesRoute from '@/app/api/v1/b/[slug]/finance/expense-categories/route';
import * as categoryRoute from '@/app/api/v1/b/[slug]/finance/expense-categories/[categoryId]/route';
import * as expensesRoute from '@/app/api/v1/b/[slug]/finance/expenses/route';
import * as expenseRoute from '@/app/api/v1/b/[slug]/finance/expenses/[expenseId]/route';
import * as expenseRecord from '@/app/api/v1/b/[slug]/finance/expenses/[expenseId]/record/route';
import * as expenseVoid from '@/app/api/v1/b/[slug]/finance/expenses/[expenseId]/void/route';
import * as payablesRoute from '@/app/api/v1/b/[slug]/finance/expense-payables/route';
import * as xPaymentsRoute from '@/app/api/v1/b/[slug]/finance/expense-payments/route';
import * as xPaymentRoute from '@/app/api/v1/b/[slug]/finance/expense-payments/[paymentId]/route';
import * as xAllocationsRoute from '@/app/api/v1/b/[slug]/finance/expense-payments/[paymentId]/allocations/route';
import * as xAllocationReverse from '@/app/api/v1/b/[slug]/finance/expense-payments/[paymentId]/allocations/[allocationId]/reverse/route';
import * as xPaymentReverse from '@/app/api/v1/b/[slug]/finance/expense-payments/[paymentId]/reverse/route';
import * as paymentsRoute from '@/app/api/v1/b/[slug]/finance/payments/route';
import * as paymentRoute from '@/app/api/v1/b/[slug]/finance/payments/[paymentId]/route';
import * as rAllocationsRoute from '@/app/api/v1/b/[slug]/finance/payments/[paymentId]/allocations/route';
import * as rPaymentReverse from '@/app/api/v1/b/[slug]/finance/payments/[paymentId]/reverse/route';
import * as invoicesRoute from '@/app/api/v1/b/[slug]/finance/invoices/route';
import * as invoiceIssue from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/issue/route';
import * as balancesRoute from '@/app/api/v1/b/[slug]/finance/customer-balances/route';
import * as reconciliationRoute from '@/app/api/v1/b/[slug]/finance/reconciliation/route';
import { devOutbox } from '@/core/email';
import { DEFAULT_CATEGORIES } from '@/modules/finance';

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
  auditFailure.action = null;
});

// A separate address range from the other suites, so rate-limit counters do not collide.
let ip = 1;
// A different block when the suite runs a second time on the same database (CI, behind PgBouncer).
const IP_BLOCK = Number(process.env.FINANCE_TEST_IP_BLOCK_F3 ?? 83);
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
async function team(label: string, currency = 'AUD') {
  const owner = await newUser(`${label}-owner`);
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const created = await businessesRoute.POST(req('POST', '/api/v1/businesses', {
    cookie: owner.cookie, body: { name: `Business ${label}`, slug, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency },
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
type Ctx = ReturnType<typeof ctx>;
type Handler = (r: Request, c: Ctx) => Promise<Response>;

const api = (who: User, slug: string) => {
  const F = `/api/v1/b/${slug}/finance`;
  const call = (h: Handler, method: string, path: string, c: Ctx, body?: unknown, headers?: Record<string, string>) =>
    h(req(method, `${F}${path}`, { cookie: who.cookie, body, headers }), c).then(json);
  const e = (expenseId: string) => ctx({ slug, expenseId });
  const p = (paymentId: string) => ctx({ slug, paymentId });
  return {
    categories: (qs = '') => call(categoriesRoute.GET, 'GET', `/expense-categories${qs}`, ctx({ slug })),
    createCategory: (body: unknown) => call(categoriesRoute.POST, 'POST', '/expense-categories', ctx({ slug }), body),
    patchCategory: (categoryId: string, body: unknown) => call(categoryRoute.PATCH, 'PATCH', `/expense-categories/${categoryId}`, ctx({ slug, categoryId }), body),
    list: (qs = '') => call(expensesRoute.GET, 'GET', `/expenses${qs}`, ctx({ slug })),
    create: (body: unknown) => call(expensesRoute.POST, 'POST', '/expenses', ctx({ slug }), body),
    get: (id: string) => call(expenseRoute.GET, 'GET', `/expenses/${id}`, e(id)),
    patch: (id: string, body: unknown) => call(expenseRoute.PATCH, 'PATCH', `/expenses/${id}`, e(id), body),
    record: (id: string, body: unknown) => call(expenseRecord.POST, 'POST', `/expenses/${id}/record`, e(id), body),
    void: (id: string, body: unknown) => call(expenseVoid.POST, 'POST', `/expenses/${id}/void`, e(id), body),
    payables: () => call(payablesRoute.GET, 'GET', '/expense-payables', ctx({ slug })),
    pay: (body: unknown, key: string | null = `xp-${randomUUID()}`) =>
      call(xPaymentsRoute.POST, 'POST', '/expense-payments', ctx({ slug }), body, key === null ? undefined : { 'idempotency-key': key }),
    payments: (qs = '') => call(xPaymentsRoute.GET, 'GET', `/expense-payments${qs}`, ctx({ slug })),
    payment: (paymentId: string) => call(xPaymentRoute.GET, 'GET', `/expense-payments/${paymentId}`, p(paymentId)),
    allocate: (paymentId: string, allocations: { expenseId: string; amount: string }[]) =>
      call(xAllocationsRoute.POST, 'POST', `/expense-payments/${paymentId}/allocations`, p(paymentId), { allocations }),
    unallocate: (paymentId: string, allocationId: string) =>
      call(xAllocationReverse.POST, 'POST', `/expense-payments/${paymentId}/allocations/${allocationId}/reverse`, ctx({ slug, paymentId, allocationId }), {}),
    reversePayment: (paymentId: string, body: unknown) => call(xPaymentReverse.POST, 'POST', `/expense-payments/${paymentId}/reverse`, p(paymentId), body),
    receivedPayments: () => call(paymentsRoute.GET, 'GET', '/payments', ctx({ slug })),
    receivedPayment: (paymentId: string) => call(paymentRoute.GET, 'GET', `/payments/${paymentId}`, p(paymentId)),
    receive: (body: unknown) => call(paymentsRoute.POST, 'POST', '/payments', ctx({ slug }), body, { 'idempotency-key': `rp-${randomUUID()}` }),
    allocateReceived: (paymentId: string, allocations: unknown) => call(rAllocationsRoute.POST, 'POST', `/payments/${paymentId}/allocations`, p(paymentId), { allocations }),
    reverseReceived: (paymentId: string, body: unknown) => call(rPaymentReverse.POST, 'POST', `/payments/${paymentId}/reverse`, p(paymentId), body),
    createInvoice: (body: unknown) => call(invoicesRoute.POST, 'POST', '/invoices', ctx({ slug }), body),
    issueInvoice: (documentId: string, body: unknown) => call(invoiceIssue.POST, 'POST', `/invoices/${documentId}/issue`, ctx({ slug, documentId }), body),
    balances: () => call(balancesRoute.GET, 'GET', '/customer-balances', ctx({ slug })),
    reconcile: () => call(reconciliationRoute.GET, 'GET', '/reconciliation', ctx({ slug })),
    createTaxRate: (body: unknown) => call(taxRatesRoute.POST, 'POST', '/tax-rates', ctx({ slug }), body),
    patchTaxRate: (taxRateId: string, body: unknown) => call(taxRateRoute.PATCH, 'PATCH', `/tax-rates/${taxRateId}`, ctx({ slug, taxRateId }), body),
    createCustomer: (body: unknown) => customersRoute.POST(req('POST', `/api/v1/b/${slug}/customers`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    archiveCustomer: (customerId: string, version: number) =>
      customerRoute.PATCH(req('PATCH', `/api/v1/b/${slug}/customers/${customerId}`, { cookie: who.cookie, body: { version, archived: true } }), ctx({ slug, customerId })).then(json),
    createProject: (body: unknown) => projectsRoute.POST(req('POST', `/api/v1/b/${slug}/projects`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    archiveProject: (projectId: string) => projectArchive.POST(req('POST', `/api/v1/b/${slug}/projects/${projectId}/archive`, { cookie: who.cookie }), ctx({ slug, projectId })).then(json),
  };
};
const audits = async (targetId: string) =>
  (await admin.query('SELECT action, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows;

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let own: ReturnType<typeof api>;
let gst: string; // A's 10% rate
let travel: string; // A's seeded "travel" category
const DAY = '2026-03-02';

beforeAll(async () => {
  A = await team('fx-a');
  B = await team('fx-b');
  own = api(A.people.OWNER!, A.slug);
  gst = (await own.createTaxRate({ name: 'GST', ratePercent: '10' })).body.taxRate.id;
  travel = (await own.categories()).body.categories.find((c: { systemKey: string }) => c.systemKey === 'travel').id;
}, 120_000);

/** A draft in A: by default 110.00 including 10% tax. */
async function draft(o: Record<string, unknown> = {}, who = own) {
  const res = await who.create({ categoryId: travel, description: 'Flights', supplierName: 'Air Co', incurredOn: DAY, taxTreatment: 'TAX_INCLUSIVE', taxRateId: gst, amount: '110', ...o });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.expense;
}
async function recorded(o: Record<string, unknown> = {}) {
  const d = await draft(o);
  const res = await own.record(d.id, { version: d.version });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.expense;
}
const payment = { paidOn: DAY, method: 'BANK_TRANSFER' };

describe('categories', () => {
  it('seeds the defaults once per business, idempotently, even under concurrent first use', async () => {
    const C = await team('fx-c');
    const c = api(C.people.OWNER!, C.slug);
    const lists = await Promise.all(Array.from({ length: 8 }, () => c.categories()));
    for (const l of lists) expect(l.status).toBe(200);
    const { rows } = await admin.query('SELECT system_key FROM finance_expense_categories WHERE business_id = $1 ORDER BY position', [C.businessId]);
    expect(rows.map((r) => r.system_key)).toEqual(DEFAULT_CATEGORIES.map((d) => d.key));
    // A renamed or archived default is never recreated.
    const first = (await c.categories()).body.categories[0];
    expect((await c.patchCategory(first.id, { version: first.version, name: 'Marketing', archived: true })).status).toBe(200);
    await c.categories();
    await c.categories('?archived=all');
    expect(Number((await admin.query('SELECT count(*) FROM finance_expense_categories WHERE business_id = $1', [C.businessId])).rows[0].count)).toBe(DEFAULT_CATEGORIES.length);
  });

  it('creates, renames, reorders, archives and restores; names are unique among active categories; no deletion', async () => {
    const made = await own.createCategory({ name: 'Training' });
    expect(made.status).toBe(201);
    expect(made.body.category).toMatchObject({ name: 'Training', systemKey: null, archivedAt: null, version: 1 });
    expect((await own.createCategory({ name: '  training ' })).body.error).toBe('duplicate_name');
    expect((await own.createCategory({ name: 'Travel and accommodation' })).body.error).toBe('duplicate_name');
    const id = made.body.category.id;
    const renamed = await own.patchCategory(id, { version: 1, name: 'Courses', position: 5 });
    expect(renamed.body.category).toMatchObject({ name: 'Courses', position: 5, version: 2 });
    expect((await own.categories()).body.categories[0].id).toBe(id); // ordered by position
    expect((await own.patchCategory(id, { version: 1, name: 'Stale' })).body.error).toBe('stale');
    const archived = await own.patchCategory(id, { version: 2, archived: true });
    expect(archived.body.category.archivedAt).not.toBeNull();
    expect((await own.categories()).body.categories.some((c: { id: string }) => c.id === id)).toBe(false);
    expect((await own.categories('?archived=archived')).body.categories.map((c: { id: string }) => c.id)).toContain(id);
    // An archived name may be reused; restoring a category whose name is now taken is refused.
    const again = await own.createCategory({ name: 'Courses' });
    expect(again.status).toBe(201);
    expect((await own.patchCategory(id, { version: 3, archived: false })).body.error).toBe('duplicate_name');
    // Defaults are editable like any category.
    const office = (await own.categories()).body.categories.find((c: { systemKey: string }) => c.systemKey === 'office');
    expect((await own.patchCategory(office.id, { version: office.version, name: 'Office and admin' })).status).toBe(200);
    // bos_app has no DELETE on categories (referential protection), and system_key is fixed.
    const grants = await admin.query(`SELECT has_table_privilege('bos_app', 'finance_expense_categories', 'DELETE') AS del,
      has_column_privilege('bos_app', 'finance_expense_categories', 'system_key', 'UPDATE') AS key`);
    expect(grants.rows[0]).toEqual({ del: false, key: false });
    const events = await audits(id);
    expect(events.map((e) => e.metadata.setting)).toEqual(['expense_category', 'expense_category', 'expense_category']);
  });

  it('an archived category cannot be newly used or recorded into, and recorded expenses keep its name', async () => {
    const cat = (await own.createCategory({ name: `Temp ${randomUUID().slice(0, 6)}` })).body.category;
    const d = await draft({ categoryId: cat.id });
    const r = await recorded({ categoryId: cat.id });
    const archived = (await own.patchCategory(cat.id, { version: 1, archived: true, name: 'Temp renamed' })).body.category;
    expect(archived.archivedAt).not.toBeNull();
    expect((await own.create({ categoryId: cat.id, description: 'x', incurredOn: DAY, taxTreatment: 'NO_TAX', amount: '1' })).body.error).toBe('archived_reference');
    expect((await own.record(d.id, { version: d.version })).body.error).toBe('archived_reference');
    expect((await own.get(r.id)).body.expense.categoryName).toBe(cat.name);
  });
});

describe('amounts and tax', () => {
  it('computes subtotal, tax and total exactly for each treatment, rounding the tax half away from zero', async () => {
    const none = await draft({ taxTreatment: 'NO_TAX', taxRateId: null, amount: '45.5' });
    expect(none).toMatchObject({ subtotal: '45.50', taxAmount: '0.00', total: '45.50', taxRateId: null, taxName: null, taxRatePercent: '0' });
    const incl = await draft({ amount: '0.55' }); // 0.55 × 10 / 110 = 0.05
    expect(incl).toMatchObject({ subtotal: '0.50', taxAmount: '0.05', total: '0.55', taxName: 'GST', taxRatePercent: '10' });
    const half = await draft({ taxTreatment: 'TAX_EXCLUSIVE', amount: '0.05' }); // 0.005 rounds away from zero to 0.01
    expect(half).toMatchObject({ subtotal: '0.05', taxAmount: '0.01', total: '0.06' });
    const odd = (await own.createTaxRate({ name: 'Odd', ratePercent: '8.875' })).body.taxRate.id;
    const x = await draft({ taxTreatment: 'TAX_EXCLUSIVE', taxRateId: odd, amount: '19.99' }); // 1.7741125 -> 1.77
    expect(x).toMatchObject({ subtotal: '19.99', taxAmount: '1.77', total: '21.76' });
    const y = await draft({ taxTreatment: 'TAX_INCLUSIVE', taxRateId: odd, amount: '100' }); // 8.1515… -> 8.15
    expect(y).toMatchObject({ subtotal: '91.85', taxAmount: '8.15', total: '100.00' });
    // Zero-decimal currency.
    const yen = await draft({ currencyCode: 'JPY', amount: '1100' });
    expect(yen).toMatchObject({ currencyScale: 0, subtotal: '1000', taxAmount: '100', total: '1100' });
    expect((await own.create({ categoryId: travel, description: 'x', incurredOn: DAY, currencyCode: 'JPY', taxTreatment: 'NO_TAX', amount: '1.5' })).body.error).toBe('invalid_amount');
  });

  it('refuses negative, zero, over-precise and JSON-number amounts, missing or stray tax rates, bad dates and unknown fields', async () => {
    const base = { categoryId: travel, description: 'x', incurredOn: DAY, taxTreatment: 'NO_TAX', amount: '10' };
    expect((await own.create({ ...base, amount: '-1' })).body.error).toBe('invalid_input');
    expect((await own.create({ ...base, amount: 10 })).body.error).toBe('invalid_input');
    expect((await own.create({ ...base, amount: '0' })).body.error).toBe('invalid_amount');
    expect((await own.create({ ...base, amount: '1.001' })).body.error).toBe('invalid_amount');
    expect((await own.create({ ...base, taxTreatment: 'TAX_INCLUSIVE' })).body.error).toBe('tax_rate_required');
    expect((await own.create({ ...base, taxRateId: gst })).body.error).toBe('invalid_tax_rate');
    expect((await own.create({ ...base, taxTreatment: 'GST_10' })).body.error).toBe('invalid_input');
    expect((await own.create({ ...base, incurredOn: '2999-01-01' })).body.error).toBe('invalid_dates');
    expect((await own.create({ ...base, dueDate: '2026-03-01' })).body.error).toBe('invalid_dates');
    for (const extra of [{ total: '10' }, { taxAmount: '1' }, { paidTotal: '10' }, { status: 'RECORDED' }, { businessId: B.businessId }, { taxRatePercent: '50' }]) {
      expect((await own.create({ ...base, ...extra })).body.error, JSON.stringify(extra)).toBe('invalid_input');
    }
    // An archived tax rate cannot be newly used.
    const old = (await own.createTaxRate({ name: 'Old', ratePercent: '5' })).body.taxRate.id;
    await own.patchTaxRate(old, { archived: true });
    expect((await own.create({ ...base, taxTreatment: 'TAX_EXCLUSIVE', taxRateId: old })).body.error).toBe('archived_reference');
  });

  it('the database checks the split itself: a forged tax amount, percentage or subtotal is refused', async () => {
    const d = await draft();
    const tx = async (sql: string) => {
      const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.business_id', $1, true)`, [A.businessId]);
        await c.query(sql, [d.id]);
        await c.query('ROLLBACK');
        return 'ok';
      } catch (error) {
        await c.query('ROLLBACK').catch(() => undefined);
        return (error as { code?: string }).code;
      } finally {
        await c.end();
      }
    };
    expect(await tx(`UPDATE finance_expenses SET tax_amount = 11, subtotal = 99 WHERE id = $1`)).toBe('23514');
    expect(await tx(`UPDATE finance_expenses SET subtotal = 101 WHERE id = $1`)).toBe('23514');
    expect(await tx(`UPDATE finance_expenses SET tax_rate_percent = 20 WHERE id = $1`)).toBe('ok'); // overwritten by the rate's own value
    expect(await tx(`UPDATE finance_expenses SET paid_total = 1 WHERE id = $1`)).toBe('FN010');
    expect(await tx(`UPDATE finance_expenses SET tax_treatment = 'NO_TAX' WHERE id = $1`)).toBe('23514');
  });
});

describe('lifecycle', () => {
  it('drafts are editable with optimistic versions; recording freezes everything; void needs a reason; discards and voids are final', async () => {
    const d = await draft({ referenceNumber: 'INV-77', notes: 'Q1 trip', dueDate: '2026-04-01' });
    expect(d).toMatchObject({ status: 'DRAFT', paymentState: null, categoryName: null, outstanding: '0.00', overdue: false });
    const edited = await own.patch(d.id, { version: 1, amount: '220', supplierName: 'Air Two' });
    expect(edited.body.expense).toMatchObject({ total: '220.00', taxAmount: '20.00', supplierName: 'Air Two', version: 2 });
    expect((await own.patch(d.id, { version: 1, amount: '1' })).body.error).toBe('stale');
    // Switching treatment keeps the entered figure: 220 becomes the subtotal.
    expect((await own.patch(d.id, { version: 2, taxTreatment: 'TAX_EXCLUSIVE' })).body.expense).toMatchObject({ subtotal: '220.00', total: '242.00' });
    const rec = await own.record(d.id, { version: 3 });
    expect(rec.body.expense).toMatchObject({ status: 'RECORDED', categoryName: 'Travel and accommodation', paymentState: 'UNPAID', outstanding: '242.00' });
    expect(rec.body.expense.recordedById).toBe(A.people.OWNER!.id);
    expect((await own.patch(d.id, { version: 4, description: 'Changed' })).body.error).toBe('invalid_state');
    expect((await own.record(d.id, { version: 4 })).body.error).toBe('invalid_state');
    expect((await own.void(d.id, { version: 4 })).body.error).toBe('reason_required');
    const voided = await own.void(d.id, { version: 4, reason: 'Entered twice' });
    expect(voided.body.expense).toMatchObject({ status: 'VOID', voidReason: 'Entered twice', paymentState: null, outstanding: '0.00' });
    expect((await own.void(d.id, { version: 5, reason: 'again' })).body.error).toBe('invalid_state');
    const discard = await draft();
    expect((await own.void(discard.id, { version: 1 })).body.expense).toMatchObject({ status: 'VOID', recordedAt: null, categoryName: null });
    expect((await audits(d.id)).map((a) => a.action)).toEqual(['finance.expense.created', 'finance.expense.updated', 'finance.expense.updated', 'finance.expense.recorded', 'finance.expense.voided']);
    // No free text in audit metadata.
    expect(JSON.stringify(await audits(d.id))).not.toMatch(/Entered twice|Q1 trip|Air/);
  });

  it('a recording and its audit entry commit together or not at all', async () => {
    const d = await draft();
    auditFailure.action = 'finance.expense.recorded';
    expect((await own.record(d.id, { version: 1 })).status).toBe(500);
    auditFailure.action = null;
    expect((await own.get(d.id)).body.expense.status).toBe('DRAFT');
  });
});

describe('payments made', () => {
  it('derives unpaid, partially paid, paid and overdue from allocations; payables exclude drafts and voids', async () => {
    const C = await team('fx-pay');
    const c = api(C.people.OWNER!, C.slug);
    const cat = (await c.categories()).body.categories[0].id;
    const mk = async (amount: string, dueDate?: string) => {
      const d = (await c.create({ categoryId: cat, description: 'Bill', incurredOn: '2026-01-05', taxTreatment: 'NO_TAX', amount, dueDate })).body.expense;
      return (await c.record(d.id, { version: 1 })).body.expense;
    };
    const overdue = await mk('100', '2026-02-01');
    const later = await mk('50', '2099-01-01');
    await c.create({ categoryId: cat, description: 'Draft', incurredOn: '2026-01-05', taxTreatment: 'NO_TAX', amount: '999' });
    const v = await mk('70');
    await c.void(v.id, { version: v.version, reason: 'Wrong' });
    expect((await c.get(overdue.id)).body.expense).toMatchObject({ paymentState: 'UNPAID', overdue: true });
    expect((await c.payables()).body.payables.currencies).toEqual([
      { currencyCode: 'AUD', currencyScale: 2, outstanding: '150.00', overdue: '100.00', openCount: 2, overdueCount: 1 },
    ]);
    const paid = await c.pay({ payeeName: 'Supplier', amount: '120', ...payment, allocations: [{ expenseId: overdue.id, amount: '40' }, { expenseId: later.id, amount: '50' }] });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.payment).toMatchObject({ allocatedTotal: '90.00', unallocatedAmount: '30.00', status: 'RECORDED', payeeName: 'Supplier' });
    expect((await c.get(overdue.id)).body.expense).toMatchObject({ paymentState: 'PARTIALLY_PAID', paidTotal: '40.00', outstanding: '60.00', overdue: true });
    expect((await c.get(later.id)).body.expense).toMatchObject({ paymentState: 'PAID', outstanding: '0.00', overdue: false });
    await c.allocate(paid.body.payment.id, [{ expenseId: overdue.id, amount: '30' }]).then((r) => expect(r.body.error).toBe('already_allocated'));
    const second = await c.pay({ amount: '60', ...payment, allocations: [{ expenseId: overdue.id, amount: '60' }] });
    expect(second.status).toBe(201);
    expect((await c.get(overdue.id)).body.expense).toMatchObject({ paymentState: 'PAID', overdue: false });
    expect((await c.payables()).body.payables.currencies).toEqual([]);
    // List filters on the derived state.
    const ids = async (qs: string) => (await c.list(qs)).body.expenses.map((x: { id: string }) => x.id).sort();
    expect(await ids('?payment=paid')).toEqual([overdue.id, later.id].sort());
    expect(await ids('?payment=open')).toEqual([]);
    expect((await c.list('?status=draft')).body.expenses).toHaveLength(1);
    expect((await c.list('?status=void')).body.expenses).toHaveLength(1);
    // Payments made never appear among payments received, customer balances or another direction's routes.
    expect((await c.receivedPayments()).body.payments).toEqual([]);
    expect((await c.receivedPayment(second.body.payment.id)).status).toBe(404);
    expect((await c.balances()).body.balances).toEqual([]);
    expect((await c.reconcile()).body.report.ok).toBe(true);
  });

  it('refuses over-payment, over-allocation, drafts, voids, other currencies and other businesses\' expenses', async () => {
    const e = await recorded({ amount: '100', taxTreatment: 'NO_TAX', taxRateId: null });
    const d = await draft();
    const pay = (await own.pay({ amount: '500', ...payment })).body.payment;
    expect((await own.allocate(pay.id, [{ expenseId: e.id, amount: '100.01' }])).body.error).toBe('over_payment');
    expect((await own.allocate(pay.id, [{ expenseId: d.id, amount: '1' }])).body.error).toBe('expense_not_open');
    const small = (await own.pay({ amount: '10', ...payment })).body.payment;
    expect((await own.allocate(small.id, [{ expenseId: e.id, amount: '10.01' }])).body.error).toBe('over_allocation');
    const eur = (await own.pay({ amount: '10', currencyCode: 'EUR', ...payment })).body.payment;
    expect((await own.allocate(eur.id, [{ expenseId: e.id, amount: '1' }])).body.error).toBe('currency_mismatch');
    const bExpense = await (async () => {
      const b = api(B.people.OWNER!, B.slug);
      const cat = (await b.categories()).body.categories[0].id;
      const x = (await b.create({ categoryId: cat, description: 'B', incurredOn: DAY, taxTreatment: 'NO_TAX', amount: '5' })).body.expense;
      return (await b.record(x.id, { version: 1 })).body.expense;
    })();
    expect((await own.allocate(pay.id, [{ expenseId: bExpense.id, amount: '1' }])).body.error).toBe('invalid_expense');
    expect((await own.pay({ amount: '1', ...payment, paidOn: '2999-01-01' })).body.error).toBe('invalid_dates');
    expect((await own.pay({ amount: '1', ...payment }, null)).body.error).toBe('idempotency_key_required');
    // A voided expense with a live payment cannot be voided until the allocation is reversed; history is kept.
    const paid = (await own.allocate(pay.id, [{ expenseId: e.id, amount: '60' }])).body.payment;
    expect((await own.void(e.id, { version: 2, reason: 'x' })).body.error).toBe('has_payments');
    const alloc = paid.allocations.find((a: { expenseId: string }) => a.expenseId === e.id);
    expect((await own.unallocate(pay.id, alloc.id)).body.payment.allocatedTotal).toBe('0.00');
    expect((await own.unallocate(pay.id, alloc.id)).body.error).toBe('already_reversed');
    const after = (await own.get(e.id)).body.expense;
    expect(after).toMatchObject({ paidTotal: '0.00', paymentState: 'UNPAID' });
    expect(after.allocations).toHaveLength(1);
    expect(after.allocations[0].reversedAt).not.toBeNull();
    expect((await own.void(e.id, { version: after.version, reason: 'Duplicate bill' })).body.expense.status).toBe('VOID');
    // A void expense cannot be paid.
    expect((await own.allocate(pay.id, [{ expenseId: e.id, amount: '1' }])).body.error).toBe('expense_not_open');
  });

  it('records and pays in full atomically; needs finance:payments too', async () => {
    const d = await draft({ amount: '33' });
    const res = await own.record(d.id, { version: 1, paidInFull: { ...payment, reference: 'card ending' } });
    expect(res.body.expense).toMatchObject({ status: 'RECORDED', paymentState: 'PAID', paidTotal: '33.00' });
    expect(res.body.expense.allocations).toHaveLength(1);
    const mgr = api(A.people.MANAGER!, A.slug);
    const m = await draft({}, mgr);
    expect((await mgr.record(m.id, { version: 1, paidInFull: payment })).status).toBe(403);
    expect((await mgr.get(m.id)).body.expense.status).toBe('DRAFT'); // nothing written
    expect((await mgr.record(m.id, { version: 1 })).body.expense.paymentState).toBe('UNPAID');
    // If the payment's audit fails, the recording rolls back too.
    const d2 = await draft();
    auditFailure.action = 'finance.expense_allocation.created';
    expect((await own.record(d2.id, { version: 1, paidInFull: payment })).status).toBe(500);
    auditFailure.action = null;
    expect((await own.get(d2.id)).body.expense).toMatchObject({ status: 'DRAFT', paidTotal: '0.00' });
  });

  it('reversing a payment reverses its allocations first, atomically, with a reason; idempotent recording', async () => {
    const e1 = await recorded({ amount: '20' });
    const e2 = await recorded({ amount: '30' });
    const key = `xp-${randomUUID()}`;
    const body = { amount: '50', ...payment, allocations: [{ expenseId: e1.id, amount: '20' }, { expenseId: e2.id, amount: '30' }] };
    const first = await own.pay(body, key);
    expect(first.status).toBe(201);
    expect((await own.pay(body, key)).status).toBe(200);
    expect((await own.pay({ ...body, amount: '51' }, key)).body.error).toBe('idempotency_conflict');
    const id = first.body.payment.id;
    expect((await own.reversePayment(id, { version: 1 })).body.error).toBe('invalid_input');
    auditFailure.action = 'finance.payment.reversed';
    expect((await own.reversePayment(id, { version: 1, reason: 'Bounced' })).status).toBe(500);
    auditFailure.action = null;
    expect((await own.payment(id)).body.payment.allocations.every((a: { reversedAt: string | null }) => a.reversedAt === null)).toBe(true);
    const rev = await own.reversePayment(id, { version: 1, reason: 'Bounced' });
    expect(rev.body.payment).toMatchObject({ status: 'REVERSED', allocatedTotal: '0.00', reversalReason: 'Bounced' });
    expect(rev.body.payment.allocations.every((a: { reversedAt: string | null }) => a.reversedAt !== null)).toBe(true);
    expect((await own.get(e1.id)).body.expense.paymentState).toBe('UNPAID');
    expect((await own.reversePayment(id, { version: 2, reason: 'again' })).body.error).toBe('invalid_state');
    expect((await own.payments(`?expenseId=${e1.id}`)).body.payments).toEqual([]);
    expect((await own.payments('?status=reversed')).body.payments.map((p: { id: string }) => p.id)).toContain(id);
  });

  it('races: 12 concurrent 10.00 payments of one 50.00 expense commit exactly 5; a void racing payments never leaves money on a void expense', { timeout: 60_000 }, async () => {
    const e = await recorded({ amount: '50', taxTreatment: 'NO_TAX', taxRateId: null });
    const results = await Promise.all(Array.from({ length: 12 }, () => own.pay({ amount: '10', ...payment, allocations: [{ expenseId: e.id, amount: '10' }] })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    for (const r of results.filter((x) => x.status !== 201)) expect(['over_payment', 'retryable']).toContain(r.body.error);
    expect((await own.get(e.id)).body.expense).toMatchObject({ paidTotal: '50.00', paymentState: 'PAID' });
    for (let i = 0; i < 6; i++) {
      const x = await recorded({ amount: '10', taxTreatment: 'NO_TAX', taxRateId: null });
      const [v, p] = await Promise.all([
        own.void(x.id, { version: x.version, reason: 'race' }),
        own.pay({ amount: '10', ...payment, allocations: [{ expenseId: x.id, amount: '10' }] }),
      ]);
      expect([v.status, p.status].filter((s) => s < 300)).toHaveLength(1);
      const final = (await own.get(x.id)).body.expense;
      expect(final.status === 'VOID' ? final.paidTotal : 'paid').toBe(final.status === 'VOID' ? '0.00' : 'paid');
    }
    expect((await own.reconcile()).body.report.ok).toBe(true);
  });
});

describe('payment direction (F3-D1) and allocation reversal (F3-D3)', () => {
  it('directions never cross: a payment made is invisible to the received-payment routes and cannot settle an invoice; a payment received cannot pay an expense', async () => {
    const cust = (await own.createCustomer({ displayName: `Dir ${randomUUID().slice(0, 4)}` })).body.customer.id;
    const inv = (await own.createInvoice({ customerId: cust, lines: [{ description: 'Work', quantity: '1', unitPrice: '50' }] })).body.document;
    expect((await own.issueInvoice(inv.id, { version: 1, issueDate: '2026-01-01', dueDate: '2099-01-01' })).status).toBe(200);
    const received = (await own.receive({ customerId: cust, amount: '50', receivedOn: DAY, method: 'CASH' })).body.payment;
    const made = (await own.pay({ amount: '50', ...payment })).body.payment;
    const e = await recorded({ amount: '20', taxTreatment: 'NO_TAX', taxRateId: null });
    // Received-payment routes answer 404 for a payment made, and vice versa.
    expect((await own.receivedPayment(made.id)).status).toBe(404);
    expect((await own.allocateReceived(made.id, [{ invoiceId: inv.id, amount: '1' }])).status).toBe(404);
    expect((await own.reverseReceived(made.id, { version: 1, reason: 'x' })).status).toBe(404);
    expect((await own.payment(received.id)).status).toBe(404);
    expect((await own.allocate(received.id, [{ expenseId: e.id, amount: '1' }])).status).toBe(404);
    expect((await own.reversePayment(received.id, { version: 1, reason: 'x' })).status).toBe(404);
    // F2 behaviour is unchanged for the received payment.
    expect((await own.allocateReceived(received.id, [{ invoiceId: inv.id, amount: '50' }])).body.payment.allocatedTotal).toBe('50.00');
    expect((await own.receivedPayments()).body.payments.map((x: { id: string }) => x.id)).toContain(received.id);
    expect((await own.receivedPayments()).body.payments.map((x: { id: string }) => x.id)).not.toContain(made.id);
    // Existing (and new) received payments are RECEIVED; direction is fixed once written.
    const dirs = await admin.query(`SELECT id::text, direction::text FROM finance_payments WHERE id = ANY($1::uuid[])`, [[received.id, made.id]]);
    expect(Object.fromEntries(dirs.rows.map((r) => [r.id, r.direction]))).toEqual({ [received.id]: 'RECEIVED', [made.id]: 'PAID' });
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      for (const [id, dir] of [[made.id, 'RECEIVED'], [received.id, 'PAID']] as const) {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.business_id', $1, true)`, [A.businessId]);
        const out = await c.query(`UPDATE finance_payments SET direction = $2 WHERE id = $1`, [id, dir]).then(() => 'ok', (err: { code?: string }) => err.code);
        await c.query('ROLLBACK');
        expect(out, `${id} -> ${dir}`).toBe('FN001');
      }
    } finally {
      await c.end();
    }
    expect((await own.reconcile()).body.report.ok).toBe(true);
  });

  it('no double-spend: one 30.00 payment made allocated concurrently to six 10.00 expenses commits exactly three', { timeout: 60_000 }, async () => {
    const pay = (await own.pay({ amount: '30', ...payment })).body.payment;
    const expenses = await Promise.all(Array.from({ length: 6 }, () => recorded({ amount: '10', taxTreatment: 'NO_TAX', taxRateId: null })));
    const results = await Promise.all(expenses.map((e) => own.allocate(pay.id, [{ expenseId: e.id, amount: '10' }])));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    for (const r of results.filter((x) => x.status !== 200)) expect(['over_allocation', 'retryable']).toContain(r.body.error);
    const after = (await own.payment(pay.id)).body.payment;
    expect(after).toMatchObject({ allocatedTotal: '30.00', unallocatedAmount: '0.00' });
    expect(after.allocations).toHaveLength(3);
  });

  it('reversing an allocation keeps the payment recorded (its money becomes unallocated) and leaves a complete audit trail', async () => {
    const e = await recorded({ amount: '40', taxTreatment: 'NO_TAX', taxRateId: null });
    const pay = (await own.pay({ amount: '40', ...payment, allocations: [{ expenseId: e.id, amount: '40' }] })).body.payment;
    const alloc = pay.allocations[0].id;
    // Atomic: if the reversal's audit entry cannot be written, nothing changes.
    auditFailure.action = 'finance.expense_allocation.reversed';
    expect((await own.unallocate(pay.id, alloc)).status).toBe(500);
    auditFailure.action = null;
    expect((await own.get(e.id)).body.expense.paidTotal).toBe('40.00');
    const after = (await own.unallocate(pay.id, alloc)).body.payment;
    expect(after).toMatchObject({ status: 'RECORDED', allocatedTotal: '0.00', unallocatedAmount: '40.00', reversedAt: null });
    expect(after.allocations[0].reversedAt).not.toBeNull();
    expect((await audits(alloc)).map((a) => a.action)).toEqual(['finance.expense_allocation.created', 'finance.expense_allocation.reversed']);
    expect((await audits(pay.id)).map((a) => a.action)).toEqual(['finance.payment.recorded']); // the payment itself was not reversed
    // The freed money can settle another expense; the voided one keeps its history.
    const v = (await own.get(e.id)).body.expense;
    expect((await own.void(e.id, { version: v.version, reason: 'Wrong supplier' })).body.expense.allocations).toHaveLength(1);
    const other = await recorded({ amount: '40', taxTreatment: 'NO_TAX', taxRateId: null });
    expect((await own.allocate(pay.id, [{ expenseId: other.id, amount: '40' }])).status).toBe(200);
  });
});

describe('links, search and pagination', () => {
  it('links projects and customers of this business only; archived links are refused for new use', async () => {
    const proj = (await own.createProject({ name: `Fit-out ${randomUUID().slice(0, 4)}` })).body.project;
    const cust = (await own.createCustomer({ displayName: 'Client One' })).body.customer;
    const e = await draft({ projectId: proj.id, customerId: cust.id });
    expect(e).toMatchObject({ projectId: proj.id, customerId: cust.id });
    const b = api(B.people.OWNER!, B.slug);
    const bProj = (await b.createProject({ name: 'B project' })).body.project;
    const bCust = (await b.createCustomer({ displayName: 'B client' })).body.customer;
    expect((await own.patch(e.id, { version: 1, projectId: bProj.id })).body.error).toBe('invalid_project');
    expect((await own.patch(e.id, { version: 1, customerId: bCust.id })).body.error).toBe('invalid_customer');
    const bCat = (await b.categories()).body.categories[0].id;
    expect((await own.patch(e.id, { version: 1, categoryId: bCat })).body.error).toBe('invalid_category');
    const bRate = (await b.createTaxRate({ name: 'B', ratePercent: '10' })).body.taxRate.id;
    expect((await own.patch(e.id, { version: 1, taxRateId: bRate })).body.error).toBe('invalid_tax_rate');
    await own.archiveProject(proj.id);
    expect((await own.create({ categoryId: travel, description: 'x', incurredOn: DAY, taxTreatment: 'NO_TAX', amount: '1', projectId: proj.id })).body.error).toBe('archived_reference');
    // The existing link stays valid and the draft can still be edited and recorded.
    expect((await own.patch(e.id, { version: 1, description: 'Still linked' })).status).toBe(200);
    expect((await own.list(`?projectId=${proj.id}`)).body.expenses.map((x: { id: string }) => x.id)).toEqual([e.id]);
    expect((await own.list(`?customerId=${cust.id}`)).body.expenses.map((x: { id: string }) => x.id)).toEqual([e.id]);
  });

  it('searches text, filters by date, category, supplier and status, and pages with an opaque keyset cursor', async () => {
    const C = await team('fx-list');
    const c = api(C.people.OWNER!, C.slug);
    const cats = (await c.categories()).body.categories;
    const made: string[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await c.create({
        categoryId: cats[i % 2].id, description: `Item ${i}`, supplierName: i % 3 === 0 ? 'Hardware Hub' : 'Paper Place', referenceNumber: `R-${i}`,
        incurredOn: `2026-02-0${i + 1}`, taxTreatment: 'NO_TAX', amount: `${i + 1}`,
      });
      made.push(res.body.expense.id);
    }
    const page1 = await c.list('?limit=3');
    expect(page1.body.expenses.map((x: { incurredOn: string }) => x.incurredOn)).toEqual(['2026-02-07', '2026-02-06', '2026-02-05']);
    const page2 = await c.list(`?limit=3&cursor=${page1.body.nextCursor}`);
    const page3 = await c.list(`?limit=3&cursor=${page2.body.nextCursor}`);
    expect([...page1.body.expenses, ...page2.body.expenses, ...page3.body.expenses].map((x: { id: string }) => x.id).sort()).toEqual([...made].sort());
    expect(page3.body.nextCursor).toBeNull();
    expect((await c.list('?cursor=bm90LWEtY3Vyc29y')).body.error).toBe('invalid_cursor');
    expect((await c.list('?supplier=hardware')).body.expenses).toHaveLength(3);
    expect((await c.list('?q=r-4')).body.expenses.map((x: { description: string }) => x.description)).toEqual(['Item 4']);
    expect((await c.list(`?categoryId=${cats[1].id}`)).body.expenses).toHaveLength(3);
    expect((await c.list('?from=2026-02-02&to=2026-02-04')).body.expenses).toHaveLength(2);
    expect((await c.list('?status=recorded')).body.expenses).toEqual([]);
    expect((await c.list('?limit=500')).body.error).toBe('invalid_query');
  });
});

describe('tenancy and permissions', () => {
  it('another business sees nothing: ids answer 404 and lists are empty', async () => {
    const e = await recorded();
    const pay = (await own.pay({ amount: '1', ...payment })).body.payment;
    const b = api(B.people.OWNER!, B.slug);
    expect((await b.get(e.id)).status).toBe(404);
    expect((await b.patch(e.id, { version: 1, description: 'x' })).status).toBe(404);
    expect((await b.void(e.id, { version: 2, reason: 'x' })).status).toBe(404);
    expect((await b.payment(pay.id)).status).toBe(404);
    expect((await b.allocate(pay.id, [{ expenseId: e.id, amount: '1' }])).status).toBe(404);
    expect((await b.patchCategory(travel, { version: 1, name: 'Hijack' })).status).toBe(404);
    expect((await b.list()).body.expenses.some((x: { id: string }) => x.id === e.id)).toBe(false);
    expect((await own.get('not-a-uuid')).status).toBe(404);
  });

  it('FD-P1: MANAGER enters expenses but cannot pay or manage categories; MEMBER has nothing; other Zones grant nothing', async () => {
    const mgr = api(A.people.MANAGER!, A.slug);
    const mem = api(A.people.MEMBER!, A.slug);
    const adm = api(A.people.ADMIN!, A.slug);
    expect((await mgr.list()).status).toBe(200);
    expect((await mgr.create({ categoryId: travel, description: 'm', incurredOn: DAY, taxTreatment: 'NO_TAX', amount: '1' })).status).toBe(201);
    expect((await mgr.createCategory({ name: 'Nope' })).status).toBe(403);
    expect((await mgr.patchCategory(travel, { version: 1, name: 'Nope' })).status).toBe(403);
    expect((await mgr.pay({ amount: '1', ...payment })).status).toBe(403);
    expect((await adm.createCategory({ name: `Admin ${randomUUID().slice(0, 4)}` })).status).toBe(201);
    expect((await adm.pay({ amount: '1', ...payment })).status).toBe(201);
    for (const call of [() => mem.list(), () => mem.categories(), () => mem.payables(), () => mem.payments(),
      () => mem.create({ categoryId: travel, description: 'x', incurredOn: DAY, taxTreatment: 'NO_TAX', amount: '1' })]) {
      expect((await call()).status).toBe(403);
    }
    // A member with every non-finance permission still has no finance access.
    custom.MEMBER = ['customers:read', 'customers:write', 'projects:read', 'projects:write', 'sales:read'] as Permission[];
    expect((await mem.list()).status).toBe(403);
    // finance:read alone reads but cannot write.
    custom.MEMBER = ['finance:read'];
    expect((await mem.list()).status).toBe(200);
    expect((await mem.create({ categoryId: travel, description: 'x', incurredOn: DAY, taxTreatment: 'NO_TAX', amount: '1' })).status).toBe(403);
  });
});

describe('database guards (X)', () => {
  const asA = async <T>(work: (c: pg.Client) => Promise<T>) => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.business_id', $1, true)`, [A.businessId]);
      const r = await work(c);
      await c.query('COMMIT');
      return r;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await c.end();
    }
  };
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');

  it('X1: a PAID payment can never settle an invoice, and a RECEIVED one never an expense (composite FKs, direction CHECK)', async () => {
    const e = await recorded();
    const id = randomUUID();
    const cust = (await own.createCustomer({ displayName: 'Payer' })).body.customer.id;
    expect(await code(asA((c) => c.query(`INSERT INTO finance_payments (id, business_id, direction, customer_id, currency_code, currency_scale, amount, received_on, method)
      VALUES ($1, $2, 'PAID', $3, 'AUD', 2, 10, '2026-01-01', 'CASH')`, [id, A.businessId, cust])))).toBe('23514');
    expect(await code(asA((c) => c.query(`INSERT INTO finance_payments (id, business_id, direction, currency_code, currency_scale, amount, received_on, method)
      VALUES ($1, $2, 'RECEIVED', 'AUD', 2, 10, '2026-01-01', 'CASH')`, [id, A.businessId])))).toBe('23514');
    await asA((c) => c.query(`INSERT INTO finance_payments (id, business_id, direction, customer_id, currency_code, currency_scale, amount, received_on, method)
      VALUES ($1, $2, 'RECEIVED', $3, 'AUD', 2, 10, '2026-01-01', 'CASH')`, [id, A.businessId, cust]));
    expect(await code(asA((c) => c.query(`INSERT INTO finance_expense_allocations (id, business_id, payment_id, expense_id, currency_code, amount)
      VALUES ($1, $2, $3, $4, 'AUD', 1)`, [randomUUID(), A.businessId, id, e.id])))).toBe('23503');
    expect(await code(asA((c) => c.query(`INSERT INTO finance_expense_allocations (id, business_id, payment_id, payment_direction, expense_id, currency_code, amount)
      VALUES ($1, $2, $3, 'RECEIVED', $4, 'AUD', 1)`, [randomUUID(), A.businessId, id, e.id])))).toBe('23514');
  });

  it('X2: counters cannot be written directly; allocations are one-way and never deleted; no DELETE on F3 tables', async () => {
    const e = await recorded({ amount: '10', taxTreatment: 'NO_TAX', taxRateId: null });
    const pay = (await own.pay({ amount: '10', ...payment, allocations: [{ expenseId: e.id, amount: '10' }] })).body.payment;
    const alloc = pay.allocations[0].id;
    expect(await code(asA((c) => c.query(`UPDATE finance_expenses SET paid_total = 0 WHERE id = $1`, [e.id])))).toBe('FN010');
    expect(await code(asA((c) => c.query(`UPDATE finance_expense_allocations SET amount = 1 WHERE id = $1`, [alloc])))).toBe('42501');
    expect(await code(asA((c) => c.query(`DELETE FROM finance_expense_allocations WHERE id = $1`, [alloc])))).toBe('42501');
    expect(await code(asA((c) => c.query(`DELETE FROM finance_expenses WHERE id = $1`, [e.id])))).toBe('42501');
    expect(await code(asA((c) => c.query(`UPDATE finance_expenses SET status = 'VOID', void_reason = 'x' WHERE id = $1`, [e.id])))).toBe('FN016');
    await asA((c) => c.query(`UPDATE finance_expense_allocations SET reversed_at = now() WHERE id = $1`, [alloc]));
    expect(await code(asA((c) => c.query(`UPDATE finance_expense_allocations SET reversed_at = NULL WHERE id = $1`, [alloc])))).toBe('FN001');
    expect((await admin.query(`SELECT paid_total::text FROM finance_expenses WHERE id = $1`, [e.id])).rows[0].paid_total).toBe('0.0000');
  });

  it('X3: a recorded expense is immutable except voiding; recorder and voider exist only through their transitions', async () => {
    const e = await recorded();
    for (const sql of [`UPDATE finance_expenses SET description = 'x' WHERE id = $1`, `UPDATE finance_expenses SET tax_rate_id = NULL WHERE id = $1`,
      `UPDATE finance_expenses SET due_date = '2030-01-01' WHERE id = $1`, `UPDATE finance_expenses SET customer_id = NULL, notes = 'x' WHERE id = $1`]) {
      expect(await code(asA((c) => c.query(sql, [e.id]))), sql).toBe('FN001');
    }
    expect(await code(asA((c) => c.query(`UPDATE finance_expenses SET recorded_by_id = gen_random_uuid() WHERE id = $1`, [e.id])))).toBe('FN010');
    expect(await code(asA((c) => c.query(`UPDATE finance_expenses SET voided_by_id = gen_random_uuid() WHERE id = $1`, [e.id])))).toBe('FN010');
  });

  it('X4: RLS: another business sees no expense or allocation rows and cannot insert into this one', async () => {
    const e = await recorded({ amount: '10', taxTreatment: 'NO_TAX', taxRateId: null });
    const pay = (await own.pay({ amount: '10', ...payment, allocations: [{ expenseId: e.id, amount: '5' }] })).body.payment;
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.business_id', $1, true)`, [B.businessId]);
      for (const t of ['finance_expenses', 'finance_expense_allocations', 'finance_payments']) {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE business_id = $1`, [A.businessId]);
        expect(rows[0].n, t).toBe(0);
      }
      await c.query('SAVEPOINT s');
      expect(await code(c.query(`INSERT INTO finance_expense_allocations (id, business_id, payment_id, expense_id, currency_code, amount)
        VALUES (gen_random_uuid(), $1, $2, $3, 'AUD', 1)`, [A.businessId, pay.id, e.id]))).toBe('42501');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  });

  it('X5: after every test above, business A reconciles cleanly (payments, expenses and their links)', async () => {
    const report = (await own.reconcile()).body.report;
    expect(report.discrepancies).toEqual([]);
    expect(report.checks.find((x: { check: string }) => x.check === 'expense_paid_total').checked).toBeGreaterThan(0);
  });

  it('X6: reconciliation detects a tampered expense counter without modifying anything', async () => {
    const C = await team('fx-recon');
    const c = api(C.people.OWNER!, C.slug);
    const cat = (await c.categories()).body.categories[0].id;
    const d = (await c.create({ categoryId: cat, description: 'x', incurredOn: DAY, taxTreatment: 'NO_TAX', amount: '10' })).body.expense;
    const e = (await c.record(d.id, { version: 1 })).body.expense;
    await c.pay({ amount: '10', ...payment, allocations: [{ expenseId: e.id, amount: '4' }] });
    // An administrative change that bypasses the guards (triggers disabled for this transaction only).
    await admin.query('BEGIN');
    await admin.query(`SET LOCAL session_replication_role = replica`);
    await admin.query(`UPDATE finance_expenses SET paid_total = 7 WHERE id = $1`, [e.id]);
    await admin.query('COMMIT');
    const report = (await c.reconcile()).body.report;
    expect(report.ok).toBe(false);
    expect(report.discrepancies).toEqual([expect.objectContaining({ check: 'expense_paid_total', recordType: 'expense', recordId: e.id, expected: '4.0000', actual: '7.0000' })]);
    expect((await admin.query(`SELECT paid_total::text FROM finance_expenses WHERE id = $1`, [e.id])).rows[0].paid_total).toBe('7.0000');
    // Put it back, so database-wide checks in other suites (Z1) see consistent counters.
    await admin.query('BEGIN');
    await admin.query(`SET LOCAL session_replication_role = replica`);
    await admin.query(`UPDATE finance_expenses SET paid_total = 4 WHERE id = $1`, [e.id]);
    await admin.query('COMMIT');
    expect((await c.reconcile()).body.report.ok).toBe(true);
  });
});
