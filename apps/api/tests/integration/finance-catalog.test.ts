/**
 * Finance F7-A (docs/finance-catalog-f7a.md): the products and services catalog, through the real route
 * handlers against PostgreSQL with the migrations applied as in production. Covers permissions (keys,
 * not roles), validation, tax and currency handling, codes, lifecycle (active/inactive, archive/restore),
 * search, filters and keyset pagination, tenant isolation (API and RLS), optimistic concurrency under
 * real races (deterministic, via pg_blocking_pids), audit metadata, documents staying independent of the
 * catalog, and the database guard on its own (G1–G6).
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
import * as itemRestore from '@/app/api/v1/b/[slug]/finance/catalog-items/[itemId]/restore/route';
import * as invoicesRoute from '@/app/api/v1/b/[slug]/finance/invoices/route';
import * as invoiceRoute from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/route';
import * as invoiceIssue from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/issue/route';
import { CatalogItemResponse, ListCatalogItemsResponse } from '@business-os/contracts';
import { devOutbox } from '@/core/email';
import { lineDefaultsOf } from '@/modules/finance';
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
const IP_BLOCK = Number(process.env.CATALOG_TEST_IP_BLOCK ?? 140);
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
type Ctx = ReturnType<typeof ctx>;
type Handler = (r: Request, c: Ctx) => Promise<Response>;

const api = (who: User, slug: string) => {
  const F = `/api/v1/b/${slug}/finance`;
  const call = (h: Handler, method: string, path: string, c: Ctx, body?: unknown) => h(req(method, `${F}${path}`, { cookie: who.cookie, body }), c).then(json);
  const i = (itemId: string) => ctx({ slug, itemId });
  return {
    list: (qs = '') => call(itemsRoute.GET, 'GET', `/catalog-items${qs}`, ctx({ slug })),
    create: (body: unknown) => call(itemsRoute.POST, 'POST', '/catalog-items', ctx({ slug }), body),
    get: (id: string) => call(itemRoute.GET, 'GET', `/catalog-items/${id}`, i(id)),
    patch: (id: string, body: unknown) => call(itemRoute.PATCH, 'PATCH', `/catalog-items/${id}`, i(id), body),
    archive: (id: string, version: number) => call(itemArchive.POST, 'POST', `/catalog-items/${id}/archive`, i(id), { version }),
    restore: (id: string, version: number) => call(itemRestore.POST, 'POST', `/catalog-items/${id}/restore`, i(id), { version }),
    createTaxRate: (body: unknown) => call(taxRatesRoute.POST, 'POST', '/tax-rates', ctx({ slug }), body),
    patchTaxRate: (taxRateId: string, body: unknown) => call(taxRateRoute.PATCH, 'PATCH', `/tax-rates/${taxRateId}`, ctx({ slug, taxRateId }), body),
    settings: () => call(settingsRoute.GET, 'GET', '/settings', ctx({ slug })),
    patchSettings: (body: unknown) => call(settingsRoute.PATCH, 'PATCH', '/settings', ctx({ slug }), body),
    createInvoice: (body: unknown) => call(invoicesRoute.POST, 'POST', '/invoices', ctx({ slug }), body),
    invoice: (documentId: string) => call(invoiceRoute.GET, 'GET', `/invoices/${documentId}`, ctx({ slug, documentId })),
    issueInvoice: (documentId: string, body: unknown) => call(invoiceIssue.POST, 'POST', `/invoices/${documentId}/issue`, ctx({ slug, documentId }), body),
    createCustomer: (body: unknown) => customersRoute.POST(req('POST', `/api/v1/b/${slug}/customers`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
  };
};
const audits = async (targetId: string) =>
  (await admin.query('SELECT action, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows;
const row = async (id: string) => (await admin.query('SELECT * FROM finance_catalog_items WHERE id = $1', [id])).rows[0];

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let own: ReturnType<typeof api>;
let adm: ReturnType<typeof api>;
let mgr: ReturnType<typeof api>;
let mem: ReturnType<typeof api>;
let bOwn: ReturnType<typeof api>;
let gst: string; // A's 10% rate
let vat: string; // B's 20% rate

beforeAll(async () => {
  A = await team('cat-a');
  B = await team('cat-b', 'EUR');
  own = api(A.people.OWNER!, A.slug);
  adm = api(A.people.ADMIN!, A.slug);
  mgr = api(A.people.MANAGER!, A.slug);
  mem = api(A.people.MEMBER!, A.slug);
  bOwn = api(B.people.OWNER!, B.slug);
  gst = (await own.createTaxRate({ name: 'GST', ratePercent: '10' })).body.taxRate.id;
  vat = (await bOwn.createTaxRate({ name: 'VAT', ratePercent: '20' })).body.taxRate.id;
}, 120_000);

const SERVICE = { type: 'SERVICE', name: 'Consulting', unit: 'hour', unitPrice: '150', taxMode: 'RATE' } as const;
/** An item in A, created by the owner: by default a 150.00 per hour consulting service at A's GST. */
async function item(o: Record<string, unknown> = {}, who = own) {
  const res = await who.create({ ...SERVICE, taxRateId: gst, ...o });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.item;
}

