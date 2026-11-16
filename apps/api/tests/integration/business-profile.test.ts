/**
 * Administration A2-A: business profile (docs/administration-a2.md §3.2–3.3, §4, §7). Runs the real
 * route handlers against PostgreSQL with migrations and prisma/privileged applied as in production.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BusinessProfileResponse } from '@business-os/contracts';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as profileRoute from '@/app/api/v1/b/[slug]/business/route';
import * as membersRoute from '@/app/api/v1/b/[slug]/members/route';
import * as memberRoute from '@/app/api/v1/b/[slug]/members/[membershipId]/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as customersRoute from '@/app/api/v1/b/[slug]/customers/route';
import * as quotesRoute from '@/app/api/v1/b/[slug]/finance/quotes/route';
import { devOutbox } from '@/core/email';
import { withTenant } from '@/core/db';
import { ForbiddenError, permissionsFor } from '@/modules/access';
import { updateBusinessProfile } from '@/modules/tenancy';

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

let ip = 1;
type User = { email: string; cookie: string; id: string };

function request(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `198.51.100.${ip++ % 250}` });
  if (opts.origin !== null) headers.set('origin', opts.origin ?? ORIGIN);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

async function newUser(prefix = 'user'): Promise<User> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  await authRoute.POST(request('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: prefix } }));
  const mail = [...devOutbox].reverse().find((m) => m.to === email)!;
  const link = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!);
  await authRoute.GET(request('GET', `${link.pathname}${link.search}`, { origin: null }));
  const res = await authRoute.POST(request('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD } }));
  const cookie = res.headers.getSetCookie().find((c) => /session_token=/.test(c))!.split(';')[0]!;
  const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
  return { email, cookie, id: rows[0].id };
}

/** A business with an OWNER and one member of each other role. */
async function team() {
  const owner = await newUser('owner');
  const slug = `biz-${randomUUID().slice(0, 8)}`;
  const created = await businessesRoute.POST(request('POST', '/api/v1/businesses', {
    cookie: owner.cookie, body: { name: 'Acme Plumbing', slug, countryCode: 'US', timeZone: 'America/Chicago', locale: 'en-US', currency: 'USD' },
  }));
  expect(created.status).toBe(201);
  const people: Record<string, User> = { OWNER: owner };
  for (const role of ['ADMIN', 'MANAGER', 'MEMBER']) {
    const user = await newUser(role.toLowerCase());
    await invitationsRoute.POST(request('POST', `/api/v1/b/${slug}/invitations`, { cookie: owner.cookie, body: { email: user.email, role } }), ctx({ slug }));
    const mail = [...devOutbox].reverse().find((m) => m.to === user.email)!;
    const token = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!).searchParams.get('token');
    expect((await acceptRoute.POST(request('POST', '/api/v1/invitations/accept', { cookie: user.cookie, body: { token } }))).status).toBe(200);
    people[role] = user;
  }
  const [{ id }] = (await admin.query('SELECT id FROM businesses WHERE slug = $1', [slug])).rows;
  return { slug, id: id as string, people };
}

const get = (by: User, slug: string) => profileRoute.GET(request('GET', `/api/v1/b/${slug}/business`, { cookie: by.cookie }), ctx({ slug }));
const patch = (by: User, slug: string, body: unknown, origin?: string | null) =>
  profileRoute.PATCH(request('PATCH', `/api/v1/b/${slug}/business`, { cookie: by.cookie, body, origin }), ctx({ slug }));
async function profile(by: User, slug: string) {
  const res = await get(by, slug);
  expect(res.status).toBe(200);
  return BusinessProfileResponse.parse(await res.json()).business;
}

describe('business profile: reading', () => {
  it('every member reads the profile; it matches the contract and starts at version 1 with empty contact fields', async () => {
    const t = await team();
    // The data region comes from the deployment's configuration (different locally and in CI), never a request.
    const { rows: [config] } = await admin.query('SELECT region FROM app_private.deployment_config');
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER']) {
      const p = await profile(t.people[role]!, t.slug);
      expect(p).toMatchObject({
        slug: t.slug, name: 'Acme Plumbing', legalName: null, tradingName: null, contactEmail: null, website: null,
        address: { line1: null, line2: null, city: null, region: null, postalCode: null, countryCode: null },
        countryCode: 'US', timeZone: 'America/Chicago', currency: 'USD', fiscalYearStartMonth: null, homeRegion: config.region, version: 1,
      });
    }
  });

  it('a non-member gets 404, and another business is never reachable by slug', async () => {
    const a = await team();
    const b = await team();
    expect((await get(b.people.OWNER!, a.slug)).status).toBe(404);
    expect((await get(await newUser('stranger'), a.slug)).status).toBe(404);
    expect((await patch(b.people.OWNER!, a.slug, { name: 'Taken over', version: 1 })).status).toBe(404);
  });
});

