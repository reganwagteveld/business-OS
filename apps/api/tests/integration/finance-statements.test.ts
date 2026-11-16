/**
 * Finance F6-2 (docs/finance-billing-f6.md §4): customer statements, receivables ageing and statement
 * PDFs through the real route handlers against PostgreSQL with the migrations applied as in production.
 * The accounting core is unit-tested in tests/unit/finance-receivables.test.ts; this suite proves the
 * loader's effective dates, the routes, permissions, tenant isolation, audit and agreement with the
 * F2/F4 counters.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Permission, Role } from '@/modules/access';
import { ReceivablesAgeingDetailResponse, ReceivablesAgeingResponse, StatementResponse } from '@business-os/contracts';

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
import * as invoicesRoute from '@/app/api/v1/b/[slug]/finance/invoices/route';
import * as invoiceIssue from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/issue/route';
import * as invoiceVoid from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/void/route';
import * as invoiceDiscard from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/discard/route';
import * as invoiceCredit from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/credit-notes/route';
import * as creditIssue from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/issue/route';
import * as applicationsRoute from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/applications/route';
import * as paymentsRoute from '@/app/api/v1/b/[slug]/finance/payments/route';
import * as allocationsRoute from '@/app/api/v1/b/[slug]/finance/payments/[paymentId]/allocations/route';
import * as paymentReverse from '@/app/api/v1/b/[slug]/finance/payments/[paymentId]/reverse/route';
import * as balancesRoute from '@/app/api/v1/b/[slug]/finance/customer-balances/route';
import * as receivablesRoute from '@/app/api/v1/b/[slug]/finance/receivables/route';
import * as statementRoute from '@/app/api/v1/b/[slug]/finance/statements/route';
import * as statementPdfRoute from '@/app/api/v1/b/[slug]/finance/statements/pdf/route';
import * as ageingRoute from '@/app/api/v1/b/[slug]/finance/receivables-ageing/route';
import * as ageingDetailRoute from '@/app/api/v1/b/[slug]/finance/receivables-ageing/detail/route';
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

let ip = 1;
const IP_BLOCK = Number(process.env.STATEMENTS_TEST_IP_BLOCK ?? 120);
type User = { email: string; cookie: string; id: string };

function req(method: string, path: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.${IP_BLOCK}.${Math.floor(ip / 250)}.${ip++ % 250}`, origin: ORIGIN, ...(opts.headers ?? {}) });
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const json = async (res: Response) => ({ status: res.status, body: await res.json() });

async function newUser(prefix: string): Promise<User> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  await authRoute.POST(req('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: prefix } }));
  const mail = [...devOutbox].reverse().find((m) => m.to === email)!;
  const link = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!);
  const verify = new Request(`${BASE}${link.pathname}${link.search}`, { headers: { 'x-forwarded-for': `100.${IP_BLOCK}.250.${ip++ % 250}` } });
  await authRoute.GET(verify);
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
  return { slug, people };
}

const api = (who: User, slug: string) => {
  const F = `/api/v1/b/${slug}/finance`;
  const d = (documentId: string) => ctx({ slug, documentId });
  type PostRoute = { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> };
  const post = (route: PostRoute, path: string, c: ReturnType<typeof ctx>, body?: unknown, headers?: Record<string, string>) =>
    route.POST(req('POST', `${F}${path}`, { cookie: who.cookie, body, headers }), c).then(json);
  const get = (route: { GET: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> }, path: string) =>
    route.GET(req('GET', `${F}${path}`, { cookie: who.cookie }), ctx({ slug }));
  return {
    createCustomer: (displayName: string) => customersRoute.POST(req('POST', `/api/v1/b/${slug}/customers`, { cookie: who.cookie, body: { displayName } }), ctx({ slug })).then(json),
    createInvoice: (body: unknown) => post(invoicesRoute, '/invoices', ctx({ slug }), body),
    issue: (id: string, body: unknown) => post(invoiceIssue, `/invoices/${id}/issue`, d(id), body),
    void: (id: string, body: unknown) => post(invoiceVoid, `/invoices/${id}/void`, d(id), body),
    discard: (id: string, body: unknown) => post(invoiceDiscard, `/invoices/${id}/discard`, d(id), body),
    credit: (invoiceId: string, body: unknown) => post(invoiceCredit, `/invoices/${invoiceId}/credit-notes`, d(invoiceId), body),
    issueCredit: (id: string, body: unknown) => post(creditIssue, `/credit-notes/${id}/issue`, d(id), body),
    applyCredit: (creditNoteId: string, applications: { invoiceId: string; amount: string }[]) =>
      post(applicationsRoute, `/credit-notes/${creditNoteId}/applications`, d(creditNoteId), { applications }),
    record: (body: unknown) => post(paymentsRoute, '/payments', ctx({ slug }), body, { 'idempotency-key': `pay-${randomUUID()}` }),
    allocate: (paymentId: string, allocations: { invoiceId: string; amount: string }[]) =>
      post(allocationsRoute, `/payments/${paymentId}/allocations`, ctx({ slug, paymentId }), { allocations }),
    reversePayment: (paymentId: string, body: unknown) => post(paymentReverse, `/payments/${paymentId}/reverse`, ctx({ slug, paymentId }), body),
    balances: (qs: string) => get(balancesRoute, `/customer-balances${qs}`).then(json),
    receivables: () => get(receivablesRoute, '/receivables').then(json),
    statement: (qs: string) => get(statementRoute, `/statements${qs}`).then(json),
    statementPdf: (qs: string) => get(statementPdfRoute, `/statements/pdf${qs}`),
    ageing: (qs = '') => get(ageingRoute, `/receivables-ageing${qs}`).then(json),
    ageingDetail: (qs: string) => get(ageingDetailRoute, `/receivables-ageing/detail${qs}`).then(json),
  };
};

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Perth', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const tomorrow = () => new Date(Date.parse(`${today()}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const line = (unitPrice: string) => ({ description: 'Work', quantity: '1', unitPrice });

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let acme: string;
let other: string;
/** The scenario's records (see beforeAll). */
/** Each issued document's current version (voiding needs it). */
const versions = new Map<string, number>();
const ids = {} as { i1: string; i2: string; eur: string; p1: string; c1: string; p2: string };

