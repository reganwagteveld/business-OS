import { inviteForSignup, admitFixture } from './support/admission';
/**
 * Finance Zone F2 (docs/finance-data-model.md §18, ADR 0007): payments, allocations, reversals, credit
 * applications, settlement projections, customer balances and reconciliation, through the real route
 * handlers against PostgreSQL with the migrations and privileged SQL applied as in production. The
 * database-level evidence (guards, counters, concurrency without the services) is in
 * finance-integrity.test.ts (C and K9–K11).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Decimal } from '@/core/db/decimal';
import type { Permission, Role } from '@/modules/access';

const custom: Partial<Record<Role, Permission[]>> = {};
vi.mock('@/modules/access', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/access')>();
  return { ...real, permissionsFor: (role: Role) => custom[role] ?? real.permissionsFor(role) };
});
// Lets one test make the audit write fail, to prove the issue and its audit entry commit or roll back together.
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
import * as contextRoute from '@/app/api/v1/b/[slug]/route';
import * as customersRoute from '@/app/api/v1/b/[slug]/customers/route';
import * as customerRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/route';
import * as contactsRoute from '@/app/api/v1/b/[slug]/contacts/route';
import * as projectsRoute from '@/app/api/v1/b/[slug]/projects/route';
import * as quotesRoute from '@/app/api/v1/b/[slug]/finance/quotes/route';
import * as quoteRoute from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/route';
import * as quoteIssue from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/issue/route';
import * as quoteAccept from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/accept/route';
import * as quoteDecline from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/decline/route';
import * as quoteExpire from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/expire/route';
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
import * as creditNoteRoute from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/route';
import * as creditIssue from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/issue/route';
import * as creditVoid from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/void/route';
import * as settingsRoute from '@/app/api/v1/b/[slug]/finance/settings/route';
import * as seriesListRoute from '@/app/api/v1/b/[slug]/finance/number-series/route';
import * as seriesRoute from '@/app/api/v1/b/[slug]/finance/number-series/[kind]/route';
import * as taxRatesRoute from '@/app/api/v1/b/[slug]/finance/tax-rates/route';
import * as taxRateRoute from '@/app/api/v1/b/[slug]/finance/tax-rates/[taxRateId]/route';
import * as paymentsRoute from '@/app/api/v1/b/[slug]/finance/payments/route';
import * as paymentRoute from '@/app/api/v1/b/[slug]/finance/payments/[paymentId]/route';
import * as allocationsRoute from '@/app/api/v1/b/[slug]/finance/payments/[paymentId]/allocations/route';
import * as allocationReverse from '@/app/api/v1/b/[slug]/finance/payments/[paymentId]/allocations/[allocationId]/reverse/route';
import * as paymentReverse from '@/app/api/v1/b/[slug]/finance/payments/[paymentId]/reverse/route';
import * as settlementRoute from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/settlement/route';
import * as applicationsRoute from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/applications/route';
import * as applicationReverse from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/applications/[applicationId]/reverse/route';
import * as balancesRoute from '@/app/api/v1/b/[slug]/finance/customer-balances/route';
import * as reconciliationRoute from '@/app/api/v1/b/[slug]/finance/reconciliation/route';
import * as receivablesRoute from '@/app/api/v1/b/[slug]/finance/receivables/route';
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
  auditFailure.action = null;
});

// A separate address range from the other suites, so rate-limit counters do not collide.
let ip = 1;
// A different block when the suite runs a second time on the same database (CI, behind PgBouncer).
const IP_BLOCK = Number(process.env.FINANCE_TEST_IP_BLOCK ?? 81);
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
type Seg = 'quotes' | 'invoices' | 'credit-notes';
const ROUTES = {
  quotes: { item: quoteRoute, issue: quoteIssue, void: quoteVoid, discard: quoteDiscard },
  invoices: { item: invoiceRoute, issue: invoiceIssue, void: invoiceVoid, discard: invoiceDiscard },
  'credit-notes': { item: creditNoteRoute, issue: creditIssue, void: creditVoid, discard: null },
} as const;

const api = (who: User, slug: string) => {
  const F = `/api/v1/b/${slug}/finance`;
  const d = (documentId: string) => ctx({ slug, documentId });
  const post = (route: { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> }, path: string, c: ReturnType<typeof ctx>, body?: unknown, headers?: Record<string, string>) =>
    route.POST(req('POST', `${F}${path}`, { cookie: who.cookie, body, headers }), c).then(json);
  return {
    createQuote: (body: unknown, headers?: Record<string, string>) => post(quotesRoute, '/quotes', ctx({ slug }), body, headers),
    createInvoice: (body: unknown, headers?: Record<string, string>) => post(invoicesRoute, '/invoices', ctx({ slug }), body, headers),
    list: (seg: Seg, qs = '') => ({ quotes: quotesRoute, invoices: invoicesRoute, 'credit-notes': creditNotesRoute })[seg].GET(req('GET', `${F}/${seg}${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    get: (seg: Seg, id: string) => ROUTES[seg].item.GET(req('GET', `${F}/${seg}/${id}`, { cookie: who.cookie }), d(id)).then(json),
    patch: (seg: Seg, id: string, body: unknown) => ROUTES[seg].item.PATCH(req('PATCH', `${F}/${seg}/${id}`, { cookie: who.cookie, body }), d(id)).then(json),
    issue: (seg: Seg, id: string, body: unknown) => post(ROUTES[seg].issue, `/${seg}/${id}/issue`, d(id), body),
    void: (seg: Seg, id: string, body: unknown) => post(ROUTES[seg].void, `/${seg}/${id}/void`, d(id), body),
    discard: (seg: 'quotes' | 'invoices', id: string, body: unknown) => post(ROUTES[seg].discard, `/${seg}/${id}/discard`, d(id), body),
    accept: (id: string, body: unknown) => post(quoteAccept, `/quotes/${id}/accept`, d(id), body),
    decline: (id: string, body: unknown) => post(quoteDecline, `/quotes/${id}/decline`, d(id), body),
    expire: (id: string, body: unknown) => post(quoteExpire, `/quotes/${id}/expire`, d(id), body),
    convert: (id: string, body: unknown = {}, headers?: Record<string, string>) => post(quoteConvert, `/quotes/${id}/convert`, d(id), body, headers),
    credit: (invoiceId: string, body: unknown = {}, headers?: Record<string, string>) => post(invoiceCredit, `/invoices/${invoiceId}/credit-notes`, d(invoiceId), body, headers),
    settings: () => settingsRoute.GET(req('GET', `${F}/settings`, { cookie: who.cookie }), ctx({ slug })).then(json),
    patchSettings: (body: unknown) => settingsRoute.PATCH(req('PATCH', `${F}/settings`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    series: () => seriesListRoute.GET(req('GET', `${F}/number-series`, { cookie: who.cookie }), ctx({ slug })).then(json),
    patchSeries: (kind: string, body: unknown) => seriesRoute.PATCH(req('PATCH', `${F}/number-series/${kind}`, { cookie: who.cookie, body }), ctx({ slug, kind })).then(json),
    taxRates: (qs = '') => taxRatesRoute.GET(req('GET', `${F}/tax-rates${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    createTaxRate: (body: unknown) => post(taxRatesRoute, '/tax-rates', ctx({ slug }), body),
    patchTaxRate: (taxRateId: string, body: unknown) => taxRateRoute.PATCH(req('PATCH', `${F}/tax-rates/${taxRateId}`, { cookie: who.cookie, body }), ctx({ slug, taxRateId })).then(json),
    createCustomer: (body: unknown) => customersRoute.POST(req('POST', `/api/v1/b/${slug}/customers`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    updateCustomer: (customerId: string, body: unknown) => customerRoute.PATCH(req('PATCH', `/api/v1/b/${slug}/customers/${customerId}`, { cookie: who.cookie, body }), ctx({ slug, customerId })).then(json),
    createContact: (body: unknown) => contactsRoute.POST(req('POST', `/api/v1/b/${slug}/contacts`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    createProject: (body: unknown) => projectsRoute.POST(req('POST', `/api/v1/b/${slug}/projects`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    context: () => contextRoute.GET(req('GET', `/api/v1/b/${slug}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    // F2
    record: (body: unknown, key: string | null = `pay-${randomUUID()}`) =>
      post(paymentsRoute, '/payments', ctx({ slug }), body, key === null ? undefined : { 'idempotency-key': key }),
    payments: (qs = '') => paymentsRoute.GET(req('GET', `${F}/payments${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    payment: (paymentId: string) => paymentRoute.GET(req('GET', `${F}/payments/${paymentId}`, { cookie: who.cookie }), ctx({ slug, paymentId })).then(json),
    patchPayment: (paymentId: string, body: unknown) => paymentRoute.PATCH(req('PATCH', `${F}/payments/${paymentId}`, { cookie: who.cookie, body }), ctx({ slug, paymentId })).then(json),
    allocate: (paymentId: string, allocations: { invoiceId: string; amount: string }[]) =>
      post(allocationsRoute, `/payments/${paymentId}/allocations`, ctx({ slug, paymentId }), { allocations }),
    unallocate: (paymentId: string, allocationId: string) =>
      post(allocationReverse, `/payments/${paymentId}/allocations/${allocationId}/reverse`, ctx({ slug, paymentId, allocationId }), {}),
    reversePayment: (paymentId: string, body: unknown) => post(paymentReverse, `/payments/${paymentId}/reverse`, ctx({ slug, paymentId }), body),
    settlement: (invoiceId: string) => settlementRoute.GET(req('GET', `${F}/invoices/${invoiceId}/settlement`, { cookie: who.cookie }), d(invoiceId)).then(json),
    creditOf: (creditNoteId: string) => applicationsRoute.GET(req('GET', `${F}/credit-notes/${creditNoteId}/applications`, { cookie: who.cookie }), d(creditNoteId)).then(json),
    applyCredit: (creditNoteId: string, applications: { invoiceId: string; amount: string }[]) =>
      post(applicationsRoute, `/credit-notes/${creditNoteId}/applications`, d(creditNoteId), { applications }),
    unapplyCredit: (creditNoteId: string, applicationId: string) =>
      post(applicationReverse, `/credit-notes/${creditNoteId}/applications/${applicationId}/reverse`, ctx({ slug, documentId: creditNoteId, applicationId }), {}),
    balances: (qs = '') => balancesRoute.GET(req('GET', `${F}/customer-balances${qs}`, { cookie: who.cookie }), ctx({ slug })).then(json),
    receivables: () => receivablesRoute.GET(req('GET', `${F}/receivables`, { cookie: who.cookie }), ctx({ slug })).then(json),
    reconcile: () => reconciliationRoute.GET(req('GET', `${F}/reconciliation`, { cookie: who.cookie }), ctx({ slug })).then(json),
    createCreditNote: (invoiceId: string, body: unknown = {}) => post(invoiceCredit, `/invoices/${invoiceId}/credit-notes`, d(invoiceId), body),
  };
};
const audits = async (targetId: string) =>
  (await admin.query('SELECT action, actor_user_id, business_id, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows;


let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let custA: string;
let custA2: string;
let custB: string;
const line = (unitPrice: string) => ({ description: 'Work', quantity: '1', unitPrice });
const PAST = '2026-01-15';

/** An issued invoice of `amount` (no tax) for a customer of A, due on `due`. */
async function issuedInvoice(amount: string, o: { customerId?: string; currencyCode?: string; due?: string; issueDate?: string; who?: User; slug?: string } = {}) {
  const own = api(o.who ?? A.people.OWNER!, o.slug ?? A.slug);
  const draft = await own.createInvoice({ customerId: o.customerId ?? custA, currencyCode: o.currencyCode, lines: [line(amount)] });
  expect(draft.status).toBe(201);
  const issued = await own.issue('invoices', draft.body.document.id, { version: 1, issueDate: o.issueDate ?? '2026-01-01', dueDate: o.due ?? '2099-12-31' });
  expect(issued.status).toBe(200);
  return issued.body.document.id as string;
}
async function issuedCreditNote(invoiceId: string, amount: string) {
  const own = api(A.people.OWNER!, A.slug);
  const draft = await own.createCreditNote(invoiceId, { lines: [line(amount)] });
  expect(draft.status).toBe(201);
  const issued = await own.issue('credit-notes', draft.body.document.id, { version: 1, issueDate: '2026-01-02' });
  expect(issued.status).toBe(200);
  return issued.body.document.id as string;
}
const pay = (amount: string, o: Record<string, unknown> = {}) => ({ customerId: custA, amount, receivedOn: PAST, method: 'BANK_TRANSFER', ...o });