describe('permissions (keys, not roles; D-F7A-2)', () => {
  it('OWNER and ADMIN manage; MANAGER reads only; MEMBER has no access; the keys decide, not the role', async () => {
    const it1 = await item({ name: 'Owner item' });
    const it2 = await item({ name: 'Admin item' }, adm);
    expect(it2.createdById).toBe(A.people.ADMIN!.id);
    // MANAGER: finance:read, no finance:catalog.
    expect((await mgr.list()).status).toBe(200);
    expect((await mgr.get(it1.id)).status).toBe(200);
    expect((await mgr.create({ ...SERVICE, taxRateId: gst })).status).toBe(403);
    expect((await mgr.patch(it1.id, { version: 1, name: 'x' })).status).toBe(403);
    expect((await mgr.archive(it1.id, 1)).status).toBe(403);
    expect((await mgr.restore(it1.id, 1)).status).toBe(403);
    // MEMBER: no finance key at all.
    expect((await mem.list()).status).toBe(403);
    expect((await mem.get(it1.id)).status).toBe(403);
    // A MEMBER given the keys can do exactly what the keys allow.
    custom.MEMBER = ['finance:read'];
    expect((await mem.list()).status).toBe(200);
    expect((await mem.create({ ...SERVICE, taxRateId: gst })).status).toBe(403);
    custom.MEMBER = ['finance:read', 'finance:catalog'];
    expect((await mem.create({ ...SERVICE, taxRateId: gst, name: 'Member item' })).status).toBe(201);
    // …and an OWNER without finance:catalog cannot.
    custom.OWNER = ['finance:read'];
    expect((await own.patch(it1.id, { version: 1, name: 'x' })).status).toBe(403);
    expect((await row(it1.id)).name).toBe('Owner item');
  });
});

describe('create, validation, tax and currency', () => {
  it('stores a product or service with its defaults; the currency defaults to the business currency; the response matches the contract', async () => {
    const res = await own.create({ type: 'PRODUCT', name: '  Widget  ', description: ' Blue ', code: ' W-001 ', unit: 'each', unitPrice: '12.5', taxMode: 'BUSINESS_DEFAULT' });
    expect(res.status).toBe(201);
    expect(CatalogItemResponse.safeParse(res.body).success).toBe(true);
    expect(res.body.item).toMatchObject({
      type: 'PRODUCT', name: 'Widget', description: 'Blue', code: 'W-001', unit: 'each', unitPrice: '12.5', currencyCode: 'AUD',
      taxMode: 'BUSINESS_DEFAULT', taxRateId: null, taxRate: null, status: 'ACTIVE', archivedAt: null, version: 1, createdById: A.people.OWNER!.id,
    });
    // Another currency is kept as given (never converted); sub-cent prices keep a document line's precision.
    const usd = await item({ currencyCode: 'USD', unitPrice: '0.012345' });
    expect([usd.currencyCode, usd.unitPrice]).toEqual(['USD', '0.012345']);
    // No default price, no tax.
    const free = await item({ unitPrice: null, taxMode: 'NONE', taxRateId: null, code: null, description: '' });
    expect([free.unitPrice, free.taxRateId, free.code, free.description]).toEqual([null, null, null, null]);
    const linked = await item();
    expect(linked.taxRate).toEqual({ id: gst, name: 'GST', ratePercent: '10', archived: false });
  });

  it('refuses invalid input: unknown fields, JSON numbers, bad units, too many decimals, unknown currencies, mismatched tax settings', async () => {
    const bad = async (o: Record<string, unknown>) => (await own.create({ ...SERVICE, taxRateId: gst, ...o })).body.error;
    for (const extra of [{ businessId: B.businessId }, { status: 'INACTIVE' }, { archivedAt: new Date().toISOString() }, { version: 3 }, { ratePercent: '10' }]) {
      expect(await bad(extra), JSON.stringify(extra)).toBe('invalid_input');
    }
    expect(await bad({ unitPrice: 150 })).toBe('invalid_input');
    expect(await bad({ unitPrice: '-1' })).toBe('invalid_input');
    expect(await bad({ unitPrice: '1.1234567' })).toBe('invalid_input');
    expect(await bad({ unit: 'parsec' })).toBe('invalid_input');
    expect(await bad({ type: 'BUNDLE' })).toBe('invalid_input');
    expect(await bad({ name: '   ' })).toBe('invalid_input');
    expect(await bad({ name: 'x'.repeat(201) })).toBe('invalid_input');
    expect(await bad({ code: 'A\u0007B' })).toBe('invalid_input');
    expect(await bad({ currencyCode: 'usd' })).toBe('invalid_input');
    expect(await bad({ currencyCode: 'ZZZ' })).toBe('invalid_currency');
    expect(await bad({ taxMode: 'RATE', taxRateId: null })).toBe('invalid_tax_rate');
    expect(await bad({ taxMode: 'NONE', taxRateId: gst })).toBe('invalid_tax_rate');
    expect(await bad({ taxMode: 'BUSINESS_DEFAULT', taxRateId: gst })).toBe('invalid_tax_rate');
    // Another business's rate answers like a missing one.
    expect(await bad({ taxRateId: vat })).toBe('invalid_tax_rate');
    expect(await bad({ taxRateId: randomUUID() })).toBe('invalid_tax_rate');
    // An archived rate cannot be newly linked.
    const old = (await own.createTaxRate({ name: 'Old', ratePercent: '5' })).body.taxRate.id;
    await own.patchTaxRate(old, { archived: true });
    expect(await bad({ taxRateId: old })).toBe('archived_reference');
  });

  it('codes are unique per business ignoring case, archived items included; other businesses may reuse them', async () => {
    const first = await item({ code: 'SKU-UNIQUE-1' });
    expect((await own.create({ ...SERVICE, taxRateId: gst, code: 'sku-unique-1' })).body.error).toBe('duplicate_code');
    expect((await own.archive(first.id, 1)).status).toBe(200);
    expect((await own.create({ ...SERVICE, taxRateId: gst, code: 'Sku-Unique-1' })).body.error).toBe('duplicate_code');
    const other = await item({ code: 'SKU-UNIQUE-2' });
    expect((await own.patch(other.id, { version: 1, code: 'SKU-UNIQUE-1' })).body.error).toBe('duplicate_code');
    // Changing only the case of its own code is allowed.
    expect((await own.patch(other.id, { version: 1, code: 'sku-unique-2' })).body.item.code).toBe('sku-unique-2');
    expect((await bOwn.create({ ...SERVICE, taxRateId: vat, code: 'SKU-UNIQUE-1' })).status).toBe(201);
  });
});

