import { inviteForSignup, admitFixture } from './support/admission';
/**
 * Reporting R1 (docs/reporting-r1.md) through the real route handlers, against PostgreSQL with the
 * migrations and privileged SQL applied as in production. Two businesses (A in Perth, B), every role,
 * and source data created through the owning Zones' own endpoints, so every expected figure comes from
 * Finance, Sales or Customers themselves, never from a second calculation in the test.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ListSavedViewsResponse, ReportingCatalogResponse, ReportingDetailsResponse, ReportingQueryResponse, RunSavedViewResponse, SavedViewResponse,
} from '@business-os/contracts';
import type { Permission, Role } from '@/modules/access';

// Narrower permission sets for one role at a time (a finance-only analyst, a role that lost a key).
// Everything else is the real code path: the route wrapper derives permissions from the verified membership.
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
import * as opportunitiesRoute from '@/app/api/v1/b/[slug]/sales/opportunities/route';
import * as winRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/win/route';
import * as loseRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/lose/route';
import * as reopenRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/reopen/route';
import * as oppArchive from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/archive/route';
import * as invoicesRoute from '@/app/api/v1/b/[slug]/finance/invoices/route';
import * as invoiceIssue from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/issue/route';
import * as invoiceVoid from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/void/route';
import * as invoiceCreditNotes from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/credit-notes/route';
import * as creditIssue from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/issue/route';
import * as paymentsRoute from '@/app/api/v1/b/[slug]/finance/payments/route';
import * as paymentReverse from '@/app/api/v1/b/[slug]/finance/payments/[paymentId]/reverse/route';
import * as receivablesRoute from '@/app/api/v1/b/[slug]/finance/receivables/route';
import * as metricsRoute from '@/app/api/v1/b/[slug]/reporting/metrics/route';
import * as queryRoute from '@/app/api/v1/b/[slug]/reporting/query/route';
import * as detailsRoute from '@/app/api/v1/b/[slug]/reporting/details/route';
import * as viewsRoute from '@/app/api/v1/b/[slug]/reporting/views/route';
import * as viewRoute from '@/app/api/v1/b/[slug]/reporting/views/[viewId]/route';
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
const config = (over: Record<string, unknown> = {}) => ({
  metrics: [M('finance.invoiced_amount')], date: fixed('2026-10-01', '2026-11-15'), granularity: 'month', groupBy: null, filters: {},
  comparison: 'none', sort: { by: 'bucket', direction: 'asc' }, visualization: { chart: 'bar', showComparison: false }, ...over,
});
const ok = (r: Result) => {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return ReportingQueryResponse.parse(r.body);
};
const first = (r: Result) => {
  const result = ok(r).results[0]!;
  if (result.status !== 'ok') throw new Error(`metric failed: ${result.code}`);
  return result;
};
/** Exact decimal sum of amount strings with two places (AUD/USD), without floating point. */
const sum2 = (values: string[]) => {
  const zero = BigInt(0);
  const hundred = BigInt(100);
  const cents = values.reduce((s, v) => s + BigInt(v.replace('.', '')), zero);
  const sign = cents < zero ? '-' : '';
  const abs = cents < zero ? -cents : cents;
  return `${sign}${abs / hundred}.${String(abs % hundred).padStart(2, '0')}`;
};

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
const a = {
  acme: '', beta: '',
  /** Totals of A's issued AUD invoices by month, taken from Finance's own responses. */
  invoicedOct: [] as string[], invoicedNov: [] as string[], invoicedUsd: [] as string[], credited: [] as string[], acmeInvoiced: [] as string[],
  invoiceIds: [] as string[], voidedId: '', draftId: '',
};