beforeAll(async () => {
  A = await team('pa');
  B = await team('pb', 'EUR');
  const owner = api(A.people.OWNER!, A.slug);
  custA = (await owner.createCustomer({ displayName: 'Acme' })).body.customer.id;
  custA2 = (await owner.createCustomer({ displayName: 'Globex' })).body.customer.id;
  custB = (await api(B.people.OWNER!, B.slug).createCustomer({ displayName: 'B customer' })).body.customer.id;
}, 180_000);

describe('recording and settling payments', () => {
  it('full and partial settlement: derived states, outstanding and overdue are computed, never stored', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const overdueInv = await issuedInvoice('100.00', { due: '2026-01-31' });
    const futureInv = await issuedInvoice('80.00');
    expect((await own.get('invoices', overdueInv)).body.document).toMatchObject({ settlementState: 'UNPAID', allocatedTotal: '0.00', creditAppliedTotal: '0.00' });
    expect((await own.settlement(overdueInv)).body.settlement).toMatchObject({ outstanding: '100.00', settlementState: 'UNPAID', overdue: true });

    const partial = await own.record(pay('40.00', { allocations: [{ invoiceId: overdueInv, amount: '40.00' }], reference: 'EFT 123' }));
    expect(partial.status).toBe(201);
    expect(partial.body.payment).toMatchObject({
      status: 'RECORDED', amount: '40.00', allocatedTotal: '40.00', unallocatedAmount: '0.00', currencyCode: 'AUD', receivedOn: PAST, method: 'BANK_TRANSFER',
      reference: 'EFT 123', recordedById: A.people.OWNER!.id, version: 1,
    });
    expect(partial.body.payment.allocations).toHaveLength(1);
    expect((await own.settlement(overdueInv)).body.settlement).toMatchObject({ allocatedTotal: '40.00', outstanding: '60.00', settlementState: 'PARTIALLY_PAID', overdue: true });

    const full = await own.record(pay('60', { allocations: [{ invoiceId: overdueInv, amount: '60' }] }));
    expect(full.status).toBe(201);
    const s = (await own.settlement(overdueInv)).body.settlement;
    expect(s).toMatchObject({ allocatedTotal: '100.00', outstanding: '0.00', settlementState: 'PAID', overdue: false });
    expect(s.allocations.map((a: { amount: string }) => a.amount)).toEqual(['40.00', '60.00']);
    expect((await own.get('invoices', futureInv)).body.document.settlementState).toBe('UNPAID');
    expect((await own.settlement(futureInv)).body.settlement.overdue).toBe(false);

    // List filters by derived state (issued invoices only).
    const ids = async (qs: string) => (await own.list('invoices', qs)).body.documents.map((d: { id: string }) => d.id);
    expect(await ids('?settlement=paid&limit=100')).toContain(overdueInv);
    expect(await ids('?settlement=unpaid&limit=100')).toContain(futureInv);
    expect(await ids('?overdue=true&limit=100')).not.toContain(overdueInv);
    // A stored paid flag does not exist: only the counters move, the issued document is otherwise unchanged.
    const cols = (await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'finance_documents' AND column_name ~ 'paid|overdue'`)).rows;
    expect(cols).toEqual([]);
  });

  it('one payment across several invoices, several payments on one invoice, overpayment kept as unallocated customer credit', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const [i1, i2, i3] = [await issuedInvoice('30'), await issuedInvoice('50'), await issuedInvoice('100')];
    const p = await own.record(pay('200', { allocations: [{ invoiceId: i2, amount: '50' }, { invoiceId: i1, amount: '30' }, { invoiceId: i3, amount: '20' }] }));
    expect(p.body.payment).toMatchObject({ allocatedTotal: '100.00', unallocatedAmount: '100.00' });
    const q = (await own.record(pay('50'))).body.payment;
    expect((await own.allocate(q.id, [{ invoiceId: i3, amount: '50' }])).body.payment).toMatchObject({ allocatedTotal: '50.00', unallocatedAmount: '0.00' });
    const r = (await own.record(pay('45'))).body.payment;
    expect((await own.allocate(r.id, [{ invoiceId: i3, amount: '30' }])).status).toBe(200);
    expect((await own.settlement(i3)).body.settlement).toMatchObject({ allocatedTotal: '100.00', settlementState: 'PAID' });
    expect((await own.settlement(i3)).body.settlement.allocations).toHaveLength(3);
    // Over-settlement and over-allocation are refused with stable codes; nothing partial commits.
    const i4 = await issuedInvoice('10');
    expect(await own.allocate(r.id, [{ invoiceId: i4, amount: '10' }, { invoiceId: i1, amount: '1' }])).toMatchObject({ status: 409, body: { error: 'over_settlement' } });
    expect((await own.payment(r.id)).body.payment.allocatedTotal).toBe('30.00');
    expect(await own.allocate(r.id, [{ invoiceId: i4, amount: '15.01' }])).toMatchObject({ status: 409, body: { error: 'over_settlement' } });
    const i5 = await issuedInvoice('100');
    expect(await own.allocate(r.id, [{ invoiceId: i5, amount: '15.01' }])).toMatchObject({ status: 409, body: { error: 'over_allocation' } });
    expect((await own.allocate(r.id, [{ invoiceId: i5, amount: '15' }])).body.payment.unallocatedAmount).toBe('0.00');
    expect(await own.allocate(p.body.payment.id, [{ invoiceId: i5, amount: '1' }, { invoiceId: i5, amount: '1' }])).toMatchObject({ status: 400, body: { error: 'invalid_input' } });
    expect(await own.allocate(q.id, [{ invoiceId: i4, amount: '0' }])).toMatchObject({ status: 400, body: { error: 'invalid_amount' } });
    expect(await own.allocate(q.id, [{ invoiceId: i4, amount: '1' }])).toMatchObject({ status: 409, body: { error: 'over_allocation' } }); // fully allocated payment
    // A live pair cannot be allocated twice; reverse and re-allocate instead.
    expect(await own.allocate(p.body.payment.id, [{ invoiceId: i1, amount: '0.01' }])).toMatchObject({ status: 409, body: { error: 'over_settlement' } });
    const i6 = await issuedInvoice('10');
    await own.allocate(p.body.payment.id, [{ invoiceId: i6, amount: '1' }]);
    expect(await own.allocate(p.body.payment.id, [{ invoiceId: i6, amount: '1' }])).toMatchObject({ status: 409, body: { error: 'already_allocated' } });
    // Unallocated balances are listed and counted as customer credit.
    const unalloc = (await own.payments(`?customerId=${custA}&unallocated=true&limit=100`)).body.payments.map((x: { id: string }) => x.id);
    expect(unalloc).toContain(p.body.payment.id);
    expect(unalloc).not.toContain(q.id);
    // Draft and void invoices and quotes are not settlement targets.
    const draft = (await own.createInvoice({ customerId: custA, lines: [line('5')] })).body.document.id;
    expect(await own.allocate(p.body.payment.id, [{ invoiceId: draft, amount: '1' }])).toMatchObject({ status: 409, body: { error: 'invoice_not_open' } });
    const quote = (await own.createQuote({ customerId: custA, lines: [line('5')] })).body.document.id;
    expect(await own.allocate(p.body.payment.id, [{ invoiceId: quote, amount: '1' }])).toMatchObject({ status: 400, body: { error: 'invalid_invoice' } });
  });

  it('validates currency, scale, customer and dates; customer and currency mismatches are refused', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const aud = await issuedInvoice('100');
    const usd = await issuedInvoice('100', { currencyCode: 'USD' });
    const otherCustomer = await issuedInvoice('100', { customerId: custA2 });
    expect(await own.record(pay('10.001'))).toMatchObject({ status: 400, body: { error: 'invalid_amount' } });
    expect(await own.record(pay(10 as never))).toMatchObject({ status: 400, body: { error: 'invalid_input' } }); // JSON numbers are refused
    expect(await own.record(pay('0'))).toMatchObject({ status: 400, body: { error: 'invalid_amount' } });
    expect(await own.record(pay('10', { currencyCode: 'XXZ' }))).toMatchObject({ status: 400, body: { error: 'invalid_currency' } });
    expect(await own.record(pay('10.5', { currencyCode: 'JPY' }))).toMatchObject({ status: 400, body: { error: 'invalid_amount' } });
    expect(await own.record(pay('10', { receivedOn: '2099-01-01' }))).toMatchObject({ status: 400, body: { error: 'invalid_dates' } });
    expect(await own.record(pay('10', { method: 'CRYPTO' }))).toMatchObject({ status: 400, body: { error: 'invalid_input' } });
    expect(await own.record(pay('10', { allocatedTotal: '10' }))).toMatchObject({ status: 400, body: { error: 'invalid_input' } }); // server-owned fields
    expect(await own.record(pay('10', { allocations: [{ invoiceId: usd, amount: '10' }] }))).toMatchObject({ status: 400, body: { error: 'currency_mismatch' } });
    expect(await own.record(pay('10', { allocations: [{ invoiceId: otherCustomer, amount: '10' }] }))).toMatchObject({ status: 400, body: { error: 'customer_mismatch' } });
    // The failed records left nothing behind (all or nothing).
    const before = (await admin.query('SELECT count(*)::int AS n FROM finance_payments WHERE business_id = $1', [A.businessId])).rows[0].n;
    expect(await own.record(pay('20', { allocations: [{ invoiceId: aud, amount: '10' }, { invoiceId: usd, amount: '10' }] }))).toMatchObject({ status: 400 });
    expect((await admin.query('SELECT count(*)::int AS n FROM finance_payments WHERE business_id = $1', [A.businessId])).rows[0].n).toBe(before);
    expect((await own.settlement(aud)).body.settlement.allocatedTotal).toBe('0.00');
    // A USD payment settles the USD invoice; a 0-decimal currency keeps 0 decimals.
    expect((await own.record(pay('10', { currencyCode: 'USD', allocations: [{ invoiceId: usd, amount: '10' }] }))).body.payment).toMatchObject({ currencyCode: 'USD', currencyScale: 2, allocatedTotal: '10.00' });
    expect((await own.record(pay('1500', { currencyCode: 'JPY' }))).body.payment).toMatchObject({ amount: '1500', currencyScale: 0 });
    // Archived customers cannot receive new payments.
    const gone = (await own.createCustomer({ displayName: 'Gone' })).body.customer;
    await admin.query('UPDATE customers SET archived_at = now() WHERE id = $1', [gone.id]);
    expect(await own.record(pay('5', { customerId: gone.id }))).toMatchObject({ status: 409, body: { error: 'archived_reference' } });
    // Only the reference changes after recording; the payment is otherwise frozen.
    const p = (await own.record(pay('7'))).body.payment;
    const patched = await own.patchPayment(p.id, { version: 1, reference: 'Cheque 991' });
    expect(patched.body.payment).toMatchObject({ reference: 'Cheque 991', version: 2, amount: '7.00' });
    expect(await own.patchPayment(p.id, { version: 1, reference: 'stale' })).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect(await own.patchPayment(p.id, { version: 2, amount: '8' })).toMatchObject({ status: 400, body: { error: 'invalid_input' } });
    expect((await audits(p.id)).map((e) => e.action)).toEqual(['finance.payment.recorded', 'finance.payment.updated']);
    expect(JSON.stringify(await audits(p.id))).not.toMatch(/Cheque 991/); // no free text in the audit log
  });
});

describe('reversals', () => {
  it('reverses an allocation without deleting it, then the payment (reason required); history and audit are kept', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const [i1, i2] = [await issuedInvoice('100'), await issuedInvoice('100')];
    const p = (await own.record(pay('150', { allocations: [{ invoiceId: i1, amount: '100' }, { invoiceId: i2, amount: '50' }] }))).body.payment;
    const a1 = p.allocations.find((a: { invoiceId: string }) => a.invoiceId === i1);
    const reversed = await own.unallocate(p.id, a1.id);
    expect(reversed.body.payment).toMatchObject({ allocatedTotal: '50.00', unallocatedAmount: '100.00' });
    expect(reversed.body.payment.allocations.find((a: { id: string }) => a.id === a1.id)).toMatchObject({ reversedById: A.people.OWNER!.id, reversedAt: expect.any(String) });
    expect(await own.unallocate(p.id, a1.id)).toMatchObject({ status: 409, body: { error: 'already_reversed' } });
    expect((await own.settlement(i1)).body.settlement).toMatchObject({ allocatedTotal: '0.00', settlementState: 'UNPAID' });
    // Re-allocating after a reversal is a new allocation.
    expect((await own.allocate(p.id, [{ invoiceId: i1, amount: '20' }])).body.payment.allocations).toHaveLength(3);

    expect(await own.reversePayment(p.id, { version: 1 })).toMatchObject({ status: 400, body: { error: 'invalid_input' } });
    expect(await own.reversePayment(p.id, { version: 1, reason: '   ' })).toMatchObject({ status: 400, body: { error: 'invalid_input' } });
    const done = await own.reversePayment(p.id, { version: 1, reason: 'Cheque bounced' });
    expect(done.status).toBe(200);
    expect(done.body.payment).toMatchObject({ status: 'REVERSED', allocatedTotal: '0.00', unallocatedAmount: '0.00', reversalReason: 'Cheque bounced', reversedById: A.people.OWNER!.id, version: 2 });
    expect(done.body.payment.allocations.every((a: { reversedAt: string | null }) => a.reversedAt !== null)).toBe(true);
    expect(done.body.payment.allocations).toHaveLength(3); // nothing deleted
    expect((await own.settlement(i2)).body.settlement.allocatedTotal).toBe('0.00');
    expect(await own.reversePayment(p.id, { version: 2, reason: 'again' })).toMatchObject({ status: 409, body: { error: 'invalid_state' } });
    expect(await own.allocate(p.id, [{ invoiceId: i2, amount: '1' }])).toMatchObject({ status: 409, body: { error: 'payment_not_open' } });
    expect(await own.patchPayment(p.id, { version: 2, reference: 'x' })).toMatchObject({ status: 409, body: { error: 'payment_not_open' } });
    const actions = (await audits(p.id)).map((e) => e.action);
    expect(actions).toEqual(['finance.payment.recorded', 'finance.payment.reversed']);
    expect((await audits(p.id)).find((e) => e.action === 'finance.payment.reversed')!.metadata).toMatchObject({ reversedAllocations: '2', hasReason: 'true', amount: '150.00' });
    expect(JSON.stringify(await audits(p.id))).not.toMatch(/bounced/i);
    const allocAudits = (await admin.query(`SELECT action, metadata FROM audit_events WHERE action LIKE 'finance.allocation.%' AND metadata->>'paymentId' = $1 ORDER BY created_at, action`, [p.id])).rows;
    expect(allocAudits.map((r) => r.action).sort()).toEqual(['finance.allocation.created', 'finance.allocation.created', 'finance.allocation.created', 'finance.allocation.reversed', 'finance.allocation.reversed', 'finance.allocation.reversed']);
    // The invoices are open again and can be voided (F1 rule: only while unsettled).
    const i1Doc = (await own.get('invoices', i1)).body.document;
    expect((await own.void('invoices', i1, { version: i1Doc.version, reason: 'Issued in error' })).status).toBe(200);
  });

  it('a payment reversal is atomic: if any part fails, every allocation stays live', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const i1 = await issuedInvoice('50');
    const p = (await own.record(pay('50', { allocations: [{ invoiceId: i1, amount: '50' }] }))).body.payment;
    auditFailure.action = 'finance.payment.reversed';
    expect((await own.reversePayment(p.id, { version: 1, reason: 'Error' })).status).toBe(500);
    auditFailure.action = null;
    const after = (await own.payment(p.id)).body.payment;
    expect(after).toMatchObject({ status: 'RECORDED', allocatedTotal: '50.00' });
    expect(after.allocations[0].reversedAt).toBeNull();
    expect((await own.settlement(i1)).body.settlement.allocatedTotal).toBe('50.00');
  });
});

describe('idempotency', () => {
  it('requires a key; repeats return the original; a different request with the same key is a conflict; 15 racing duplicates record one payment', async () => {
    const own = api(A.people.OWNER!, A.slug);
    expect(await own.record(pay('5'), null)).toMatchObject({ status: 400, body: { error: 'idempotency_key_required' } });
    expect(await own.record(pay('5'), 'has space')).toMatchObject({ status: 400, body: { error: 'invalid_idempotency_key' } });
    const inv = await issuedInvoice('100');
    const key = `pay-${randomUUID()}`;
    const body = pay('25', { allocations: [{ invoiceId: inv, amount: '25' }] });
    const first = await own.record(body, key);
    const again = await own.record(body, key);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.payment.id).toBe(first.body.payment.id);
    expect((await own.settlement(inv)).body.settlement.allocatedTotal).toBe('25.00'); // the replay re-applied nothing
    expect(await own.record({ ...body, amount: '26' }, key)).toMatchObject({ status: 409, body: { error: 'idempotency_conflict' } });
    // Keys are per business.
    expect((await api(B.people.OWNER!, B.slug).record({ customerId: custB, amount: '25', receivedOn: PAST, method: 'CASH' }, key)).status).toBe(201);

    const raceKey = `race-${randomUUID()}`;
    const race = await Promise.all(Array.from({ length: 15 }, () => own.record(pay('9', { allocations: [{ invoiceId: inv, amount: '9' }] }), raceKey)));
    expect(race.filter((r) => r.status === 201)).toHaveLength(1);
    expect(race.filter((r) => r.status === 200)).toHaveLength(14);
    expect(new Set(race.map((r) => r.body.payment.id)).size).toBe(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM finance_payments WHERE idempotency_key = $1', [raceKey])).rows[0].n).toBe(1);
    expect((await own.settlement(inv)).body.settlement.allocatedTotal).toBe('34.00');
  });
});

describe('races', () => {
  it('payment versus payment: 10 concurrent 30.00 settlements of one 100.00 invoice, exactly 3 commit', { timeout: 60_000 }, async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice('100');
    const payments = await Promise.all(Array.from({ length: 10 }, async () => (await own.record(pay('30'))).body.payment.id as string));
    const results = await Promise.all(payments.map((p) => own.allocate(p, [{ invoiceId: inv, amount: '30' }])));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409).every((r) => ['over_settlement', 'retryable'].includes(r.body.error))).toBe(true);
    expect(results.filter((r) => r.status !== 200 && r.status !== 409)).toEqual([]);
    expect((await own.settlement(inv)).body.settlement.allocatedTotal).toBe('90.00');
  });

  it('allocation versus reversal, and payment reversal versus allocation: every interleaving leaves exact counters', { timeout: 120_000 }, async () => {
    const own = api(A.people.OWNER!, A.slug);
    for (let n = 0; n < 6; n++) {
      const inv = await issuedInvoice('100');
      const p = (await own.record(pay('50', { allocations: [{ invoiceId: inv, amount: '50' }] }))).body.payment;
      const q = (await own.record(pay('60'))).body.payment;
      const [rev, alloc] = await Promise.all([own.unallocate(p.id, p.allocations[0].id), own.allocate(q.id, [{ invoiceId: inv, amount: '60' }])]);
      expect(rev.status).toBe(200);
      expect([200, 409]).toContain(alloc.status);
      const s = (await own.settlement(inv)).body.settlement;
      expect(s.allocatedTotal).toBe(alloc.status === 200 ? '60.00' : '0.00');

      // Reversing a payment while it is being allocated elsewhere: either the allocation lands first and is reversed with it, or it is refused.
      const other = await issuedInvoice('100');
      const [reversal, late] = await Promise.all([own.reversePayment(p.id, { version: 1, reason: 'Recorded in error' }), own.allocate(p.id, [{ invoiceId: other, amount: '10' }])]);
      expect(reversal.status).toBe(200);
      expect([200, 409]).toContain(late.status);
      expect((await own.settlement(other)).body.settlement.allocatedTotal).toBe('0.00');
      expect((await own.payment(p.id)).body.payment).toMatchObject({ status: 'REVERSED', allocatedTotal: '0.00' });
    }
    expect((await own.reconcile()).body.report.ok).toBe(true);
  });

  it('simultaneous reversals: one payment reversed five times at once, and mixed payment and credit settlement reversed concurrently', { timeout: 60_000 }, async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice('100');
    const cn = await issuedCreditNote(inv, '30');
    const p = (await own.record(pay('50', { allocations: [{ invoiceId: inv, amount: '50' }] }))).body.payment;
    const applied = (await own.applyCredit(cn, [{ invoiceId: inv, amount: '30' }])).body.credit.applications[0];
    expect((await own.settlement(inv)).body.settlement).toMatchObject({ allocatedTotal: '50.00', creditAppliedTotal: '30.00', outstanding: '20.00' });
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => own.reversePayment(p.id, { version: 1, reason: 'Duplicate entry' })),
      own.unapplyCredit(cn, applied.id), own.unapplyCredit(cn, applied.id),
    ]);
    const reversals = results.slice(0, 5);
    expect(reversals.filter((r) => r.status === 200)).toHaveLength(1);
    expect(reversals.filter((r) => r.status === 409).every((r) => ['invalid_state', 'stale'].includes(r.body.error))).toBe(true);
    expect(results.slice(5).map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await own.settlement(inv)).body.settlement).toMatchObject({ allocatedTotal: '0.00', creditAppliedTotal: '0.00', outstanding: '100.00', settlementState: 'UNPAID' });
    expect((await audits(p.id)).filter((e) => e.action === 'finance.payment.reversed')).toHaveLength(1);
    expect((await own.reconcile()).body.report.ok).toBe(true);
  });
});

describe('credit applications', () => {
  it('applies a credit note partially to its invoice and to another, within both totals; reversible; voids blocked while applied', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice('100');
    const other = await issuedInvoice('40');
    const cn = await issuedCreditNote(inv, '50');
    // Issuing the credit note settled nothing.
    expect((await own.settlement(inv)).body.settlement).toMatchObject({ creditAppliedTotal: '0.00', outstanding: '100.00', settlementState: 'UNPAID' });
    expect((await own.creditOf(cn)).body.credit).toMatchObject({ total: '50.00', appliedTotal: '0.00', available: '50.00', applications: [] });

    const applied = await own.applyCredit(cn, [{ invoiceId: inv, amount: '30' }, { invoiceId: other, amount: '15' }]);
    expect(applied.status).toBe(200);
    expect(applied.body.credit).toMatchObject({ appliedTotal: '45.00', available: '5.00' });
    expect(applied.body.credit.applications).toHaveLength(2);
    expect((await own.settlement(inv)).body.settlement).toMatchObject({ creditAppliedTotal: '30.00', outstanding: '70.00', settlementState: 'PARTIALLY_PAID' });
    expect((await own.get('credit-notes', cn)).body.document).toMatchObject({ creditAppliedTotal: '45.00', settlementState: null });

    // Limits: the credit note's remaining credit, and the invoice's outstanding (payments + credit).
    const third = await issuedInvoice('100');
    expect(await own.applyCredit(cn, [{ invoiceId: third, amount: '5.01' }])).toMatchObject({ status: 409, body: { error: 'over_application' } });
    await own.record(pay('25', { allocations: [{ invoiceId: other, amount: '25' }] }));
    expect((await own.settlement(other)).body.settlement).toMatchObject({ settlementState: 'PAID', outstanding: '0.00' });
    const cn2 = await issuedCreditNote(third, '10');
    expect(await own.applyCredit(cn2, [{ invoiceId: other, amount: '0.01' }])).toMatchObject({ status: 409, body: { error: 'over_settlement' } });
    expect(await own.applyCredit(cn, [{ invoiceId: inv, amount: '1' }])).toMatchObject({ status: 409, body: { error: 'already_applied' } });
    // Wrong customer or currency, drafts, and invoices of another business.
    const usd = await issuedInvoice('100', { currencyCode: 'USD' });
    const globex = await issuedInvoice('100', { customerId: custA2 });
    expect(await own.applyCredit(cn, [{ invoiceId: usd, amount: '1' }])).toMatchObject({ status: 400, body: { error: 'currency_mismatch' } });
    expect(await own.applyCredit(cn, [{ invoiceId: globex, amount: '1' }])).toMatchObject({ status: 400, body: { error: 'customer_mismatch' } });
    const draftCn = (await own.createCreditNote(inv, { lines: [line('1')] })).body.document.id;
    expect(await own.applyCredit(draftCn, [{ invoiceId: inv, amount: '1' }])).toMatchObject({ status: 409, body: { error: 'credit_note_not_open' } });
    expect(await own.applyCredit(inv, [{ invoiceId: other, amount: '1' }])).toMatchObject({ status: 404 }); // an invoice is not a credit note

    // Voids are blocked while credit is applied, on both sides.
    const otherDoc = (await own.get('invoices', other)).body.document;
    expect(await own.void('invoices', other, { version: otherDoc.version, reason: 'x' })).toMatchObject({ status: 409, body: { error: 'has_credit_applications' } });
    const cnDoc = (await own.get('credit-notes', cn)).body.document;
    expect(await own.void('credit-notes', cn, { version: cnDoc.version, reason: 'x' })).toMatchObject({ status: 409, body: { error: 'has_credit_applications' } });

    // Reversal: one way, kept as history, audited.
    const toOther = applied.body.credit.applications.find((a: { invoiceId: string }) => a.invoiceId === other);
    const back = await own.unapplyCredit(cn, toOther.id);
    expect(back.body.credit).toMatchObject({ appliedTotal: '30.00', available: '20.00' });
    expect(back.body.credit.applications.find((a: { id: string }) => a.id === toOther.id).reversedAt).not.toBeNull();
    expect(await own.unapplyCredit(cn, toOther.id)).toMatchObject({ status: 409, body: { error: 'already_reversed' } });
    expect((await own.settlement(other)).body.settlement).toMatchObject({ creditAppliedTotal: '0.00', outstanding: '15.00', settlementState: 'PARTIALLY_PAID' });
    const actions = (await admin.query(`SELECT action FROM audit_events WHERE metadata->>'creditNoteId' = $1 ORDER BY created_at, action`, [cn])).rows.map((r) => r.action);
    expect(actions.sort()).toEqual(['finance.credit_application.created', 'finance.credit_application.created', 'finance.credit_application.reversed']);

    // Customer balances: receivable, unallocated payments and unapplied credit, per currency.
    const bal = (await own.balances(`?customerId=${custA}&currencyCode=AUD`)).body;
    expect(bal.balances).toHaveLength(1);
    const b = bal.balances[0];
    expect(new Decimal(b.creditAvailable).eq(new Decimal(b.unallocatedPayments).add(b.unappliedCredit))).toBe(true);
    expect(new Decimal(b.unappliedCredit).gte(new Decimal('30'))).toBe(true); // cn 20 + cn2 10 at least
  });

  it('F1 credit-note guards still hold: never above the invoice total in issued credit notes, and credited invoices cannot be voided', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice('100');
    await issuedCreditNote(inv, '60');
    const second = (await own.createCreditNote(inv, { lines: [line('40.01')] })).body.document.id;
    expect(await own.issue('credit-notes', second, { version: 1 })).toMatchObject({ status: 409, body: { error: 'credit_exceeds_invoice' } });
    const invDoc = (await own.get('invoices', inv)).body.document;
    expect(await own.void('invoices', inv, { version: invDoc.version, reason: 'x' })).toMatchObject({ status: 409, body: { error: 'invoice_credited' } });
    expect(await own.patch('invoices', inv, { version: invDoc.version, notes: 'changed' })).toMatchObject({ status: 409, body: { error: 'immutable' } });
  });
});

describe('F4 receivables summary (read-only)', () => {
  it('per currency only, equal to the sum of customer balances; overdue and counts; never nets credit; tenant-scoped; finance:read', async () => {
    const own = api(A.people.OWNER!, A.slug);
    // An overdue USD invoice partly paid, and an open NZD one: three currencies at least, none added together.
    const usd = await issuedInvoice('70', { currencyCode: 'USD', due: '2026-02-01' });
    expect((await own.record(pay('20', { currencyCode: 'USD', allocations: [{ invoiceId: usd, amount: '20' }] }))).status).toBe(201);
    await issuedInvoice('5.5', { currencyCode: 'NZD' });
    const r = await own.receivables();
    expect(r.status).toBe(200);
    const list = r.body.receivables.currencies as {
      currencyCode: string; outstanding: string; overdue: string; openCount: number; overdueCount: number; unallocatedPayments: string; unappliedCredit: string;
    }[];
    expect(new Set(list.map((c) => c.currencyCode)).size).toBe(list.length);
    expect(list.map((c) => c.currencyCode)).toEqual(expect.arrayContaining(['AUD', 'USD', 'NZD']));
    // The whole-business figure is exactly the sum of the per-customer balances of the same currency.
    const balances: { currencyCode: string; receivable: string; overdue: string; unallocatedPayments: string; unappliedCredit: string }[] = [];
    for (let cursor: string | null = null, first = true; first || cursor; first = false) {
      const page: { balances: typeof balances; nextCursor: string | null } = (await own.balances(`?limit=100${cursor ? `&cursor=${cursor}` : ''}`)).body;
      balances.push(...page.balances);
      cursor = page.nextCursor;
    }
    for (const c of list) {
      const mine = balances.filter((b) => b.currencyCode === c.currencyCode);
      const sum = (k: 'receivable' | 'overdue' | 'unallocatedPayments' | 'unappliedCredit') => mine.reduce((s, b) => s.add(b[k]), new Decimal(0));
      expect(new Decimal(c.outstanding).eq(sum('receivable')), c.currencyCode).toBe(true);
      expect(new Decimal(c.overdue).eq(sum('overdue')), c.currencyCode).toBe(true);
      expect(new Decimal(c.unallocatedPayments).eq(sum('unallocatedPayments')), c.currencyCode).toBe(true);
      expect(new Decimal(c.unappliedCredit).eq(sum('unappliedCredit')), c.currencyCode).toBe(true);
      expect(c.overdueCount).toBeLessThanOrEqual(c.openCount);
    }
    const usdRow = list.find((c) => c.currencyCode === 'USD')!;
    expect(new Decimal(usdRow.overdue).gte(new Decimal('50'))).toBe(true);
    expect(usdRow.overdueCount).toBeGreaterThanOrEqual(1);
    const nzd = list.find((c) => c.currencyCode === 'NZD')!;
    expect(nzd).toMatchObject({ overdue: '0.00', overdueCount: 0 });
    expect(nzd.openCount).toBeGreaterThanOrEqual(1);
    // Another business sees only its own currencies (B is EUR with no records here); MEMBER has no finance:read.
    const bList = (await api(B.people.OWNER!, B.slug).receivables()).body.receivables.currencies as { currencyCode: string }[];
    expect(bList.some((c) => c.currencyCode === 'NZD')).toBe(false);
    expect((await api(A.people.MEMBER!, A.slug).receivables()).status).toBe(403);
    expect((await api(A.people.MANAGER!, A.slug).receivables()).status).toBe(200);
    // Reading changed nothing.
    expect((await own.reconcile()).body.report.ok).toBe(true);
  });
});

describe('invoice list order (sort=due_asc)', () => {
  it('oldest due first, undated last, ties by id; keyset pages are complete and stable; cursors belong to one order', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const cust = (await own.createCustomer({ displayName: 'Sorted' })).body.customer.id as string;
    const mar = await issuedInvoice('10', { customerId: cust, due: '2026-03-01' });
    const janA = await issuedInvoice('10', { customerId: cust, due: '2026-01-10' });
    const feb = await issuedInvoice('10', { customerId: cust, due: '2026-02-01' });
    const janB = await issuedInvoice('10', { customerId: cust, due: '2026-01-10' });
    const future = await issuedInvoice('10', { customerId: cust, due: '2099-12-31' });
    const paid = await issuedInvoice('10', { customerId: cust, due: '2026-01-01' });
    expect((await own.record(pay('10', { customerId: cust, allocations: [{ invoiceId: paid, amount: '10' }] }))).status).toBe(201);
    const draft = (await own.createInvoice({ customerId: cust, lines: [line('10')] })).body.document.id as string;

    type Page = { status: number; body: { documents: { id: string; dueDate: string | null }[]; nextCursor: string | null; error?: string } };
    const list = (qs: string): Promise<Page> => own.list('invoices', `?customerId=${cust}&${qs}`);
    const all = async (qs: string, limit: number) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Page = await list(`${qs}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
        expect(page.status).toBe(200);
        seen.push(...page.body.documents.map((d) => d.id));
        cursor = page.body.nextCursor;
      } while (cursor);
      return seen;
    };
    const jan = [janA, janB].sort();

    // Overdue only (issued, open, due before today): oldest due first, the two same-day invoices by id.
    const overdue = (await list('overdue=true&sort=due_asc&limit=100')).body.documents;
    expect(overdue.map((d) => d.id)).toEqual([...jan, feb, mar]);
    expect(overdue.map((d) => d.dueDate)).toEqual(['2026-01-10', '2026-01-10', '2026-02-01', '2026-03-01']);
    expect(await all('overdue=true&sort=due_asc', 1)).toEqual([...jan, feb, mar]);

    // Every status: dated invoices by due date, then the undated draft last; pages cross the undated boundary.
    const expected = [paid, ...jan, feb, mar, future, draft];
    expect((await list('status=all&sort=due_asc&limit=100')).body.documents.map((d) => d.id)).toEqual(expected);
    for (const limit of [1, 2, 3, 5]) expect(await all('status=all&sort=due_asc', limit), `limit ${limit}`).toEqual(expected);

    // The default (and explicit created_desc) order is unchanged: newest created first.
    const newest = [draft, paid, future, janB, feb, janA, mar];
    expect((await list('status=all&limit=100')).body.documents.map((d) => d.id)).toEqual(newest);
    expect((await list('status=all&sort=created_desc&limit=100')).body.documents.map((d) => d.id)).toEqual(newest);
    expect(await all('status=all', 2)).toEqual(newest);

    // A cursor belongs to the order that issued it.
    const byDue = (await list('status=all&sort=due_asc&limit=2')).body.nextCursor!;
    const byNew = (await list('status=all&limit=2')).body.nextCursor!;
    expect((await list(`status=all&limit=2&cursor=${byDue}`)).body.error).toBe('invalid_cursor');
    expect((await list(`status=all&sort=due_asc&limit=2&cursor=${byNew}`)).body.error).toBe('invalid_cursor');
    const forged = (v: Record<string, string>) => Buffer.from(JSON.stringify({ k: 'finance:INVOICE:due_asc', ...v }), 'utf8').toString('base64url');
    const badCursors = [
      { d: '2026-13-45', i: randomUUID() }, { d: 'later', i: randomUUID() }, { d: 'none', i: 'not-a-uuid' },
      // Regex-shaped but not calendar dates (JavaScript would roll these into the next month).
      { d: '2026-02-31', i: randomUUID() }, { d: '2026-04-31', i: randomUUID() }, { d: '2026-02-29', i: randomUUID() },
      { d: '2100-02-29', i: randomUUID() }, { d: '2026-06-00', i: randomUUID() },
    ];
    for (const bad of badCursors) {
      const res = await list(`status=all&sort=due_asc&cursor=${forged(bad)}`);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error).toBe('invalid_cursor');
    }
    // Real leap days are valid positions (2024 and 2000 are leap years).
    for (const d of ['2024-02-29', '2000-02-29']) {
      const res = await list(`status=all&sort=due_asc&limit=100&cursor=${forged({ d, i: randomUUID() })}`);
      expect(res.status, d).toBe(200);
      expect(res.body.documents.map((x) => x.id)).toEqual(expected);
    }

    // Unknown orders are refused; quotes and credit notes have no sort parameter.
    expect((await list('sort=due_desc')).status).toBe(400);
    expect((await own.list('quotes', '?sort=due_asc')).status).toBe(400);
    expect((await own.list('credit-notes', '?sort=due_asc')).status).toBe(400);
    // Another business sees none of these invoices in either order.
    const b = api(B.people.OWNER!, B.slug);
    expect((await b.list('invoices', '?status=all&sort=due_asc&limit=100')).body.documents.map((d: { id: string }) => d.id)).not.toContain(janA);
  });
});