describe('edit and lifecycle', () => {
  it('edits with optimistic versions; switching tax mode clears the rate; an unchanged edit writes nothing', async () => {
    const it1 = await item();
    const r1 = await own.patch(it1.id, { version: 1, name: 'Senior consulting', unitPrice: '175.50', description: 'On site' });
    expect(r1.body.item).toMatchObject({ name: 'Senior consulting', unitPrice: '175.5', description: 'On site', version: 2, updatedById: A.people.OWNER!.id });
    expect((await own.patch(it1.id, { version: 1, name: 'Late' })).body.error).toBe('stale');
    const same = await own.patch(it1.id, { version: 2, name: 'Senior consulting', unitPrice: '175.500' });
    expect(same.body.item.version).toBe(2);
    const none = await own.patch(it1.id, { version: 2, taxMode: 'NONE' });
    expect(none.body.item).toMatchObject({ taxMode: 'NONE', taxRateId: null, taxRate: null, version: 3 });
    expect((await own.patch(it1.id, { version: 3, taxRateId: gst })).body.error).toBe('invalid_tax_rate');
    expect((await own.patch(it1.id, { version: 3, taxMode: 'RATE' })).body.error).toBe('invalid_tax_rate');
    expect((await own.patch(it1.id, { version: 3, taxMode: 'RATE', taxRateId: gst })).body.item.taxRateId).toBe(gst);
    // The type is fixed (not part of the edit contract).
    expect((await own.patch(it1.id, { version: 4, type: 'PRODUCT' })).body.error).toBe('invalid_input');
    expect((await own.get(it1.id)).body.item.type).toBe('SERVICE');
  });

  it('an item keeps a tax rate that was archived later, can still be edited, but cannot be re-linked to it', async () => {
    const rate = (await own.createTaxRate({ name: 'Temporary', ratePercent: '7.5' })).body.taxRate.id;
    const it1 = await item({ taxRateId: rate });
    await own.patchTaxRate(rate, { archived: true });
    const kept = await own.patch(it1.id, { version: 1, name: 'Still linked' });
    expect(kept.body.item).toMatchObject({ taxRateId: rate, taxRate: { archived: true, ratePercent: '7.5' }, version: 2 });
    await own.patch(it1.id, { version: 2, taxMode: 'NONE' });
    expect((await own.patch(it1.id, { version: 3, taxMode: 'RATE', taxRateId: rate })).body.error).toBe('archived_reference');
  });

  it('active ⇄ inactive; archive makes it read-only and hides it; restore brings it back with its status; nothing is deleted', async () => {
    const it1 = await item({ name: 'Lifecycle item' });
    const inactive = await own.patch(it1.id, { version: 1, status: 'INACTIVE' });
    expect(inactive.body.item).toMatchObject({ status: 'INACTIVE', version: 2 });
    const archived = await own.archive(it1.id, 2);
    expect(archived.status).toBe(200);
    expect(archived.body.item.archivedAt).not.toBeNull();
    expect(archived.body.item.version).toBe(3);
    expect((await own.archive(it1.id, 3)).body.error).toBe('archived');
    expect((await own.patch(it1.id, { version: 3, name: 'x' })).body.error).toBe('archived');
    expect((await own.patch(it1.id, { version: 3, status: 'ACTIVE' })).body.error).toBe('archived');
    expect((await own.restore(it1.id, 2)).body.error).toBe('stale');
    const restored = await own.restore(it1.id, 3);
    expect(restored.body.item).toMatchObject({ archivedAt: null, status: 'INACTIVE', version: 4, name: 'Lifecycle item' });
    expect((await own.restore(it1.id, 4)).body.error).toBe('not_archived');
    expect((await own.patch(it1.id, { version: 4, status: 'ACTIVE' })).body.item.status).toBe('ACTIVE');
    // No DELETE handler exists for catalog items.
    expect('DELETE' in itemRoute).toBe(false);
  });

  it('a missing or malformed id is 404', async () => {
    expect((await own.get(randomUUID())).status).toBe(404);
    expect((await own.get('not-a-uuid')).status).toBe(404);
    expect((await own.patch(randomUUID(), { version: 1, name: 'x' })).status).toBe(404);
    expect((await own.archive(randomUUID(), 1)).status).toBe(404);
  });
});