async function issuedInvoice(customerId: string, amount: string, issueDate: string, dueDate: string, currencyCode?: string) {
  const own = api(A.people.OWNER!, A.slug);
  const draft = await own.createInvoice({ customerId, currencyCode, lines: [line(amount)] });
  expect(draft.status).toBe(201);
  const issued = await own.issue(draft.body.document.id, { version: 1, issueDate, dueDate });
  expect(issued.status).toBe(200);
  versions.set(issued.body.document.id, issued.body.document.version);
  return issued.body.document.id as string;
}

/**
 * Acme (AUD), with past business dates; every allocation, application, void and reversal happens today:
 *   I1 100.00 issued 2026-01-10 due 2026-02-09    P1 60.00 received 2026-02-01, allocated to I1 (today)
 *   I2  50.00 issued 2026-02-05 due 2026-03-07    voided today
 *   C1  20.00 credit note on I1 issued 2026-02-15 15.00 applied to I1 (today)
 *   P2  30.00 received 2026-03-01                 reversed today
 *   a discarded draft (never numbered) and a EUR invoice of 40.00 issued 2026-02-20, due 2026-03-22
 */
beforeAll(async () => {
  A = await team('st');
  B = await team('su');
  const own = api(A.people.OWNER!, A.slug);
  acme = (await own.createCustomer('Acme')).body.customer.id;
  other = (await own.createCustomer('Other')).body.customer.id;
  ids.i1 = await issuedInvoice(acme, '100.00', '2026-01-10', '2026-02-09');
  ids.i2 = await issuedInvoice(acme, '50.00', '2026-02-05', '2026-03-07');
  ids.eur = await issuedInvoice(acme, '40.00', '2026-02-20', '2026-03-22', 'EUR');
  await issuedInvoice(other, '70.00', '2026-01-20', '2026-01-20');
  const draft = await own.createInvoice({ customerId: acme, lines: [line('999.00')] });
  expect((await own.discard(draft.body.document.id, { version: 1 })).status).toBe(200);

  const p1 = await own.record({ customerId: acme, amount: '60.00', receivedOn: '2026-02-01', method: 'BANK_TRANSFER', reference: 'EFT 1' });
  expect(p1.status).toBe(201);
  ids.p1 = p1.body.payment.id;
  expect((await own.allocate(ids.p1, [{ invoiceId: ids.i1, amount: '60.00' }])).status).toBe(200);

  const cnDraft = await own.credit(ids.i1, { lines: [line('20.00')] });
  expect(cnDraft.status).toBe(201);
  const cn = await own.issueCredit(cnDraft.body.document.id, { version: 1, issueDate: '2026-02-15' });
  expect(cn.status).toBe(200);
  ids.c1 = cn.body.document.id;
  expect((await own.applyCredit(ids.c1, [{ invoiceId: ids.i1, amount: '15.00' }])).status).toBe(200);

  const p2 = await own.record({ customerId: acme, amount: '30.00', receivedOn: '2026-03-01', method: 'CASH' });
  ids.p2 = p2.body.payment.id;
  expect((await own.reversePayment(ids.p2, { version: 1, reason: 'Bounced' })).status).toBe(200);
  expect((await own.void(ids.i2, { version: versions.get(ids.i2)!, reason: 'Raised in error' })).status).toBe(200);
}, 180_000);