/** Creates and issues an invoice; returns Finance's own document. */
async function invoice(who: User, slug: string, customerId: string, issueDate: string, unitPrice: string, currencyCode?: string) {
  const draft = await call(who, slug, invoicesRoute.POST, 'POST', '/finance/invoices', {}, {
    customerId, ...(currencyCode ? { currencyCode } : {}), lines: [{ description: 'Work', quantity: '1', unitPrice }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const doc = draft.body.document;
  const issued = await call(who, slug, invoiceIssue.POST, 'POST', `/finance/invoices/${doc.id}/issue`, { documentId: doc.id }, { version: doc.version, issueDate, dueDate: issueDate });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.document as { id: string; total: string; version: number; currencyCode: string };
}

beforeAll(async () => {
  A = await team('ra');
  B = await team('rb', []);
  const own = A.people.OWNER!;
  a.acme = (await call(own, A.slug, customersRoute.POST, 'POST', '/customers', {}, { displayName: 'Acme' })).body.customer.id;
  a.beta = (await call(own, A.slug, customersRoute.POST, 'POST', '/customers', {}, { displayName: 'Beta' })).body.customer.id;

  // Invoices: two in October, two in November (AUD), one in USD, one voided, one draft.
  const i1 = await invoice(own, A.slug, a.acme, '2026-10-05', '100.00');
  const i2 = await invoice(own, A.slug, a.beta, '2026-10-31', '40.00');
  const i3 = await invoice(own, A.slug, a.acme, '2026-11-01', '250.00');
  const i4 = await invoice(own, A.slug, a.beta, '2026-11-12', '19.99');
  const usd = await invoice(own, A.slug, a.acme, '2026-11-03', '75.00', 'USD');
  a.invoicedOct = [i1.total, i2.total];
  a.invoicedNov = [i3.total, i4.total];
  a.invoicedUsd = [usd.total];
  a.acmeInvoiced = [i1.total, i3.total];
  a.invoiceIds = [i1.id, i2.id, i3.id, i4.id];
  const voided = await invoice(own, A.slug, a.acme, '2026-11-02', '999.00');
  const v = await call(own, A.slug, invoiceVoid.POST, 'POST', `/finance/invoices/${voided.id}/void`, { documentId: voided.id }, { version: voided.version, reason: 'Wrong customer' });
  expect(v.status).toBe(200);
  a.voidedId = voided.id;
  a.draftId = (await call(own, A.slug, invoicesRoute.POST, 'POST', '/finance/invoices', {}, { customerId: a.acme, lines: [{ description: 'Draft', quantity: '1', unitPrice: '5000.00' }] })).body.document.id;

  // A credit note against i3, issued in November.
  const cn = await call(own, A.slug, invoiceCreditNotes.POST, 'POST', `/finance/invoices/${i3.id}/credit-notes`, { documentId: i3.id }, { lines: [{ description: 'Discount', quantity: '1', unitPrice: '10.00' }] });
  expect(cn.status).toBe(201);
  const cnIssued = await call(own, A.slug, creditIssue.POST, 'POST', `/finance/credit-notes/${cn.body.document.id}/issue`, { documentId: cn.body.document.id }, { version: 1, issueDate: '2026-11-05' });
  expect(cnIssued.status).toBe(200);
  a.credited = [cnIssued.body.document.total];

  // Payments: one in October, one in November, one reversed.
  for (const [customerId, amount, receivedOn] of [[a.acme, '60.00', '2026-10-20'], [a.beta, '25.50', '2026-11-02']] as const) {
    expect((await call(own, A.slug, paymentsRoute.POST, 'POST', '/finance/payments', {}, { customerId, amount, receivedOn, method: 'BANK_TRANSFER' })).status).toBe(201);
  }
  const bad = await call(own, A.slug, paymentsRoute.POST, 'POST', '/finance/payments', {}, { customerId: a.acme, amount: '500.00', receivedOn: '2026-11-03', method: 'CASH' });
  expect((await call(own, A.slug, paymentReverse.POST, 'POST', `/finance/payments/${bad.body.payment.id}/reverse`, { paymentId: bad.body.payment.id }, { version: bad.body.payment.version, reason: 'Bounced' })).status).toBe(200);

  // Sales: won (with and without amount), won then reopened, lost, won then archived.
  const opp = async (title: string, amount?: string, customerId = a.acme) =>
    (await call(own, A.slug, opportunitiesRoute.POST, 'POST', '/sales/opportunities', {}, { title, customerId, ...(amount ? { amount } : {}) })).body.opportunity.id as string;
  const win = (id: string) => call(own, A.slug, winRoute.POST, 'POST', `/sales/opportunities/${id}/win`, { opportunityId: id }, {});
  const won1 = await opp('Fit-out', '1200.00');
  const won2 = await opp('Unpriced', undefined, a.beta);
  const reopened = await opp('Reopened', '800.00');
  const lost = await opp('Lost', '300.00');
  const archived = await opp('Archived', '450.00');
  for (const id of [won1, won2, reopened, archived]) expect((await win(id)).status).toBe(200);
  expect((await call(own, A.slug, reopenRoute.POST, 'POST', `/sales/opportunities/${reopened}/reopen`, { opportunityId: reopened }, {})).status).toBe(200);
  expect((await call(own, A.slug, loseRoute.POST, 'POST', `/sales/opportunities/${lost}/lose`, { opportunityId: lost }, {})).status).toBe(200);
  expect((await call(own, A.slug, oppArchive.POST, 'POST', `/sales/opportunities/${archived}/archive`, { opportunityId: archived })).status).toBe(200);
  // Time-zone boundary: 31 Oct 17:30 UTC is 1 Nov 01:30 in Perth. Won time set directly (the API stamps "now").
  await admin.query("UPDATE opportunities SET closed_at = '2026-10-31T17:30:00Z' WHERE id = $1", [won1]);
  await admin.query("UPDATE opportunities SET closed_at = '2026-10-31T15:59:59Z' WHERE id = $1", [won2]); // 31 Oct 23:59:59 Perth

  // Customers: Acme and Beta (created now), one on the Perth boundary, one archived.
  const edge = (await call(own, A.slug, customersRoute.POST, 'POST', '/customers', {}, { displayName: 'Edge' })).body.customer.id;
  await admin.query("UPDATE customers SET created_at = '2026-10-31T16:00:00Z' WHERE id = $1", [edge]); // 1 Nov 00:00 Perth
  const gone = (await call(own, A.slug, customersRoute.POST, 'POST', '/customers', {}, { displayName: 'Gone' })).body.customer.id;
  await admin.query("UPDATE customers SET created_at = '2026-11-02T02:00:00Z' WHERE id = $1", [gone]);
  expect((await call(own, A.slug, customerArchive.POST, 'POST', `/customers/${gone}/archive`, { customerId: gone })).status).toBe(200);
  await admin.query("UPDATE customers SET created_at = '2026-09-15T02:00:00Z' WHERE id = ANY($1::uuid[])", [[a.acme, a.beta]]);

  // B: one invoice of its own, so isolation is about real data on both sides.
  const bc = (await call(B.people.OWNER!, B.slug, customersRoute.POST, 'POST', '/customers', {}, { displayName: 'B only' })).body.customer.id;
  await invoice(B.people.OWNER!, B.slug, bc, '2026-11-01', '7777.00');
}, 120_000);

describe('catalogue', () => {
  it('lists every registered metric with its semantics, and whether this caller may run it', async () => {
    const res = await call(A.people.MEMBER!, A.slug, metricsRoute.GET, 'GET', '/reporting/metrics');
    expect(res.status).toBe(200);
    const cat = ReportingCatalogResponse.parse(res.body);
    expect(cat.timeZone).toBe('Australia/Perth');
    const byId = Object.fromEntries(cat.metrics.map((m) => [m.id, m]));
    expect(byId['finance.invoiced_amount']).toMatchObject({ accessible: false, requires: ['finance:read'], availability: 'available' });
    expect(byId['sales.won_count']).toMatchObject({ accessible: true });
    expect(byId['people.headcount']).toMatchObject({ availability: 'planned' });
    expect(JSON.stringify(res.body)).not.toMatch(/business_id|finance_documents|SELECT/);
  });

  it('needs a signed-in member of the business in the URL', async () => {
    expect((await call(null, A.slug, metricsRoute.GET, 'GET', '/reporting/metrics')).status).toBe(401);
    expect((await call(B.people.OWNER!, A.slug, metricsRoute.GET, 'GET', '/reporting/metrics')).status).toBe(404);
  });
});

describe('financial metrics match Finance', () => {
  it('amount invoiced: issued invoices by issue date, per currency; void and draft never count', async () => {
    const r = first(await query(A.people.MANAGER!, A.slug, { metrics: [M('finance.invoiced_amount')], date: fixed('2026-10-01', '2026-11-30'), granularity: 'month' }));
    expect(r.buckets).toEqual(['2026-10-01', '2026-11-01']);
    const aud = r.series.find((s) => s.currencyCode === 'AUD')!;
    expect(aud.points.map((p) => p.value)).toEqual([sum2(a.invoicedOct), sum2(a.invoicedNov)]);
    expect(aud.total).toBe(sum2([...a.invoicedOct, ...a.invoicedNov]));
    const usd = r.series.find((s) => s.currencyCode === 'USD')!;
    expect(usd.total).toBe(sum2(a.invoicedUsd));
    expect(r.series).toHaveLength(2);
    expect(r.notes.join(' ')).toMatch(/never converted/);
  });

  it('counts invoices and keeps credit notes separate (never netted)', async () => {
    const r = ok(await query(A.people.OWNER!, A.slug, {
      metrics: [M('finance.invoices_issued'), M('finance.credited_amount')], date: fixed('2026-10-01', '2026-11-30'), granularity: 'none',
    }));
    const [count, credited] = r.results as Extract<(typeof r.results)[number], { status: 'ok' }>[];
    expect(count!.series[0]!.total).toBe('5'); // four AUD + one USD; the voided one and the draft are excluded
    expect(credited!.series[0]!.total).toBe(sum2(a.credited));
  });

  it('amount received: recorded payments by date received; reversed payments never count', async () => {
    const r = first(await query(A.people.OWNER!, A.slug, { metrics: [M('finance.payments_received')], date: fixed('2026-10-01', '2026-11-30'), granularity: 'month' }));
    expect(r.series[0]!.points.map((p) => p.value)).toEqual(['60.00', '25.50']);
  });

  it('outstanding receivables are exactly the Finance overview figures', async () => {
    const finance = await call(A.people.OWNER!, A.slug, receivablesRoute.GET, 'GET', '/finance/receivables');
    const r = ok(await query(A.people.OWNER!, A.slug, {
      metrics: [M('finance.receivables_outstanding'), M('finance.receivables_overdue')], date: { kind: 'relative', preset: 'this_month' }, granularity: 'none',
    }));
    for (const [i, field] of [[0, 'outstanding'], [1, 'overdue']] as const) {
      const result = r.results[i]!;
      if (result.status !== 'ok') throw new Error('failed');
      expect(result.temporal).toBe('snapshot');
      expect(result.asOf).toBe(finance.body.receivables.asOf);
      expect(Object.fromEntries(result.series.map((s) => [s.currencyCode, s.total])))
        .toEqual(Object.fromEntries(finance.body.receivables.currencies.map((c: Record<string, string>) => [c.currencyCode, c[field]])));
    }
  });

  it('filters by currency and customer, and groups by customer with names', async () => {
    const r = first(await query(A.people.MANAGER!, A.slug, {
      metrics: [M('finance.invoiced_amount')], date: fixed('2026-10-01', '2026-11-30'), granularity: 'none', groupBy: 'customer', filters: { currencyCode: 'AUD' },
    }));
    const acme = r.series.find((s) => s.customerId === a.acme)!;
    expect(acme.label).toBe('Acme (AUD)');
    expect(acme.total).toBe(sum2(a.acmeInvoiced));
    expect(r.series.every((s) => s.currencyCode === 'AUD')).toBe(true);
    const one = first(await query(A.people.MANAGER!, A.slug, {
      metrics: [M('finance.invoiced_amount')], date: fixed('2026-10-01', '2026-11-30'), granularity: 'none', filters: { customerId: a.acme, currencyCode: 'AUD' },
    }));
    expect(one.series[0]!.total).toBe(sum2(a.acmeInvoiced));
  });

  it('compares with the previous period', async () => {
    const r = first(await query(A.people.OWNER!, A.slug, {
      metrics: [M('finance.invoiced_amount')], date: fixed('2026-11-01', '2026-11-30'), granularity: 'week', comparison: 'previous_period', filters: { currencyCode: 'AUD' },
    }));
    const res = ok(await query(A.people.OWNER!, A.slug, { metrics: [M('finance.invoiced_amount')], date: fixed('2026-11-01', '2026-11-30'), comparison: 'previous_period' }));
    // The 30 days immediately before 1–30 November: 2–31 October (both October invoices fall inside it).
    expect(res.comparisonRange).toEqual({ from: '2026-10-02', to: '2026-10-31' });
    const s = r.series[0]!;
    expect(s.total).toBe(sum2(a.invoicedNov));
    expect(s.comparisonTotal).toBe(sum2(a.invoicedOct));
    // November has six Monday weeks in range, 2–31 October five: aligned by position, the shorter side simply ends.
    expect(s.points).toHaveLength(6);
    expect(s.comparisonPoints).toHaveLength(5);
    expect(s.changePercent).not.toBeNull();
  });

  it('places records by business-local date at day boundaries', async () => {
    const r = first(await query(A.people.OWNER!, A.slug, { metrics: [M('finance.invoiced_amount')], date: fixed('2026-10-31', '2026-11-01'), granularity: 'day', filters: { currencyCode: 'AUD' } }));
    expect(r.series[0]!.points).toEqual([{ bucket: '2026-10-31', value: a.invoicedOct[1] }, { bucket: '2026-11-01', value: a.invoicedNov[0] }]);
  });
});

describe('sales and customer metrics', () => {
  it('won value and count: current wins by won date in Perth; reopened, lost and archived excluded', async () => {
    const r = ok(await query(A.people.MEMBER!, A.slug, {
      metrics: [M('sales.won_value'), M('sales.won_count')], date: fixed('2026-10-01', '2026-11-30'), granularity: 'month',
    }));
    const [value, count] = r.results as Extract<(typeof r.results)[number], { status: 'ok' }>[];
    // 17:30 UTC on 31 Oct is November in Perth; 15:59:59 UTC is still 31 October.
    expect(value!.series[0]!.points.map((p) => p.value)).toEqual(['0.00', '1200.00']);
    expect(count!.series[0]!.points.map((p) => p.value)).toEqual(['1', '1']);
  });

  it('new customers: created date in Perth, archived excluded', async () => {
    const r = first(await query(A.people.MEMBER!, A.slug, { metrics: [M('customers.new_customers')], date: fixed('2026-09-01', '2026-11-30'), granularity: 'month' }));
    expect(r.series[0]!.points.map((p) => p.value)).toEqual(['2', '0', '1']);
  });

  it('an empty business returns empty money series and zero counts, not errors', async () => {
    const empty = await team('re', []);
    const r = ok(await query(empty.people.OWNER!, empty.slug, {
      metrics: [M('finance.invoiced_amount'), M('customers.new_customers'), M('finance.receivables_outstanding')], date: { kind: 'relative', preset: 'last_30_days' }, granularity: 'week',
    }));
    const [inv, cust, recv] = r.results as Extract<(typeof r.results)[number], { status: 'ok' }>[];
    expect(inv!.series).toEqual([]);
    expect(cust!.series[0]!.total).toBe('0');
    expect(recv!.series).toEqual([]);
  });
});

describe('access', () => {
  it('requires the source Zone key on top of reporting:read', async () => {
    expect((await query(A.people.MEMBER!, A.slug, { metrics: [M('finance.invoiced_amount')], date: fixed('2026-10-01', '2026-11-30') })).status).toBe(403);
    expect((await query(A.people.MEMBER!, A.slug, { metrics: [M('sales.won_count'), M('finance.payments_received')], date: fixed('2026-10-01', '2026-11-30') })).status).toBe(403);
    expect((await details(A.people.MEMBER!, A.slug, { metric: M('finance.invoiced_amount'), date: fixed('2026-10-01', '2026-11-30') })).status).toBe(403);
  });

  it('refuses everyone without reporting:read, even with every source key', async () => {
    custom.MANAGER = ['business:read', 'finance:read', 'customers:read', 'sales:read'];
    expect((await query(A.people.MANAGER!, A.slug, { metrics: [M('finance.invoiced_amount')], date: fixed('2026-10-01', '2026-11-30') })).status).toBe(403);
    expect((await call(A.people.MANAGER!, A.slug, viewsRoute.GET, 'GET', '/reporting/views')).status).toBe(403);
  });

  it('customer names need customers:read: grouping is refused and drill-down leaves them out', async () => {
    custom.MANAGER = ['business:read', 'reporting:read', 'finance:read'];
    expect((await query(A.people.MANAGER!, A.slug, { metrics: [M('finance.invoiced_amount')], date: fixed('2026-10-01', '2026-11-30'), groupBy: 'customer' })).status).toBe(403);
    const d = await details(A.people.MANAGER!, A.slug, { metric: M('finance.invoiced_amount'), date: fixed('2026-10-01', '2026-11-30') });
    expect(d.status).toBe(200);
    expect(d.body.columns.map((c: { key: string }) => c.key)).not.toContain('customer');
    expect(JSON.stringify(d.body)).not.toMatch(/Acme|Beta/);
  });

  it('never shows another business\'s data, through any entry point', async () => {
    const r = first(await query(B.people.OWNER!, B.slug, { metrics: [M('finance.invoiced_amount')], date: fixed('2026-10-01', '2026-11-30'), granularity: 'none' }));
    expect(r.series.map((s) => s.total)).toEqual([r.series[0]!.total]);
    expect(r.series[0]!.total).not.toBe(sum2([...a.invoicedOct, ...a.invoicedNov]));
    const aIds = new Set([a.acme, a.beta, ...a.invoiceIds]);
    const d = await details(B.people.OWNER!, B.slug, { metric: M('finance.invoiced_amount'), date: fixed('2026-10-01', '2026-11-30'), limit: 100 });
    expect(d.body.rows.some((row: { id: string }) => aIds.has(row.id))).toBe(false);
    // A customer id from A as a filter in B finds nothing (it is not B's), rather than leaking A's totals.
    const f = first(await query(B.people.OWNER!, B.slug, { metrics: [M('finance.invoiced_amount')], date: fixed('2026-10-01', '2026-11-30'), filters: { customerId: a.acme } }));
    expect(f.series).toEqual([]);
    // B's owner cannot use A's slug at all.
    expect((await query(B.people.OWNER!, A.slug, { metrics: [M('sales.won_count')], date: fixed('2026-10-01', '2026-11-30') })).status).toBe(404);
  });
});

describe('drill-down', () => {
  it('pages through exactly the records behind the total, newest first, without repeats', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await details(A.people.OWNER!, A.slug, { metric: M('finance.invoiced_amount'), date: fixed('2026-10-01', '2026-11-30'), filters: { currencyCode: 'AUD' }, limit: 1, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      const page = ReportingDetailsResponse.parse(res.body);
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...a.invoiceIds].sort());
    expect(seen).not.toContain(a.voidedId);
    expect(seen).not.toContain(a.draftId);
    const all = await details(A.people.OWNER!, A.slug, { metric: M('finance.invoiced_amount'), date: fixed('2026-10-01', '2026-11-30'), filters: { currencyCode: 'AUD' } });
    expect(all.body.rows.map((r: { id: string }) => r.id)).toEqual(seen);
    expect(all.body.columns.map((c: { key: string }) => c.key)).toContain('customer');
    expect(sum2(all.body.rows.map((r: { cells: { total: string } }) => r.cells.total))).toBe(sum2([...a.invoicedOct, ...a.invoicedNov]));
  });

  it('refuses tampered or foreign cursors, oversize pages and snapshot metrics', async () => {
    const page = await details(A.people.OWNER!, A.slug, { metric: M('finance.invoiced_amount'), date: fixed('2026-10-01', '2026-11-30'), limit: 1 });
    const foreign = await details(A.people.OWNER!, A.slug, { metric: M('finance.payments_received'), date: fixed('2026-10-01', '2026-11-30'), limit: 1, cursor: page.body.nextCursor });
    expect(foreign).toMatchObject({ status: 400, body: { error: 'invalid_cursor' } });
    expect((await details(A.people.OWNER!, A.slug, { metric: M('finance.invoiced_amount'), date: fixed('2026-10-01', '2026-11-30'), cursor: 'bm90LWEtY3Vyc29y' })).body.error).toBe('invalid_cursor');
    expect((await details(A.people.OWNER!, A.slug, { metric: M('finance.invoiced_amount'), date: fixed('2026-10-01', '2026-11-30'), limit: 101 })).status).toBe(400);
    expect((await details(A.people.OWNER!, A.slug, { metric: M('finance.receivables_outstanding'), date: fixed('2026-10-01', '2026-11-30') })).body.error).toBe('no_detail');
    const customers = await details(A.people.OWNER!, A.slug, { metric: M('customers.new_customers'), date: fixed('2026-09-01', '2026-11-30'), limit: 1 });
    const next = await details(A.people.OWNER!, A.slug, { metric: M('customers.new_customers'), date: fixed('2026-09-01', '2026-11-30'), limit: 5, cursor: customers.body.nextCursor });
    expect(next.status).toBe(200);
    expect(next.body.rows.map((r: { id: string }) => r.id)).not.toContain(customers.body.rows[0].id);
    expect(next.body.rows).toHaveLength(2);
  });
});

describe('limits and malicious input', () => {
  const base = { metrics: [M('sales.won_count')], date: fixed('2026-10-01', '2026-11-30') };
  it.each([
    ['unknown metric', { ...base, metrics: [M('finance.revenue')] }, 'unknown_metric'],
    ['retired version', { ...base, metrics: [M('sales.won_count', 9)] }, 'metric_version_unsupported'],
    ['planned metric', { ...base, metrics: [M('people.headcount')] }, 'metric_unavailable'],
    ['unsupported filter', { ...base, metrics: [M('customers.new_customers')], filters: { currencyCode: 'AUD' } }, 'unsupported_filter'],
    ['unsupported dimension', { ...base, metrics: [M('customers.new_customers')], groupBy: 'customer' }, 'unsupported_dimension'],
    ['reversed range', { ...base, date: fixed('2026-11-30', '2026-10-01') }, 'invalid_date_range'],
    ['range too large', { ...base, date: fixed('2020-01-01', '2026-11-30') }, 'range_too_large'],
    ['too many buckets', { ...base, date: fixed('2025-01-01', '2026-11-30'), granularity: 'day' }, 'too_many_buckets'],
  ])('%s → 400 %s', async (_label, body, error) => {
    expect(await query(A.people.OWNER!, A.slug, body)).toMatchObject({ status: 400, body: { error } });
  });

  it.each([
    ['raw SQL', { ...base, sql: 'SELECT * FROM finance_documents' }],
    ['injection in a metric id', { ...base, metrics: [{ id: "sales.won_count'; DROP TABLE customers; --", version: 1 }] }],
    ['a table name as dimension', { ...base, groupBy: 'finance_documents.customer_id' }],
    ['a business id filter', { ...base, filters: { businessId: '00000000-0000-4000-8000-000000000000' } }],
    ['injection in a customer filter', { ...base, filters: { customerId: "' OR 1=1 --" } }],
    ['seven metrics', { ...base, metrics: Array.from({ length: 7 }, () => M('sales.won_count')) }],
    ['an impossible date', { ...base, date: fixed('2026-02-30', '2026-03-01') }],
  ])('%s → 400 invalid_input', async (_label, body) => {
    expect(await query(A.people.OWNER!, A.slug, body)).toMatchObject({ status: 400, body: { error: 'invalid_input' } });
  });
});

describe('saved views', () => {
  const create = (who: User, body: unknown) => call(who, A.slug, viewsRoute.POST, 'POST', '/reporting/views', {}, body);
  const get = (who: User, id: string) => call(who, A.slug, viewRoute.GET, 'GET', `/reporting/views/${id}`, { viewId: id });
  const patch = (who: User, id: string, body: unknown) => call(who, A.slug, viewRoute.PATCH, 'PATCH', `/reporting/views/${id}`, { viewId: id }, body);
  const remove = (who: User, id: string) => call(who, A.slug, viewRoute.DELETE, 'DELETE', `/reporting/views/${id}`, { viewId: id });
  const run = (who: User, id: string, slug = A.slug) => call(who, slug, runRoute.POST, 'POST', `/reporting/views/${id}/run`, { viewId: id });
  const list = async (who: User) => ListSavedViewsResponse.parse((await call(who, A.slug, viewsRoute.GET, 'GET', '/reporting/views')).body).views;

  it('saves a private report, reopens it and gets the same figures as running it directly', async () => {
    const mgr = A.people.MANAGER!;
    const saved = await create(mgr, { title: 'Monthly invoicing', config: config({ comparison: 'previous_period' }) });
    expect(saved.status).toBe(201);
    const view = SavedViewResponse.parse(saved.body).view;
    expect(view).toMatchObject({ visibility: 'PRIVATE', isOwner: true, version: 1, ownerUserId: mgr.id });
    expect(JSON.stringify(view.config)).not.toMatch(/series|total/);
    const ran = RunSavedViewResponse.parse((await run(mgr, view.id)).body);
    const direct = ok(await query(mgr, A.slug, { metrics: view.config.metrics, date: view.config.date, granularity: 'month', comparison: 'previous_period' }));
    expect(ran.result).toEqual(direct);
    // Stored: configuration only.
    const { rows } = await admin.query('SELECT config, visibility FROM reporting_saved_views WHERE id = $1', [view.id]);
    expect(Object.keys(rows[0].config).sort()).toEqual(['comparison', 'date', 'filters', 'granularity', 'groupBy', 'metrics', 'sort', 'visualization']);
    // Private: invisible to everyone else, including the OWNER of the business.
    expect((await get(A.people.OWNER!, view.id)).status).toBe(404);
    expect((await run(A.people.OWNER!, view.id)).status).toBe(404);
    expect((await list(A.people.OWNER!)).map((v) => v.id)).not.toContain(view.id);
    expect((await patch(A.people.OWNER!, view.id, { version: 1, title: 'Mine now' })).status).toBe(404);
    expect((await remove(A.people.OWNER!, view.id)).status).toBe(404);
  });

  it('cannot save a view over data its owner cannot read, nor share without reporting:share', async () => {
    const mem = A.people.MEMBER!;
    expect((await create(mem, { title: 'Finance', config: config() })).status).toBe(403);
    expect((await create(mem, { title: 'Sales', visibility: 'BUSINESS', config: config({ metrics: [M('sales.won_count')] }) })).status).toBe(403);
    const mine = await create(mem, { title: 'Sales', config: config({ metrics: [M('sales.won_count')] }) });
    expect(mine.status).toBe(201);
    expect((await patch(mem, mine.body.view.id, { version: 1, visibility: 'BUSINESS' })).status).toBe(403);
    expect(await create(mem, { title: 'Bad', config: config({ metrics: [M('sales.nope')] }) })).toMatchObject({ status: 400, body: { error: 'unknown_metric' } });
    expect(await create(mem, { title: 'Bad', config: config({ metrics: [M('customers.new_customers')], groupBy: 'customer' }) })).toMatchObject({ status: 400, body: { error: 'unsupported_dimension' } });
    expect((await create(mem, { title: 'Bad', config: { ...config(), results: [{ total: '1' }] } })).status).toBe(400);
    expect((await create(mem, { title: '', config: config({ metrics: [M('sales.won_count')] }) })).status).toBe(400);
  });

  it('shares a view only with people who can read every source it uses; only the owner edits', async () => {
    const mgr = A.people.MANAGER!;
    const shared = (await create(mgr, { title: 'Team finance', visibility: 'BUSINESS', config: config() })).body.view;
    const salesShared = (await create(mgr, { title: 'Team sales', visibility: 'BUSINESS', config: config({ metrics: [M('sales.won_count')] }) })).body.view;
    // MEMBER has no finance:read: the finance view is not listed and answers 404 everywhere.
    const memberList = await list(A.people.MEMBER!);
    expect(memberList.map((v) => v.id)).not.toContain(shared.id);
    expect(memberList.map((v) => v.id)).toContain(salesShared.id);
    expect((await get(A.people.MEMBER!, shared.id)).status).toBe(404);
    expect((await run(A.people.MEMBER!, shared.id)).status).toBe(404);
    // ADMIN can read finance: sees it, runs it as ADMIN, cannot edit it.
    expect((await list(A.people.ADMIN!)).find((v) => v.id === shared.id)).toMatchObject({ isOwner: false, issues: [] });
    const ran = RunSavedViewResponse.parse((await run(A.people.ADMIN!, shared.id)).body);
    expect(ran.result.results[0]!.status).toBe('ok');
    expect((await patch(A.people.ADMIN!, shared.id, { version: 1, title: 'Hijack' })).status).toBe(403);
    // Optimistic concurrency for the owner.
    expect((await patch(mgr, shared.id, { version: 1, title: 'Team invoicing' })).body.view).toMatchObject({ title: 'Team invoicing', version: 2 });
    expect(await patch(mgr, shared.id, { version: 1, title: 'Stale' })).toMatchObject({ status: 409, body: { error: 'stale' } });
    // Deleting someone else's shared view needs reporting:manage (ADMIN yes, MEMBER no).
    expect((await remove(A.people.MEMBER!, salesShared.id)).status).toBe(403);
    expect((await remove(A.people.ADMIN!, salesShared.id)).status).toBe(200);
    expect((await get(mgr, salesShared.id)).status).toBe(404);
    // Another business never sees it.
    expect((await call(B.people.OWNER!, B.slug, viewRoute.GET, 'GET', `/reporting/views/${shared.id}`, { viewId: shared.id })).status).toBe(404);
    expect((await run(B.people.OWNER!, shared.id, B.slug)).status).toBe(404);
    const audit = await admin.query("SELECT action FROM audit_events WHERE target_id = $1 ORDER BY created_at", [shared.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['reporting.view.created', 'reporting.view.updated']);
  });

  it('never grants access: a view whose owner later loses a source key runs that metric as an error with no data', async () => {
    const mgr = A.people.MANAGER!;
    const view = (await create(mgr, { title: 'Mixed', config: config({ metrics: [M('finance.invoiced_amount'), M('sales.won_count')] }) })).body.view;
    custom.MANAGER = ['business:read', 'reporting:read', 'reporting:save', 'sales:read'];
    const res = RunSavedViewResponse.parse((await run(mgr, view.id)).body);
    expect(res.result.results[0]).toMatchObject({ status: 'error', code: 'forbidden_source' });
    expect(res.result.results[0]).not.toHaveProperty('series');
    expect(res.result.results[1]!.status).toBe('ok');
    expect((await list(mgr)).find((v) => v.id === view.id)!.issues.join(' ')).toMatch(/do not have access/);
  });

  it('validates stored configurations against the current registry on every run', async () => {
    const mgr = A.people.MANAGER!;
    const view = (await create(mgr, { title: 'Old', config: config({ metrics: [M('finance.invoiced_amount'), M('sales.won_count')] }) })).body.view;
    // As if saved by an older or newer release: a retired version and a metric that no longer exists.
    await admin.query(`UPDATE reporting_saved_views SET config = jsonb_set(config, '{metrics}', '[{"id":"finance.invoiced_amount","version":7},{"id":"sales.retired","version":1}]') WHERE id = $1`, [view.id]);
    const res = RunSavedViewResponse.parse((await run(mgr, view.id)).body);
    expect(res.result.results.map((r) => r.status === 'error' && r.code)).toEqual(['metric_version_unsupported', 'unknown_metric']);
    expect((await list(mgr)).find((v) => v.id === view.id)!.issues).toHaveLength(2);
    // An unreadable format is reported, never guessed at.
    await admin.query('UPDATE reporting_saved_views SET config_version = 99 WHERE id = $1', [view.id]);
    expect(await run(mgr, view.id)).toMatchObject({ status: 400, body: { error: 'view_config_invalid' } });
    expect(await get(mgr, view.id)).toMatchObject({ status: 409, body: { error: 'view_config_invalid' } });
    expect((await remove(mgr, view.id)).status).toBe(200);
  });

  it('the database enforces owner and visibility rules even if the service did not (RLS)', async () => {
    const own = A.people.OWNER!;
    const view = (await create(own, { title: 'Private', config: config() })).body.view;
    const asUser = async (userId: string, sql: string, params: unknown[] = []) => {
      await app.query('BEGIN');
      try {
        await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [A.businessId, userId]);
        return await app.query(sql, params);
      } finally {
        await app.query('ROLLBACK');
      }
    };
    const other = A.people.ADMIN!.id;
    expect((await asUser(other, 'SELECT id FROM reporting_saved_views WHERE id = $1', [view.id])).rowCount).toBe(0);
    expect((await asUser(other, "UPDATE reporting_saved_views SET title = 'x' WHERE id = $1", [view.id])).rowCount).toBe(0);
    expect((await asUser(other, 'DELETE FROM reporting_saved_views WHERE id = $1', [view.id])).rowCount).toBe(0);
    await expect(asUser(other, `INSERT INTO reporting_saved_views (id, business_id, owner_user_id, updated_by_id, title, config) VALUES ($1, $2, $3, $3, 't', '{}')`,
      [randomUUID(), A.businessId, own.id])).rejects.toThrow(/row-level security/);
    await expect(asUser(own.id, 'UPDATE reporting_saved_views SET owner_user_id = $2 WHERE id = $1', [view.id, other])).rejects.toThrow(/permission denied/);
    // Another business sees nothing, whatever the user.
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [B.businessId, own.id]);
    expect((await app.query('SELECT id FROM reporting_saved_views')).rowCount).toBe(0);
    await app.query('ROLLBACK');
    const policies = await admin.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'reporting_saved_views'");
    expect(policies.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});

describe('saved-view list pagination (audit R1-2)', () => {
  type Page = { views: { id: string; isOwner: boolean }[]; nextCursor: string | null };
  const page = async (who: User, qs: string): Promise<{ status: number; body: Page }> =>
    call(who, A.slug, viewsRoute.GET, 'GET', `/reporting/views?${qs}`);
  async function all(who: User, scope: string, limit: number) {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const res = await page(who, `scope=${scope}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const parsed = ListSavedViewsResponse.parse(res.body);
      expect(parsed.views.length).toBeLessThanOrEqual(limit);
      ids.push(...parsed.views.map((v) => v.id));
      cursor = parsed.nextCursor;
      if (!cursor) return ids;
    }
    throw new Error('did not finish');
  }
  /** Inserts shared views owned by `owner` directly (bulk), each newer than everything already there. */
  async function bulk(owner: User, n: number, metric: string): Promise<string[]> {
    const cfg = JSON.stringify(config({ metrics: [M(metric)] }));
    const { rows } = await admin.query(
      `INSERT INTO reporting_saved_views (id, business_id, owner_user_id, updated_by_id, title, config, visibility, updated_at)
       SELECT gen_random_uuid(), $1, $2, $2, 'Bulk ' || g, $3::jsonb, 'BUSINESS', now() + g * interval '1 millisecond'
         FROM generate_series(1, $4::int) AS g RETURNING id::text`, [A.businessId, owner.id, cfg, n]);
    return rows.map((r) => r.id);
  }

  it('never hides a caller\'s own views behind more than 500 newer views from others, visible or not', async () => {
    const mem = A.people.MEMBER!;
    const mgr = A.people.MANAGER!;
    const own = (await call(mem, A.slug, viewsRoute.POST, 'POST', '/reporting/views', {}, { title: 'Member own', config: config({ metrics: [M('sales.won_count')] }) })).body.view;
    await admin.query("UPDATE reporting_saved_views SET updated_at = now() - interval '1 day' WHERE id = $1", [own.id]);
    const hidden = await bulk(mgr, 520, 'finance.invoiced_amount'); // MEMBER cannot read Finance: skipped
    const visible = await bulk(mgr, 30, 'sales.won_count'); // shared and readable by MEMBER
    // Interleave so filtering happens inside pages, not only at the edges.
    await admin.query("UPDATE reporting_saved_views SET updated_at = updated_at + interval '1 second' WHERE id = ANY($1::uuid[])", [visible.filter((_, i) => i % 2 === 0)]);

    const seen = await all(mem, 'all', 25);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(own.id);
    for (const id of visible) expect(seen).toContain(id);
    for (const id of hidden) expect(seen).not.toContain(id);

    // Their own views are also complete under scope=mine, on the first page.
    expect((await page(mem, 'scope=mine&limit=100')).body.views.map((v) => v.id)).toContain(own.id);

    // The owner of 550+ views reaches every one of them, newest first, without repeats.
    const mgrSeen = await all(mgr, 'mine', 100);
    expect(new Set(mgrSeen).size).toBe(mgrSeen.length);
    for (const id of [...hidden, ...visible]) expect(mgrSeen).toContain(id);
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM reporting_saved_views WHERE business_id = $1 AND owner_user_id = $2', [A.businessId, mgr.id]);
    expect(mgrSeen).toHaveLength(rows[0].n);
  });

  it('refuses tampered cursors and cursors from another scope', async () => {
    const mgr = A.people.MANAGER!;
    const first = await page(mgr, 'scope=mine&limit=1');
    expect(first.body.nextCursor).toBeTruthy();
    expect(await page(mgr, `scope=all&limit=1&cursor=${first.body.nextCursor}`)).toMatchObject({ status: 400, body: { error: 'invalid_cursor' } });
    expect((await page(mgr, 'scope=mine&limit=1&cursor=bm90LWEtY3Vyc29y')).status).toBe(400);
    expect((await page(mgr, 'scope=mine&limit=101')).status).toBe(400);
  });
});