describe('search, filters and pagination', () => {
  it('searches name, code and description; filters by type, status, tax rate, currency and exact code; pages with an opaque keyset cursor', async () => {
    const C = await team('cat-search');
    const c = api(C.people.OWNER!, C.slug);
    const rate = (await c.createTaxRate({ name: 'GST', ratePercent: '10' })).body.taxRate.id;
    const mk = async (o: Record<string, unknown>) => (await c.create({ type: 'PRODUCT', unit: 'each', taxMode: 'NONE', ...o })).body.item;
    const apple = await mk({ name: 'Apple', code: 'FR-001', description: 'Fresh fruit' });
    const bolt = await mk({ name: 'Bolt', code: 'HW-777', description: 'Steel', taxMode: 'RATE', taxRateId: rate });
    const cleaning = await mk({ type: 'SERVICE', unit: 'hour', name: 'Cleaning', description: 'Includes fruit bowl wipe' });
    const drill = await mk({ name: 'Drill', code: 'HW-778', currencyCode: 'USD' });
    const engine = await mk({ name: 'Engine' });
    await c.patch(drill.id, { version: 1, status: 'INACTIVE' });
    await c.archive(engine.id, 1);
    const names = async (qs: string) => {
      const res = await c.list(qs);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(ListCatalogItemsResponse.safeParse(res.body).success).toBe(true);
      return res.body.items.map((x: { name: string }) => x.name);
    };
    expect(await names('')).toEqual(['Apple', 'Bolt', 'Cleaning', 'Drill']);
    expect(await names('?status=active')).toEqual(['Apple', 'Bolt', 'Cleaning']);
    expect(await names('?status=inactive')).toEqual(['Drill']);
    expect(await names('?status=archived')).toEqual(['Engine']);
    expect(await names('?status=all')).toEqual(['Apple', 'Bolt', 'Cleaning', 'Drill', 'Engine']);
    expect(await names('?q=fruit')).toEqual(['Apple', 'Cleaning']);
    expect(await names('?q=hw-77')).toEqual(['Bolt', 'Drill']);
    expect(await names('?code=hw-777')).toEqual(['Bolt']);
    expect(await names('?type=SERVICE')).toEqual(['Cleaning']);
    expect(await names(`?taxRateId=${rate}`)).toEqual(['Bolt']);
    expect(await names('?currencyCode=USD')).toEqual(['Drill']);
    // Paging: no duplicates, no gaps, stable order.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: { body: { items: { id: string }[]; nextCursor: string | null } } = await c.list(`?status=all&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...res.body.items.map((x) => x.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([apple.id, bolt.id, cleaning.id, drill.id, engine.id]);
    // Cursors from another list, or tampered, are refused rather than restarting.
    const foreign = Buffer.from(JSON.stringify({ k: 'finance:expenses', d: '2026-01-01', i: apple.id })).toString('base64url');
    expect((await c.list(`?cursor=${foreign}`)).body.error).toBe('invalid_cursor');
    const tampered = Buffer.from(JSON.stringify({ k: 'finance:catalog-items', n: 'A', i: 'x' })).toString('base64url');
    expect((await c.list(`?cursor=${tampered}`)).body.error).toBe('invalid_cursor');
    expect((await c.list('?limit=101')).body.error).toBe('invalid_query');
    expect((await c.list('?status=deleted')).body.error).toBe('invalid_query');
  });

  it('binds the cursor to the filters: a changed, added or removed filter is refused; the page size may change', async () => {
    const C = await team('cat-cursor');
    const c = api(C.people.OWNER!, C.slug);
    const rate = (await c.createTaxRate({ name: 'VAT', ratePercent: '20' })).body.taxRate.id;
    const ids: string[] = [];
    for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']) {
      ids.push((await c.create({ type: 'PRODUCT', unit: 'each', name, code: `K-${name}`, description: 'kit part', taxMode: 'RATE', taxRateId: rate })).body.item.id);
    }
    const base = `q=kit&type=PRODUCT&status=all&taxRateId=${rate}&currencyCode=AUD`;
    const first = await c.list(`?${base}&limit=2`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const cursor: string = first.body.nextCursor;
    expect(cursor).toBeTruthy();
    // Same filters, written differently (case, order), are the same list.
    const reordered = `currencyCode=AUD&taxRateId=${rate.toUpperCase()}&status=all&type=PRODUCT&q=kit`;
    expect((await c.list(`?${reordered}&limit=2&cursor=${cursor}`)).status).toBe(200);
    const refused = [
      // changed
      `q=kits&type=PRODUCT&status=all&taxRateId=${rate}&currencyCode=AUD`,
      `q=kit&type=SERVICE&status=all&taxRateId=${rate}&currencyCode=AUD`,
      `q=kit&type=PRODUCT&status=current&taxRateId=${rate}&currencyCode=AUD`,
      `q=kit&type=PRODUCT&status=all&taxRateId=${randomUUID()}&currencyCode=AUD`,
      `q=kit&type=PRODUCT&status=all&taxRateId=${rate}&currencyCode=EUR`,
      // added
      `${base}&code=K-Echo`,
      // removed
      `type=PRODUCT&status=all&taxRateId=${rate}&currencyCode=AUD`,
      `q=kit&status=all&taxRateId=${rate}&currencyCode=AUD`,
      `q=kit&type=PRODUCT&taxRateId=${rate}&currencyCode=AUD`,
      `q=kit&type=PRODUCT&status=all&currencyCode=AUD`,
      `q=kit&type=PRODUCT&status=all&taxRateId=${rate}`,
      '',
    ];
    for (const qs of refused) {
      const res = await c.list(`?${qs}${qs ? '&' : ''}limit=2&cursor=${cursor}`);
      expect(res.status, qs).toBe(400);
      expect(res.body.error, qs).toBe('invalid_cursor');
    }
    // Fixed filters with a changing page size: every row once, in order.
    const seen: string[] = [...first.body.items.map((x: { id: string }) => x.id)];
    let next: string | null = cursor;
    for (const limit of [3, 1, 5]) {
      if (!next) break;
      const res: { status: number; body: { items: { id: string }[]; nextCursor: string | null } } = await c.list(`?${base}&limit=${limit}&cursor=${next}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((x) => x.id));
      next = res.body.nextCursor;
    }
    expect(next).toBeNull();
    expect(seen).toEqual(ids);
  });
});

describe('tenant isolation', () => {
  it('another business can neither see nor change these items through the API (404, never 403)', async () => {
    const it1 = await item({ name: 'Private to A', code: 'A-PRIVATE' });
    expect((await bOwn.get(it1.id)).status).toBe(404);
    expect((await bOwn.patch(it1.id, { version: 1, name: 'Hijacked' })).status).toBe(404);
    expect((await bOwn.archive(it1.id, 1)).status).toBe(404);
    const listed = (await bOwn.list('?status=all&q=Private')).body.items;
    expect(listed).toEqual([]);
    expect((await bOwn.list('?code=A-PRIVATE')).body.items).toEqual([]);
    // A's rate cannot be linked from B.
    expect((await bOwn.create({ ...SERVICE, taxRateId: gst })).body.error).toBe('invalid_tax_rate');
    expect((await row(it1.id)).name).toBe('Private to A');
  });

  it('RLS: under another business context, raw SQL sees no rows and cannot insert, update or link across businesses', async () => {
    const it1 = await item();
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.business_id', $1, true)`, [B.businessId]);
      expect((await c.query('SELECT count(*)::int AS n FROM finance_catalog_items WHERE business_id = $1', [A.businessId])).rows[0].n).toBe(0);
      expect((await c.query(`UPDATE finance_catalog_items SET name = 'x', version = version + 1 WHERE id = $1`, [it1.id])).rowCount).toBe(0);
      await c.query('SAVEPOINT s');
      expect(await code(c.query(`INSERT INTO finance_catalog_items (id, business_id, type, name, unit, currency_code, tax_mode)
        VALUES (gen_random_uuid(), $1, 'PRODUCT', 'x', 'each', 'AUD', 'NONE')`, [A.businessId]))).toBe('42501');
      await c.query('ROLLBACK TO SAVEPOINT s');
      // In B's own row, a link to A's tax rate is refused by the composite FK (A's rate is invisible).
      expect(await code(c.query(`INSERT INTO finance_catalog_items (id, business_id, type, name, unit, currency_code, tax_mode, tax_rate_id)
        VALUES (gen_random_uuid(), $1, 'PRODUCT', 'x', 'each', 'EUR', 'RATE', $2)`, [B.businessId, gst]))).toBe('23503');
      await c.query('ROLLBACK');
      // No business context at all: nothing.
      await c.query('BEGIN');
      expect((await c.query('SELECT count(*)::int AS n FROM finance_catalog_items')).rows[0].n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect((await row(it1.id)).name).toBe('Consulting');
  });
});

describe('concurrency (deterministic: each race is staged with pg_blocking_pids)', () => {
  /** Holds the item's row lock in another transaction until `release` is called. */
  async function holdRow(id: string) {
    const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM finance_catalog_items WHERE id = $1 FOR UPDATE', [id]);
    const pid = await backendPid(holder);
    return { pid, release: async () => { await holder.query('COMMIT'); await holder.end(); } };
  }

  it('two edits from the same version: exactly one wins, the other is 409 stale, and the version moves by one', async () => {
    const it1 = await item();
    const lock = await holdRow(it1.id);
    const first = own.patch(it1.id, { version: 1, name: 'From tab one' });
    const second = adm.patch(it1.id, { version: 1, unitPrice: '999' });
    await waitUntilBlocked(admin, lock.pid, { count: 2 });
    await lock.release();
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe('stale');
    const after = await row(it1.id);
    expect(after.version).toBe(2);
    // Only the winner's change is in the row: never a mix of both.
    expect([after.name === 'From tab one', after.unit_price === '999.000000'].filter(Boolean)).toHaveLength(1);
  });

  it('an edit racing an archive: one wins; an archived item is never edited afterwards', async () => {
    const it1 = await item();
    const lock = await holdRow(it1.id);
    const edit = own.patch(it1.id, { version: 1, name: 'Edited' });
    const archive = adm.archive(it1.id, 1);
    await waitUntilBlocked(admin, lock.pid, { count: 2 });
    await lock.release();
    const [e, a] = await Promise.all([edit, archive]);
    expect([e.status, a.status].sort()).toEqual([200, 409]);
    const after = await row(it1.id);
    expect(after.version).toBe(2);
    if (a.status === 200) expect(after.name).toBe('Consulting');
    else expect(after.archived_at).toBeNull();
  });

  it('two creates with the same code at once: one 201, one 409 duplicate_code (the unique index arbitrates)', async () => {
    const codeValue = `RACE-${randomUUID().slice(0, 8)}`;
    // Hold the index entry: an uncommitted insert of the same code blocks both requests on the unique check.
    const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await holder.connect();
    await holder.query('BEGIN');
    const placeholder = randomUUID();
    await holder.query(`INSERT INTO finance_catalog_items (id, business_id, type, name, unit, currency_code, tax_mode, code)
      VALUES ($1, $2, 'PRODUCT', 'placeholder', 'each', 'AUD', 'NONE', $3)`, [placeholder, A.businessId, codeValue]);
    const pid = await backendPid(holder);
    const one = own.create({ ...SERVICE, taxRateId: gst, code: codeValue });
    const two = adm.create({ ...SERVICE, taxRateId: gst, code: codeValue.toLowerCase() });
    await waitUntilBlocked(admin, pid, { count: 2 });
    await holder.query('ROLLBACK');
    await holder.end();
    const results = await Promise.all([one, two]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe('duplicate_code');
    expect((await admin.query('SELECT count(*)::int AS n FROM finance_catalog_items WHERE business_id = $1 AND lower(code) = lower($2)', [A.businessId, codeValue])).rows[0].n).toBe(1);
  });

  it('linking a tax rate that is being archived: the guard waits for the archive and then refuses the link (FN017 → archived_reference)', async () => {
    const rate = (await own.createTaxRate({ name: 'Racing', ratePercent: '3' })).body.taxRate.id;
    const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('UPDATE finance_tax_rates SET archived_at = now() WHERE id = $1', [rate]);
    const pid = await backendPid(holder);
    // The service's own check still sees the rate as active (the archive is not committed yet)…
    const create = own.create({ ...SERVICE, taxRateId: rate, name: 'Racing item' });
    // …so the request reaches the guard's FOR SHARE read and waits there.
    await waitUntilBlocked(admin, pid, { count: 1 });
    await holder.query('COMMIT');
    await holder.end();
    const res = await create;
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('archived_reference');
    expect((await admin.query(`SELECT count(*)::int AS n FROM finance_catalog_items WHERE tax_rate_id = $1`, [rate])).rows[0].n).toBe(0);
  });
});

describe('audit', () => {
  it('records each change with references and field names only: no names, codes, descriptions or prices', async () => {
    const it1 = await item({ name: 'Secret recipe', code: 'SECRET-1', description: 'Do not leak', unitPrice: '4321.99' });
    await own.patch(it1.id, { version: 1, name: 'Renamed secret', unitPrice: '1234.5', status: 'INACTIVE' });
    await own.archive(it1.id, 2);
    await own.restore(it1.id, 3);
    const rows = await audits(it1.id);
    expect(rows.map((r) => r.action)).toEqual(['finance.catalog.created', 'finance.catalog.updated', 'finance.catalog.archived', 'finance.catalog.restored']);
    expect(rows[0].metadata).toEqual({ itemType: 'SERVICE' });
    expect(rows[1].metadata).toEqual({ itemType: 'SERVICE', fields: ['name', 'status', 'unitPrice'], statusFrom: 'ACTIVE', statusTo: 'INACTIVE' });
    const text = JSON.stringify(rows);
    for (const secret of ['Secret', 'SECRET-1', 'leak', '4321', '1234', 'Renamed']) expect(text).not.toContain(secret);
    // Reads write nothing.
    await own.get(it1.id);
    await own.list(`?q=secret`);
    expect((await audits(it1.id)).length).toBe(4);
  });

  it('a failed change writes no audit entry and changes nothing (one unit of work)', async () => {
    const it1 = await item();
    expect((await own.patch(it1.id, { version: 9, name: 'Nope' })).status).toBe(409);
    expect((await own.restore(it1.id, 1)).status).toBe(409);
    expect((await audits(it1.id)).map((r) => r.action)).toEqual(['finance.catalog.created']);
  });
});

describe('documents stay independent of the catalog', () => {
  it('a line copied from an item keeps its own values: later catalog edits and archiving never change the draft or the issued invoice', async () => {
    const customer = (await own.createCustomer({ displayName: 'Catalog customer' })).body.customer.id;
    const it1 = await item({ name: 'Install', description: 'Per unit', unitPrice: '80', taxMode: 'RATE', taxRateId: gst });
    const settings = (await own.settings()).body.settings;
    const defaults = lineDefaultsOf(it1, { currencyCode: 'AUD', defaultTaxRateId: settings.defaultTaxRateId });
    expect(defaults).toEqual({ description: 'Install\nPer unit', unitPrice: '80', taxRateId: gst });
    const created = await own.createInvoice({ customerId: customer, lines: [{ description: defaults.description, quantity: '2', unitPrice: defaults.unitPrice!, taxRateId: defaults.taxRateId }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const inv = created.body.document;
    const issued = await own.issueInvoice(inv.id, { version: inv.version, issueDate: '2026-01-05', dueDate: '2026-02-05' });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const before = (await own.invoice(inv.id)).body.document;
    await own.patch(it1.id, { version: 1, name: 'Install v2', unitPrice: '95', taxMode: 'NONE' });
    await own.archive(it1.id, 2);
    await own.patchTaxRate(gst, { name: 'GST renamed' });
    const after = (await own.invoice(inv.id)).body.document;
    expect(after.lines).toEqual(before.lines);
    expect([after.total, after.contentSha256]).toEqual([before.total, before.contentSha256]);
    expect(after.lines[0]).toMatchObject({ description: 'Install\nPer unit', unitPrice: '80', taxName: 'GST', taxRatePercent: '10' });
    await own.patchTaxRate(gst, { name: 'GST' });
    // Documents without any catalog reference keep working exactly as before (no new required field).
    expect((await own.createInvoice({ customerId: customer, lines: [{ description: 'Ad hoc', quantity: '1', unitPrice: '5' }] })).status).toBe(201);
  });

  it('the picker helper never converts currencies, follows the business default, and refuses inactive or archived items', async () => {
    const base = { name: 'X', description: null, unitPrice: '10', currencyCode: 'USD', taxMode: 'BUSINESS_DEFAULT' as const, taxRateId: null, status: 'ACTIVE' as const, archivedAt: null };
    expect(lineDefaultsOf(base, { currencyCode: 'AUD', defaultTaxRateId: gst })).toEqual({ description: 'X', unitPrice: null, taxRateId: gst });
    expect(lineDefaultsOf(base, { currencyCode: 'USD', defaultTaxRateId: null })).toEqual({ description: 'X', unitPrice: '10', taxRateId: null });
    expect(lineDefaultsOf({ ...base, taxMode: 'NONE' }, { currencyCode: 'USD', defaultTaxRateId: gst }).taxRateId).toBeNull();
    expect(() => lineDefaultsOf({ ...base, status: 'INACTIVE' }, { currencyCode: 'USD', defaultTaxRateId: null })).toThrow();
    expect(() => lineDefaultsOf({ ...base, archivedAt: new Date().toISOString() }, { currencyCode: 'USD', defaultTaxRateId: null })).toThrow();
    expect(lineDefaultsOf({ ...base, name: 'y'.repeat(200), description: 'z'.repeat(2000) }, { currencyCode: 'USD', defaultTaxRateId: null }).description).toHaveLength(1000);
  });
});

describe('database guard (G), as bos_app under RLS', () => {
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

  it('G1: no DELETE or TRUNCATE; identity, type and creation columns are not updatable at all', async () => {
    const it1 = await item();
    expect(await code(asA((c) => c.query('DELETE FROM finance_catalog_items WHERE id = $1', [it1.id])))).toBe('42501');
    expect(await code(asA((c) => c.query('TRUNCATE finance_catalog_items')))).toBe('42501');
    for (const set of [`type = 'PRODUCT'`, `id = gen_random_uuid()`, `business_id = '${B.businessId}'`, `created_at = now()`, `created_by_id = gen_random_uuid()`]) {
      expect(await code(asA((c) => c.query(`UPDATE finance_catalog_items SET ${set}, version = version + 1 WHERE id = $1`, [it1.id]))), set).toBe('42501');
    }
    expect((await row(it1.id)).type).toBe('SERVICE');
  });

  it('G2: the version advances by exactly one on every update (FN052)', async () => {
    const it1 = await item();
    expect(await code(asA((c) => c.query(`UPDATE finance_catalog_items SET name = 'x' WHERE id = $1`, [it1.id])))).toBe('FN052');
    expect(await code(asA((c) => c.query(`UPDATE finance_catalog_items SET name = 'x', version = version + 2 WHERE id = $1`, [it1.id])))).toBe('FN052');
    expect(await code(asA((c) => c.query(`UPDATE finance_catalog_items SET name = 'x', version = 1 WHERE id = $1`, [it1.id])))).toBe('FN052');
    expect(await code(asA((c) => c.query(`UPDATE finance_catalog_items SET name = 'x', version = version + 1 WHERE id = $1`, [it1.id])))).toBe('ok');
  });

  it('G3: archived items are read-only except their restore; an archive changes nothing else; the archive time is the database\'s (FN051)', async () => {
    const it1 = await item();
    expect(await code(asA((c) => c.query(`UPDATE finance_catalog_items SET archived_at = now(), name = 'x', version = version + 1 WHERE id = $1`, [it1.id])))).toBe('FN051');
    await asA((c) => c.query(`UPDATE finance_catalog_items SET archived_at = '2000-01-01', version = version + 1 WHERE id = $1`, [it1.id]));
    const archivedAt = (await row(it1.id)).archived_at as Date;
    expect(archivedAt.getUTCFullYear()).toBeGreaterThan(2000);
    for (const set of [`name = 'x'`, `status = 'INACTIVE'`, `unit_price = 1`, `archived_at = now()`, `tax_mode = 'NONE', tax_rate_id = NULL`]) {
      expect(await code(asA((c) => c.query(`UPDATE finance_catalog_items SET ${set}, version = version + 1 WHERE id = $1`, [it1.id]))), set).toBe('FN051');
    }
    expect(await code(asA((c) => c.query(`UPDATE finance_catalog_items SET archived_at = NULL, name = 'x', version = version + 1 WHERE id = $1`, [it1.id])))).toBe('FN051');
    expect(await code(asA((c) => c.query(`UPDATE finance_catalog_items SET archived_at = NULL, version = version + 1 WHERE id = $1`, [it1.id])))).toBe('ok');
  });

  it('G4: rows are created at version 1, unarchived, with database times (FN050); CHECKs hold every shape', async () => {
    const ins = (cols: string, vals: string) => asA((c) => c.query(`INSERT INTO finance_catalog_items (id, business_id, type, name, unit, currency_code, tax_mode${cols})
      VALUES (gen_random_uuid(), $1, 'PRODUCT', 'x', 'each', 'AUD', 'NONE'${vals})`, [A.businessId]));
    expect(await code(ins(', archived_at', ', now()'))).toBe('FN050');
    expect(await code(ins(', version', ', 2'))).toBe('FN050');
    expect(await code(ins(', created_at', `, '2000-01-01'`))).toBe('ok'); // replaced by now()
    for (const [cols, vals] of [
      [', status', `, 'DELETED'`], [', code', `, ' padded'`], [', code', `, ''`], [', unit_price', ', -1'], [', description', `, repeat('x', 2001)`],
      [', tax_rate_id', `, '${gst}'`],
    ] as const) {
      expect(await code(ins(cols, vals)), cols + vals).toBe('23514');
    }
    expect(await code(asA((c) => c.query(`INSERT INTO finance_catalog_items (id, business_id, type, name, unit, currency_code, tax_mode)
      VALUES (gen_random_uuid(), $1, 'BUNDLE', 'x', 'each', 'AUD', 'NONE')`, [A.businessId])))).toBe('23514');
    expect(await code(asA((c) => c.query(`INSERT INTO finance_catalog_items (id, business_id, type, name, unit, currency_code, tax_mode)
      VALUES (gen_random_uuid(), $1, 'PRODUCT', 'x', 'Each!', 'AUD', 'NONE')`, [A.businessId])))).toBe('23514');
    expect(await code(asA((c) => c.query(`INSERT INTO finance_catalog_items (id, business_id, type, name, unit, currency_code, tax_mode)
      VALUES (gen_random_uuid(), $1, 'PRODUCT', 'x', 'each', 'aud', 'NONE')`, [A.businessId])))).toBe('23514');
    expect(await code(asA((c) => c.query(`INSERT INTO finance_catalog_items (id, business_id, type, name, unit, currency_code, tax_mode)
      VALUES (gen_random_uuid(), $1, 'PRODUCT', 'x', 'each', 'AUD', 'RATE')`, [A.businessId])))).toBe('23514');
    const created = (await admin.query(`SELECT created_at FROM finance_catalog_items WHERE business_id = $1 ORDER BY created_at LIMIT 1`, [A.businessId])).rows[0].created_at as Date;
    expect(created.getUTCFullYear()).toBeGreaterThan(2000);
  });

  it('G5: an archived tax rate cannot be newly linked by any path (FN017), while existing links stay', async () => {
    const rate = (await own.createTaxRate({ name: 'Gone', ratePercent: '1' })).body.taxRate.id;
    const it1 = await item({ taxRateId: rate });
    await own.patchTaxRate(rate, { archived: true });
    const other = await item({ taxMode: 'NONE', taxRateId: null });
    expect(await code(asA((c) => c.query(`UPDATE finance_catalog_items SET tax_mode = 'RATE', tax_rate_id = $2, version = version + 1 WHERE id = $1`, [other.id, rate])))).toBe('FN017');
    expect(await code(asA((c) => c.query(`INSERT INTO finance_catalog_items (id, business_id, type, name, unit, currency_code, tax_mode, tax_rate_id)
      VALUES (gen_random_uuid(), $1, 'PRODUCT', 'x', 'each', 'AUD', 'RATE', $2)`, [A.businessId, rate])))).toBe('FN017');
    // The existing link is untouched by edits that do not change it.
    expect(await code(asA((c) => c.query(`UPDATE finance_catalog_items SET name = 'still', version = version + 1 WHERE id = $1`, [it1.id])))).toBe('ok');
  });

  it('G6: every finance_catalog_items CHECK and index is the reviewed set', async () => {
    const checks = (await admin.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'finance_catalog_items'::regclass AND contype = 'c' ORDER BY 1`)).rows.map((r) => r.conname);
    expect(checks).toEqual([
      'finance_catalog_items_code_shape', 'finance_catalog_items_currency', 'finance_catalog_items_description_length', 'finance_catalog_items_name_length',
      'finance_catalog_items_status', 'finance_catalog_items_tax_mode', 'finance_catalog_items_tax_rate', 'finance_catalog_items_type',
      'finance_catalog_items_unit_price', 'finance_catalog_items_unit_shape', 'finance_catalog_items_version_positive',
    ]);
    const indexes = (await admin.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'finance_catalog_items' ORDER BY 1`)).rows.map((r) => r.indexname);
    expect(indexes).toEqual([
      'finance_catalog_items_business_id_archived_at_status_name_i_idx', 'finance_catalog_items_business_id_id_key',
      'finance_catalog_items_business_id_tax_rate_id_idx', 'finance_catalog_items_code_key', 'finance_catalog_items_pkey',
    ]);
  });
});