const q = (o: Record<string, string>) => `?${new URLSearchParams(o).toString()}`;

describe('customer statements (D-F6-10)', () => {
  it('balance forward over a past range: later voids and reversals never reach it; allocations are not entries', async () => {
    const res = await api(A.people.OWNER!, A.slug).statement(q({ customerId: acme, currencyCode: 'AUD', from: '2026-01-01', to: '2026-03-31' }));
    expect(res.status).toBe(200);
    StatementResponse.parse(res.body);
    const s = res.body.statement;
    expect(s).toMatchObject({ openingBalance: '0.00', closingBalance: '40.00', timeZone: 'Australia/Perth' });
    expect(s.entries.map((e: { date: string; type: string; amount: string; balance: string }) => [e.date, e.type, e.amount, e.balance])).toEqual([
      ['2026-01-10', 'INVOICE', '100.00', '100.00'],
      ['2026-02-01', 'PAYMENT', '-60.00', '40.00'],
      ['2026-02-05', 'INVOICE', '50.00', '90.00'],
      ['2026-02-15', 'CREDIT_NOTE', '-20.00', '70.00'],
      ['2026-03-01', 'PAYMENT', '-30.00', '40.00'],
    ]);
    // At 31 March nothing was allocated or applied yet (that happened today): invoices fully open, credit separate.
    expect(s.position).toMatchObject({
      receivable: '150.00', unallocatedPayments: '90.00', unappliedCredit: '20.00', accountBalance: '40.00', balanced: true,
      buckets: { current: '0.00', days1To30: '50.00', days31To60: '100.00', days61To90: '0.00', days90Plus: '0.00', noDueDate: '0.00' },
    });
  });

  it('up to today: the void and reversal appear on today, and the position equals the F2 counters', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const s = (await own.statement(q({ customerId: acme, currencyCode: 'AUD', from: '2026-03-01', to: today() }))).body.statement;
    expect(s.openingBalance).toBe('70.00');
    expect(s.entries.map((e: { type: string; date: string }) => [e.type, e.date])).toEqual([['PAYMENT', '2026-03-01'], ['PAYMENT_REVERSAL', today()], ['INVOICE_VOID', today()]]);
    expect(s.closingBalance).toBe('20.00');
    const counters = (await own.balances(q({ customerId: acme, currencyCode: 'AUD' }))).body.balances[0];
    expect(s.position).toMatchObject({ receivable: counters.receivable, overdue: counters.overdue, unallocatedPayments: counters.unallocatedPayments, unappliedCredit: counters.unappliedCredit, balanced: true });
    expect(s.position.receivable).toBe('25.00');
  });

  it('keeps currencies apart and leaves discarded drafts out', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const eur = (await own.statement(q({ customerId: acme, currencyCode: 'EUR', from: '2026-01-01', to: today() }))).body.statement;
    expect(eur.entries.map((e: { reference: string; amount: string }) => e.amount)).toEqual(['40.00']);
    const aud = (await own.statement(q({ customerId: acme, currencyCode: 'AUD', from: '2026-01-01', to: today() }))).body.statement;
    expect(aud.entries.some((e: { amount: string }) => e.amount === '999.00')).toBe(false);
    const none = (await own.statement(q({ customerId: acme, currencyCode: 'JPY', from: '2026-01-01', to: today() }))).body.statement;
    expect(none).toMatchObject({ currencyScale: 0, openingBalance: '0', closingBalance: '0', entries: [] });
  });

  it('refuses dates after today and a reversed range; another business\'s customer is not found', async () => {
    const own = api(A.people.OWNER!, A.slug);
    expect((await own.statement(q({ customerId: acme, currencyCode: 'AUD', from: '2026-01-01', to: tomorrow() }))).body.error).toBe('invalid_dates');
    expect((await own.statement(q({ customerId: acme, currencyCode: 'AUD', from: '2026-03-01', to: '2026-02-01' }))).status).toBe(400);
    expect((await api(B.people.OWNER!, B.slug).statement(q({ customerId: acme, currencyCode: 'AUD', from: '2026-01-01', to: today() }))).status).toBe(404);
  });
});

