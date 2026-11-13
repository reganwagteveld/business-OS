/**
 * Phase 1b tenancy and access control (PR 5): businesses, memberships, invitations, role rules,
 * last-owner protection, tenant isolation, trusted paths and schema guards (data-model §4, §5.5,
 * §5.6; architecture §7.2–7.3). Runs the real route handlers against PostgreSQL with the migrations
 * and prisma/privileged applied exactly as in production.
 */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as contextRoute from '@/app/api/v1/b/[slug]/route';
import * as membersRoute from '@/app/api/v1/b/[slug]/members/route';
import * as memberRoute from '@/app/api/v1/b/[slug]/members/[membershipId]/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as invitationRoute from '@/app/api/v1/b/[slug]/invitations/[invitationId]/route';
import { devOutbox } from '@/core/email';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
const authRole = new pg.Client({ connectionString: process.env.AUTH_DATABASE_URL });

beforeAll(async () => {
  await Promise.all([admin.connect(), app.connect(), authRole.connect()]);
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end(), authRole.end()]);
});

let ip = 1;
type User = { email: string; cookie: string; id: string; token: string };

function request(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `192.0.2.${ip++ % 250}` });
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
  const token = decodeURIComponent(cookie.split('=')[1]!).split('.')[0]!;
  const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
  return { email, cookie, id: rows[0].id, token };
}

const slugOf = () => `biz-${randomUUID().slice(0, 8)}`;
const business = (slug = slugOf()) => ({ name: 'Acme Plumbing', slug, countryCode: 'US', timeZone: 'America/Chicago', locale: 'en-US', currency: 'USD' });

async function createBusiness(owner: User, input = business()) {
  const res = await businessesRoute.POST(request('POST', '/api/v1/businesses', { cookie: owner.cookie, body: input }));
  return { res, slug: input.slug };
}

async function invite(by: User, slug: string, email: string, role: string) {
  const res = await invitationsRoute.POST(request('POST', `/api/v1/b/${slug}/invitations`, { cookie: by.cookie, body: { email, role } }), ctx({ slug }));
  const mail = [...devOutbox].reverse().find((m) => m.to === email.toLowerCase());
  const token = mail ? new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!).searchParams.get('token') : null;
  return { res, token };
}

async function accept(user: User, token: string) {
  return acceptRoute.POST(request('POST', '/api/v1/invitations/accept', { cookie: user.cookie, body: { token } }));
}

/** A business with an OWNER and one member of each other role. */
async function team() {
  const owner = await newUser('owner');
  const { slug } = await createBusiness(owner);
  const people: Record<string, User> = { OWNER: owner };
  for (const role of ['ADMIN', 'MANAGER', 'MEMBER']) {
    const user = await newUser(role.toLowerCase());
    const { token } = await invite(owner, slug, user.email, role);
    expect((await accept(user, token!)).status).toBe(200);
    people[role] = user;
  }
  const members = await (await membersRoute.GET(request('GET', `/api/v1/b/${slug}/members`, { cookie: owner.cookie }), ctx({ slug }))).json();
  const membershipOf = (u: User) => members.members.find((m: { userId: string }) => m.userId === u.id).id as string;
  return { slug, people, membershipOf };
}

const changeRole = (by: User, slug: string, membershipId: string, role: string, origin?: string | null) =>
  memberRoute.PATCH(request('PATCH', `/api/v1/b/${slug}/members/${membershipId}`, { cookie: by.cookie, body: { role }, origin }), ctx({ slug, membershipId }));
const remove = (by: User, slug: string, membershipId: string) =>
  memberRoute.DELETE(request('DELETE', `/api/v1/b/${slug}/members/${membershipId}`, { cookie: by.cookie }), ctx({ slug, membershipId }));

