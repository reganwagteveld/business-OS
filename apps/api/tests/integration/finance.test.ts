/**
 * Finance Zone F1 (docs/finance-data-model.md, ADR 0007): quotes, invoices, credit notes and finance
 * settings through the real route handlers, against PostgreSQL with the migrations and privileged SQL
 * applied as in production. Two independent businesses and every membership role. The database-level
 * integrity suite (the F0 spike moved onto the migrated tables) is finance-integrity.test.ts.
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
type User = { email: string; cookie: string; id: string };

function req(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.80.${Math.floor(ip / 250)}.${ip++ % 250}`, ...(opts.headers ?? {}) });
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
  };
};
const audits = async (targetId: string) =>
  (await admin.query('SELECT action, actor_user_id, business_id, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows;

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let custA: string;
let custA2: string;
let custB: string;
let gst: string;
beforeAll(async () => {
  A = await team('fa');
  B = await team('fb', 'EUR');
  const owner = api(A.people.OWNER!, A.slug);
  custA = (await owner.createCustomer({ displayName: 'Acme', legalName: 'Acme Pty Ltd', addressLine1: '1 Old Street', city: 'Perth', countryCode: 'AU', taxNumber: '51 824 753 556', taxNumberType: 'au_abn' })).body.customer.id;
  custA2 = (await owner.createCustomer({ displayName: 'Globex' })).body.customer.id;
  custB = (await api(B.people.OWNER!, B.slug).createCustomer({ displayName: 'B customer' })).body.customer.id;
  gst = (await owner.createTaxRate({ name: 'GST', ratePercent: '10' })).body.taxRate.id;
  await owner.patchSettings({ version: 0, sellerLegalName: 'A Business Pty Ltd', sellerAddress: '9 Seller Street, Perth', sellerIdentifiers: [{ label: 'ABN', value: '12 345 678 901' }], defaultPaymentTermsDays: 30 });
}, 180_000);

const line = (over: Record<string, unknown> = {}) => ({ description: 'Consulting', quantity: '2', unitPrice: '150', ...over });

describe('quote to invoice', () => {
  it('drafts, issues and accepts a quote, converts it to a draft invoice without touching the quote, and issues the invoice', async () => {
    const mgr = api(A.people.MANAGER!, A.slug);
    const own = api(A.people.OWNER!, A.slug);
    const q = await mgr.createQuote({ customerId: custA, lines: [line({ taxRateId: gst }), line({ description: 'Travel', quantity: '1', unitPrice: '99.99' })] });
    expect(q.status).toBe(201);
    expect(q.body.document).toMatchObject({
      kind: 'QUOTE', status: 'DRAFT', number: null, currencyCode: 'AUD', currencyScale: 2, taxMode: 'EXCLUSIVE',
      subtotal: '399.99', taxTotal: '30.00', total: '429.99', allocatedTotal: '0.00', version: 1, createdById: A.people.MANAGER!.id,
    });
    expect(q.body.document.lines.map((l: { position: number; taxName: string | null; lineNet: string }) => [l.position, l.taxName, l.lineNet]))
      .toEqual([[1000, 'GST', '300.00'], [2000, null, '99.99']]);
    const quoteId = q.body.document.id;

    expect((await mgr.issue('quotes', quoteId, { version: 1 })).status).toBe(403); // MANAGER drafts but does not issue (FD-P1)
    const issued = await own.issue('quotes', quoteId, { version: 1, issueDate: '2026-11-14', validUntil: '2026-12-14' });
    expect(issued.status).toBe(200);
    expect(issued.body.document).toMatchObject({ status: 'ISSUED', number: expect.stringMatching(/^Q-\d{4}$/), issueDate: '2026-11-14', validUntil: '2026-12-14', issuedById: A.people.OWNER!.id });
    expect(issued.body.document.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.body.document.sellerSnapshot).toMatchObject({ legalName: 'A Business Pty Ltd', identifiers: [{ label: 'ABN', value: '12 345 678 901' }], countryCode: 'AU' });
    expect(issued.body.document.billToSnapshot).toMatchObject({ customerId: custA, name: 'Acme Pty Ltd', taxNumber: '51 824 753 556', addressLine1: '1 Old Street' });

    const accepted = await own.accept(quoteId, { version: 2 });
    expect(accepted.body.document).toMatchObject({ status: 'ACCEPTED', statusChangedById: A.people.OWNER!.id, allocatedTotal: '0.00' }); // acceptance is not payment

    const before = (await own.get('quotes', quoteId)).body.document;
    const conv = await mgr.convert(quoteId, { dueDate: '2026-12-31' });
    expect(conv.status).toBe(201);
    expect(conv.body.document).toMatchObject({ kind: 'INVOICE', status: 'DRAFT', number: null, sourceQuoteId: quoteId, customerId: custA, total: '429.99', dueDate: '2026-12-31' });
    expect(conv.body.document.lines.map((l: { description: string }) => l.description)).toEqual(['Consulting', 'Travel']);
    expect((await own.get('quotes', quoteId)).body.document).toEqual(before); // the quote is untouched

    const invoiceId = conv.body.document.id;
    const edited = await mgr.patch('invoices', invoiceId, { version: 1, lines: [line({ description: 'Travel', quantity: '1', unitPrice: '99.99' }), line({ taxRateId: gst, quantity: '3' })] });
    expect(edited.body.document).toMatchObject({ version: 2, subtotal: '549.99', taxTotal: '45.00', total: '594.99' });
    const inv = await own.issue('invoices', invoiceId, { version: 2, issueDate: '2026-11-15' });
    expect(inv.body.document).toMatchObject({ status: 'ISSUED', number: expect.stringMatching(/^INV-\d{4}$/), dueDate: '2026-12-31', total: '594.99' });
    expect((await audits(invoiceId)).map((e) => e.action)).toEqual(['finance.document.created', 'finance.document.updated', 'finance.document.issued']);
    const issuedAudit = (await audits(invoiceId)).find((e) => e.action === 'finance.document.issued')!;
    expect(issuedAudit.metadata).toMatchObject({ kind: 'INVOICE', number: inv.body.document.number, currencyCode: 'AUD', total: '594.99', contentSha256: inv.body.document.contentSha256 });
    expect(JSON.stringify(await audits(invoiceId))).not.toMatch(/Consulting|Acme|Seller Street/); // no free text in the audit log
  });

  it('due dates come from the request, the draft or the default payment terms, and never precede the issue date', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const draft = (await own.createInvoice({ customerId: custA, lines: [line()] })).body.document;
    expect(await own.issue('invoices', draft.id, { version: 1, issueDate: '2026-11-20', dueDate: '2026-11-19' })).toMatchObject({ status: 400, body: { error: 'invalid_dates' } });
    const ok = await own.issue('invoices', draft.id, { version: 1, issueDate: '2026-11-20' });
    expect(ok.body.document.dueDate).toBe('2026-12-20'); // 30 days default terms
    const q = (await own.createQuote({ customerId: custA, lines: [line()] })).body.document;
    expect(await own.issue('quotes', q.id, { version: 1, dueDate: '2026-12-01' })).toMatchObject({ status: 400, body: { error: 'invalid_dates' } });
    expect(await own.createQuote({ customerId: custA, dueDate: '2026-12-01' })).toMatchObject({ status: 400, body: { error: 'invalid_input' } });
  });
});

describe('lifecycle and invalid transitions', () => {
  it('follows the lifecycle per kind and refuses everything else with explicit errors', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const q = (await own.createQuote({ customerId: custA, lines: [line()] })).body.document;
    expect(await own.accept(q.id, { version: 1 })).toMatchObject({ status: 409, body: { error: 'invalid_state' } }); // a draft cannot be accepted
    expect(await own.convert(q.id)).toMatchObject({ status: 409, body: { error: 'quote_not_convertible' } });
    await own.issue('quotes', q.id, { version: 1 });
    expect(await own.issue('quotes', q.id, { version: 2 })).toMatchObject({ status: 409, body: { error: 'invalid_state' } });
    expect(await own.patch('quotes', q.id, { version: 2, notes: 'changed' })).toMatchObject({ status: 409, body: { error: 'immutable' } });
    expect(await own.accept(q.id, { version: 1 })).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect((await own.decline(q.id, { version: 2 })).body.document.status).toBe('DECLINED');
    expect(await own.accept(q.id, { version: 3 })).toMatchObject({ status: 409, body: { error: 'invalid_state' } });
    expect(await own.void('quotes', q.id, { version: 3, reason: 'x' })).toMatchObject({ status: 409, body: { error: 'invalid_state' } }); // declined is final
    expect(await own.convert(q.id)).toMatchObject({ status: 409, body: { error: 'quote_not_convertible' } });

    const q2 = (await own.createQuote({ customerId: custA, lines: [line()] })).body.document;
    await own.issue('quotes', q2.id, { version: 1 });
    expect((await own.expire(q2.id, { version: 2 })).body.document.status).toBe('EXPIRED');
    const q3 = (await own.createQuote({ customerId: custA, lines: [line()] })).body.document;
    await own.issue('quotes', q3.id, { version: 1 });
    await own.accept(q3.id, { version: 2 });
    const voided = await own.void('quotes', q3.id, { version: 3, reason: 'Customer withdrew' });
    expect(voided.body.document).toMatchObject({ status: 'VOID', voidReason: 'Customer withdrew', voidedById: A.people.OWNER!.id, number: expect.stringMatching(/^Q-/) });
    expect(voided.body.document.voidedAt).not.toBeNull();

    // Invoices: void requires a reason; void is final; the number and amounts stay.
    const inv = (await own.createInvoice({ customerId: custA, lines: [line()] })).body.document;
    expect(await own.void('invoices', inv.id, { version: 1, reason: 'draft' })).toMatchObject({ status: 409, body: { error: 'invalid_state' } }); // drafts are discarded
    const issued = (await own.issue('invoices', inv.id, { version: 1 })).body.document;
    expect((await own.void('invoices', inv.id, { version: 2 })).status).toBe(400);
    expect((await own.void('invoices', inv.id, { version: 2, reason: '   ' })).status).toBe(400);
    const v = (await own.void('invoices', inv.id, { version: 2, reason: 'Wrong customer' })).body.document;
    expect(v).toMatchObject({ status: 'VOID', number: issued.number, total: issued.total, contentSha256: issued.contentSha256, voidReason: 'Wrong customer' });
    expect(v.lines).toEqual(issued.lines);
    expect(await own.void('invoices', inv.id, { version: 3, reason: 'again' })).toMatchObject({ status: 409, body: { error: 'invalid_state' } });
    expect(await own.credit(inv.id)).toMatchObject({ status: 409, body: { error: 'invoice_not_open' } });

    // Discarding a draft: never numbered, MANAGER may do it, and it is final.
    const mgr = api(A.people.MANAGER!, A.slug);
    const draft = (await mgr.createInvoice({ customerId: custA, lines: [line()] })).body.document;
    const discarded = (await mgr.discard('invoices', draft.id, { version: 1 })).body.document;
    expect(discarded).toMatchObject({ status: 'VOID', number: null, contentSha256: null, issuedAt: null });
    expect(await own.issue('invoices', draft.id, { version: 2 })).toMatchObject({ status: 409, body: { error: 'invalid_state' } });
    expect((await own.void('invoices', draft.id, { version: 2, reason: 'x' })).status).toBe(409);
  });

  it('refuses issuing an empty document, and edits after issue', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const empty = (await own.createInvoice({ customerId: custA })).body.document;
    expect(await own.issue('invoices', empty.id, { version: 1 })).toMatchObject({ status: 400, body: { error: 'no_lines' } });
    expect((await own.get('invoices', empty.id)).body.document).toMatchObject({ status: 'DRAFT', number: null });
  });

  it('keeps kinds apart: a quote id is not an invoice, and a credit note is created only from an issued invoice', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const q = (await own.createQuote({ customerId: custA, lines: [line()] })).body.document;
    expect((await own.get('invoices', q.id)).status).toBe(404);
    expect((await own.issue('invoices', q.id, { version: 1 })).status).toBe(404);
    expect((await own.credit(q.id)).status).toBe(404);
    expect((await own.get('quotes', 'not-a-uuid')).status).toBe(404);
  });
});

describe('credit notes', () => {
  it('credits an issued invoice in its own series without settling it, never beyond its total, and blocks voiding while live', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = (await own.createInvoice({ customerId: custA, lines: [line({ taxRateId: gst })] })).body.document; // 300 + 30
    await own.issue('invoices', inv.id, { version: 1 });
    const cn = await own.credit(inv.id, { copyInvoiceLines: true });
    expect(cn.status).toBe(201);
    expect(cn.body.document).toMatchObject({ kind: 'CREDIT_NOTE', status: 'DRAFT', creditedInvoiceId: inv.id, customerId: custA, currencyCode: 'AUD', total: '330.00' });
    expect(await own.patch('credit-notes', cn.body.document.id, { version: 1, customerId: custA2 })).toMatchObject({ status: 400 });
    // A draft credit note is live: the invoice cannot be voided until it is discarded or voided.
    expect(await own.void('invoices', inv.id, { version: 2, reason: 'x' })).toMatchObject({ status: 409, body: { error: 'invoice_credited' } });
    const partial = await own.patch('credit-notes', cn.body.document.id, { version: 1, lines: [line({ quantity: '1', unitPrice: '100', taxRateId: gst })] });
    expect(partial.body.document.total).toBe('110.00');
    const issuedCn = await own.issue('credit-notes', cn.body.document.id, { version: 2 });
    expect(issuedCn.body.document).toMatchObject({ status: 'ISSUED', number: expect.stringMatching(/^CN-\d{4}$/) });
    expect((await own.get('invoices', inv.id)).body.document).toMatchObject({ status: 'ISSUED', allocatedTotal: '0.00' }); // not settled by a credit note

    const tooMuch = (await own.credit(inv.id, { lines: [line({ quantity: '1', unitPrice: '200.01', taxRateId: gst })] })).body.document; // 220.01 > 330 - 110
    expect(await own.issue('credit-notes', tooMuch.id, { version: 1 })).toMatchObject({ status: 409, body: { error: 'credit_exceeds_invoice' } });
    const rest = (await own.credit(inv.id, { lines: [line({ quantity: '1', unitPrice: '200', taxRateId: gst })] })).body.document; // exactly 220
    await api(A.people.MANAGER!, A.slug).discard('invoices', tooMuch.id, { version: 1 }).then((r) => expect(r.status).toBe(404)); // wrong kind
    expect((await own.issue('credit-notes', rest.id, { version: 1 })).body.document.status).toBe('ISSUED');
    expect((await own.list('credit-notes', `?invoiceId=${inv.id}&status=issued`)).body.documents).toHaveLength(2);

    // Void path: void the credit notes (and discard the oversized draft), then the invoice can be voided.
    await own.void('credit-notes', issuedCn.body.document.id, { version: 3, reason: 'Issued in error' });
    await own.void('credit-notes', rest.id, { version: 2, reason: 'Issued in error' });
    expect(await own.void('invoices', inv.id, { version: 2, reason: 'x' })).toMatchObject({ status: 409, body: { error: 'invoice_credited' } });
    const { rows } = await admin.query('SELECT version FROM finance_documents WHERE id = $1', [tooMuch.id]);
    await own.void('credit-notes', tooMuch.id, { version: rows[0].version, reason: 'x' }).then((r) => expect(r.body.error).toBe('invalid_state'));
    expect((await api(A.people.OWNER!, A.slug).list('credit-notes', `?invoiceId=${inv.id}&status=draft`)).body.documents).toHaveLength(1);
  });
});

describe('settings, numbering and tax rates', () => {
  it('numbers each kind gaplessly from a custom starting value that is fixed once used (FD-L1)', async () => {
    const C = await team('fc');
    const own = api(C.people.OWNER!, C.slug);
    const cust = (await own.createCustomer({ displayName: 'Initech' })).body.customer.id;
    expect(await own.issue('invoices', (await own.createInvoice({ customerId: cust, lines: [line()] })).body.document.id, { version: 1 }))
      .toMatchObject({ status: 400, body: { error: 'due_date_required' } }); // no due date and no default terms: nothing is assumed
    await own.patchSettings({ version: 0, defaultPaymentTermsDays: 7 });
    const series = (await own.series()).body.series;
    expect(series.map((s: { kind: string; nextNumber: string; used: boolean; version: number }) => [s.kind, s.nextNumber, s.used, s.version]))
      .toEqual([['QUOTE', 'Q-0001', false, 0], ['INVOICE', 'INV-0001', false, 0], ['CREDIT_NOTE', 'CN-0001', false, 0]]);
    expect(await api(C.people.MANAGER!, C.slug).patchSeries('invoice', { version: 0, startingValue: 1043 })).toMatchObject({ status: 403 });
    const set = await own.patchSeries('invoice', { version: 0, prefix: 'TAX-', minDigits: 6, startingValue: 1043 });
    expect(set.body.series).toMatchObject({ kind: 'INVOICE', prefix: 'TAX-', minDigits: 6, startingValue: 1043, nextValue: 1043, nextNumber: 'TAX-001043', used: false, version: 1 });
    expect(await own.patchSeries('invoice', { version: 0, minDigits: 5 })).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect((await own.patchSeries('invoice', { version: 1, startingValue: 1000 })).body.series.nextValue).toBe(1000); // still unused: may move
    expect((await own.patchSeries('bogus', { version: 0, prefix: 'X' })).status).toBe(404);

    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = (await own.createInvoice({ customerId: cust, lines: [line()] })).body.document;
      numbers.push((await own.issue('invoices', d.id, { version: 1 })).body.document.number);
    }
    expect(numbers).toEqual(['TAX-001000', 'TAX-001001', 'TAX-001002']);
    expect(await own.patchSeries('invoice', { version: 2, startingValue: 1 })).toMatchObject({ status: 409, body: { error: 'series_in_use' } });
    expect(await own.patchSeries('invoice', { version: 2, startingValue: 5000 })).toMatchObject({ status: 409, body: { error: 'series_in_use' } });
    // Prefix and padding stay editable; issued documents keep their numbers.
    expect((await own.patchSeries('invoice', { version: 2, prefix: 'T', minDigits: 3 })).body.series).toMatchObject({ nextNumber: 'T1003', used: true });
    const d = (await own.createInvoice({ customerId: cust, lines: [line()] })).body.document;
    expect((await own.issue('invoices', d.id, { version: 1 })).body.document.number).toBe('T1003');
    // Voided numbers stay in the sequence: void one, the next is still consecutive.
    await own.void('invoices', d.id, { version: 2, reason: 'mistake' });
    const e = (await own.createInvoice({ customerId: cust, lines: [line()] })).body.document;
    expect((await own.issue('invoices', e.id, { version: 1 })).body.document.number).toBe('T1004');
    const quote = (await own.createQuote({ customerId: cust, lines: [line()] })).body.document;
    expect((await own.issue('quotes', quote.id, { version: 1 })).body.document.number).toBe('Q-0001'); // its own series
    const changes = (await admin.query("SELECT metadata FROM audit_events WHERE business_id = $1 AND action = 'finance.settings.changed' ORDER BY created_at", [C.businessId])).rows;
    expect(changes.map((r) => r.metadata)).toEqual(expect.arrayContaining([
      expect.objectContaining({ setting: 'number_series', kind: 'INVOICE', startingValueFrom: '1', startingValueTo: '1043' }),
      expect.objectContaining({ setting: 'number_series', kind: 'INVOICE', startingValueFrom: '1043', startingValueTo: '1000' }),
    ]));
  });

  it('tax rates: percentages never change, archived rates cannot be newly used, lines keep the name they were issued with', async () => {
    const own = api(A.people.OWNER!, A.slug);
    expect(await api(A.people.MANAGER!, A.slug).createTaxRate({ name: 'X', ratePercent: '5' })).toMatchObject({ status: 403 });
    for (const body of [{ name: 'Bad', ratePercent: '100.5' }, { name: 'Bad', ratePercent: 10 }, { name: '', ratePercent: '5' }, { name: 'Bad', ratePercent: '5.12345' }]) {
      expect((await own.createTaxRate(body)).status, JSON.stringify(body)).toBe(400);
    }
    const vat = (await own.createTaxRate({ name: 'VAT 7.625', ratePercent: '7.625' })).body.taxRate;
    expect(vat.ratePercent).toBe('7.625');
    expect((await own.patchTaxRate(vat.id, { ratePercent: '8' })).status).toBe(400); // not a writable field
    const inv = (await own.createInvoice({ customerId: custA, lines: [line({ taxRateId: vat.id, quantity: '1', unitPrice: '100' })] })).body.document;
    expect(inv).toMatchObject({ taxTotal: '7.63', total: '107.63' }); // 7.625 rounds half away from zero
    await own.issue('invoices', inv.id, { version: 1 });
    expect((await own.patchTaxRate(vat.id, { name: 'Renamed', archived: true })).body.taxRate).toMatchObject({ name: 'Renamed', archivedAt: expect.any(String) });
    expect((await own.get('invoices', inv.id)).body.document.lines[0]).toMatchObject({ taxName: 'VAT 7.625', taxRatePercent: '7.625' });
    expect(await own.createInvoice({ customerId: custA, lines: [line({ taxRateId: vat.id })] })).toMatchObject({ status: 409, body: { error: 'archived_reference' } });
    expect((await own.taxRates()).body.taxRates.map((r: { id: string }) => r.id)).not.toContain(vat.id);
    expect((await own.taxRates('?archived=all')).body.taxRates.map((r: { id: string }) => r.id)).toContain(vat.id);
    const { rows } = await admin.query('SELECT rate_percent::text AS p FROM finance_tax_rates WHERE id = $1', [vat.id]);
    expect(rows[0].p).toBe('7.6250');
  });

  it('refuses unsupported tax modes explicitly instead of computing them as exclusive (FD-T1)', async () => {
    const own = api(A.people.OWNER!, A.slug);
    expect(await own.createInvoice({ customerId: custA, taxMode: 'INCLUSIVE', lines: [line()] })).toMatchObject({ status: 400, body: { error: 'unsupported_tax_mode' } });
    expect(await own.createQuote({ customerId: custA, taxMode: 'COMPOUND' })).toMatchObject({ status: 400, body: { error: 'unsupported_tax_mode' } });
    const ok = await own.createInvoice({ customerId: custA, taxMode: 'EXCLUSIVE', lines: [line()] });
    expect(ok.status).toBe(201);
    expect(await own.patch('invoices', ok.body.document.id, { version: 1, taxMode: 'INCLUSIVE' })).toMatchObject({ status: 400, body: { error: 'unsupported_tax_mode' } });
  });

  it('settings: seller details, defaults and retention with optimistic concurrency; retention never below 7 years (FD-L3)', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const s = (await own.settings()).body.settings;
    expect(s).toMatchObject({ sellerLegalName: 'A Business Pty Ltd', defaultPaymentTermsDays: 30, defaultCurrency: 'AUD', retentionYears: 7, legalHold: false, hasRetainedRecords: true, version: 1 });
    expect(await own.patchSettings({ version: 1, retentionYears: 6 })).toMatchObject({ status: 400 });
    expect(await own.patchSettings({ version: 0, retentionYears: 10 })).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect(await api(A.people.MANAGER!, A.slug).patchSettings({ version: 1, retentionYears: 10 })).toMatchObject({ status: 403 });
    const next = (await own.patchSettings({ version: 1, retentionYears: 10, legalHold: true })).body.settings;
    expect(next).toMatchObject({ retentionYears: 10, legalHold: true, version: 2 });
    expect(await own.patchSettings({ version: 2, defaultTaxRateId: randomUUID() })).toMatchObject({ status: 400, body: { error: 'invalid_tax_rate' } });
    const audit = (await admin.query("SELECT metadata FROM audit_events WHERE business_id = $1 AND action = 'finance.settings.changed' AND metadata->>'setting' = 'settings' ORDER BY created_at DESC LIMIT 1", [A.businessId])).rows[0];
    expect(audit.metadata).toMatchObject({ fields: ['legalHold', 'retentionYears'], retentionYearsFrom: '7', retentionYearsTo: '10', legalHoldFrom: 'false', legalHoldTo: 'true' });
    await own.patchSettings({ version: 2, retentionYears: 7, legalHold: false });
  });
});

describe('concurrent first saves (re-audit)', () => {
  it('racing first saves of the settings and of a number series: exactly one wins, the others get 409 stale, one audit entry each', async () => {
    const C = await team('fs');
    const own = api(C.people.OWNER!, C.slug);
    const adm = api(C.people.ADMIN!, C.slug);
    const settings = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? own : adm).patchSettings({ version: 0, retentionYears: 8 + i })));
    expect(settings.filter((r) => r.status === 200), JSON.stringify(settings.map((r) => r.status))).toHaveLength(1);
    expect(settings.filter((r) => r.status === 409 && r.body.error === 'stale')).toHaveLength(7);
    const winner = settings.find((r) => r.status === 200)!.body.settings;
    expect((await own.settings()).body.settings).toMatchObject({ version: 1, retentionYears: winner.retentionYears });
    const settingsAudits = await admin.query(`SELECT count(*)::int AS n FROM audit_events WHERE business_id = $1 AND action = 'finance.settings.changed' AND metadata->>'setting' = 'settings'`, [C.businessId]);
    expect(settingsAudits.rows[0].n).toBe(1); // the losers' audit entries rolled back with them

    const series = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? own : adm).patchSeries('invoice', { version: 0, startingValue: 100 + i })));
    expect(series.filter((r) => r.status === 200), JSON.stringify(series.map((r) => r.status))).toHaveLength(1);
    expect(series.filter((r) => r.status === 409 && r.body.error === 'stale')).toHaveLength(7);
    const won = series.find((r) => r.status === 200)!.body.series;
    const rows = await admin.query(`SELECT starting_value::int AS s, next_value::int AS n, version FROM finance_number_series WHERE business_id = $1 AND kind = 'INVOICE'`, [C.businessId]);
    expect(rows.rows).toEqual([{ s: won.startingValue, n: won.startingValue, version: 1 }]);
    const seriesAudits = await admin.query(`SELECT count(*)::int AS n FROM audit_events WHERE business_id = $1 AND action = 'finance.settings.changed' AND metadata->>'setting' = 'number_series'`, [C.businessId]);
    expect(seriesAudits.rows[0].n).toBe(1);

    // A first save racing the first issue (which creates the series with its defaults): the save either
    // creates the series first or answers 409 stale; it never fails with 500.
    const cust = (await own.createCustomer({ displayName: 'Race Co' })).body.customer.id;
    const quote = (await own.createQuote({ customerId: cust, lines: [line()] })).body.document;
    const [issued, saved] = await Promise.all([own.issue('quotes', quote.id, { version: 1 }), adm.patchSeries('quote', { version: 0, prefix: 'QT-' })]);
    expect(issued.status).toBe(200);
    expect([200, 409]).toContain(saved.status);
    if (saved.status === 409) expect(saved.body.error).toBe('stale');
    // Tenant isolation is unchanged: another business's first save is independent.
    expect((await api(B.people.OWNER!, B.slug).patchSeries('invoice', { version: 0, prefix: 'B-' })).status).toBe(200);
  }, 60_000);
});

describe('money: exact amounts across currencies and precision scales (FD-T2)', () => {
  it('rounds line by line, half away from zero, at each currency\'s precision, and refuses excess precision', async () => {
    const own = api(A.people.OWNER!, A.slug);
    // 1.005 is 1.00499999… in binary floating point; exact decimal arithmetic rounds it to 1.01.
    const aud = (await own.createInvoice({ customerId: custA, lines: [line({ quantity: '1', unitPrice: '1.005' }), line({ quantity: '3', unitPrice: '0.335', taxRateId: gst })] })).body.document;
    expect(aud.lines.map((l: { lineNet: string; lineTax: string }) => [l.lineNet, l.lineTax])).toEqual([['1.01', '0.00'], ['1.01', '0.10']]);
    expect(aud).toMatchObject({ subtotal: '2.02', taxTotal: '0.10', total: '2.12' });
    expect((await own.issue('invoices', aud.id, { version: 1 })).body.document.total).toBe('2.12'); // the database agrees

    const jpy = (await own.createInvoice({ customerId: custA, currencyCode: 'JPY', lines: [line({ quantity: '3', unitPrice: '333.5', taxRateId: gst, discountAmount: '1' })] })).body.document;
    expect(jpy).toMatchObject({ currencyScale: 0, subtotal: '1000', taxTotal: '100', total: '1100' }); // round(1000.5) = 1001, − 1
    expect(await own.createInvoice({ customerId: custA, currencyCode: 'JPY', lines: [line({ discountAmount: '0.5' })] })).toMatchObject({ status: 400, body: { error: 'invalid_amount' } });
    expect((await own.issue('invoices', jpy.id, { version: 1 })).body.document.total).toBe('1100');

    const kwd = (await own.createInvoice({ customerId: custA, currencyCode: 'KWD', lines: [line({ quantity: '0.125', unitPrice: '10.0045', taxRateId: gst })] })).body.document;
    expect(kwd).toMatchObject({ currencyScale: 3, subtotal: '1.251', taxTotal: '0.125', total: '1.376' }); // 1.2505625 → 1.251; 0.1251 → 0.125
    expect((await own.issue('invoices', kwd.id, { version: 1 })).body.document.total).toBe('1.376');

    for (const bad of [
      { lines: [line({ quantity: 2 })] }, { lines: [line({ unitPrice: 1.5 })] }, { lines: [line({ quantity: '0' })] }, { lines: [line({ quantity: '-1' })] },
      { lines: [line({ unitPrice: '1e3' })] }, { lines: [line({ quantity: '1', unitPrice: '10', discountAmount: '10.01' })] },
      { currencyCode: 'XXZ', lines: [line()] }, { currencyCode: 'usd' },
    ]) {
      expect((await own.createInvoice({ customerId: custA, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    // Stored values are exact numerics, not floats.
    const { rows } = await admin.query('SELECT total::text AS t, currency_scale FROM finance_documents WHERE id = $1', [kwd.id]);
    expect(rows[0]).toEqual({ t: '1.3760', currency_scale: 3 });
  });
});

describe('tenancy, permissions and isolation', () => {
  it('another business sees nothing and cannot link this business\'s records', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const other = api(B.people.OWNER!, B.slug);
    const inv = (await own.createInvoice({ customerId: custA, lines: [line()] })).body.document;
    expect((await other.get('invoices', inv.id)).status).toBe(404);
    expect((await other.patch('invoices', inv.id, { version: 1, notes: 'x' })).status).toBe(404);
    expect((await other.issue('invoices', inv.id, { version: 1 })).status).toBe(404);
    expect((await other.credit(inv.id)).status).toBe(404);
    expect((await other.list('invoices')).body.documents.map((x: { id: string }) => x.id)).not.toContain(inv.id);
    expect(await other.createInvoice({ customerId: custA, lines: [line()] })).toMatchObject({ status: 400, body: { error: 'invalid_customer' } });
    expect(await other.createInvoice({ customerId: custB, lines: [line({ taxRateId: gst })] })).toMatchObject({ status: 400, body: { error: 'invalid_tax_rate' } });
    const proj = (await own.createProject({ name: 'A project' })).body.project.id;
    expect(await other.createInvoice({ customerId: custB, projectId: proj })).toMatchObject({ status: 400, body: { error: 'invalid_project' } });
    // B's default currency is EUR; nothing assumes AUD or USD.
    expect((await other.createInvoice({ customerId: custB })).body.document.currencyCode).toBe('EUR');
    // An unknown body field (a business id, a number, a status, a total) is refused.
    for (const extra of [{ businessId: B.businessId }, { number: 'INV-9999' }, { status: 'ISSUED' }, { total: '1.00' }, { contentSha256: 'x' }]) {
      expect((await own.createInvoice({ customerId: custA, ...extra })).status).toBe(400);
    }
  });

  it('links: the contact must be the customer\'s and newly linked records must be active', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const contact = (await own.createContact({ customerId: custA2, firstName: 'Gil', lastName: 'Bates' })).body.contact.id;
    expect(await own.createInvoice({ customerId: custA, contactId: contact })).toMatchObject({ status: 400, body: { error: 'contact_customer_mismatch' } });
    const ok = (await own.createInvoice({ customerId: custA2, contactId: contact, lines: [line()] })).body.document;
    expect(await own.patch('invoices', ok.id, { version: 1, customerId: custA })).toMatchObject({ status: 400, body: { error: 'contact_customer_mismatch' } });
    const issued = (await own.issue('invoices', ok.id, { version: 1 })).body.document;
    expect(issued.billToSnapshot.contact).toMatchObject({ contactId: contact, name: 'Gil Bates' });
    // A converted invoice stays with its quote's customer (F1-02), in the service and in the database.
    const q = (await own.createQuote({ customerId: custA, lines: [line()] })).body.document;
    await own.issue('quotes', q.id, { version: 1 });
    const conv = (await own.convert(q.id)).body.document;
    expect(await own.patch('invoices', conv.id, { version: 1, customerId: custA2 })).toMatchObject({ status: 400, body: { error: 'source_quote_customer' } });
    expect((await own.patch('invoices', conv.id, { version: 1, customerId: custA, notes: 'same customer is fine' })).status).toBe(200);
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.business_id', $1, true)", [A.businessId]);
      const err = await app.query('UPDATE finance_documents SET customer_id = $2 WHERE id = $1', [conv.id, custA2]).then(() => 'ok', (e: { code?: string }) => e.code);
      await app.query('ROLLBACK');
      expect(err).toBe('23503');
    } finally {
      await app.end();
    }
  });

  it('RBAC: the FD-P1 matrix through the real routes; finance access is never implied by other Zones', async () => {
    const roles = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'] as const;
    const expected: Record<string, Record<string, boolean>> = {
      read: { OWNER: true, ADMIN: true, MANAGER: true, MEMBER: false },
      write: { OWNER: true, ADMIN: true, MANAGER: true, MEMBER: false },
      issue: { OWNER: true, ADMIN: true, MANAGER: false, MEMBER: false },
      manage: { OWNER: true, ADMIN: true, MANAGER: false, MEMBER: false },
    };
    for (const role of roles) {
      const who = api(A.people[role]!, A.slug);
      expect((await who.list('invoices')).status !== 403, `${role} read`).toBe(expected.read![role]);
      expect((await who.settings()).status !== 403, `${role} read settings`).toBe(expected.read![role]);
      const created = await who.createInvoice({ customerId: custA, lines: [line()] });
      expect(created.status !== 403, `${role} write`).toBe(expected.write![role]);
      const draft = created.status === 201 ? created.body.document : (await api(A.people.OWNER!, A.slug).createInvoice({ customerId: custA, lines: [line()] })).body.document;
      expect((await who.issue('invoices', draft.id, { version: 1 })).status !== 403, `${role} issue`).toBe(expected.issue![role]);
      expect((await who.createTaxRate({ name: `R ${role}`, ratePercent: '1' })).status !== 403, `${role} manage`).toBe(expected.manage![role]);
    }
    // The context endpoint reports the same keys the routes enforce.
    expect((await api(A.people.MANAGER!, A.slug).context()).body.membership.permissions.filter((p: string) => p.startsWith('finance:')))
      .toEqual(['finance:read', 'finance:write', 'finance:expenses', 'finance:documents_preview', 'finance:documents_generate', 'finance:documents_download']);
    // Every customer, sales and project key, but no finance key: still no finance access.
    custom.ADMIN = ['business:read', 'customers:read', 'customers:write', 'customers:delete', 'sales:read', 'sales:write', 'sales:manage',
      'projects:read', 'projects:create', 'projects:update', 'projects:archive', 'projects:manage_tasks'];
    const admin2 = api(A.people.ADMIN!, A.slug);
    for (const r of [await admin2.list('quotes'), await admin2.createQuote({ customerId: custA }), await admin2.settings(), await admin2.taxRates()]) expect(r.status).toBe(403);
    // A narrower custom role: read only.
    custom.MEMBER = ['business:read', 'finance:read'];
    const reader = api(A.people.MEMBER!, A.slug);
    expect((await reader.list('quotes')).status).toBe(200);
    expect((await reader.createQuote({ customerId: custA })).status).toBe(403);
  });
});

describe('idempotency and duplicate requests', () => {
  it('a repeated Idempotency-Key returns the first draft; a different request with the same key is a conflict', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const key = { 'idempotency-key': `inv-${randomUUID()}` };
    const body = { customerId: custA, lines: [line()] };
    const first = await own.createInvoice(body, key);
    const again = await own.createInvoice(body, key);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.document.id).toBe(first.body.document.id);
    expect(await own.createInvoice({ ...body, notes: 'different' }, key)).toMatchObject({ status: 409, body: { error: 'idempotency_conflict' } });
    expect(await own.createInvoice(body, { 'idempotency-key': 'has space' })).toMatchObject({ status: 400, body: { error: 'invalid_idempotency_key' } });
    // Ten racing duplicates create exactly one draft.
    const raceKey = { 'idempotency-key': `race-${randomUUID()}` };
    const results = await Promise.all(Array.from({ length: 10 }, () => own.createQuote({ customerId: custA, lines: [line()] }, raceKey)));
    expect(new Set(results.map((r) => r.body.document.id)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    // Conversions too.
    const q = (await own.createQuote({ customerId: custA, lines: [line()] })).body.document;
    await own.issue('quotes', q.id, { version: 1 });
    const convKey = { 'idempotency-key': `conv-${randomUUID()}` };
    const c1 = await own.convert(q.id, {}, convKey);
    const c2 = await own.convert(q.id, {}, convKey);
    expect(c2.body.document.id).toBe(c1.body.document.id);
    expect((await own.list('invoices', '?status=draft&limit=100')).body.documents.filter((d: { sourceQuoteId: string }) => d.sourceQuoteId === q.id)).toHaveLength(1);
  });
});

describe('concurrency', () => {
  it('concurrent issues get unique, consecutive numbers; failed issues in between leave no gap', async () => {
    const C = await team('fk');
    const own = api(C.people.OWNER!, C.slug);
    const adm = api(C.people.ADMIN!, C.slug);
    const cust = (await own.createCustomer({ displayName: 'Hooli' })).body.customer.id;
    await own.patchSettings({ version: 0, defaultPaymentTermsDays: 14 });
    const drafts = await Promise.all(Array.from({ length: 16 }, () => own.createInvoice({ customerId: cust, lines: [line()] }).then((r) => r.body.document)));
    const empty = await Promise.all(Array.from({ length: 4 }, () => own.createInvoice({ customerId: cust }).then((r) => r.body.document))); // will fail at issue
    const all = [...drafts, ...empty].sort(() => Math.random() - 0.5);
    const results = await Promise.all(all.map((d, i) => (i % 2 ? own : adm).issue('invoices', d.id, { version: 1 })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(16);
    expect(results.filter((r) => r.status === 400 && r.body.error === 'no_lines')).toHaveLength(4);
    const numbers = results.filter((r) => r.status === 200).map((r) => r.body.document.number as string).sort();
    expect(numbers).toEqual(Array.from({ length: 16 }, (_, i) => `INV-${String(i + 1).padStart(4, '0')}`));
    // The same draft issued twice at once: exactly one wins.
    const once = (await own.createInvoice({ customerId: cust, lines: [line()] })).body.document;
    const twice = await Promise.all([own.issue('invoices', once.id, { version: 1 }), adm.issue('invoices', once.id, { version: 1 })]);
    expect(twice.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await own.get('invoices', once.id)).body.document.number).toBe('INV-0017');
  }, 60_000);

  it('a draft edit racing an issue: one wins, and the issued totals and hash always match the lines that committed', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const mgr = api(A.people.MANAGER!, A.slug);
    for (let round = 0; round < 8; round++) {
      const d = (await mgr.createInvoice({ customerId: custA, lines: [line()] })).body.document;
      const [edit, issue] = await Promise.all([
        mgr.patch('invoices', d.id, { version: 1, lines: [line(), line({ description: 'Extra', unitPrice: '10' })] }),
        own.issue('invoices', d.id, { version: 1 }),
      ]);
      expect([edit.status, issue.status].sort(), `round ${round}`).toEqual([200, 409]);
      if (edit.status === 409) expect(edit.body.error).toBe('immutable');
      else expect(issue.body.error).toBe('stale');
      const { rows } = await admin.query(
        `SELECT d.status, d.content_sha256 = finance_content_hash(d) AS hash_ok,
                d.subtotal = (SELECT sum(line_net) FROM finance_document_lines l WHERE l.document_id = d.id) AS totals_ok
         FROM finance_documents d WHERE d.id = $1`, [d.id]);
      expect(rows[0].totals_ok).toBe(true);
      if (rows[0].status === 'ISSUED') expect(rows[0].hash_ok).toBe(true);
    }
  }, 60_000);
});

describe('database backstops behind the API', () => {
  it('issued documents and their lines refuse direct writes as bos_app, with integrity SQLSTATEs (FN class)', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = (await own.createInvoice({ customerId: custA, lines: [line()] })).body.document;
    await own.issue('invoices', inv.id, { version: 1 });
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    const asApp = async (sql: string, params: unknown[] = []) => {
      await app.query('BEGIN');
      try {
        await app.query("SELECT set_config('app.business_id', $1, true)", [A.businessId]);
        await app.query(sql, params);
        await app.query('COMMIT');
        return 'ok';
      } catch (e) {
        await app.query('ROLLBACK');
        return (e as { code?: string }).code;
      }
    };
    try {
      expect(await asApp('UPDATE finance_documents SET notes = $2 WHERE id = $1', [inv.id, 'tampered'])).toBe('FN001');
      expect(await asApp('UPDATE finance_documents SET total = total + 1, subtotal = subtotal + 1 WHERE id = $1', [inv.id])).toBe('FN001');
      expect(await asApp('UPDATE finance_documents SET number = $2 WHERE id = $1', [inv.id, 'INV-9999'])).toBe('FN001');
      expect(await asApp("UPDATE finance_documents SET status = 'DRAFT' WHERE id = $1", [inv.id])).toBe('FN002');
      expect(await asApp('UPDATE finance_documents SET issued_at = now() - interval \'1 day\' WHERE id = $1', [inv.id])).toBe('FN001');
      expect(await asApp('UPDATE finance_documents SET status_changed_at = now() - interval \'1 day\' WHERE id = $1', [inv.id])).toBe('FN010');
      expect(await asApp('UPDATE finance_document_lines SET unit_price = 1 WHERE document_id = $1', [inv.id])).toBe('FN001');
      expect(await asApp('DELETE FROM finance_document_lines WHERE document_id = $1', [inv.id])).toBe('FN001');
      expect(await asApp(`INSERT INTO finance_document_lines (id, business_id, document_id, position, description, quantity, unit_price, line_net, line_tax)
        VALUES (gen_random_uuid(), $2, $1, 99999, 'sneaky', 1, 1, 1, 0)`, [inv.id, A.businessId])).toBe('FN001');
      expect(await asApp('DELETE FROM finance_documents WHERE id = $1', [inv.id])).toBe('42501'); // no DELETE grant at all
      expect(await asApp('UPDATE finance_tax_rates SET rate_percent = 99 WHERE id = $1', [gst])).toBe('42501'); // column grant
      expect(await asApp("UPDATE finance_number_series SET next_value = next_value + 5 WHERE kind = 'INVOICE'")).toBe('FN008');
      expect(await asApp('UPDATE finance_documents SET allocated_total = 1 WHERE id = $1', [inv.id])).toBe('FN010');
      // Another business's context sees nothing to update.
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.business_id', $1, true)", [B.businessId]);
      const r = await app.query('UPDATE finance_documents SET notes = $2 WHERE id = $1', [inv.id, 'x']);
      await app.query('ROLLBACK');
      expect(r.rowCount).toBe(0);
    } finally {
      await app.end();
    }
    // Unchanged.
    expect((await own.get('invoices', inv.id)).body.document.notes).toBeNull();
  });

  it('snapshots and the content hash stay stable when the customer, contact or tax rate changes afterwards', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const cust = (await own.createCustomer({ displayName: 'Stable Co', addressLine1: '5 First Ave' })).body.customer;
    const rate = (await own.createTaxRate({ name: 'Rate S', ratePercent: '5' })).body.taxRate;
    const inv = (await own.createInvoice({ customerId: cust.id, lines: [line({ taxRateId: rate.id })] })).body.document;
    const issued = (await own.issue('invoices', inv.id, { version: 1 })).body.document;
    await own.updateCustomer(cust.id, { displayName: 'Renamed Co', addressLine1: '7 New Road' });
    await own.patchTaxRate(rate.id, { name: 'Rate S renamed', archived: true });
    await own.patchSettings({ version: (await own.settings()).body.settings.version, sellerLegalName: 'Changed seller' });
    const now = (await own.get('invoices', inv.id)).body.document;
    expect(now.billToSnapshot).toEqual(issued.billToSnapshot);
    expect(now.billToSnapshot).toMatchObject({ name: 'Stable Co', addressLine1: '5 First Ave' });
    expect(now.sellerSnapshot).toEqual(issued.sellerSnapshot);
    expect(now.lines).toEqual(issued.lines);
    expect(now.contentSha256).toBe(issued.contentSha256);
    const { rows } = await admin.query('SELECT content_sha256 = finance_content_hash(d) AS ok FROM finance_documents d WHERE id = $1', [inv.id]);
    expect(rows[0].ok).toBe(true);
  });

  it('an issue and its audit entry commit or roll back together, number included', async () => {
    const C = await team('fr');
    const own = api(C.people.OWNER!, C.slug);
    const cust = (await own.createCustomer({ displayName: 'Rollback Ltd' })).body.customer.id;
    const d = (await own.createInvoice({ customerId: cust, dueDate: '2030-01-01', lines: [line()] })).body.document;
    auditFailure.action = 'finance.document.issued';
    expect((await own.issue('invoices', d.id, { version: 1, issueDate: '2026-11-15' })).status).toBe(500);
    auditFailure.action = null;
    expect((await own.get('invoices', d.id)).body.document).toMatchObject({ status: 'DRAFT', number: null, version: 1 });
    expect((await audits(d.id)).map((e) => e.action)).toEqual(['finance.document.created']);
    const { rows } = await admin.query("SELECT next_value::int AS n FROM finance_number_series WHERE business_id = $1 AND kind = 'INVOICE'", [C.businessId]);
    expect(rows[0]?.n ?? 1).toBe(1); // the number was returned
    expect((await own.issue('invoices', d.id, { version: 1, issueDate: '2026-11-15' })).body.document.number).toBe('INV-0001');
  });

  it('retention (FD-L3): a business with finance records cannot be deleted; one without can, as before', async () => {
    const C = await team('fd');
    const own = api(C.people.OWNER!, C.slug);
    const cust = (await own.createCustomer({ displayName: 'Kept' })).body.customer.id;
    const inv = (await own.createInvoice({ customerId: cust, dueDate: '2030-01-01', lines: [line()] })).body.document;
    await own.issue('invoices', inv.id, { version: 1 });
    expect((await own.settings()).body.settings.hasRetainedRecords).toBe(true);
    // Retention settings are a recorded policy only (F1-03): placing and lifting a legal hold, and raising
    // and lowering retention to the 7-year floor, delete nothing and change nothing about protection.
    const v1 = (await own.patchSettings({ version: 0, retentionYears: 12, legalHold: true })).body.settings.version;
    await own.patchSettings({ version: v1, retentionYears: 7, legalHold: false });
    expect((await own.get('invoices', inv.id)).body.document.status).toBe('ISSUED');
    // An administrative delete (as the future purge job or a manual erasure would run) fails whole.
    const failed = await admin.query('DELETE FROM businesses WHERE id = $1', [C.businessId]).then(() => null, (e: { code?: string; constraint?: string; table?: string }) => e);
    expect(failed?.code).toBe('23503');
    expect(failed?.constraint).toMatch(/^finance_/);
    const left = await admin.query('SELECT (SELECT count(*) FROM businesses WHERE id = $1)::int AS b, (SELECT count(*) FROM finance_documents WHERE business_id = $1)::int AS d, (SELECT count(*) FROM audit_events WHERE business_id = $1)::int AS a', [C.businessId]);
    expect(left.rows[0].b).toBe(1);
    expect(left.rows[0].d).toBe(1);
    expect(left.rows[0].a).toBeGreaterThan(0);
    // Hard-deleting the customer of an issued invoice (erasure) is refused too (FD-L4 stays open).
    const erasure = await admin.query('DELETE FROM customers WHERE id = $1', [cust]).then(() => null, (e: { code?: string }) => e.code);
    expect(erasure).toBe('23503');

    // A business that never used Finance is deleted exactly as before (existing behaviour preserved).
    const D = await team('fe');
    await api(D.people.OWNER!, D.slug).createCustomer({ displayName: 'Gone' });
    expect((await api(D.people.OWNER!, D.slug).settings()).body.settings.hasRetainedRecords).toBe(false);
    await admin.query('DELETE FROM businesses WHERE id = $1', [D.businessId]);
    expect((await admin.query('SELECT count(*)::int AS n FROM customers WHERE business_id = $1', [D.businessId])).rows[0].n).toBe(0);
  });
});

describe('lists', () => {
  it('filters by status, customer, project, issue date and overdue, and pages with a bound cursor', async () => {
    const C = await team('fl');
    const own = api(C.people.OWNER!, C.slug);
    const c1 = (await own.createCustomer({ displayName: 'One' })).body.customer.id;
    const c2 = (await own.createCustomer({ displayName: 'Two' })).body.customer.id;
    const p = (await own.createProject({ name: 'P' })).body.project.id;
    const mk = async (customerId: string, issueDate: string | null, dueDate: string, projectId?: string) => {
      const d = (await own.createInvoice({ customerId, projectId, dueDate, lines: [line()] })).body.document;
      return issueDate ? (await own.issue('invoices', d.id, { version: 1, issueDate })).body.document : d;
    };
    const old = await mk(c1, '2020-01-01', '2020-01-31');
    const recent = await mk(c2, '2026-11-01', '2099-01-01', p);
    const draft = await mk(c1, null, '2099-01-01');
    const ids = (r: { body: { documents: { id: string }[] } }) => r.body.documents.map((d) => d.id);
    expect(ids(await own.list('invoices'))).toEqual([draft.id, recent.id, old.id]);
    expect(ids(await own.list('invoices', '?status=draft'))).toEqual([draft.id]);
    expect(ids(await own.list('invoices', `?customerId=${c1}`))).toEqual([draft.id, old.id]);
    expect(ids(await own.list('invoices', `?projectId=${p}`))).toEqual([recent.id]);
    expect(ids(await own.list('invoices', '?from=2026-01-01&to=2026-12-01'))).toEqual([recent.id]);
    expect(ids(await own.list('invoices', '?overdue=true'))).toEqual([old.id]);
    const page1 = await own.list('invoices', '?limit=2');
    expect(ids(page1)).toEqual([draft.id, recent.id]);
    const page2 = await own.list('invoices', `?limit=2&cursor=${page1.body.nextCursor}`);
    expect(ids(page2)).toEqual([old.id]);
    expect(page2.body.nextCursor).toBeNull();
    expect(await own.list('quotes', `?cursor=${page1.body.nextCursor}`)).toMatchObject({ status: 400, body: { error: 'invalid_cursor' } });
    expect((await own.list('invoices', '?status=paid')).status).toBe(400);
    expect(page1.body.documents[0]).not.toHaveProperty('lines');
  });
});