describe('tenancy and permissions', () => {
  it('another business sees nothing and cannot settle this business\'s invoices or use its payments', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const bOwn = api(B.people.OWNER!, B.slug);
    const inv = await issuedInvoice('100');
    const cn = await issuedCreditNote(inv, '10');
    const p = (await own.record(pay('10'))).body.payment;
    expect((await bOwn.payment(p.id)).status).toBe(404);
    expect((await bOwn.settlement(inv)).status).toBe(404);
    expect((await bOwn.creditOf(cn)).status).toBe(404);
    expect((await bOwn.allocate(p.id, [{ invoiceId: inv, amount: '1' }])).status).toBe(404);
    expect((await bOwn.unallocate(p.id, randomUUID())).status).toBe(404);
    expect((await bOwn.reversePayment(p.id, { version: 1, reason: 'x' })).status).toBe(404);
    expect((await bOwn.applyCredit(cn, [{ invoiceId: inv, amount: '1' }])).status).toBe(404);
    const bPay = (await bOwn.record({ customerId: custB, amount: '10', receivedOn: PAST, method: 'CASH' })).body.payment;
    expect(await bOwn.allocate(bPay.id, [{ invoiceId: inv, amount: '1' }])).toMatchObject({ status: 400, body: { error: 'invalid_invoice' } });
    expect((await bOwn.record({ customerId: custA, amount: '10', receivedOn: PAST, method: 'CASH' })).body.error).toBe('invalid_customer');
    expect((await bOwn.payments('?limit=100')).body.payments.map((x: { id: string }) => x.id)).not.toContain(p.id);
    expect((await bOwn.balances()).body.balances.every((x: { customerId: string }) => x.customerId === custB)).toBe(true);
    expect((await own.payment('not-a-uuid')).status).toBe(404);
  });

  it('FD-P1: finance:read reads, finance:payments settles; MANAGER and MEMBER cannot record; other Zones grant nothing', async () => {
    const inv = await issuedInvoice('100');
    const cn = await issuedCreditNote(inv, '10');
    const p = (await api(A.people.OWNER!, A.slug).record(pay('10'))).body.payment;
    const expected = { OWNER: [true, true], ADMIN: [true, true], MANAGER: [true, false], MEMBER: [false, false] } as const;
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'] as const) {
      const who = api(A.people[role]!, A.slug);
      const [read, mutate] = expected[role];
      for (const r of [await who.payments(), await who.payment(p.id), await who.settlement(inv), await who.creditOf(cn), await who.balances(), await who.reconcile()]) {
        expect(r.status !== 403, `${role} read`).toBe(read);
      }
      expect((await who.record(pay('1'))).status !== 403, `${role} record`).toBe(mutate);
      expect((await who.patchPayment(p.id, { version: 99, reference: 'r' })).status !== 403, `${role} patch`).toBe(mutate);
      expect((await who.reversePayment(p.id, { version: 99, reason: 'r' })).status !== 403, `${role} reverse`).toBe(mutate);
      expect((await who.applyCredit(cn, [{ invoiceId: inv, amount: '0.01' }])).status !== 403, `${role} apply`).toBe(mutate);
    }
    expect((await api(A.people.MANAGER!, A.slug).context()).body.membership.permissions.filter((x: string) => x.startsWith('finance:')))
      .toEqual(['finance:read', 'finance:write', 'finance:expenses', 'finance:documents_preview', 'finance:documents_generate', 'finance:documents_download']);
    // Every customer, sales and project key and finance:issue: still no payments, and issuing a credit note is not applying it.
    custom.ADMIN = ['business:read', 'customers:read', 'customers:write', 'customers:delete', 'sales:read', 'sales:write', 'sales:manage',
      'projects:read', 'projects:create', 'projects:update', 'projects:archive', 'projects:manage_tasks', 'finance:read', 'finance:issue'];
    const adm = api(A.people.ADMIN!, A.slug);
    expect((await adm.payments()).status).toBe(200);
    for (const r of [await adm.record(pay('1')), await adm.allocate(p.id, [{ invoiceId: inv, amount: '1' }]), await adm.applyCredit(cn, [{ invoiceId: inv, amount: '1' }])]) {
      expect(r.status).toBe(403);
    }
    custom.ADMIN = ['business:read', 'customers:read', 'customers:write', 'sales:read', 'projects:read'];
    for (const r of [await adm.payments(), await adm.balances(), await adm.reconcile()]) expect(r.status).toBe(403);
  });
});