describe('creating businesses (pre-tenant trusted path)', () => {
  it('creates the business, an OWNER membership and an audit event; the region comes from the database', async () => {
    const owner = await newUser();
    const input = business();
    const { res } = await createBusiness(owner, input);
    expect(res.status).toBe(201);
    const list = await (await businessesRoute.GET(request('GET', '/api/v1/businesses', { cookie: owner.cookie }))).json();
    expect(list.businesses).toEqual([{ slug: input.slug, name: input.name, role: 'OWNER' }]);
    const { rows } = await admin.query(
      `SELECT b.home_region, b.country_code, b.time_zone, b.locale, b.currency,
              (SELECT count(*)::int FROM memberships m WHERE m.business_id = b.id AND m.role = 'OWNER') AS owners,
              (SELECT count(*)::int FROM audit_events a WHERE a.business_id = b.id AND a.action = 'business.created') AS audits,
              (SELECT region FROM app_private.deployment_config) AS deployment_region
       FROM businesses b WHERE b.slug = $1`, [input.slug]);
    expect(rows[0]).toMatchObject({ country_code: 'US', time_zone: 'America/Chicago', locale: 'en-US', currency: 'USD', owners: 1, audits: 1 });
    expect(rows[0].home_region).toBe(rows[0].deployment_region);
  });

  it('rejects invalid details, reserved and taken slugs, and requests without the app origin', async () => {
    const owner = await newUser();
    for (const bad of [{ timeZone: 'Mars/Olympus' }, { currency: 'XYZ' }, { countryCode: 'ZZ' }, { locale: 'english' }, { slug: 'admin' }, { slug: 'A_B' }]) {
      const { res } = await createBusiness(owner, { ...business(), ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const taken = business();
    expect((await createBusiness(owner, taken)).res.status).toBe(201);
    expect((await createBusiness(await newUser(), taken)).res.status).toBe(409);
    const csrf = await businessesRoute.POST(request('POST', '/api/v1/businesses', { cookie: owner.cookie, body: business(), origin: null }));
    expect(csrf.status).toBe(403);
    const anon = await businessesRoute.POST(request('POST', '/api/v1/businesses', { body: business() }));
    expect(anon.status).toBe(401);
  });

  it('has no parameter for a user id or a region: a body that tries is rejected', async () => {
    const owner = await newUser();
    const res = await businessesRoute.POST(request('POST', '/api/v1/businesses', { cookie: owner.cookie, body: { ...business(), homeRegion: 'eu-west-1', userId: randomUUID() } }));
    expect(res.status).toBe(400);
  });
});

describe('invitations', () => {
  it('accept_invitation works when called directly as bos_app, and only once', async () => {
    const owner = await newUser('owner');
    const { slug } = await createBusiness(owner);
    const invitee = await newUser('invitee');
    const { token } = await invite(owner, slug, invitee.email, 'MEMBER');
    const { rows } = await app.query('SELECT slug, role::text FROM app_private.accept_invitation($1, $2)', [invitee.token, token]);
    expect(rows).toEqual([{ slug, role: 'MEMBER' }]);
    await expect(app.query('SELECT * FROM app_private.accept_invitation($1, $2)', [invitee.token, token])).rejects.toThrow(/invitation not valid/);
  });

  it('stores only a hash, accepts once for the matching verified email, and refuses everyone else', async () => {
    const owner = await newUser('owner');
    const { slug } = await createBusiness(owner);
    const invitee = await newUser('invitee');
    const { res, token } = await invite(owner, slug, invitee.email.toUpperCase(), 'MEMBER');
    expect(res.status).toBe(201);
    const { rows } = await admin.query('SELECT email, token_hash FROM invitations WHERE token_hash = $1', [createHash('sha256').update(token!).digest('hex')]);
    expect(rows).toEqual([{ email: invitee.email, token_hash: createHash('sha256').update(token!).digest('hex') }]);

    const stranger = await newUser('stranger');
    expect((await accept(stranger, token!)).status).toBe(400);
    expect((await accept(invitee, 'x'.repeat(43))).status).toBe(400);
    const ok = await accept(invitee, token!);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ business: { slug, role: 'MEMBER' } });
    expect((await accept(invitee, token!)).status).toBe(400); // replay
  });

  it('refuses expired and revoked invitations', async () => {
    const owner = await newUser('owner');
    const { slug } = await createBusiness(owner);
    const a = await newUser('a');
    const b = await newUser('b');
    const expired = await invite(owner, slug, a.email, 'MEMBER');
    await admin.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [createHash('sha256').update(expired.token!).digest('hex')]);
    expect((await accept(a, expired.token!)).status).toBe(400);

    const revoked = await invite(owner, slug, b.email, 'MEMBER');
    const { invitation } = await revoked.res.json();
    const del = await invitationRoute.DELETE(request('DELETE', `/api/v1/b/${slug}/invitations/${invitation.id}`, { cookie: owner.cookie }), ctx({ slug, invitationId: invitation.id }));
    expect(del.status).toBe(200);
    expect((await accept(b, revoked.token!)).status).toBe(400);
  });

  it('never invites an owner, and only below the inviter’s own role', async () => {
    const { slug, people } = await team();
    expect((await invite(people.OWNER!, slug, 'x@example.com', 'OWNER')).res.status).toBe(400); // not an invitable role
    expect((await invite(people.ADMIN!, slug, 'y@example.com', 'ADMIN')).res.status).toBe(403);
    expect((await invite(people.ADMIN!, slug, 'y@example.com', 'MANAGER')).res.status).toBe(201);
    expect((await invite(people.MANAGER!, slug, 'z@example.com', 'MANAGER')).res.status).toBe(403);
    expect((await invite(people.MANAGER!, slug, 'z@example.com', 'MEMBER')).res.status).toBe(201);
    expect((await invite(people.MEMBER!, slug, 'w@example.com', 'MEMBER')).res.status).toBe(403);
  });
});

