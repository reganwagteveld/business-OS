import { inviteForSignup, admitFixture } from './support/admission';
/**
 * Finance F7-B (docs/finance-catalog-f7b.md): catalog items on draft quote and invoice lines, through
 * the real route handlers against PostgreSQL with the migrations applied as in production. Covers the
 * defaults copied from an item and overrides, manual lines unchanged, currency (no conversion), tax
 * (item rate, business default, none, archived rates), archived and inactive items, tenant isolation,
 * permissions (keys), credit notes refusing catalog lines, snapshots of issued documents, audit, and
 * races with catalog changes staged deterministically with pg_blocking_pids.
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

import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as customersRoute from '@/app/api/v1/b/[slug]/customers/route';
import * as taxRatesRoute from '@/app/api/v1/b/[slug]/finance/tax-rates/route';
import * as taxRateRoute from '@/app/api/v1/b/[slug]/finance/tax-rates/[taxRateId]/route';
import * as settingsRoute from '@/app/api/v1/b/[slug]/finance/settings/route';
import * as itemsRoute from '@/app/api/v1/b/[slug]/finance/catalog-items/route';
import * as itemRoute from '@/app/api/v1/b/[slug]/finance/catalog-items/[itemId]/route';
import * as itemArchive from '@/app/api/v1/b/[slug]/finance/catalog-items/[itemId]/archive/route';
import * as quotesRoute from '@/app/api/v1/b/[slug]/finance/quotes/route';
import * as quoteRoute from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/route';
import * as quoteIssue from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/issue/route';
import * as quoteConvert from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/convert/route';
import * as invoicesRoute from '@/app/api/v1/b/[slug]/finance/invoices/route';
import * as invoiceRoute from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/route';
import * as invoiceIssue from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/issue/route';
import * as creditNotesRoute from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/credit-notes/route';
import * as creditNoteRoute from '@/app/api/v1/b/[slug]/finance/credit-notes/[documentId]/route';
import { FinanceDocumentResponse } from '@business-os/contracts';
import { devOutbox } from '@/core/email';
import { backendPid, waitUntilBlocked } from './support/locks';

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

// A separate address range from the other suites, so rate-limit counters do not collide.
let ip = 1;
const IP_BLOCK = Number(process.env.CATALOG_LINES_TEST_IP_BLOCK ?? 150);
type User = { email: string; cookie: string; id: string };

function req(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.${IP_BLOCK}.${Math.floor(ip / 250)}.${ip++ % 250}` });
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
  const call = (h: Handler, method: string, path: string, c: Ctx, body?: unknown, headers?: Record<string, string>) => {
    const r = req(method, `${F}${path}`, { cookie: who.cookie, body });
    for (const [k, v] of Object.entries(headers ?? {})) r.headers.set(k, v);
    return h(r, c).then(json);
  };
  const d = (documentId: string) => ctx({ slug, documentId });
  return {
    createItem: (body: unknown) => call(itemsRoute.POST, 'POST', '/catalog-items', ctx({ slug }), body),
    patchItem: (id: string, body: unknown) => call(itemRoute.PATCH, 'PATCH', `/catalog-items/${id}`, ctx({ slug, itemId: id }), body),
    archiveItem: (id: string, version: number) => call(itemArchive.POST, 'POST', `/catalog-items/${id}/archive`, ctx({ slug, itemId: id }), { version }),
    createTaxRate: (body: unknown) => call(taxRatesRoute.POST, 'POST', '/tax-rates', ctx({ slug }), body),
    patchTaxRate: (taxRateId: string, body: unknown) => call(taxRateRoute.PATCH, 'PATCH', `/tax-rates/${taxRateId}`, ctx({ slug, taxRateId }), body),
    settings: () => call(settingsRoute.GET, 'GET', '/settings', ctx({ slug })),
    patchSettings: (body: unknown) => call(settingsRoute.PATCH, 'PATCH', '/settings', ctx({ slug }), body),
    createQuote: (body: unknown) => call(quotesRoute.POST, 'POST', '/quotes', ctx({ slug }), body),
    patchQuote: (id: string, body: unknown) => call(quoteRoute.PATCH, 'PATCH', `/quotes/${id}`, d(id), body),
    issueQuote: (id: string, body: unknown) => call(quoteIssue.POST, 'POST', `/quotes/${id}/issue`, d(id), body),
    convertQuote: (id: string) => call(quoteConvert.POST, 'POST', `/quotes/${id}/convert`, d(id), {}),
    createInvoice: (body: unknown, key?: string) => call(invoicesRoute.POST, 'POST', '/invoices', ctx({ slug }), body, key ? { 'idempotency-key': key } : undefined),
    invoice: (id: string) => call(invoiceRoute.GET, 'GET', `/invoices/${id}`, d(id)),
    patchInvoice: (id: string, body: unknown) => call(invoiceRoute.PATCH, 'PATCH', `/invoices/${id}`, d(id), body),
    issueInvoice: (id: string, body: unknown) => call(invoiceIssue.POST, 'POST', `/invoices/${id}/issue`, d(id), body),
    createCreditNote: (invoiceId: string, body: unknown) => call(creditNotesRoute.POST, 'POST', `/invoices/${invoiceId}/credit-notes`, d(invoiceId), body),
    patchCreditNote: (id: string, body: unknown) => call(creditNoteRoute.PATCH, 'PATCH', `/credit-notes/${id}`, d(id), body),
    createCustomer: (body: unknown) => customersRoute.POST(req('POST', `/api/v1/b/${slug}/customers`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
  };
};
const audits = async (targetId: string) =>
  (await admin.query('SELECT action, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows;
const docRow = async (id: string) => (await admin.query('SELECT version, total, status FROM finance_documents WHERE id = $1', [id])).rows[0];

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let own: ReturnType<typeof api>;
let mgr: ReturnType<typeof api>;
let mem: ReturnType<typeof api>;
let bOwn: ReturnType<typeof api>;
let gst: string; // A's 10% rate
let reduced: string; // A's 5% rate
let customer: string; // an active customer of A
let bItem: string; // an item of business B

beforeAll(async () => {
  A = await team('catl-a');
  B = await team('catl-b', 'EUR');
  own = api(A.people.OWNER!, A.slug);
  mgr = api(A.people.MANAGER!, A.slug);
  mem = api(A.people.MEMBER!, A.slug);
  bOwn = api(B.people.OWNER!, B.slug);
  gst = (await own.createTaxRate({ name: 'GST', ratePercent: '10' })).body.taxRate.id;
  reduced = (await own.createTaxRate({ name: 'Reduced', ratePercent: '5' })).body.taxRate.id;
  customer = (await own.createCustomer({ displayName: 'Catalog lines customer' })).body.customer.id;
  bItem = (await bOwn.createItem({ type: 'PRODUCT', name: 'B widget', unit: 'each', unitPrice: '9', taxMode: 'NONE' })).body.item.id;
}, 120_000);

/** An item in A, created by the owner: by default a 150 AUD per hour consulting service at A's GST. */
async function item(o: Record<string, unknown> = {}) {
  const res = await own.createItem({ type: 'SERVICE', name: 'Consulting', description: 'Senior consultant', unit: 'hour', unitPrice: '150', taxMode: 'RATE', taxRateId: gst, ...o });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.item as { id: string; version: number; name: string };
}
async function invoiceWith(lines: unknown[], who = own) {
  return who.createInvoice({ customerId: customer, lines });
}