describe('business profile: editing', () => {
  it('OWNER and ADMIN may edit; MANAGER and MEMBER get 403 and nothing changes', async () => {
    const t = await team();
    expect((await patch(t.people.MANAGER!, t.slug, { name: 'Manager was here', version: 1 })).status).toBe(403);
    expect((await patch(t.people.MEMBER!, t.slug, { name: 'Member was here', version: 1 })).status).toBe(403);
    expect((await profile(t.people.OWNER!, t.slug)).name).toBe('Acme Plumbing');

    const res = await patch(t.people.ADMIN!, t.slug, {
      name: 'Acme Plumbing & Heating', legalName: 'Acme Plumbing LLC', tradingName: 'Acme', contactEmail: 'Hello@Acme.example',
      contactPhone: '+1 312 555 0100', website: 'https://acme.example',
      address: { line1: '1 Main St', city: 'Chicago', region: 'IL', postalCode: '60601', countryCode: 'US' }, fiscalYearStartMonth: 7, version: 1,
    });
    expect(res.status).toBe(200);
    const p = BusinessProfileResponse.parse(await res.json()).business;
    expect(p).toMatchObject({
      name: 'Acme Plumbing & Heating', legalName: 'Acme Plumbing LLC', tradingName: 'Acme', contactEmail: 'hello@acme.example',
      website: 'https://acme.example', address: { line1: '1 Main St', line2: null, city: 'Chicago', countryCode: 'US' }, fiscalYearStartMonth: 7, version: 2,
    });
    // The switcher shows the new name (my_memberships reads businesses.name).
    const list = await (await businessesRoute.GET(request('GET', '/api/v1/businesses', { cookie: t.people.MEMBER!.cookie }))).json();
    expect(list.businesses.find((b: { slug: string }) => b.slug === t.slug).name).toBe('Acme Plumbing & Heating');
    // Empty text clears a field.
    const cleared = BusinessProfileResponse.parse(await (await patch(t.people.OWNER!, t.slug, { tradingName: '', version: 2 })).json()).business;
    expect(cleared.tradingName).toBeNull();
    expect(cleared.version).toBe(3);
  });

  it('rejects a stale version with 409 and keeps the newer edit', async () => {
    const t = await team();
    expect((await patch(t.people.OWNER!, t.slug, { name: 'First', version: 1 })).status).toBe(200);
    const stale = await patch(t.people.ADMIN!, t.slug, { name: 'Second', version: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'stale' });
    expect((await profile(t.people.OWNER!, t.slug)).name).toBe('First');
  });

  it('two concurrent edits from the same version: exactly one wins', async () => {
    const t = await team();
    const results = await Promise.all([
      patch(t.people.OWNER!, t.slug, { tradingName: 'One', version: 1 }),
      patch(t.people.ADMIN!, t.slug, { tradingName: 'Two', version: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await profile(t.people.OWNER!, t.slug)).version).toBe(2);
  });

  it('validates every field on the server with a clear error and changes nothing', async () => {
    const t = await team();
    const cases: [unknown, number, string?][] = [
      [{ timeZone: 'Mars/Olympus', version: 1 }, 400, 'invalid_time_zone'],
      [{ currency: 'ZZZ', version: 1 }, 400, 'invalid_currency'],
      [{ countryCode: 'ZZ', version: 1 }, 400, 'invalid_country'],
      [{ locale: 'english', version: 1 }, 400, 'invalid_locale'],
      [{ address: { countryCode: 'QM' }, version: 1 }, 400, 'invalid_address_country'],
      [{ website: 'acme.example', version: 1 }, 400, 'invalid_input'],
      [{ contactEmail: 'not-an-email', version: 1 }, 400, 'invalid_input'],
      [{ fiscalYearStartMonth: 13, version: 1 }, 400, 'invalid_input'],
      [{ name: '', version: 1 }, 400, 'invalid_input'],
      [{ version: 1 }, 400, 'invalid_input'],
      [{ name: 'x' }, 400, 'invalid_input'],
      // Not editable: the slug, the data region and anything unknown are rejected outright.
      [{ slug: 'other-slug', version: 1 }, 400, 'invalid_input'],
      [{ homeRegion: 'eu-west-1', version: 1 }, 400, 'invalid_input'],
      [{ businessId: randomUUID(), name: 'x', version: 1 }, 400, 'invalid_input'],
    ];
    for (const [body, status, error] of cases) {
      const res = await patch(t.people.OWNER!, t.slug, body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect((await res.json()).error, JSON.stringify(body)).toBe(error);
    }
    expect((await profile(t.people.OWNER!, t.slug)).version).toBe(1);
  });

  it('refuses a request from another origin (CSRF) without changing anything', async () => {
    const t = await team();
    expect((await patch(t.people.OWNER!, t.slug, { name: 'Forged', version: 1 }, 'https://evil.example')).status).toBe(403);
    expect((await profile(t.people.OWNER!, t.slug)).name).toBe('Acme Plumbing');
  });

  it('a request that changes nothing writes nothing and audits nothing', async () => {
    const t = await team();
    const p = BusinessProfileResponse.parse(await (await patch(t.people.OWNER!, t.slug, { name: 'Acme Plumbing', version: 1 })).json()).business;
    expect(p.version).toBe(1);
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE business_id = $1 AND action = 'business.updated'", [t.id]);
    expect(rows[0].n).toBe(0);
  });

  it('a demoted admin cannot finish an edit: authority is re-checked inside the unit of work', async () => {
    const t = await team();
    const members = await (await membersRoute.GET(request('GET', `/api/v1/b/${t.slug}/members`, { cookie: t.people.OWNER!.cookie }), ctx({ slug: t.slug }))).json();
    const adminMembership = members.members.find((m: { userId: string }) => m.userId === t.people.ADMIN!.id).id as string;
    const demote = await memberRoute.PATCH(
      request('PATCH', `/api/v1/b/${t.slug}/members/${adminMembership}`, { cookie: t.people.OWNER!.cookie, body: { role: 'MEMBER' } }),
      ctx({ slug: t.slug, membershipId: adminMembership }),
    );
    expect(demote.status).toBe(200);
    expect((await patch(t.people.ADMIN!, t.slug, { name: 'Still admin?', version: 1 })).status).toBe(403);
  });
  it('authority is re-read inside the unit of work: an actor resolved as ADMIN but demoted before the transaction is refused', async () => {
    const t = await team();
    const { rows: [m] } = await admin.query('SELECT id FROM memberships WHERE user_id = $1 AND business_id = $2', [t.people.ADMIN!.id, t.id]);
    // The route resolved this actor as ADMIN; the demotion commits before the profile transaction runs.
    const stale = { userId: t.people.ADMIN!.id, membershipId: m.id as string, role: 'ADMIN' as const, permissions: new Set(permissionsFor('ADMIN')) };
    await admin.query("UPDATE memberships SET role = 'MEMBER' WHERE id = $1", [m.id]);
    await expect(withTenant({ businessId: t.id, userId: stale.userId }, (db) => updateBusinessProfile(db, stale, { name: 'Stale admin', version: 1 })))
      .rejects.toBeInstanceOf(ForbiddenError);
    // Suspended is refused the same way.
    await admin.query("UPDATE memberships SET role = 'ADMIN', status = 'SUSPENDED' WHERE id = $1", [m.id]);
    await expect(withTenant({ businessId: t.id, userId: stale.userId }, (db) => updateBusinessProfile(db, stale, { name: 'Suspended admin', version: 1 })))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect((await profile(t.people.OWNER!, t.slug)).name).toBe('Acme Plumbing');
  });
});

describe('business profile: audit and history', () => {
  it('audits who changed which fields, with old and new regional values and no free text', async () => {
    const t = await team();
    await patch(t.people.OWNER!, t.slug, { timeZone: 'Australia/Perth', currency: 'AUD', contactPhone: '+61 8 5550 0100', version: 1 });
    const { rows } = await admin.query(
      "SELECT actor_user_id::text, target_type, target_id::text, metadata FROM audit_events WHERE business_id = $1 AND action = 'business.updated'", [t.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: t.people.OWNER!.id, target_type: 'business', target_id: t.id });
    expect(rows[0].metadata).toEqual({
      fields: ['contactPhone', 'currency', 'timeZone'], currencyFrom: 'USD', currencyTo: 'AUD', timeZoneFrom: 'America/Chicago', timeZoneTo: 'Australia/Perth',
    });
    expect(JSON.stringify(rows[0].metadata)).not.toContain('5550');
  });

  it('changing the currency or time zone does not touch existing financial records', async () => {
    const t = await team();
    const owner = t.people.OWNER!;
    const customer = await (await customersRoute.POST(
      request('POST', `/api/v1/b/${t.slug}/customers`, { cookie: owner.cookie, body: { displayName: 'Globex' } }), ctx({ slug: t.slug }),
    )).json();
    const quote = await quotesRoute.POST(request('POST', `/api/v1/b/${t.slug}/finance/quotes`, {
      cookie: owner.cookie, body: { customerId: customer.customer.id, lines: [{ description: 'Consulting', quantity: '2', unitPrice: '150' }] },
    }), ctx({ slug: t.slug }));
    expect(quote.status).toBe(201);
    const snapshot = 'SELECT id, currency_code, issue_date, due_date, total::text, updated_at FROM finance_documents WHERE business_id = $1 ORDER BY id';
    const before = (await admin.query(snapshot, [t.id])).rows;
    expect(before).toHaveLength(1);
    expect(before[0].currency_code).toBe('USD');
    expect((await patch(owner, t.slug, { currency: 'EUR', timeZone: 'Europe/Berlin', version: 1 })).status).toBe(200);
    expect((await admin.query(snapshot, [t.id])).rows).toEqual(before);
    const p = await profile(owner, t.slug);
    expect([p.currency, p.timeZone]).toEqual(['EUR', 'Europe/Berlin']);
  });
});

describe('business profile: database guards', () => {
  async function asApp<T>(businessId: string, userId: string, fn: () => Promise<T>) {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [businessId, userId]);
      return await fn();
    } finally {
      await app.query('ROLLBACK');
    }
  }

  it('bos_app cannot change the slug, data region, archive state or another business, and the checks hold without the API', async () => {
    const a = await team();
    const b = await team();
    await asApp(a.id, a.people.OWNER!.id, async () => {
      for (const sql of ["UPDATE businesses SET slug = 'stolen-slug'", "UPDATE businesses SET home_region = 'eu-west-1'", 'UPDATE businesses SET archived_at = now()']) {
        await app.query('SAVEPOINT s');
        await expect(app.query(sql)).rejects.toThrow(/permission denied/);
        await app.query('ROLLBACK TO SAVEPOINT s');
      }
      const other = await app.query("UPDATE businesses SET trading_name = 'x' WHERE id = $1", [b.id]);
      expect(other.rowCount).toBe(0);
      const checks: [string, RegExp][] = [
        ["UPDATE businesses SET time_zone = 'Mars/Olympus'", /unknown time zone/],
        ["UPDATE businesses SET website = 'javascript:alert(1)'", /businesses_website_format/],
        ["UPDATE businesses SET contact_email = 'nope'", /businesses_contact_email_format/],
        ['UPDATE businesses SET fiscal_year_start_month = 0', /businesses_fiscal_year_start_month_range/],
        ["UPDATE businesses SET address_country_code = 'us'", /businesses_address_country_format/],
        ['UPDATE businesses SET version = 0', /businesses_version_positive/],
      ];
      for (const [sql, error] of checks) {
        await app.query('SAVEPOINT s');
        await expect(app.query(sql)).rejects.toThrow(error);
        await app.query('ROLLBACK TO SAVEPOINT s');
      }
    });
    expect((await admin.query('SELECT trading_name FROM businesses WHERE id = $1', [b.id])).rows[0].trading_name).toBeNull();
  });

  it('without a tenant context bos_app sees and updates no business', async () => {
    await app.query('BEGIN');
    try {
      expect((await app.query("UPDATE businesses SET trading_name = 'x'")).rowCount).toBe(0);
    } finally {
      await app.query('ROLLBACK');
    }
  });
});