describe('role changes: no privilege escalation, last owner kept', () => {
  it('enforces the role rules server-side', async () => {
    const { slug, people, membershipOf } = await team();
    const { OWNER: owner, ADMIN: adminUser, MANAGER: manager, MEMBER: member } = people as Record<string, User>;
    // Nobody changes their own role.
    for (const u of [owner, adminUser, manager, member]) expect((await changeRole(u!, slug, membershipOf(u!), 'OWNER')).status).toBe(403);
    // Members cannot manage anyone.
    expect((await changeRole(member!, slug, membershipOf(manager!), 'MEMBER')).status).toBe(403);
    // Managers manage only members, and only to MEMBER.
    expect((await changeRole(manager!, slug, membershipOf(member!), 'MANAGER')).status).toBe(403);
    expect((await changeRole(manager!, slug, membershipOf(adminUser!), 'MEMBER')).status).toBe(403);
    // Admins cannot touch owners or other admins, nor create admins.
    expect((await changeRole(adminUser!, slug, membershipOf(owner!), 'MEMBER')).status).toBe(403);
    expect((await changeRole(adminUser!, slug, membershipOf(member!), 'ADMIN')).status).toBe(403);
    expect((await changeRole(adminUser!, slug, membershipOf(member!), 'MANAGER')).status).toBe(200);
    // Owners can make another owner.
    expect((await changeRole(owner!, slug, membershipOf(adminUser!), 'OWNER')).status).toBe(200);
    const { rows } = await admin.query("SELECT action, metadata FROM audit_events WHERE action = 'membership.role_changed' AND target_id = $1", [membershipOf(adminUser!)]);
    expect(rows.map((r) => r.metadata)).toContainEqual({ from: 'ADMIN', to: 'OWNER' });
  });

  it('keeps at least one owner: the API cannot remove or demote the last one, and neither can SQL', async () => {
    const { slug, people, membershipOf } = await team();
    const owner = people.OWNER!;
    // Only owners act on owners, and not on themselves, so the API has no path to the last owner.
    expect((await remove(people.ADMIN!, slug, membershipOf(owner))).status).toBe(403);
    expect((await remove(owner, slug, membershipOf(owner))).status).toBe(403);
    // Two owners: one may demote the other, after which the remaining one is protected.
    expect((await changeRole(owner, slug, membershipOf(people.ADMIN!), 'OWNER')).status).toBe(200);
    expect((await changeRole(people.ADMIN!, slug, membershipOf(owner), 'MEMBER')).status).toBe(200);
    // Database layer: as bos_app inside a tenant context, deleting the last owner fails at commit.
    const { rows } = await admin.query('SELECT business_id FROM memberships WHERE id = $1', [membershipOf(owner)]);
    await app.query('BEGIN');
    await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [rows[0].business_id, owner.id]);
    await app.query("DELETE FROM memberships WHERE role = 'OWNER'");
    await expect(app.query('COMMIT')).rejects.toThrow(/at least one owner/);
  });

  it('blocks a self role change in the database even without the API', async () => {
    const { people, membershipOf } = await team();
    const manager = people.MANAGER!;
    const { rows } = await admin.query('SELECT business_id FROM memberships WHERE id = $1', [membershipOf(manager)]);
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [rows[0].business_id, manager.id]);
      await expect(app.query("UPDATE memberships SET role = 'OWNER' WHERE user_id = $1", [manager.id])).rejects.toThrow(/role change not allowed/);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('removal takes effect on the next request', async () => {
    const { slug, people, membershipOf } = await team();
    const member = people.MEMBER!;
    expect((await membersRoute.GET(request('GET', `/api/v1/b/${slug}/members`, { cookie: member.cookie }), ctx({ slug }))).status).toBe(200);
    expect((await remove(people.MANAGER!, slug, membershipOf(member))).status).toBe(200);
    expect((await membersRoute.GET(request('GET', `/api/v1/b/${slug}/members`, { cookie: member.cookie }), ctx({ slug }))).status).toBe(404);
    const list = await (await businessesRoute.GET(request('GET', '/api/v1/businesses', { cookie: member.cookie }))).json();
    expect(list.businesses).toEqual([]);
  });

  it('permission checks gate every tenant route', async () => {
    const { slug, people } = await team();
    const member = people.MEMBER!;
    const ctxRes = await contextRoute.GET(request('GET', `/api/v1/b/${slug}`, { cookie: member.cookie }), ctx({ slug }));
    const body = await ctxRes.json();
    expect(body.membership.role).toBe('MEMBER');
    expect(body.membership.permissions).not.toContain('members:manage');
    expect((await invitationsRoute.GET(request('GET', `/api/v1/b/${slug}/invitations`, { cookie: member.cookie }), ctx({ slug }))).status).toBe(403);
    expect((await invitationsRoute.GET(request('GET', `/api/v1/b/${slug}/invitations`, { cookie: people.MANAGER!.cookie }), ctx({ slug }))).status).toBe(200);
    // CSRF: a cookie-authenticated change without the app origin is refused.
    expect((await changeRole(people.OWNER!, slug, randomUUID(), 'MEMBER', null)).status).toBe(403);
  });
});