describe('receivables ageing (D-F6-11)', () => {
  it('as of a past date: buckets from dated settlement, credit separate, totals reconcile', async () => {
    const res = await api(A.people.MANAGER!, A.slug).ageing(q({ asOf: '2026-03-31', currencyCode: 'AUD' }));
    expect(res.status).toBe(200);
    ReceivablesAgeingResponse.parse(res.body);
    const { totals, rows } = res.body.ageing;
    const acmeRow = rows.find((r: { customerId: string }) => r.customerId === acme);
    expect(acmeRow).toMatchObject({ receivable: '150.00', overdue: '150.00', unallocatedPayments: '90.00', unappliedCredit: '20.00', openInvoiceCount: 2, balanced: true });
    expect(totals).toEqual([expect.objectContaining({ currencyCode: 'AUD', receivable: '220.00', customerCount: 2, openInvoiceCount: 3, balanced: true })]);
    expect(totals[0].buckets).toMatchObject({ days1To30: '50.00', days31To60: '100.00', days61To90: '70.00' });
  });

  it('as of today the totals equal the Finance overview receivables (R1 snapshot metrics)', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const ageing = (await own.ageing()).body.ageing;
    const overview = (await own.receivables()).body.receivables.currencies;
    for (const c of overview) {
      const t = ageing.totals.find((x: { currencyCode: string }) => x.currencyCode === c.currencyCode);
      expect(t, c.currencyCode).toMatchObject({ receivable: c.outstanding, overdue: c.overdue, unallocatedPayments: c.unallocatedPayments, unappliedCredit: c.unappliedCredit, openInvoiceCount: c.openCount });
    }
    expect(ageing.totals.length).toBe(overview.length);
  });

  it('drill-down lists each open invoice with its bucket and each credit separately', async () => {
    const res = await api(A.people.OWNER!, A.slug).ageingDetail(q({ asOf: '2026-03-31', customerId: acme, currencyCode: 'AUD' }));
    expect(res.status).toBe(200);
    ReceivablesAgeingDetailResponse.parse(res.body);
    const d = res.body.detail;
    expect(d.invoices.map((i: { invoiceId: string; outstanding: string; daysPastDue: number; bucket: string }) => [i.invoiceId, i.outstanding, i.daysPastDue, i.bucket])).toEqual([
      [ids.i1, '100.00', 50, 'DAYS_31_60'], [ids.i2, '50.00', 24, 'DAYS_1_30'],
    ]);
    expect(d.credits.map((c: { kind: string; sourceId: string; available: string }) => [c.kind, c.sourceId, c.available])).toEqual([
      ['PAYMENT', ids.p1, '60.00'], ['CREDIT_NOTE', ids.c1, '20.00'], ['PAYMENT', ids.p2, '30.00'],
    ]);
    const now = (await api(A.people.OWNER!, A.slug).ageingDetail(q({ customerId: acme, currencyCode: 'AUD' }))).body.detail;
    expect(now.invoices).toEqual([expect.objectContaining({ invoiceId: ids.i1, paid: '60.00', credited: '15.00', outstanding: '25.00' })]);
    expect(now.credits).toEqual([expect.objectContaining({ kind: 'CREDIT_NOTE', available: '5.00' })]);
  });

  it('pages rows with a cursor bound to the date; refuses a future date', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const first = (await own.ageing(q({ asOf: '2026-03-31', limit: '1' }))).body.ageing;
    expect(first.rows).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const rest = (await own.ageing(q({ asOf: '2026-03-31', limit: '10', cursor: first.nextCursor }))).body.ageing;
    expect([...first.rows, ...rest.rows].map((r: { customerId: string; currencyCode: string }) => `${r.customerId}${r.currencyCode}`).sort())
      .toEqual([`${acme}AUD`, `${acme}EUR`, `${other}AUD`].sort());
    expect((await own.ageing(q({ asOf: '2026-04-30', cursor: first.nextCursor }))).status).toBe(400);
    expect((await own.ageing(q({ asOf: tomorrow() }))).body.error).toBe('invalid_dates');
  });

  it('binds the cursor to the customer and currency filters; filtered paging still works', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const key = (r: { customerId: string; currencyCode: string }) => `${r.customerId}${r.currencyCode}`;
    const asOf = '2026-03-31';

    // Currency filter: two AUD rows (acme, other), one per page; the page size may change.
    const aud1 = (await own.ageing(q({ asOf, currencyCode: 'AUD', limit: '1' }))).body.ageing;
    expect(aud1.nextCursor).not.toBeNull();
    const aud2 = await own.ageing(q({ asOf, currencyCode: 'AUD', limit: '5', cursor: aud1.nextCursor }));
    expect(aud2.status).toBe(200);
    expect(aud2.body.ageing.nextCursor).toBeNull();
    expect([...aud1.rows, ...aud2.body.ageing.rows].map(key).sort()).toEqual([`${acme}AUD`, `${other}AUD`].sort());
    for (const changed of <Record<string, string>[]>[{}, { currencyCode: 'EUR' }, { currencyCode: 'AUD', customerId: acme }]) {
      const res = await own.ageing(q({ asOf, limit: '1', ...changed, cursor: aud1.nextCursor }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_cursor');
    }

    // Customer filter: acme has AUD and EUR rows.
    const acme1 = (await own.ageing(q({ asOf, customerId: acme, limit: '1' }))).body.ageing;
    expect(acme1.nextCursor).not.toBeNull();
    const acme2 = await own.ageing(q({ asOf, customerId: acme, limit: '1', cursor: acme1.nextCursor }));
    expect(acme2.status).toBe(200);
    expect([...acme1.rows, ...acme2.body.ageing.rows].map(key).sort()).toEqual([`${acme}AUD`, `${acme}EUR`].sort());
    for (const changed of <Record<string, string>[]>[{}, { customerId: other }, { customerId: acme, currencyCode: 'EUR' }]) {
      const res = await own.ageing(q({ asOf, limit: '1', ...changed, cursor: acme1.nextCursor }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_cursor');
    }

    // An unfiltered cursor is refused once a filter is added.
    const all1 = (await own.ageing(q({ asOf, limit: '1' }))).body.ageing;
    for (const changed of <Record<string, string>[]>[{ customerId: acme }, { currencyCode: 'AUD' }]) {
      const res = await own.ageing(q({ asOf, limit: '1', ...changed, cursor: all1.nextCursor }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_cursor');
    }
  });
});

describe('access, audit and PDFs', () => {
  it('finance:read gives statements and ageing to MANAGER; MEMBER has no finance access', async () => {
    const qs = q({ customerId: acme, currencyCode: 'AUD', from: '2026-01-01', to: today() });
    expect((await api(A.people.MANAGER!, A.slug).statement(qs)).status).toBe(200);
    expect((await api(A.people.MEMBER!, A.slug).statement(qs)).status).toBe(403);
    expect((await api(A.people.MEMBER!, A.slug).ageing()).status).toBe(403);
  });

  it('the PDF is an audited attachment rendered on demand: hash audited, nothing stored, no contents logged', async () => {
    const qs = q({ customerId: acme, currencyCode: 'AUD', from: '2026-01-01', to: '2026-03-31' });
    const before = (await admin.query('SELECT count(*)::int AS n FROM finance_document_pdfs')).rows[0].n;
    const res = await api(A.people.MANAGER!, A.slug).statementPdf(qs);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="statement-AUD-2026-01-01-to-2026-03-31\.pdf"/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await admin.query('SELECT count(*)::int AS n FROM finance_document_pdfs')).rows[0].n).toBe(before);
    const { rows } = await admin.query(
      "SELECT actor_user_id, target_type, metadata FROM audit_events WHERE target_id = $1 AND action = 'finance.statement_pdf.downloaded' ORDER BY created_at DESC LIMIT 1", [acme],
    );
    expect(rows[0]).toMatchObject({ actor_user_id: A.people.MANAGER!.id, target_type: 'customer' });
    expect(rows[0].metadata).toEqual({ currencyCode: 'AUD', from: '2026-01-01', to: '2026-03-31', fileSha256: res.headers.get('x-document-sha256'), template: 'statement-standard@1' });
  });

  it('the PDF follows F5\'s download rule (finance:documents_download), not finance:read alone', async () => {
    custom.MANAGER = ['finance:read'];
    const res = await api(A.people.MANAGER!, A.slug).statementPdf(q({ customerId: acme, currencyCode: 'AUD', from: '2026-01-01', to: '2026-03-31' }));
    expect(res.status).toBe(403);
    expect((await api(A.people.MEMBER!, A.slug).statementPdf(q({ customerId: acme, currencyCode: 'AUD', from: '2026-01-01', to: '2026-03-31' }))).status).toBe(403);
  });

  it('another business cannot render a statement for this customer', async () => {
    const res = await api(B.people.OWNER!, B.slug).statementPdf(q({ customerId: acme, currencyCode: 'AUD', from: '2026-01-01', to: '2026-03-31' }));
    expect(res.status).toBe(404);
    const ageing = (await api(B.people.OWNER!, B.slug).ageing()).body.ageing;
    expect(ageing.rows).toEqual([]);
  });
});