describe('defaults and overrides', () => {
  it('fills a line from the item (name and description, quantity 1, price, tax) and stores a plain line', async () => {
    const it1 = await item();
    const res = await invoiceWith([{ catalogItemId: it1.id }]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(() => FinanceDocumentResponse.parse(res.body)).not.toThrow();
    const doc = res.body.document;
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({
      description: 'Consulting\nSenior consultant', quantity: '1', unitPrice: '150', taxRateId: gst, taxName: 'GST', taxRatePercent: '10',
      lineNet: '150.00', lineTax: '15.00',
    });
    expect([doc.subtotal, doc.taxTotal, doc.total]).toEqual(['150.00', '15.00', '165.00']);
    // No reference to the item is kept anywhere on the line (D-F7B-1: no migration, no column).
    const cols = (await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'finance_document_lines'`)).rows.map((r) => r.column_name);
    expect(cols.some((c: string) => c.includes('catalog'))).toBe(false);
    expect(JSON.stringify(doc)).not.toContain(it1.id);
  });

  it('every field the client sends wins: quantity, description, price, discount and tax (including no tax)', async () => {
    const it1 = await item();
    const res = await invoiceWith([
      { catalogItemId: it1.id, quantity: '2.5', description: 'Workshop', unitPrice: '120.125', discountAmount: '10', taxRateId: reduced },
      { catalogItemId: it1.id, taxRateId: null },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [a, b] = res.body.document.lines;
    expect(a).toMatchObject({ description: 'Workshop', quantity: '2.5', unitPrice: '120.125', discountAmount: '10.00', taxRateId: reduced, taxRatePercent: '5' });
    expect(b).toMatchObject({ unitPrice: '150', taxRateId: null, taxName: null, lineTax: '0.00' });
  });

  it('mixes catalog and manual lines in the order sent, on quotes and invoices, on create and on edit', async () => {
    const it1 = await item({ name: 'Visit', description: null, unitPrice: '80' });
    const q = await own.createQuote({ customerId: customer, lines: [{ description: 'Manual first', quantity: '1', unitPrice: '5' }, { catalogItemId: it1.id, quantity: '3' }] });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body.document.lines.map((l: { description: string }) => l.description)).toEqual(['Manual first', 'Visit']);
    const edited = await own.patchQuote(q.body.document.id, {
      version: q.body.document.version,
      lines: [{ catalogItemId: it1.id }, ...q.body.document.lines.map((l: Record<string, unknown>) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRateId: l.taxRateId }))],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.document.lines.map((l: { description: string; quantity: string }) => [l.description, l.quantity])).toEqual([['Visit', '1'], ['Manual first', '1'], ['Visit', '3']]);
    const inv = await invoiceWith([{ description: 'Manual', quantity: '1', unitPrice: '1' }]);
    const p = await own.patchInvoice(inv.body.document.id, { version: 1, lines: [{ catalogItemId: it1.id, quantity: '2' }] });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.document.lines[0]).toMatchObject({ description: 'Visit', quantity: '2', unitPrice: '80', lineNet: '160.00' });
  });

  it('manual lines are unchanged: without catalogItemId every field is still required, and unknown fields are refused', async () => {
    for (const line of [{ quantity: '1', unitPrice: '5' }, { description: 'x', unitPrice: '5' }, { description: 'x', quantity: '1' }, { description: 'x', quantity: '1', unitPrice: '5', itemId: randomUUID() }]) {
      const res = await invoiceWith([line]);
      expect(res.status, JSON.stringify(line)).toBe(400);
      expect(res.body.error).toBe('invalid_input');
    }
    for (const bad of [{ catalogItemId: 'not-a-uuid' }, { catalogItemId: randomUUID(), unitPrice: 12 }, { catalogItemId: randomUUID(), quantity: '0' }]) {
      expect((await invoiceWith([bad])).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await invoiceWith([{ description: 'Ad hoc', quantity: '1', unitPrice: '5' }])).status).toBe(201);
  });

  it('keeps the item price exactly (6 decimals, never rounded to cents); the document rounds only line amounts', async () => {
    const it1 = await item({ unitPrice: '0.012345', taxMode: 'NONE', taxRateId: undefined });
    const res = await invoiceWith([{ catalogItemId: it1.id, quantity: '1000' }]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.document.lines[0]).toMatchObject({ unitPrice: '0.012345', lineNet: '12.35' });
  });

  it('an idempotent create with catalog lines replays the same draft', async () => {
    const it1 = await item();
    const key = randomUUID();
    const first = await own.createInvoice({ customerId: customer, lines: [{ catalogItemId: it1.id }] }, key);
    const again = await own.createInvoice({ customerId: customer, lines: [{ catalogItemId: it1.id }] }, key);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.document.id).toBe(first.body.document.id);
  });
});

describe('currency (never converted; D-F7B-2)', () => {
  it('uses the price only in the item currency; otherwise the line must carry a price in the document currency', async () => {
    const usd = await item({ name: 'US licence', unitPrice: '99', currencyCode: 'USD' });
    const refused = await invoiceWith([{ catalogItemId: usd.id }]);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('catalog_currency_mismatch');
    const priced = await invoiceWith([{ catalogItemId: usd.id, unitPrice: '150' }]);
    expect(priced.status).toBe(201);
    expect(priced.body.document.lines[0]).toMatchObject({ description: 'US licence\nSenior consultant', unitPrice: '150' });
    // The same item on a USD document uses its price as is.
    const usdDoc = await own.createInvoice({ customerId: customer, currencyCode: 'USD', lines: [{ catalogItemId: usd.id }] });
    expect(usdDoc.status, JSON.stringify(usdDoc.body)).toBe(201);
    expect(usdDoc.body.document.lines[0].unitPrice).toBe('99');
  });

  it('an item without a default price needs a price on the line', async () => {
    const noPrice = await item({ name: 'Quoted work', unitPrice: null });
    const refused = await invoiceWith([{ catalogItemId: noPrice.id }]);
    expect([refused.status, refused.body.error]).toEqual([400, 'catalog_price_required']);
    expect((await invoiceWith([{ catalogItemId: noPrice.id, unitPrice: '0' }])).status).toBe(201);
  });
});

describe('tax', () => {
  it('BUSINESS_DEFAULT uses the default rate at the time of use; none when the business has none; NONE never taxes', async () => {
    const byDefault = await item({ name: 'Default-taxed', taxMode: 'BUSINESS_DEFAULT', taxRateId: undefined });
    const none = await item({ name: 'Untaxed', taxMode: 'NONE', taxRateId: undefined });
    let settings = (await own.settings()).body.settings;
    if (settings.defaultTaxRateId !== null) settings = (await own.patchSettings({ version: settings.version, defaultTaxRateId: null })).body.settings;
    const noDefault = await invoiceWith([{ catalogItemId: byDefault.id }, { catalogItemId: none.id }]);
    expect(noDefault.body.document.lines.map((l: { taxRateId: string | null }) => l.taxRateId)).toEqual([null, null]);
    settings = (await own.patchSettings({ version: settings.version, defaultTaxRateId: reduced })).body.settings;
    const withDefault = await invoiceWith([{ catalogItemId: byDefault.id }, { catalogItemId: none.id }]);
    expect(withDefault.body.document.lines.map((l: { taxRateId: string | null }) => l.taxRateId)).toEqual([reduced, null]);
    await own.patchSettings({ version: settings.version, defaultTaxRateId: null });
  });

  it('an archived tax rate is never newly applied: the item rate or the business default (409 archived_reference); the line can choose another', async () => {
    const rate = (await own.createTaxRate({ name: `Old ${randomUUID().slice(0, 6)}`, ratePercent: '7' })).body.taxRate.id;
    const it1 = await item({ name: 'Old-rate item', taxRateId: rate });
    const byDefault = await item({ name: 'Default-taxed 2', taxMode: 'BUSINESS_DEFAULT', taxRateId: undefined });
    let settings = (await own.settings()).body.settings;
    settings = (await own.patchSettings({ version: settings.version, defaultTaxRateId: rate })).body.settings;
    expect((await own.patchTaxRate(rate, { archived: true })).status).toBe(200);
    for (const id of [it1.id, byDefault.id]) {
      const refused = await invoiceWith([{ catalogItemId: id }]);
      expect([refused.status, refused.body.error]).toEqual([409, 'archived_reference']);
      expect((await invoiceWith([{ catalogItemId: id, taxRateId: gst }])).status).toBe(201);
    }
    // A draft that already used the rate keeps it (existing rule), also when the lines are resent from the catalog.
    await own.patchTaxRate(rate, { archived: false });
    const draft = await invoiceWith([{ catalogItemId: it1.id }]);
    await own.patchTaxRate(rate, { archived: true });
    const resent = await own.patchInvoice(draft.body.document.id, { version: 1, lines: [{ catalogItemId: it1.id, quantity: '2' }] });
    expect(resent.status, JSON.stringify(resent.body)).toBe(200);
    await own.patchSettings({ version: settings.version, defaultTaxRateId: null });
  });
});

describe('archived and inactive items, tenant isolation, permissions', () => {
  it('an archived item is 409 archived_reference, an inactive one 409 catalog_item_inactive; the draft is not changed', async () => {
    const archived = await item({ name: 'Retired' });
    await own.archiveItem(archived.id, 1);
    const inactive = await item({ name: 'Paused' });
    await own.patchItem(inactive.id, { version: 1, status: 'INACTIVE' });
    const draft = (await invoiceWith([{ description: 'Keep', quantity: '1', unitPrice: '1' }])).body.document;
    for (const [id, code] of [[archived.id, 'archived_reference'], [inactive.id, 'catalog_item_inactive']] as const) {
      const created = await invoiceWith([{ catalogItemId: id }]);
      expect([created.status, created.body.error]).toEqual([409, code]);
      const patched = await own.patchInvoice(draft.id, { version: 1, lines: [{ catalogItemId: id, unitPrice: '1' }] });
      expect([patched.status, patched.body.error]).toEqual([409, code]);
    }
    expect(await docRow(draft.id)).toMatchObject({ version: 1, total: '1.0000' });
    expect((await audits(draft.id)).map((a) => a.action)).toEqual(['finance.document.created']);
  });

  it('another business\'s item, or an unknown id, is the same 400 invalid_catalog_item: nothing about it leaks', async () => {
    const other = await invoiceWith([{ catalogItemId: bItem }]);
    const unknown = await invoiceWith([{ catalogItemId: randomUUID() }]);
    expect([other.status, other.body.error]).toEqual([400, 'invalid_catalog_item']);
    expect(unknown.body).toEqual(other.body);
    expect(JSON.stringify(other.body)).not.toContain('B widget');
    // Even with every value supplied, a foreign item id is refused rather than ignored.
    expect((await invoiceWith([{ catalogItemId: bItem, description: 'x', quantity: '1', unitPrice: '1' }])).status).toBe(400);
  });

  it('permissions are the document keys: MANAGER (finance:write) may add catalog lines, MEMBER may not, and the keys decide', async () => {
    const it1 = await item();
    expect((await invoiceWith([{ catalogItemId: it1.id }], mgr)).status).toBe(201);
    expect((await invoiceWith([{ catalogItemId: it1.id }], mem)).status).toBe(403);
    custom.MANAGER = ['finance:read'];
    expect((await invoiceWith([{ catalogItemId: it1.id }], mgr)).status).toBe(403);
  });

  it('credit notes never take catalog lines (contract and service)', async () => {
    const it1 = await item();
    const inv = (await invoiceWith([{ catalogItemId: it1.id }])).body.document;
    expect((await own.issueInvoice(inv.id, { version: inv.version, issueDate: '2026-01-05', dueDate: '2026-02-05' })).status).toBe(200);
    expect((await own.createCreditNote(inv.id, { lines: [{ catalogItemId: it1.id }] })).status).toBe(400);
    const cn = (await own.createCreditNote(inv.id, { copyInvoiceLines: true })).body.document;
    expect((await own.patchCreditNote(cn.id, { version: cn.version, lines: [{ catalogItemId: it1.id }] })).status).toBe(400);
  });
});

describe('snapshots, issue and numbering', () => {
  it('issued documents keep their sealed lines: later item edits, archiving and rate renames never change them', async () => {
    const it1 = await item({ name: 'Install', description: 'Per unit', unitPrice: '80' });
    const inv = (await invoiceWith([{ catalogItemId: it1.id, quantity: '2' }])).body.document;
    const issued = await own.issueInvoice(inv.id, { version: inv.version, issueDate: '2026-01-05', dueDate: '2026-02-05' });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.document.number).toMatch(/\d/);
    const before = (await own.invoice(inv.id)).body.document;
    await own.patchItem(it1.id, { version: 1, name: 'Install v2', unitPrice: '95', taxMode: 'NONE' });
    await own.archiveItem(it1.id, 2);
    const after = (await own.invoice(inv.id)).body.document;
    expect(after.lines).toEqual(before.lines);
    expect([after.total, after.contentSha256, after.number]).toEqual([before.total, before.contentSha256, before.number]);
    // An issued document cannot be edited, catalog line or not.
    const refused = await own.patchInvoice(inv.id, { version: after.version, lines: [{ description: 'x', quantity: '1', unitPrice: '1' }] });
    expect([refused.status, refused.body.error]).toEqual([409, 'immutable']);
  });

  it('a quote from the catalog issues and converts as before (numbers taken only at issue)', async () => {
    const it1 = await item({ name: 'Package' });
    const q = (await own.createQuote({ customerId: customer, lines: [{ catalogItemId: it1.id }] })).body.document;
    expect(q.number).toBeNull();
    const issued = await own.issueQuote(q.id, { version: q.version, issueDate: '2026-01-05' });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    await own.archiveItem(it1.id, 1);
    const converted = await own.convertQuote(q.id);
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    expect(converted.body.document.number).toBeNull();
    expect(converted.body.document.lines[0]).toMatchObject({ description: 'Package\nSenior consultant', unitPrice: '150', taxRateId: gst });
  });
});

describe('audit', () => {
  it('records how many lines came from the catalog, never item ids, names or prices', async () => {
    const it1 = await item({ name: 'Secret name', unitPrice: '4321' });
    const inv = (await invoiceWith([{ catalogItemId: it1.id }, { description: 'Manual', quantity: '1', unitPrice: '1' }])).body.document;
    await own.patchInvoice(inv.id, { version: 1, lines: [{ catalogItemId: it1.id }] });
    await own.patchInvoice(inv.id, { version: 2, notes: 'n' });
    const rows = await audits(inv.id);
    expect(rows.map((r) => [r.action, r.metadata.catalogLineCount ?? null])).toEqual([
      ['finance.document.created', '1'], ['finance.document.updated', '1'], ['finance.document.updated', null],
    ]);
    const text = JSON.stringify(rows);
    for (const secret of [it1.id, 'Secret name', '4321']) expect(text).not.toContain(secret);
  });
});

describe('concurrency with catalog changes (deterministic: staged with pg_blocking_pids)', () => {
  /** Starts an uncommitted change to the item in another transaction; it holds the row until finished. */
  async function pendingItemChange(id: string, sql: string) {
    const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(sql, [id]);
    const pid = await backendPid(holder);
    return { pid, finish: async (how: 'COMMIT' | 'ROLLBACK') => { await holder.query(how); await holder.end(); } };
  }

  it('a save racing an archive waits for it, then refuses the archived item; no line is written from it', async () => {
    const it1 = await item({ name: 'Racing archive' });
    const draft = (await invoiceWith([{ description: 'Keep', quantity: '1', unitPrice: '1' }])).body.document;
    const archive = await pendingItemChange(it1.id, 'UPDATE finance_catalog_items SET archived_at = now(), version = version + 1 WHERE id = $1');
    const save = own.patchInvoice(draft.id, { version: 1, lines: [{ catalogItemId: it1.id }] });
    await waitUntilBlocked(admin, archive.pid, { count: 1 });
    await archive.finish('COMMIT');
    const res = await save;
    expect([res.status, res.body.error]).toEqual([409, 'archived_reference']);
    expect(await docRow(draft.id)).toMatchObject({ version: 1, total: '1.0000' });
  });

  it('a save racing a price change uses the committed price, never a mix; a rolled-back change is never seen', async () => {
    const it1 = await item({ name: 'Racing price', unitPrice: '100', taxMode: 'NONE', taxRateId: undefined });
    const change = await pendingItemChange(it1.id, 'UPDATE finance_catalog_items SET unit_price = 200, version = version + 1 WHERE id = $1');
    const save = invoiceWith([{ catalogItemId: it1.id }]);
    await waitUntilBlocked(admin, change.pid, { count: 1 });
    await change.finish('COMMIT');
    const res = await save;
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.document.lines[0]).toMatchObject({ unitPrice: '200', lineNet: '200.00' });
    expect(res.body.document.total).toBe('200.00');

    const rolledBack = await pendingItemChange(it1.id, 'UPDATE finance_catalog_items SET unit_price = 999, version = version + 1 WHERE id = $1');
    const save2 = invoiceWith([{ catalogItemId: it1.id }]);
    await waitUntilBlocked(admin, rolledBack.pid, { count: 1 });
    await rolledBack.finish('ROLLBACK');
    expect((await save2).body.document.lines[0].unitPrice).toBe('200');
  });
});