describe('tenant isolation', () => {
  it('a member of one business cannot reach another business by slug or by id', async () => {
    const a = await team();
    const b = await team();
    const outsider = a.people.OWNER!;
    expect((await membersRoute.GET(request('GET', `/api/v1/b/${b.slug}/members`, { cookie: outsider.cookie }), ctx({ slug: b.slug }))).status).toBe(404);
    expect((await contextRoute.GET(request('GET', `/api/v1/b/${b.slug}`, { cookie: outsider.cookie }), ctx({ slug: b.slug }))).status).toBe(404);
    // B's membership id through A's URL: invisible under RLS, so 404, and nothing changes.
    const target = b.membershipOf(b.people.MEMBER!);
    expect((await changeRole(outsider, a.slug, target, 'MANAGER')).status).toBe(404);
    expect((await remove(outsider, a.slug, target)).status).toBe(404);
    const { rows } = await admin.query('SELECT role FROM memberships WHERE id = $1', [target]);
    expect(rows[0].role).toBe('MEMBER');
    // The members list never contains anyone from B.
    const list = await (await membersRoute.GET(request('GET', `/api/v1/b/${a.slug}/members`, { cookie: outsider.cookie }), ctx({ slug: a.slug }))).json();
    const bUsers = new Set(Object.values(b.people).map((u) => u.id));
    expect(list.members.some((m: { userId: string }) => bUsers.has(m.userId))).toBe(false);
  });

  it('audit events: tenant code reads only its business, never platform events, and cannot write for another business or change history', async () => {
    const a = await team();
    const b = await team();
    const [{ business_id: aId }] = (await admin.query('SELECT id AS business_id FROM businesses WHERE slug = $1', [a.slug])).rows;
    const [{ business_id: bId }] = (await admin.query('SELECT id AS business_id FROM businesses WHERE slug = $1', [b.slug])).rows;
    await admin.query("INSERT INTO audit_events (id, business_id, action) VALUES ($1, NULL, 'user.signed_in')", [randomUUID()]);
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [aId, a.people.OWNER!.id]);
      const { rows } = await app.query('SELECT DISTINCT business_id::text FROM audit_events');
      expect(rows).toEqual([{ business_id: aId }]);
      await app.query('SAVEPOINT s');
      await expect(app.query("INSERT INTO audit_events (id, business_id, actor_user_id, action) VALUES ($1, $2, $3, 'x')", [randomUUID(), bId, a.people.OWNER!.id])).rejects.toThrow(/row-level security/);
      await app.query('ROLLBACK TO SAVEPOINT s');
      await expect(app.query("INSERT INTO audit_events (id, business_id, actor_user_id, action) VALUES ($1, NULL, $2, 'x')", [randomUUID(), a.people.OWNER!.id])).rejects.toThrow(/row-level security/);
      await app.query('ROLLBACK TO SAVEPOINT s');
      await expect(app.query("UPDATE audit_events SET action = 'x'")).rejects.toThrow(/permission denied/);
      await app.query('ROLLBACK TO SAVEPOINT s');
      await expect(app.query('DELETE FROM audit_events')).rejects.toThrow(/permission denied/);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('bos_app has no direct INSERT on businesses or memberships, and sees nothing without a context', async () => {
    await expect(app.query("INSERT INTO businesses (id, name, slug, country_code, time_zone, locale, currency, home_region) VALUES (gen_random_uuid(), 'x', 'xx-x', 'US', 'UTC', 'en-US', 'USD', 'ci')")).rejects.toThrow(/permission denied/);
    await expect(app.query("INSERT INTO memberships (id, business_id, user_id) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid())")).rejects.toThrow(/permission denied/);
    for (const table of ['businesses', 'memberships', 'invitations', 'audit_events']) {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
  });
});

describe('trusted paths and schema guards (data-model §5.5)', () => {
  it('functions bind to the session token: forged tokens see nothing; no role but bos_app can call them', async () => {
    const owner = await newUser();
    await createBusiness(owner);
    const mine = await app.query('SELECT slug FROM app_private.my_memberships($1)', [owner.token]);
    expect(mine.rows).toHaveLength(1);
    for (const forged of ['x'.repeat(32), `h:${createHash('sha256').update(owner.token).digest('hex')}`, createHash('sha256').update(owner.token).digest('hex')]) {
      expect((await app.query('SELECT * FROM app_private.my_memberships($1)', [forged])).rows).toEqual([]);
    }
    await expect(app.query('SELECT app_private.session_user_id($1)', [owner.token])).rejects.toThrow(/permission denied/);
    await expect(authRole.query('SELECT * FROM app_private.my_memberships($1)', [owner.token])).rejects.toThrow(/permission denied/);
    // Signing out revokes the session for the database functions too.
    await authRoute.POST(request('POST', '/api/v1/auth/sign-out', { cookie: owner.cookie, body: {} }));
    expect((await app.query('SELECT * FROM app_private.my_memberships($1)', [owner.token])).rows).toEqual([]);
  });

  it('a temp-schema object shadowing a function name is not used', async () => {
    const owner = await newUser();
    await createBusiness(owner);
    await app.query('BEGIN');
    try {
      await app.query("SET LOCAL search_path = pg_temp, public");
      const res = await app.query('SELECT count(*)::int AS n FROM app_private.my_memberships($1)', [owner.token]);
      expect(res.rows[0].n).toBe(1);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('every SECURITY DEFINER function has a fixed search_path, a dedicated owner and no PUBLIC execute', async () => {
    const { rows } = await admin.query(`
      SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.proconfig::text AS config,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')`);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) {
      expect(['bos_definer', 'bos_maint'], r.proname).toContain(r.owner);
      expect(r.config, r.proname).toContain('search_path=pg_catalog, pg_temp');
      expect(r.public_exec, r.proname).toBe(false);
    }
  });

  it('nobody is a member of bos_definer or bos_maint, and neither can log in', async () => {
    const { rows } = await admin.query(`
      SELECT r.rolname, r.rolcanlogin, (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid = r.oid) AS members
      FROM pg_roles r WHERE r.rolname IN ('bos_definer', 'bos_maint')`);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ rolcanlogin: false, members: 0 });
  });

  it('every tenancy table forces row-level security', async () => {
    const { rows } = await admin.query(
      "SELECT relname FROM pg_class WHERE relname IN ('businesses','memberships','invitations','audit_events') AND relrowsecurity AND relforcerowsecurity");
    expect(rows).toHaveLength(4);
  });
});
