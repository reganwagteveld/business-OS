import { inviteForSignup, admitFixture } from './support/admission';
/**
 * Global search GS1-A (docs/global-search-gs1.md §14) through the real route handlers, against PostgreSQL
 * with the migrations (including 20261206000000_search_indexes) and privileged SQL applied, as bos_app with
 * forced RLS. Two businesses with identical names, numbers and emails; every role; record states; leak
 * canaries in non-match columns; cursors; concurrency slots; the statement timeout; term-free logging.
 * Records are seeded directly by the superuser test connection (search only reads them).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SearchResolveResponse, SearchResponse } from '@business-os/contracts';
import type { Permission, Role } from '@/modules/access';

// Narrower permission sets for one role at a time (a role without customers:read).
const custom: Partial<Record<Role, Permission[]>> = {};
vi.mock('@/modules/access', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/access')>();
  return { ...real, permissionsFor: (role: Role) => custom[role] ?? real.permissionsFor(role) };
});

import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as searchRoute from '@/app/api/v1/b/[slug]/search/route';
import * as resolveRoute from '@/app/api/v1/b/[slug]/search/resolve/route';
import { devOutbox } from '@/core/email';
import { joinSql, sql, TransactionStartTimeoutError, withTenant } from '@/core/db';
import { SearchTimeoutError } from '@/core/http/errors';
import type { SearchProvider } from '@/core/search';
import { permissionsFor } from '@/modules/access';
import { runSearch, SEARCH_PROVIDERS } from '@/modules/search';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });

let ip = 1 + Math.floor(Math.random() * 200) * 250;
type User = { email: string; cookie: string; id: string };
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function req(method: string, path: string, opts: { cookie?: string; body?: unknown; raw?: string } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.125.${Math.floor(ip / 250) % 256}.${ip++ % 250}`, origin: ORIGIN });
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined || opts.raw !== undefined) headers.set('content-type', 'application/json');
  if (method === 'POST') headers.set('idempotency-key', randomUUID());
  return new Request(`${BASE}${path}`, { method, headers, body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)) });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

async function newUser(prefix: string): Promise<User> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  await inviteForSignup(admin, email);
  await authRoute.POST(req('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: prefix } }));
  await admitFixture(admin, email);
  const mail = [...devOutbox].reverse().find((m) => m.to === email)!;
  const link = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!);
  await authRoute.GET(new Request(`${BASE}${link.pathname}${link.search}`, { method: 'GET', headers: { 'x-forwarded-for': `100.124.${Math.floor(ip / 250) % 256}.${ip++ % 250}` } }));
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

type Result = { status: number; body: any; text: string; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(who: User, slug: string, handler: Handler, path: string, body?: unknown, raw?: string): Promise<Result> {
  const res = await handler(req('POST', `/api/v1/b/${slug}${path}`, { cookie: who.cookie, body, raw }), ctx({ slug }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text, headers: res.headers };
}
const search = (who: User, slug: string, body: unknown) => call(who, slug, searchRoute.POST, '/search', body);
const resolve = (who: User, slug: string, body: unknown) => call(who, slug, resolveRoute.POST, '/search/resolve', body);
const ok = (r: Result) => {
  expect(r.status, r.text).toBe(200);
  return SearchResponse.parse(r.body);
};
const ids = (r: SearchResponse, type: string) => r.groups.find((g) => g.type === type)?.items.map((i) => i.id) ?? [];

// ---- seeding (superuser, triggers off: search only reads these rows) ----------------------------

type Seed = Record<string, string>;
async function seed(businessId: string, token: string): Promise<Seed> {
  const s: Seed = {};
  const id = (key: string) => (s[key] = randomUUID());
  await admin.query('BEGIN');
  await admin.query("SET LOCAL session_replication_role = 'replica'");
  const q = (text: string, values: unknown[]) => admin.query(text, [businessId, ...values]);
  await q(`INSERT INTO customers (id, business_id, display_name, legal_name, email, phone, notes) VALUES
    ($2, $1, 'Kelp & Co', 'Kelp Holdings Pty Ltd', 'accounts@kelp.example', $5, $6),
    ($3, $1, 'Kelpie Supplies', NULL, 'hello@kelpie.example', NULL, NULL),
    ($4, $1, 'Archived Kelp', NULL, NULL, NULL, NULL)`,
  [id('kelp'), id('kelpie'), id('archivedKelp'), `0400${token}`, `note ${token}`]);
  await admin.query('UPDATE customers SET archived_at = now() WHERE id = $1', [s.archivedKelp]);
  await q(`INSERT INTO contacts (id, business_id, customer_id, display_name, email, phone) VALUES ($2, $1, $3, 'Mara Kelp', 'mara@kelp.example', $4)`,
    [id('mara'), s.kelp, `0411${token}`]);
  await q(`INSERT INTO sales_pipelines (id, business_id, name) VALUES ($2, $1, 'Default')`, [id('pipeline')]);
  await q(`INSERT INTO sales_stages (id, business_id, pipeline_id, name, position) VALUES ($2, $1, $3, 'Proposal', 1)`, [id('stage'), s.pipeline]);
  await q(`INSERT INTO opportunities (id, business_id, title, customer_id, pipeline_id, stage_id, currency_code, amount, description, status, closed_at) VALUES
    ($2, $1, 'Kelp fit-out', $3, $4, $5, 'AUD', 99000, $6, 'WON', now())`, [id('opp'), s.kelp, s.pipeline, s.stage, `desc ${token}`]);
  await q(`INSERT INTO projects (id, business_id, name, customer_id, description) VALUES ($2, $1, 'Kelp website', $3, $4)`, [id('project'), s.kelp, `desc ${token}`]);
  await q(`INSERT INTO project_tasks (id, business_id, project_id, title, description, position) VALUES ($2, $1, $3, 'Kelp homepage copy', $4, 1)`,
    [id('task'), s.project, `desc ${token}`]);
  await q(`INSERT INTO finance_documents (id, business_id, kind, status, customer_id, currency_code, currency_scale, issue_date, due_date,
      number_value, number, issued_at, content_sha256, seller_snapshot, bill_to_snapshot, subtotal, tax_total, total, notes) VALUES
    ($2, $1, 'INVOICE', 'ISSUED', $4, 'AUD', 2, '2026-11-01', '2026-11-30', 42, 'INV-0042', now(), 'x', '{}', '{}', 100, 0, 100, $5),
    ($3, $1, 'INVOICE', 'DRAFT', $4, 'AUD', 2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, NULL)`,
  [id('invoice'), id('draftInvoice'), s.kelp, `note ${token}`]);
  await q(`INSERT INTO finance_documents (id, business_id, kind, status, customer_id, currency_code, currency_scale, issue_date,
      number_value, number, issued_at, content_sha256, seller_snapshot, bill_to_snapshot, subtotal, tax_total, total, voided_at) VALUES
    ($2, $1, 'QUOTE', 'VOID', $3, 'AUD', 2, '2026-10-01', 7, 'Q-0007', now(), 'x', '{}', '{}', 0, 0, 0, now())`, [id('quote'), s.kelp]);
  await q(`INSERT INTO finance_catalog_items (id, business_id, type, name, code, unit, currency_code, tax_mode, description, unit_price) VALUES
    ($2, $1, 'SERVICE', 'Kelp consulting', 'KC-01', 'hour', 'AUD', 'NONE', $3, 150)`, [id('catalog'), `desc ${token}`]);
  await q(`INSERT INTO people_departments (id, business_id, name) VALUES ($2, $1, 'Design')`, [id('dept')]);
  await q(`INSERT INTO people_employees (id, business_id, employee_number, given_name, family_name, preferred_name, job_title, work_email, work_phone, status, start_date, end_date) VALUES
    ($2, $1, 'E-100', 'Katherine', 'Kelpson', 'Kat', 'Designer', 'kat@kelp.example', $4, 'ACTIVE', '2026-01-01', NULL),
    ($3, $1, 'E-101', 'Kevin', 'Kelpson', NULL, 'Former designer', 'kevin@kelp.example', NULL, 'TERMINATED', '2025-01-01', '2026-06-30')`,
  [id('kat'), id('kevin'), `0422${token}`]);
  await q(`INSERT INTO people_department_assignments (id, business_id, employee_id, department_id, starts_on) VALUES ($2, $1, $3, $4, '2026-01-01')`,
    [randomUUID(), s.kat, s.dept]);
  await q(`INSERT INTO people_employee_personal_details (employee_id, business_id, personal_email, personal_phone, home_address, emergency_contact_name) VALUES
    ($2, $1, $3, $4, $4, $4)`, [s.kat, `personal${token}@home.example`, `personal${token}`]);
  await admin.query('COMMIT');
  return s;
}

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let a: Seed;
let b: Seed;
const TOKEN_A = `zq${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const TOKEN_B = `zq${randomUUID().replace(/-/g, '').slice(0, 10)}`;

beforeAll(async () => {
  process.env.SEARCH_API_TEST_ENABLE = '1';
  await admin.connect();
  A = await team('srcha');
  B = await team('srchb', []);
  a = await seed(A.businessId, TOKEN_A);
  b = await seed(B.businessId, TOKEN_B);
}, 120_000);
afterAll(async () => {
  delete process.env.SEARCH_API_TEST_ENABLE;
  await admin.end();
});
afterEach(() => {
  for (const key of Object.keys(custom)) delete custom[key as Role];
  process.env.SEARCH_API_TEST_ENABLE = '1';
});

describe('enablement gate', () => {
  it('answers the same 404 to every caller, before authentication, CSRF or tenant work, while disabled', async () => {
    delete process.env.SEARCH_API_TEST_ENABLE;
    const anonymous = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      new Request(`${BASE}/api/v1/b/${A.slug}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
    const responses = [
      await searchRoute.POST(anonymous('/search', { q: 'kelp' }), ctx({ slug: A.slug })),                              // no session
      await searchRoute.POST(anonymous('/search', { q: 'kelp' }, { origin: 'https://evil.example' }), ctx({ slug: A.slug })), // would fail CSRF
      await searchRoute.POST(anonymous('/search', 'not json'), ctx({ slug: 'no-such-business' })),                     // unknown slug, bad body
      await searchRoute.POST(req('POST', `/api/v1/b/${A.slug}/search`, { cookie: B.people.OWNER!.cookie, body: { q: 'kelp' } }), ctx({ slug: A.slug })), // not a member
      await searchRoute.POST(req('POST', `/api/v1/b/${A.slug}/search`, { cookie: A.people.MEMBER!.cookie, body: { q: 'kelp' } }), ctx({ slug: A.slug })), // member
      await searchRoute.POST(req('POST', `/api/v1/b/${A.slug}/search`, { cookie: A.people.OWNER!.cookie, body: { q: 'kelp' } }), ctx({ slug: A.slug })),  // owner
      await resolveRoute.POST(anonymous('/search/resolve', { items: [] }), ctx({ slug: A.slug })),
      await resolveRoute.POST(req('POST', `/api/v1/b/${A.slug}/search/resolve`, { cookie: A.people.OWNER!.cookie, body: { items: [{ type: 'customer', id: a.kelp }] } }), ctx({ slug: A.slug })),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });
});

describe('results and ranking', () => {
  it('finds every type for the owner, grouped, with the exact match first and archived excluded', async () => {
    const r = ok(await search(A.people.OWNER!, A.slug, { q: 'kelp' }));
    expect(r.searchedTypes).toEqual(['customer', 'contact', 'opportunity', 'project', 'task', 'quote', 'invoice', 'credit_note', 'catalog_item', 'employee']);
    const customers = r.groups.find((g) => g.type === 'customer')!;
    expect(customers.items.map((i) => i.id)).toEqual([a.kelp, a.kelpie]);
    expect(customers.items[0]).toEqual({ type: 'customer', id: a.kelp, title: 'Kelp & Co', subtitle: 'Kelp Holdings Pty Ltd', badges: [], route: { zone: 'customers', target: a.kelp } });
    expect(ids(r, 'contact')).toEqual([a.mara]);
    expect(ids(r, 'opportunity')).toEqual([a.opp]);
    expect(r.groups.find((g) => g.type === 'opportunity')!.items[0]).toMatchObject({ subtitle: 'Kelp & Co · Proposal', badges: ['won'] });
    expect(r.groups.find((g) => g.type === 'project')!.items[0]).toMatchObject({ subtitle: 'Kelp & Co · Planned' });
    expect(r.groups.find((g) => g.type === 'task')!.items[0]).toMatchObject({ subtitle: 'Kelp website · To do', route: { zone: 'projects', target: `${a.project}:task:${a.task}` } });
    // Documents through the customer's name: the issued invoice and the draft, labelled.
    const invoices = r.groups.find((g) => g.type === 'invoice')!.items;
    expect(invoices.map((i) => i.id).sort()).toEqual([a.invoice, a.draftInvoice].sort());
    expect(invoices.find((i) => i.id === a.draftInvoice)).toMatchObject({ title: 'Draft invoice', badges: ['draft'] });
    expect(invoices.find((i) => i.id === a.invoice)).toMatchObject({ title: 'INV-0042', subtitle: 'Kelp & Co · 2026-11-30', route: { zone: 'finance', target: `invoice:${a.invoice}` } });
    expect(r.groups.find((g) => g.type === 'quote')!.items[0]).toMatchObject({ title: 'Q-0007', badges: ['void'] });
    expect(r.groups.find((g) => g.type === 'catalog_item')!.items[0]).toMatchObject({ subtitle: 'KC-01 · Service', route: { zone: 'finance', target: `catalog:${a.catalog}` } });
    // Employees: word arm on the family name; the former employee ranks after the current one.
    expect(ids(r, 'employee')).toEqual([a.kat, a.kevin]);
    expect(r.groups.find((g) => g.type === 'employee')!.items.map((i) => i.badges)).toEqual([[], ['former']]);
    expect(r.groups.find((g) => g.type === 'employee')!.items[0]).toMatchObject({ title: 'Kat Kelpson', subtitle: 'Designer · Design' });
    expect(r.groups.some((g) => g.items.some((i) => i.id === a.archivedKelp))).toBe(false);
  });

  it('includes archived records only on request, badged and ranked last', async () => {
    const r = ok(await search(A.people.OWNER!, A.slug, { q: 'kelp', types: ['customer'], includeArchived: true }));
    expect(ids(r, 'customer')).toEqual([a.kelp, a.kelpie, a.archivedKelp]);
    expect(r.groups[0]!.items[2]!.badges).toEqual(['archived']);
  });

  it('matches numbers, codes and emails by prefix, and words in multi-word queries', async () => {
    expect(ids(ok(await search(A.people.OWNER!, A.slug, { q: 'inv-00' })), 'invoice')).toEqual([a.invoice]);
    expect(ids(ok(await search(A.people.OWNER!, A.slug, { q: 'kc-0' })), 'catalog_item')).toEqual([a.catalog]);
    expect(ids(ok(await search(A.people.OWNER!, A.slug, { q: 'accounts@kel' })), 'customer')).toEqual([a.kelp]);
    expect(ids(ok(await search(A.people.OWNER!, A.slug, { q: 'e-10' })), 'employee').sort()).toEqual([a.kat, a.kevin].sort());
    expect(ids(ok(await search(A.people.OWNER!, A.slug, { q: 'holdings kel' })), 'customer')).toEqual([a.kelp]);
    expect(ids(ok(await search(A.people.OWNER!, A.slug, { q: 'kat designer' })), 'employee')).toEqual([a.kat]);
  });

  it('runs only prefix arms under three characters', async () => {
    // "co" is a word of "Kelp & Co" but not a prefix of any name: no word arm, no hit.
    expect(ids(ok(await search(A.people.OWNER!, A.slug, { q: 'co', types: ['customer'] })), 'customer')).toEqual([]);
    expect(ids(ok(await search(A.people.OWNER!, A.slug, { q: 'ke', types: ['customer'] })), 'customer')).toEqual([a.kelp, a.kelpie]);
  });
});

describe('permissions and tenant isolation', () => {
  it('searches only the Zones each role can read', async () => {
    const member = ok(await search(A.people.MEMBER!, A.slug, { q: 'kelp' }));
    expect(member.searchedTypes).toEqual(['customer', 'contact', 'opportunity', 'project', 'task']);
    expect(member.groups.map((g) => g.type)).not.toContain('invoice');
    expect(member.groups.map((g) => g.type)).not.toContain('employee');
    const manager = ok(await search(A.people.MANAGER!, A.slug, { q: 'kelp' }));
    expect(manager.searchedTypes).toContain('employee');
    expect(manager.searchedTypes).toContain('invoice');
    // An explicitly requested type the caller cannot read is dropped silently.
    const narrowed = ok(await search(A.people.MEMBER!, A.slug, { q: 'kelp', types: ['employee', 'customer'] }));
    expect(narrowed.searchedTypes).toEqual(['customer']);
  });

  it('never shows a customer name under another Zone to a caller without customers:read', async () => {
    custom.MEMBER = permissionsFor('MEMBER').filter((p) => !p.startsWith('customers:'));
    const raw = await search(A.people.MEMBER!, A.slug, { q: 'kelp' });
    const r = ok(raw);
    expect(r.searchedTypes).toEqual(['opportunity', 'project', 'task']);
    expect(r.groups.find((g) => g.type === 'opportunity')!.items[0]!.subtitle).toBe('Proposal');
    expect(r.groups.find((g) => g.type === 'project')!.items[0]!.subtitle).toBe('Planned');
    expect(raw.text).not.toContain('Kelp & Co');
  });

  it('returns only the caller’s business for identical names, numbers and emails', async () => {
    const own = new Set(Object.values(a));
    const foreign = new Set(Object.values(b));
    for (const q of ['kelp', 'inv-0042', 'accounts@kelp.example', 'kc-01', 'kat', 'e-100']) {
      const r = ok(await search(A.people.OWNER!, A.slug, { q }));
      for (const item of r.groups.flatMap((g) => g.items)) {
        expect(own.has(item.id)).toBe(true);
        expect(foreign.has(item.id)).toBe(false);
      }
    }
    const resolved = SearchResolveResponse.parse((await resolve(A.people.OWNER!, A.slug, { items: [{ type: 'customer', id: b.kelp }, { type: 'customer', id: a.kelp }] })).body);
    expect(resolved.items.map((i) => i.id)).toEqual([a.kelp]);
  });

  it('forced RLS alone holds every branch to the caller’s business (explicit predicate removed)', async () => {
    const user = A.people.OWNER!;
    const rows = await withTenant({ businessId: A.businessId, userId: user.id }, async (db) => {
      const branches = SEARCH_PROVIDERS.map((p) => p.branch({
        mode: 'text', query: { q: 'kelp', tsquery: "'kelp':*" }, take: 50, includeArchived: true, canReadCustomers: true, prefixCap: 50, after: null,
        withoutTenantPredicateForIsolationTests: true,
      }));
      return db.$queryRaw<{ id: string }[]>(joinSql(branches, ' UNION ALL '));
    });
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(Object.values(b)).not.toContain(row.id);
  });
});

describe('field leakage and logging', () => {
  it('never matches or returns notes, descriptions, phones, amounts or personal details', async () => {
    for (const q of [TOKEN_A, `0400${TOKEN_A}`, `personal${TOKEN_A}`, `note ${TOKEN_A}`, `desc ${TOKEN_A}`]) {
      const r = await search(A.people.OWNER!, A.slug, { q });
      expect(ok(r).groups).toEqual([]);
      expect(r.text).not.toContain(TOKEN_A);
    }
    const all = await search(A.people.OWNER!, A.slug, { q: 'kelp', limit: 25 });
    expect(all.text).not.toContain(TOKEN_A);
    expect(all.text).not.toMatch(/99000|150\.00|0400|0411|0422/);
    const resolved = await resolve(A.people.OWNER!, A.slug, { items: [{ type: 'employee', id: a.kat }, { type: 'customer', id: a.kelp }] });
    expect(resolved.text).not.toContain(TOKEN_A);
  });

  it('logs no search term, id or title on success, validation failure and refusal', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    try {
      await search(A.people.OWNER!, A.slug, { q: 'kelpie supplies' });
      await search(A.people.OWNER!, A.slug, { q: 'kelpie', unknown: true });
      await search(A.people.OWNER!, A.slug, { q: 'kelpie', cursor: 'kelpie.forged' , types: ['customer'] });
      const text = spies.flatMap((s) => s.mock.calls.flat()).map(String).join('\n');
      expect(text).not.toMatch(/kelpie/i);
      expect(text).not.toContain(a.kelpie);
      expect(text).toContain('[search]');
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

describe('direct API requests', () => {
  it('rejects malformed input with 400 and never echoes the query', async () => {
    const owner = A.people.OWNER!;
    const bad = [
      { q: 'k' }, { q: 'x'.repeat(101) }, { q: 'a b c d e f g h i' }, { q: 'kelp', limit: 26 }, { q: 'kelp', limit: 0 },
      { q: 'kelp', types: ['event'] }, { q: 'kelp', types: ['resource'] }, { q: 'kelp', businessId: B.businessId },
      { q: 'kelp', cursor: 'abc' }, { q: 'kelp', types: ['customer', 'contact'], cursor: 'abc' },
    ];
    for (const body of bad) {
      const r = await search(owner, A.slug, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.text).not.toContain('kelp');
    }
    expect('GET' in searchRoute).toBe(false);
  });

  it('treats operator and wildcard characters as plain text', async () => {
    for (const q of ["' ; --", '%%', '__', '\\\\', 'a & b', 'a | b', '!(a)', 'a:*', 'a <-> b', 'kelp%', 'ｋｅｌｐ']) {
      expect((await search(A.people.OWNER!, A.slug, { q })).status, q).toBe(200);
    }
    // A wildcard is a literal character in the prefix arms (no LIKE anywhere): '%e' matches nothing,
    // and in the word arm punctuation only separates words ('kelp%' is the word prefix 'kelp').
    expect(ok(await search(A.people.OWNER!, A.slug, { q: '%e' })).groups).toEqual([]);
    expect(ok(await search(A.people.OWNER!, A.slug, { q: '_e' })).groups).toEqual([]);
    expect(ids(ok(await search(A.people.OWNER!, A.slug, { q: 'kelp%' })), 'customer')).toEqual([a.kelp, a.kelpie]);
  });
});

describe('show more (single-type keyset cursor)', () => {
  it('pages one type to the end without duplicates and refuses forged or rebound cursors', async () => {
    await admin.query(`INSERT INTO customers (id, business_id, display_name) SELECT gen_random_uuid(), $1, 'Pager ' || lpad(n::text, 2, '0') FROM generate_series(1, 23) n`, [A.businessId]);
    const owner = A.people.OWNER!;
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r = ok(await search(owner, A.slug, { q: 'pager', types: ['customer'], limit: 10, cursor }));
      const group = r.groups[0]!;
      seen.push(...group.items.map((i) => i.title));
      cursor = group.nextCursor;
      if (!group.hasMore) break;
      expect(cursor).not.toBeNull();
    }
    expect(seen).toEqual(Array.from({ length: 23 }, (_, i) => `Pager ${String(i + 1).padStart(2, '0')}`));

    const first = ok(await search(owner, A.slug, { q: 'pager', types: ['customer'], limit: 10 })).groups[0]!.nextCursor!;
    // Multi-type responses never carry a cursor.
    expect(ok(await search(owner, A.slug, { q: 'pager', limit: 5 })).groups.every((g) => g.nextCursor === null)).toBe(true);
    const [body, mac] = first.split('.');
    const forged = `${Buffer.from(JSON.stringify([2, 0, 'pager 20', randomUUID()])).toString('base64url')}.${mac}`;
    expect((await search(owner, A.slug, { q: 'pager', types: ['customer'], limit: 10, cursor: forged })).status).toBe(400);
    expect((await search(owner, A.slug, { q: 'pager', types: ['contact'], limit: 10, cursor: first })).status).toBe(400);
    expect((await search(owner, A.slug, { q: 'pagers', types: ['customer'], limit: 10, cursor: first })).status).toBe(400);
    expect((await search(owner, A.slug, { q: 'pager', types: ['customer'], limit: 10, includeArchived: true, cursor: first })).status).toBe(400);
    expect((await search(B.people.OWNER!, B.slug, { q: 'pager', types: ['customer'], limit: 10, cursor: first })).status).toBe(400);
    expect(body).toBeTruthy();
  });
});

describe('bounded discovery (not exhaustive)', () => {
  it('stops "Show more" at the bounded depth even when more records match; the Zone list stays the exhaustive view', async () => {
    await admin.query(`INSERT INTO customers (id, business_id, display_name) SELECT gen_random_uuid(), $1, 'Deep ' || lpad(n::text, 3, '0') FROM generate_series(1, 140) n`, [A.businessId]);
    const seen: string[] = [];
    let cursor: string | null = null;
    let last: { hasMore: boolean } | undefined;
    for (let page = 0; page < 10; page++) {
      const group: SearchResponse['groups'][number] = ok(await search(A.people.OWNER!, A.slug, { q: 'de', types: ['customer'], limit: 25, cursor })).groups[0]!;
      seen.push(...group.items.map((i) => i.title));
      last = group;
      if (!group.hasMore) break;
      cursor = group.nextCursor;
    }
    // 140 records start with "de" (a 2-character query runs prefix arms only); search reaches the first 125
    // in rank order and then reports no more reachable rows. Word matches are capped the same way at 200.
    expect(seen).toEqual(Array.from({ length: 125 }, (_, i) => `Deep ${String(i + 1).padStart(3, '0')}`));
    expect(last!.hasMore).toBe(false);
  });
});

describe('resolve', () => {
  it('returns what the caller can still see, in request order, and drops the rest', async () => {
    const r = await resolve(A.people.MEMBER!, A.slug, {
      items: [
        { type: 'project', id: a.project }, { type: 'customer', id: a.archivedKelp }, { type: 'employee', id: a.kat },
        { type: 'customer', id: randomUUID() }, { type: 'customer', id: a.kelp }, { type: 'customer', id: b.kelp },
      ],
    });
    expect(r.status, r.text).toBe(200);
    expect(SearchResolveResponse.parse(r.body).items.map((i) => [i.type, i.id])).toEqual([['project', a.project], ['customer', a.kelp]]);
    expect((await resolve(A.people.MEMBER!, A.slug, { items: [{ type: 'event', id: randomUUID() }] })).status).toBe(400);
    expect((await resolve(A.people.MEMBER!, A.slug, { items: Array.from({ length: 9 }, () => ({ type: 'customer', id: randomUUID() })) })).status).toBe(400);
  });
});

describe('server-side controls', () => {
  it('refuses a search with 429 search_busy when no user or business slot is free, and frees slots afterwards', async () => {
    const owner = A.people.OWNER!;
    const holder = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('search.user:' || $1 || ':' || $2 || ':' || n, 0)) FROM generate_series(0, 1) n`, [A.businessId, owner.id]);
      const busy = await search(owner, A.slug, { q: 'kelp' });
      expect(busy.status).toBe(429);
      expect(busy.body).toEqual({ error: 'search_busy' });
      expect(busy.headers.get('retry-after')).toBe('1');
      // Another member of the same business still has a user slot.
      expect((await search(A.people.ADMIN!, A.slug, { q: 'kelp' })).status).toBe(200);
      await holder.query('ROLLBACK');

      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('search.business:' || $1 || ':' || n, 0)) FROM generate_series(0, 7) n`, [A.businessId]);
      expect((await search(A.people.ADMIN!, A.slug, { q: 'kelp' })).status).toBe(429);
      expect((await resolve(A.people.ADMIN!, A.slug, { items: [{ type: 'customer', id: a.kelp }] })).status).toBe(429);
      // Another business is unaffected.
      expect((await search(B.people.OWNER!, B.slug, { q: 'kelp' })).status).toBe(200);
      await holder.query('ROLLBACK');
      expect((await search(owner, A.slug, { q: 'kelp' })).status).toBe(200);
    } finally {
      await holder.end();
    }
  });

  it('maps the search statement timeout to SearchTimeoutError and leaves the next transaction at the default', async () => {
    const slow: SearchProvider<Permission> = {
      type: 'customer', zone: 'customers', requires: ['customers:read'], matchFields: [], resultFields: [],
      branch: () => sql`(SELECT 'customer'::text AS type, gen_random_uuid()::text AS id, 1 AS tier, 0 AS demote, ''::text AS sort_key,
        ''::text AS title, NULL::text AS subtitle, ARRAY[]::text[] AS badges, ''::text AS target FROM pg_sleep(2))`,
    };
    const principal = { role: 'OWNER' as const, permissions: new Set(permissionsFor('OWNER')) };
    const owner = A.people.OWNER!;
    await expect(withTenant({ businessId: A.businessId, userId: owner.id }, (db) =>
      runSearch(db, principal, { q: 'kelp', limit: 5, includeArchived: false, cursor: null }, { providers: [slow] }), { timeoutMs: 3000 }))
      .rejects.toBeInstanceOf(SearchTimeoutError);
    const after = await withTenant({ businessId: A.businessId, userId: owner.id }, (db) => db.$queryRaw<{ t: string }[]>`SELECT current_setting('statement_timeout') AS t`);
    expect(after[0]!.t).toBe('0');
  });
});

describe('connection pool', () => {
  // The bounded pool wait covers the search unit of work. (Authentication's own membership lookups run before
  // it, on the same pool, and wait as they do for every route: see the PR's known limitations.)
  it('abandons a unit of work that cannot get a pooled connection within maxWait, without running it', async () => {
    const owner = A.people.OWNER!;
    const tenant = { businessId: A.businessId, userId: owner.id };
    const holders = Array.from({ length: 5 }, () => withTenant(tenant, (db) => db.$queryRaw`SELECT 1 AS slept FROM pg_sleep(2)`, { timeoutMs: 5000 }));
    await new Promise((r) => setTimeout(r, 300));
    let ran = false;
    const t0 = Date.now();
    await expect(withTenant(tenant, async () => { ran = true; }, { timeoutMs: 3000, maxWaitMs: 500 })).rejects.toBeInstanceOf(TransactionStartTimeoutError);
    expect(Date.now() - t0).toBeLessThan(1500);
    await Promise.all(holders);
    await new Promise((r) => setTimeout(r, 200));
    expect(ran).toBe(false);
    // The pool is usable again afterwards.
    expect((await search(owner, A.slug, { q: 'kelp' })).status).toBe(200);
  });
});