describe('reconciliation', () => {
  it('reports counter, settlement and content discrepancies with the record and values, and modifies nothing', async () => {
    const C = await team('pc');
    const own = api(C.people.OWNER!, C.slug);
    const cust = (await own.createCustomer({ displayName: 'Recon' })).body.customer.id;
    const inv = await issuedInvoice('100', { customerId: cust, who: C.people.OWNER!, slug: C.slug });
    const inv2 = await issuedInvoice('50', { customerId: cust, who: C.people.OWNER!, slug: C.slug });
    const p = (await own.record({ customerId: cust, amount: '80', receivedOn: PAST, method: 'CASH', allocations: [{ invoiceId: inv, amount: '40' }] })).body.payment;
    const clean = (await own.reconcile()).body.report;
    expect(clean).toMatchObject({ ok: true, discrepancies: [], truncated: false });
    expect(clean.checks.find((c: { check: string }) => c.check === 'payment_allocated_total').checked).toBe(1);

    // Simulate damage that bypassed the guards (an administrative fix with triggers disabled).
    await admin.query('BEGIN');
    await admin.query(`SET LOCAL session_replication_role = replica`);
    await admin.query(`UPDATE finance_payments SET allocated_total = 30 WHERE id = $1`, [p.id]);
    await admin.query(`UPDATE finance_documents SET notes = 'edited after issue', allocated_total = 10 WHERE id = $1`, [inv2]);
    await admin.query(`UPDATE finance_number_series SET next_value = next_value + 1 WHERE business_id = $1 AND kind = 'INVOICE'`, [C.businessId]);
    await admin.query('COMMIT');
    const snapshot = async () => (await admin.query(`SELECT
        (SELECT json_agg(p ORDER BY id) FROM finance_payments p WHERE business_id = $1) AS p,
        (SELECT json_agg(d ORDER BY id) FROM finance_documents d WHERE business_id = $1) AS d,
        (SELECT count(*) FROM audit_events WHERE business_id = $1) AS audits`, [C.businessId])).rows[0];
    const before = await snapshot();
    const report = (await own.reconcile()).body.report;
    expect(await snapshot()).toEqual(before); // read-only: nothing written, not even an audit entry
    expect(report.ok).toBe(false);
    const found = report.discrepancies.map((x: { check: string; recordId: string; expected: string; actual: string }) => [x.check, x.recordId, x.expected, x.actual]);
    expect(found).toEqual(expect.arrayContaining([
      ['payment_allocated_total', p.id, '40.0000', '30.0000'],
      ['invoice_allocated_total', inv2, '0', '10.0000'],
      ['content_hash', inv2, expect.stringMatching(/^[0-9a-f]{64}$/), expect.stringMatching(/^[0-9a-f]{64}$/)],
    ]));
    expect(found.some((f: string[]) => f[0] === 'numbering_series')).toBe(true);
    const byCheck = Object.fromEntries(report.checks.map((c: { check: string; discrepancies: number }) => [c.check, c.discrepancies]));
    expect(byCheck).toMatchObject({ payment_allocated_total: 1, invoice_allocated_total: 1, content_hash: 1, numbering_series: 1, duplicate_live_allocation: 0 });
    // Other businesses are unaffected and see none of it.
    expect((await api(B.people.OWNER!, B.slug).reconcile()).body.report.ok).toBe(true);

    // Undo the damage, so database-wide checks in other suites (finance-integrity Z1) stay meaningful.
    await admin.query('BEGIN');
    await admin.query(`SET LOCAL session_replication_role = replica`);
    await admin.query(`UPDATE finance_payments SET allocated_total = 40 WHERE id = $1`, [p.id]);
    await admin.query(`UPDATE finance_documents SET notes = NULL, allocated_total = 0 WHERE id = $1`, [inv2]);
    await admin.query(`UPDATE finance_number_series SET next_value = next_value - 1 WHERE business_id = $1 AND kind = 'INVOICE'`, [C.businessId]);
    await admin.query('COMMIT');
    expect((await own.reconcile()).body.report).toMatchObject({ ok: true, discrepancies: [] });
  });

  it('after every test above, business A reconciles cleanly', async () => {
    expect((await api(A.people.OWNER!, A.slug).reconcile()).body.report).toMatchObject({ ok: true, discrepancies: [] });
  });
});
