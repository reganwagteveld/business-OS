/**
 * Administration A2-B: membership lifecycle and invitations (docs/administration-a2.md §3.5–3.11, §6,
 * §12 requirements 1–5). Real route handlers against PostgreSQL with the migrations and privileged SQL
 * applied as in production. Concurrency tests use two (or three) real connections and wait on
 * PostgreSQL's own lock graph (support/locks.ts), never on sleeps.
 */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as membersRoute from '@/app/api/v1/b/[slug]/members/route';
import * as memberRoute from '@/app/api/v1/b/[slug]/members/[membershipId]/route';
import * as transferRoute from '@/app/api/v1/b/[slug]/members/[membershipId]/transfer-ownership/route';
import * as leaveRoute from '@/app/api/v1/b/[slug]/membership/leave/route';
import * as stepDownRoute from '@/app/api/v1/b/[slug]/membership/step-down/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as invitationRoute from '@/app/api/v1/b/[slug]/invitations/[invitationId]/route';
import * as resendRoute from '@/app/api/v1/b/[slug]/invitations/[invitationId]/resend/route';
import { devOutbox } from '@/core/email';
import { holderKeepsAuthority } from '@/modules/communications';
import { admitFixture, inviteForSignup } from './support/admission';
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

let ip = 1;
type User = { email: string; cookie: string; id: string; token: string };

function request(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `203.0.${Math.floor(ip / 250) % 256}.${ip++ % 250}`, origin: ORIGIN });
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

async function newUser(prefix = 'user'): Promise<User> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  await inviteForSignup(admin, email);
  await authRoute.POST(request('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: prefix } }));
  await admitFixture(admin, email);
  const mail = [...devOutbox].reverse().find((m) => m.to === email)!;
  const link = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!);
  await authRoute.GET(new Request(`${BASE}${link.pathname}${link.search}`, { method: 'GET', headers: { 'x-forwarded-for': `203.1.${Math.floor(ip / 250) % 256}.${ip++ % 250}` } }));
  const res = await authRoute.POST(request('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD } }));
  const cookie = res.headers.getSetCookie().find((c) => /session_token=/.test(c))!.split(';')[0]!;
  const token = decodeURIComponent(cookie.split('=')[1]!).split('.')[0]!;
  const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
  return { email, cookie, id: rows[0].id, token };
}

const tokenFromOutbox = (email: string) => {
  const mail = [...devOutbox].reverse().find((m) => m.to === email.toLowerCase());
  return mail ? new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!).searchParams.get('token') : null;
};

async function invite(by: User, slug: string, email: string, role: string) {
  const res = await invitationsRoute.POST(request('POST', `/api/v1/b/${slug}/invitations`, { cookie: by.cookie, body: { email, role } }), ctx({ slug }));
  return { res, token: res.status === 201 ? tokenFromOutbox(email) : null };
}
const accept = (user: User, token: string) => acceptRoute.POST(request('POST', '/api/v1/invitations/accept', { cookie: user.cookie, body: { token } }));

type Team = { slug: string; businessId: string; people: Record<string, User>; membershipOf: (u: User) => string };

/** A business with an OWNER and one member of each other role (plus any extra roles asked for). */
async function team(extra: string[] = []): Promise<Team> {
  const owner = await newUser('owner');
  const slug = `a2b-${randomUUID().slice(0, 8)}`;
  const created = await businessesRoute.POST(request('POST', '/api/v1/businesses', {
    cookie: owner.cookie, body: { name: 'Acme Plumbing', slug, countryCode: 'US', timeZone: 'America/Chicago', locale: 'en-US', currency: 'USD' },
  }));
  expect(created.status).toBe(201);
  const people: Record<string, User> = { OWNER: owner };
  for (const key of ['ADMIN', 'MANAGER', 'MEMBER', ...extra]) {
    const user = await newUser(key.toLowerCase());
    const { token } = await invite(owner, slug, user.email, key.replace(/\d+$/, ''));
    expect((await accept(user, token!)).status).toBe(200);
    people[key] = user;
  }
  const { rows } = await admin.query('SELECT b.id AS business_id, m.id, m.user_id FROM businesses b JOIN memberships m ON m.business_id = b.id WHERE b.slug = $1', [slug]);
  const ids = new Map(rows.map((r) => [r.user_id as string, r.id as string]));
  return { slug, businessId: rows[0].business_id, people, membershipOf: (u) => ids.get(u.id)! };
}

/** Makes `key` an OWNER through the database (admin), for owner-race setups. */
const makeOwner = (t: Team, key: string) => admin.query("UPDATE memberships SET role = 'OWNER' WHERE id = $1", [t.membershipOf(t.people[key]!)]);

const patch = (by: User, slug: string, membershipId: string, body: unknown) =>
  memberRoute.PATCH(request('PATCH', `/api/v1/b/${slug}/members/${membershipId}`, { cookie: by.cookie, body }), ctx({ slug, membershipId }));
const remove = (by: User, slug: string, membershipId: string) =>
  memberRoute.DELETE(request('DELETE', `/api/v1/b/${slug}/members/${membershipId}`, { cookie: by.cookie }), ctx({ slug, membershipId }));
const transfer = (by: User, slug: string, membershipId: string, body: unknown) =>
  transferRoute.POST(request('POST', `/api/v1/b/${slug}/members/${membershipId}/transfer-ownership`, { cookie: by.cookie, body }), ctx({ slug, membershipId }));
const leave = (by: User, slug: string, body: unknown = { confirm: true }) =>
  leaveRoute.POST(request('POST', `/api/v1/b/${slug}/membership/leave`, { cookie: by.cookie, body }), ctx({ slug }));
const stepDown = (by: User, slug: string, body: unknown = { confirm: true }) =>
  stepDownRoute.POST(request('POST', `/api/v1/b/${slug}/membership/step-down`, { cookie: by.cookie, body }), ctx({ slug }));
const members = (by: User, slug: string) => membersRoute.GET(request('GET', `/api/v1/b/${slug}/members`, { cookie: by.cookie }), ctx({ slug }));
const revoke = (by: User, slug: string, invitationId: string) =>
  invitationRoute.DELETE(request('DELETE', `/api/v1/b/${slug}/invitations/${invitationId}`, { cookie: by.cookie }), ctx({ slug, invitationId }));
const resend = (by: User, slug: string, invitationId: string) =>
  resendRoute.POST(request('POST', `/api/v1/b/${slug}/invitations/${invitationId}/resend`, { cookie: by.cookie }), ctx({ slug, invitationId }));

const activeOwners = async (businessId: string) =>
  Number((await admin.query("SELECT count(*) AS n FROM memberships WHERE business_id = $1 AND role = 'OWNER' AND status = 'ACTIVE'", [businessId])).rows[0].n);

/** A bos_app connection with an open transaction in the tenant context of `userId` (as withTenant sets it). */
async function tenantTx(businessId: string, userId: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [businessId, userId]);
  return c;
}
async function settle(c: pg.Client, sql: string): Promise<'ok' | string> {
  try {
    await c.query(sql);
    return 'ok';
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    return (error as Error).message;
  } finally {
    await c.end();
  }
}

// ---------------------------------------------------------------------------------------------
describe('last owner under concurrency (requirement 1, §6.1)', () => {
  // Each race: owners A and B, two transactions each take away one owner (as the other owner, the way
  // the API would), then both commit at the same moment. Before A2-B both commits succeeded (zero
  // owners). Now exactly one commits and the business keeps an owner.
  const races: { name: string; a: (t: Team) => string; b: (t: Team) => string }[] = [
    { name: 'demote vs demote', a: (t) => `UPDATE memberships SET role = 'ADMIN' WHERE id = '${t.membershipOf(t.people.ADMIN!)}'`, b: (t) => `UPDATE memberships SET role = 'MEMBER' WHERE id = '${t.membershipOf(t.people.OWNER!)}'` },
    { name: 'remove vs remove', a: (t) => `DELETE FROM memberships WHERE id = '${t.membershipOf(t.people.ADMIN!)}'`, b: (t) => `DELETE FROM memberships WHERE id = '${t.membershipOf(t.people.OWNER!)}'` },
    {
      name: 'suspend vs suspend',
      a: (t) => `UPDATE memberships SET status = 'SUSPENDED', suspended_at = now(), suspended_by = '${t.people.OWNER!.id}' WHERE id = '${t.membershipOf(t.people.ADMIN!)}'`,
      b: (t) => `UPDATE memberships SET status = 'SUSPENDED', suspended_at = now(), suspended_by = '${t.people.ADMIN!.id}' WHERE id = '${t.membershipOf(t.people.OWNER!)}'`,
    },
    {
      name: 'suspend vs remove',
      a: (t) => `UPDATE memberships SET status = 'SUSPENDED', suspended_at = now(), suspended_by = '${t.people.OWNER!.id}' WHERE id = '${t.membershipOf(t.people.ADMIN!)}'`,
      b: (t) => `DELETE FROM memberships WHERE id = '${t.membershipOf(t.people.OWNER!)}'`,
    },
    { name: 'self step-down vs self step-down', a: (t) => `UPDATE memberships SET role = 'ADMIN' WHERE id = '${t.membershipOf(t.people.OWNER!)}'`, b: (t) => `UPDATE memberships SET role = 'ADMIN' WHERE id = '${t.membershipOf(t.people.ADMIN!)}'`, },
  ];
  // Who acts in each transaction: tx A acts as OWNER on ADMIN's row (or self for step-down), tx B as ADMIN.
  for (const race of races) {
    it(`${race.name}: exactly one commits, an owner remains`, async () => {
      const t = await team();
      await makeOwner(t, 'ADMIN');
      const selfRace = race.name.startsWith('self');
      const txA = await tenantTx(t.businessId, selfRace ? t.people.OWNER!.id : t.people.OWNER!.id);
      const txB = await tenantTx(t.businessId, selfRace ? t.people.ADMIN!.id : t.people.ADMIN!.id);
      await txA.query(race.a(t));
      await txB.query(race.b(t));
      const outcomes = await Promise.all([settle(txA, 'COMMIT'), settle(txB, 'COMMIT')]);
      expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
      expect(outcomes.find((o) => o !== 'ok')).toMatch(/at least one owner/);
      expect(await activeOwners(t.businessId)).toBe(1);
    });
  }

  it('the §6.1 reproduction (checks run before either commits) now blocks the second check and refuses it', async () => {
    const t = await team();
    await makeOwner(t, 'ADMIN');
    const txA = await tenantTx(t.businessId, t.people.OWNER!.id);
    const txB = await tenantTx(t.businessId, t.people.ADMIN!.id);
    await txA.query("UPDATE memberships SET role = 'ADMIN' WHERE id = $1", [t.membershipOf(t.people.ADMIN!)]);
    await txB.query("UPDATE memberships SET role = 'ADMIN' WHERE id = $1", [t.membershipOf(t.people.OWNER!)]);
    await txA.query('SET CONSTRAINTS ALL IMMEDIATE'); // A's check runs now and holds the business owner lock
    const bCheck = txB.query('SET CONSTRAINTS ALL IMMEDIATE').then(() => 'ok', (e: Error) => e.message);
    await waitUntilBlocked(admin, await backendPid(txA)); // B's check waits for A
    expect(await settle(txA, 'COMMIT')).toBe('ok');
    expect(await bCheck).toMatch(/at least one owner/);
    await txB.query('ROLLBACK');
    await txB.end();
    expect(await activeOwners(t.businessId)).toBe(1);
  });

  it('API: concurrent ownership transfer with step-down, the other owner stepping down, and a suspension keep an owner', async () => {
    for (let round = 0; round < 3; round++) {
      const t = await team();
      await makeOwner(t, 'ADMIN');
      const [a, b, c] = await Promise.all([
        transfer(t.people.OWNER!, t.slug, t.membershipOf(t.people.MANAGER!), { stepDown: true, confirm: true }),
        stepDown(t.people.ADMIN!, t.slug),
        patch(t.people.ADMIN!, t.slug, t.membershipOf(t.people.OWNER!), { status: 'SUSPENDED' }),
      ]);
      for (const res of [a, b, c]) expect([200, 403, 409, 503]).toContain(res!.status);
      expect(await activeOwners(t.businessId)).toBeGreaterThanOrEqual(1);
    }
  });

  it('API: two owners demoting each other at the same time leaves exactly one owner', async () => {
    for (let round = 0; round < 3; round++) {
      const t = await team();
      await makeOwner(t, 'ADMIN');
      const results = await Promise.all([
        patch(t.people.OWNER!, t.slug, t.membershipOf(t.people.ADMIN!), { role: 'MEMBER' }),
        patch(t.people.ADMIN!, t.slug, t.membershipOf(t.people.OWNER!), { role: 'MEMBER' }),
      ]);
      expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
      expect(await activeOwners(t.businessId)).toBe(1);
    }
  });

  it('an owner change under REPEATABLE READ is refused (it could miss a concurrent change)', async () => {
    const t = await team();
    await makeOwner(t, 'ADMIN');
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await c.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [t.businessId, t.people.OWNER!.id]);
    await c.query("UPDATE memberships SET role = 'ADMIN' WHERE id = $1", [t.membershipOf(t.people.ADMIN!)]);
    expect(await settle(c, 'COMMIT')).toMatch(/READ COMMITTED or SERIALIZABLE/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('actor authority re-checked inside the transaction (requirement 5, §3.11)', () => {
  it('an admin demoted while their removal request waits gets 403 and removes nobody', async () => {
    const t = await team();
    // The owner's demotion of the admin is in flight (row locked, not committed).
    const demotion = await tenantTx(t.businessId, t.people.OWNER!.id);
    await demotion.query("UPDATE memberships SET role = 'MEMBER' WHERE id = $1", [t.membershipOf(t.people.ADMIN!)]);
    const pending = remove(t.people.ADMIN!, t.slug, t.membershipOf(t.people.MEMBER!));
    await waitUntilBlocked(admin, await backendPid(demotion));
    expect(await settle(demotion, 'COMMIT')).toBe('ok');
    expect((await pending).status).toBe(403);
    expect((await admin.query('SELECT 1 FROM memberships WHERE id = $1', [t.membershipOf(t.people.MEMBER!)])).rowCount).toBe(1);
  });

  it('a target promoted to OWNER while an admin acts on it is re-read after the lock: the admin gets 403', async () => {
    const t = await team();
    const promotion = await tenantTx(t.businessId, t.people.OWNER!.id);
    await promotion.query("UPDATE memberships SET role = 'OWNER' WHERE id = $1", [t.membershipOf(t.people.MANAGER!)]);
    const pending = remove(t.people.ADMIN!, t.slug, t.membershipOf(t.people.MANAGER!));
    await waitUntilBlocked(admin, await backendPid(promotion));
    expect(await settle(promotion, 'COMMIT')).toBe('ok');
    expect((await pending).status).toBe(403);
    expect((await admin.query("SELECT role FROM memberships WHERE id = $1", [t.membershipOf(t.people.MANAGER!)])).rows[0].role).toBe('OWNER');
  });
});

// ---------------------------------------------------------------------------------------------
describe('database actor rules (§6.3 invariants 2 and 3, G14)', () => {
  it('only an active owner may make an owner, or change or remove one; nobody changes their own status', async () => {
    const t = await team();
    const asAdmin = async (sql: string, params: unknown[]) => {
      const c = await tenantTx(t.businessId, t.people.ADMIN!.id);
      try {
        await c.query(sql, params);
        return 'ok';
      } catch (e) {
        return (e as Error).message;
      } finally {
        await c.query('ROLLBACK');
        await c.end();
      }
    };
    expect(await asAdmin("UPDATE memberships SET role = 'OWNER' WHERE id = $1", [t.membershipOf(t.people.MEMBER!)])).toMatch(/role change not allowed/);
    expect(await asAdmin("UPDATE memberships SET role = 'MEMBER' WHERE id = $1", [t.membershipOf(t.people.OWNER!)])).toMatch(/role change not allowed/);
    expect(await asAdmin("UPDATE memberships SET status = 'SUSPENDED', suspended_at = now() WHERE id = $1", [t.membershipOf(t.people.OWNER!)])).toMatch(/role change not allowed/);
    expect(await asAdmin('DELETE FROM memberships WHERE id = $1', [t.membershipOf(t.people.OWNER!)])).toMatch(/role change not allowed/);
    expect(await asAdmin("UPDATE memberships SET status = 'SUSPENDED', suspended_at = now() WHERE id = $1", [t.membershipOf(t.people.ADMIN!)])).toMatch(/status change not allowed/);
    expect(await asAdmin("UPDATE memberships SET role = 'MANAGER' WHERE id = $1", [t.membershipOf(t.people.ADMIN!)])).toMatch(/role change not allowed/);
    // Suspension details must match the status: a bare status change is stamped, inconsistent details are refused.
    expect(await asAdmin("UPDATE memberships SET suspended_at = now() WHERE id = $1", [t.membershipOf(t.people.MEMBER!)])).toMatch(/memberships_suspension_consistent/);
    await admin.query("UPDATE memberships SET status = 'SUSPENDED' WHERE id = $1", [t.membershipOf(t.people.MEMBER!)]);
    expect((await admin.query('SELECT suspended_at IS NOT NULL AS stamped FROM memberships WHERE id = $1', [t.membershipOf(t.people.MEMBER!)])).rows[0].stamped).toBe(true);
    await admin.query("UPDATE memberships SET status = 'ACTIVE' WHERE id = $1", [t.membershipOf(t.people.MEMBER!)]);
    expect((await admin.query('SELECT suspended_at, suspended_by FROM memberships WHERE id = $1', [t.membershipOf(t.people.MEMBER!)])).rows[0]).toEqual({ suspended_at: null, suspended_by: null });
    // Without a session user, bos_app cannot touch an owner at all.
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.business_id', $1, true)", [t.businessId]);
    await expect(c.query("UPDATE memberships SET role = 'OWNER' WHERE id = $1", [t.membershipOf(t.people.MEMBER!)])).rejects.toThrow(/role change not allowed/);
    await c.query('ROLLBACK');
    await c.end();
  });
});

// ---------------------------------------------------------------------------------------------
describe('suspend, reactivate, leave, transfer and step down', () => {
  it('suspension ends access at once, keeps the membership and audits; reactivation restores access', async () => {
    const t = await team();
    const member = t.people.MEMBER!;
    const id = t.membershipOf(member);
    expect((await patch(t.people.MANAGER!, t.slug, id, { status: 'SUSPENDED' })).status).toBe(200);
    expect((await members(member, t.slug)).status).toBe(404);
    const row = (await admin.query('SELECT status, suspended_at, suspended_by FROM memberships WHERE id = $1', [id])).rows[0];
    expect(row).toMatchObject({ status: 'SUSPENDED', suspended_by: t.people.MANAGER!.id });
    expect(row.suspended_at).not.toBeNull();
    const listed = (await (await members(t.people.OWNER!, t.slug)).json()).members.find((m: { id: string }) => m.id === id);
    expect(listed).toMatchObject({ status: 'SUSPENDED', email: member.email });
    expect(listed.suspendedAt).not.toBeNull();
    expect((await patch(t.people.MANAGER!, t.slug, id, { status: 'ACTIVE' })).status).toBe(200);
    expect((await members(member, t.slug)).status).toBe(200);
    const audits = (await admin.query("SELECT action FROM audit_events WHERE target_id = $1 AND action LIKE 'membership.%' ORDER BY created_at", [id])).rows.map((r) => r.action);
    expect(audits).toEqual(['membership.suspended', 'membership.reactivated']);
  });

  it('applies the rank rules to suspension and refuses self-suspension and suspending the last owner', async () => {
    const t = await team();
    expect((await patch(t.people.MANAGER!, t.slug, t.membershipOf(t.people.ADMIN!), { status: 'SUSPENDED' })).status).toBe(403);
    expect((await patch(t.people.ADMIN!, t.slug, t.membershipOf(t.people.OWNER!), { status: 'SUSPENDED' })).status).toBe(403);
    expect((await patch(t.people.ADMIN!, t.slug, t.membershipOf(t.people.ADMIN!), { status: 'SUSPENDED' })).status).toBe(403);
    expect((await patch(t.people.OWNER!, t.slug, t.membershipOf(t.people.OWNER!), { status: 'SUSPENDED' })).status).toBe(403);
    expect((await patch(t.people.OWNER!, t.slug, t.membershipOf(t.people.MEMBER!), { status: 'BANNED' })).status).toBe(400);
  });

  it('a member leaves (assignments cleared, audited); the last owner cannot', async () => {
    const t = await team();
    expect((await leave(t.people.MEMBER!, t.slug, {})).status).toBe(400); // explicit confirmation required
    expect((await leave(t.people.MEMBER!, t.slug)).status).toBe(200);
    expect((await members(t.people.MEMBER!, t.slug)).status).toBe(404);
    expect((await admin.query("SELECT 1 FROM audit_events WHERE action = 'membership.left' AND actor_user_id = $1", [t.people.MEMBER!.id])).rowCount).toBe(1);
    expect((await leave(t.people.OWNER!, t.slug)).status).toBe(409);
    expect(await activeOwners(t.businessId)).toBe(1);
  });

  it('ownership transfer: owner only, confirmed, active target, audited; with step-down in one transaction', async () => {
    const t = await team();
    const target = t.membershipOf(t.people.ADMIN!);
    expect((await transfer(t.people.ADMIN!, t.slug, t.membershipOf(t.people.MANAGER!), { stepDown: false, confirm: true })).status).toBe(403);
    expect((await transfer(t.people.OWNER!, t.slug, target, { stepDown: true })).status).toBe(400);
    expect((await transfer(t.people.OWNER!, t.slug, target, { stepDown: true, confirm: false })).status).toBe(400);
    expect((await transfer(t.people.OWNER!, t.slug, t.membershipOf(t.people.OWNER!), { stepDown: true, confirm: true })).status).toBe(403);
    expect((await patch(t.people.OWNER!, t.slug, t.membershipOf(t.people.MEMBER!), { status: 'SUSPENDED' })).status).toBe(200);
    expect((await transfer(t.people.OWNER!, t.slug, t.membershipOf(t.people.MEMBER!), { stepDown: false, confirm: true })).status).toBe(409);
    expect((await patch(t.people.OWNER!, t.slug, t.membershipOf(t.people.MEMBER!), { role: 'OWNER' })).status).toBe(409); // also via role change

    const res = await transfer(t.people.OWNER!, t.slug, target, { stepDown: true, confirm: true });
    expect(res.status).toBe(200);
    expect((await res.json()).member).toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
    const roles = (await admin.query('SELECT user_id, role FROM memberships WHERE business_id = $1', [t.businessId])).rows;
    expect(roles.find((r) => r.user_id === t.people.OWNER!.id).role).toBe('ADMIN');
    expect(roles.find((r) => r.user_id === t.people.ADMIN!.id).role).toBe('OWNER');
    const audit = (await admin.query("SELECT actor_user_id, metadata FROM audit_events WHERE action = 'membership.ownership_transferred' AND target_id = $1", [target])).rows;
    expect(audit).toEqual([{ actor_user_id: t.people.OWNER!.id, metadata: { from: 'ADMIN', to: 'OWNER', fromUserId: t.people.OWNER!.id, toUserId: t.people.ADMIN!.id, stepDown: true } }]);
    expect((await admin.query("SELECT 1 FROM audit_events WHERE action = 'membership.owner_stepped_down' AND actor_user_id = $1", [t.people.OWNER!.id])).rowCount).toBe(1);
    // The former owner is an ADMIN now and can no longer transfer.
    expect((await transfer(t.people.OWNER!, t.slug, t.membershipOf(t.people.MANAGER!), { stepDown: false, confirm: true })).status).toBe(403);
  });

  it('step-down needs another active owner', async () => {
    const t = await team();
    expect((await stepDown(t.people.OWNER!, t.slug)).status).toBe(409);
    expect((await stepDown(t.people.ADMIN!, t.slug)).status).toBe(403);
    await makeOwner(t, 'ADMIN');
    const res = await stepDown(t.people.OWNER!, t.slug);
    expect(res.status).toBe(200);
    expect((await res.json()).member.role).toBe('ADMIN');
    expect((await stepDown(t.people.ADMIN!, t.slug)).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------------------------
describe('member emails (D-A2-11, privileged 005)', () => {
  it('only OWNER, ADMIN and MANAGER see emails; the function answers nothing for a MEMBER or without a context', async () => {
    const t = await team();
    for (const role of ['OWNER', 'ADMIN', 'MANAGER']) {
      const list = (await (await members(t.people[role]!, t.slug)).json()).members;
      expect(list.find((m: { userId: string }) => m.userId === t.people.MEMBER!.id).email).toBe(t.people.MEMBER!.email);
    }
    const asMember = (await (await members(t.people.MEMBER!, t.slug)).json()).members;
    expect(asMember.every((m: Record<string, unknown>) => !('email' in m))).toBe(true);

    const c = await tenantTx(t.businessId, t.people.MEMBER!.id);
    expect((await c.query('SELECT * FROM app_private.member_emails()')).rowCount).toBe(0);
    await c.query('ROLLBACK');
    await c.end();
    const bare = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await bare.connect();
    expect((await bare.query('SELECT * FROM app_private.member_emails()')).rowCount).toBe(0);
    // users.email is still not readable by bos_app directly.
    await expect(bare.query('SELECT email FROM users LIMIT 1')).rejects.toThrow(/permission denied/);
    await bare.end();
    // Another business's context never returns this business's members.
    const other = await team();
    const x = await tenantTx(other.businessId, other.people.OWNER!.id);
    const emails = (await x.query('SELECT email FROM app_private.member_emails()')).rows.map((r) => r.email);
    expect(emails).not.toContain(t.people.MEMBER!.email);
    await x.query('ROLLBACK');
    await x.end();
  });
});

// ---------------------------------------------------------------------------------------------
describe('invitations (requirement 4, §6.2)', () => {
  it('one open invitation per address; already_member; an expired one is replaced', async () => {
    const t = await team();
    const email = `new-${randomUUID()}@example.com`;
    expect((await invite(t.people.OWNER!, t.slug, email, 'MEMBER')).res.status).toBe(201);
    const dup = await invite(t.people.OWNER!, t.slug, email.toUpperCase(), 'MANAGER');
    expect(dup.res.status).toBe(409);
    expect(await dup.res.json()).toEqual({ error: 'invitation_exists' });
    const member = await invite(t.people.OWNER!, t.slug, t.people.MEMBER!.email, 'MEMBER');
    expect(member.res.status).toBe(409);
    expect(await member.res.json()).toEqual({ error: 'already_member' });
    await admin.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE business_id = $1 AND email = $2", [t.businessId, email]);
    const again = await invite(t.people.OWNER!, t.slug, email, 'MEMBER');
    expect(again.res.status).toBe(201);
    expect(await again.res.clone().json()).toMatchObject({ delivery: 'sent' });
    const rows = (await admin.query('SELECT revoked_at IS NOT NULL AS revoked FROM invitations WHERE business_id = $1 AND email = $2 ORDER BY created_at', [t.businessId, email])).rows;
    expect(rows.map((r) => r.revoked)).toEqual([true, false]); // history kept
  });

  it('two concurrent invitations to one address: one 201, one 409', async () => {
    const t = await team();
    const email = `race-${randomUUID()}@example.com`;
    const results = await Promise.all([invite(t.people.OWNER!, t.slug, email, 'MEMBER'), invite(t.people.ADMIN!, t.slug, email, 'MEMBER')]);
    expect(results.map((r) => r.res.status).sort()).toEqual([201, 409]);
    expect(Number((await admin.query('SELECT count(*) AS n FROM invitations WHERE business_id = $1 AND email = $2', [t.businessId, email])).rows[0].n)).toBe(1);
  });

  it('resend revokes and reissues: the old link dies, the new one works; throttled to once per 60 s', async () => {
    const t = await team();
    const invitee = await newUser('invitee');
    const first = await invite(t.people.OWNER!, t.slug, invitee.email, 'MEMBER');
    const firstId = (await first.res.json()).invitation.id;
    expect((await resend(t.people.OWNER!, t.slug, firstId)).status).toBe(429);
    await admin.query("UPDATE invitations SET created_at = now() - interval '2 minutes' WHERE id = $1", [firstId]);
    const res = await resend(t.people.OWNER!, t.slug, firstId);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ delivery: 'sent', invitation: { email: invitee.email, role: 'MEMBER' } });
    expect(body.invitation.id).not.toBe(firstId);
    const newToken = tokenFromOutbox(invitee.email)!;
    expect(newToken).not.toBe(first.token);
    expect((await accept(invitee, first.token!)).status).toBe(400);
    expect((await resend(t.people.OWNER!, t.slug, firstId)).status).toBe(409); // the old one is closed
    expect((await accept(invitee, newToken)).status).toBe(200);
    const audit = (await admin.query("SELECT metadata FROM audit_events WHERE action = 'invitation.resent' AND target_id = $1", [body.invitation.id])).rows;
    expect(audit).toEqual([{ metadata: { role: 'MEMBER', replaces: firstId } }]);
    // No token in any audit metadata.
    const all = JSON.stringify((await admin.query('SELECT metadata FROM audit_events WHERE business_id = $1', [t.businessId])).rows);
    expect(all).not.toContain(newToken);
    // Managers resend only what they could send.
    const adminInvite = await invite(t.people.OWNER!, t.slug, `adm-${randomUUID()}@example.com`, 'ADMIN');
    const adminInviteId = (await adminInvite.res.json()).invitation.id;
    await admin.query("UPDATE invitations SET created_at = now() - interval '2 minutes' WHERE id = $1", [adminInviteId]);
    expect((await resend(t.people.MANAGER!, t.slug, adminInviteId)).status).toBe(403);
  });

  it('accept wins against a revoke in flight: the revoke waits, then answers 409, and nothing is marked revoked', async () => {
    const t = await team();
    const invitee = await newUser('invitee');
    const { res, token } = await invite(t.people.OWNER!, t.slug, invitee.email, 'MEMBER');
    const id = (await res.json()).invitation.id;
    const acceptTx = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await acceptTx.connect();
    await acceptTx.query('BEGIN');
    await acceptTx.query('SELECT * FROM app_private.accept_invitation($1, $2)', [invitee.token, token]);
    const pending = revoke(t.people.OWNER!, t.slug, id);
    await waitUntilBlocked(admin, await backendPid(acceptTx));
    expect(await settle(acceptTx, 'COMMIT')).toBe('ok');
    const revoked = await pending;
    expect(revoked.status).toBe(409);
    expect(await revoked.json()).toEqual({ error: 'invitation_closed' });
    const row = (await admin.query('SELECT accepted_at IS NOT NULL AS accepted, revoked_at IS NOT NULL AS revoked FROM invitations WHERE id = $1', [id])).rows[0];
    expect(row).toEqual({ accepted: true, revoked: false });
    expect((await admin.query("SELECT 1 FROM audit_events WHERE action = 'invitation.revoked' AND target_id = $1", [id])).rowCount).toBe(0);
  });

  it('revoke wins against an accept in flight: the accept waits, then fails generically, and no membership exists', async () => {
    const t = await team();
    const invitee = await newUser('invitee');
    const { res, token } = await invite(t.people.OWNER!, t.slug, invitee.email, 'MEMBER');
    const id = (await res.json()).invitation.id;
    const revokeTx = await tenantTx(t.businessId, t.people.OWNER!.id);
    await revokeTx.query('UPDATE invitations SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [id]);
    const pending = accept(invitee, token!);
    await waitUntilBlocked(admin, await backendPid(revokeTx));
    expect(await settle(revokeTx, 'COMMIT')).toBe('ok');
    expect((await pending).status).toBe(400);
    expect((await admin.query('SELECT 1 FROM memberships WHERE business_id = $1 AND user_id = $2', [t.businessId, invitee.id])).rowCount).toBe(0);
    expect((await admin.query('SELECT accepted_at FROM invitations WHERE id = $1', [id])).rows[0].accepted_at).toBeNull();
  });

  it('accept and revoke fired together: exactly one outcome holds', async () => {
    for (let round = 0; round < 4; round++) {
      const t = await team();
      const invitee = await newUser('invitee');
      const { res, token } = await invite(t.people.OWNER!, t.slug, invitee.email, 'MEMBER');
      const id = (await res.json()).invitation.id;
      const [a, r] = await Promise.all([accept(invitee, token!), revoke(t.people.OWNER!, t.slug, id)]);
      const row = (await admin.query('SELECT accepted_at IS NOT NULL AS accepted, revoked_at IS NOT NULL AS revoked FROM invitations WHERE id = $1', [id])).rows[0];
      const isMember = (await admin.query('SELECT 1 FROM memberships WHERE business_id = $1 AND user_id = $2', [t.businessId, invitee.id])).rowCount === 1;
      expect(row.accepted !== row.revoked).toBe(true);
      expect(isMember).toBe(row.accepted);
      expect(a.status === 200).toBe(row.accepted);
      expect(r.status === 200).toBe(row.revoked);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Mailbox credential cutoff (requirement 3, §3.10). Connections are seeded as the superuser with an
// opaque credential row (the format the credential CHECKs accept); no provider is ever called.
const ENC = (n: string) => `v1.test-key.${'A'.repeat(16)}.${n.padEnd(22, 'x')}`;
async function personalMailbox(t: Team, holder: User): Promise<{ connectionId: string; jobId: string; version: string }> {
  const connectionId = randomUUID();
  const jobId = randomUUID();
  const version = randomUUID();
  const account = `acct-${randomUUID()}`;
  await admin.query(`INSERT INTO mail_connections (id, business_id, provider, owner_user_id, credential_holder_id, provider_account_id, principal_account_id,
      mailbox_address, granted_scopes, kind, sharing) VALUES ($1, $2, 'GOOGLE', $3, $3, $4, $4, $5, ARRAY['gmail.readonly'], 'PERSONAL', 'OWNER_ONLY')`,
  [connectionId, t.businessId, holder.id, account, `${account}@example.com`]);
  await admin.query(`INSERT INTO mail_connection_credentials (business_id, connection_id, key_id, credential_version, refresh_token_enc)
      VALUES ($1, $2, 'test-key', $3, $4)`, [t.businessId, connectionId, version, ENC('refresh')]);
  await admin.query("INSERT INTO mail_sync_jobs (id, business_id, connection_id, kind, status, lease_id, lease_expires_at, attempts, started_at) VALUES ($1, $2, $3, 'INITIAL', 'RUNNING', gen_random_uuid(), now() + interval '5 minutes', 1, now())",
    [jobId, t.businessId, connectionId]);
  return { connectionId, jobId, version };
}
const connectionState = async (connectionId: string) => (await admin.query(`
  SELECT c.status, c.last_error_code, (SELECT count(*)::int FROM mail_connection_credentials k WHERE k.connection_id = c.id) AS credentials,
         (SELECT string_agg(j.status, ',') FROM mail_sync_jobs j WHERE j.connection_id = c.id) AS jobs
    FROM mail_connections c WHERE c.id = $1`, [connectionId])).rows[0];

/** A BUSINESS mailbox on a verified domain, held by `holder`, shared with `member` (READ). */
async function businessMailbox(t: Team, holder: User, member: User): Promise<string> {
  const domainId = randomUUID();
  const addressId = randomUUID();
  const connectionId = randomUUID();
  const domain = `d${randomUUID().slice(0, 8)}.example.org`;
  await admin.query(`INSERT INTO mail_business_domains (id, business_id, domain, verification_token_hash, created_by_id, verified_at, verified_by_id)
      VALUES ($1, $2, $3, $4, $5, now(), $5)`, [domainId, t.businessId, domain, 'a'.repeat(64), holder.id]);
  // The insert stamp clears verification; record it once, as the verify step would.
  await admin.query('UPDATE mail_business_domains SET verified_at = now(), verified_by_id = $2 WHERE id = $1 AND verified_at IS NULL', [domainId, holder.id]);
  await admin.query('INSERT INTO mail_business_addresses (id, business_id, address, domain_id, created_by_id) VALUES ($1, $2, $3, $4, $5)',
    [addressId, t.businessId, `team@${domain}`, domainId, holder.id]);
  await admin.query(`INSERT INTO mail_connections (id, business_id, provider, owner_user_id, credential_holder_id, provider_account_id, principal_account_id,
      mailbox_address, granted_scopes, kind, sharing, business_address_id) VALUES ($1, $2, 'GOOGLE', $3, $3, $4, $5, $6, ARRAY['gmail.readonly'], 'BUSINESS', 'MEMBERS', $7)`,
  [connectionId, t.businessId, holder.id, `team@${domain}`, `holder-${randomUUID()}`, `team@${domain}`, addressId]);
  await admin.query("INSERT INTO mail_connection_members (business_id, connection_id, user_id, access, granted_by_id) VALUES ($1, $2, $3, 'READ', $4)",
    [t.businessId, connectionId, member.id, holder.id]);
  return connectionId;
}
const grants = async (userId: string) => Number((await admin.query('SELECT count(*) AS n FROM mail_connection_members WHERE user_id = $1', [userId])).rows[0].n);

describe('mailbox credential cutoff (requirement 3, §3.10)', () => {
  it('the holder rule is shared with the sync claim: who keeps authority after a role change', () => {
    expect(holderKeepsAuthority('ADMIN', 'BUSINESS')).toBe(true);
    expect(holderKeepsAuthority('MANAGER', 'BUSINESS')).toBe(false);
    expect(holderKeepsAuthority('MANAGER', 'PERSONAL')).toBe(true);
    expect(holderKeepsAuthority('MEMBER', 'PERSONAL')).toBe(false);
    expect(holderKeepsAuthority('ADMIN', 'PERSONAL')).toBe(true); // OWNER → ADMIN step-down keeps both
    expect(holderKeepsAuthority(null, 'PERSONAL')).toBe(false);
  });

  it('removal stops the held mailbox in the same transaction, audited as the acting admin; shared access is recorded', async () => {
    const t = await team();
    const box = await personalMailbox(t, t.people.MANAGER!);
    const before = await connectionState(box.connectionId);
    expect(before).toMatchObject({ status: 'ACTIVE', credentials: 1, jobs: 'RUNNING' });
    expect((await remove(t.people.ADMIN!, t.slug, t.membershipOf(t.people.MANAGER!))).status).toBe(200);
    expect(await connectionState(box.connectionId)).toMatchObject({ status: 'NEEDS_REAUTH', last_error_code: 'owner_inactive', credentials: 0, jobs: 'CANCELLED' });
    const audit = (await admin.query("SELECT actor_user_id, metadata FROM audit_events WHERE action = 'communications.connection.holder_departed' AND target_id = $1", [box.connectionId])).rows;
    expect(audit).toEqual([{ actor_user_id: t.people.ADMIN!.id, metadata: { provider: 'GOOGLE', kind: 'PERSONAL', userId: t.people.MANAGER!.id, cause: 'member_removed' } }]);
    // The fences refuse the in-flight worker: heartbeat/complete find no valid lease, the refresh store no credential.
    const job = (await admin.query('SELECT lease_id FROM mail_sync_jobs WHERE id = $1', [box.jobId])).rows[0];
    expect(job.lease_id).toBeNull();
  });

  it('suspension stops held mailboxes but keeps shared-mailbox access rows; removal cascades them with an audit; demotions stop only what loses authority', async () => {
    const t = await team(['MANAGER2']);
    const box = await personalMailbox(t, t.people.MANAGER!);
    const shared = await businessMailbox(t, t.people.OWNER!, t.people.MANAGER!);
    expect(await grants(t.people.MANAGER!.id)).toBe(1);
    expect((await patch(t.people.ADMIN!, t.slug, t.membershipOf(t.people.MANAGER!), { status: 'SUSPENDED' })).status).toBe(200);
    expect(await connectionState(box.connectionId)).toMatchObject({ status: 'NEEDS_REAUTH', credentials: 0 });
    // Their access to the owner's business mailbox stays (it grants nothing while suspended) and the mailbox keeps running.
    expect(await grants(t.people.MANAGER!.id)).toBe(1);
    expect((await connectionState(shared)).status).toBe('ACTIVE');
    // Reactivation restores the shared access without a re-grant; removal then cascades it, audited first.
    expect((await patch(t.people.ADMIN!, t.slug, t.membershipOf(t.people.MANAGER!), { status: 'ACTIVE' })).status).toBe(200);
    expect(await grants(t.people.MANAGER!.id)).toBe(1);
    expect((await remove(t.people.ADMIN!, t.slug, t.membershipOf(t.people.MANAGER!))).status).toBe(200);
    expect(await grants(t.people.MANAGER!.id)).toBe(0);
    expect((await admin.query("SELECT actor_user_id, metadata FROM audit_events WHERE action = 'communications.member.revoked' AND target_id = $1", [shared])).rows)
      .toEqual([{ actor_user_id: t.people.ADMIN!.id, metadata: { userId: t.people.MANAGER!.id, access: 'READ', cause: 'member_removed' } }]);
    expect((await admin.query("SELECT metadata->>'cause' AS cause FROM audit_events WHERE action = 'communications.connection.holder_departed' AND target_id = $1", [box.connectionId])).rows)
      .toEqual([{ cause: 'member_suspended' }]);

    const box2 = await personalMailbox(t, t.people.MANAGER2!);
    expect((await patch(t.people.ADMIN!, t.slug, t.membershipOf(t.people.MANAGER2!), { role: 'MEMBER' })).status).toBe(200);
    expect(await connectionState(box2.connectionId)).toMatchObject({ status: 'NEEDS_REAUTH', credentials: 0 });
    // A BUSINESS mailbox held by an ADMIN demoted to MANAGER (loses manage_connections) stops too.
    const t2 = await team();
    const biz = await businessMailbox(t2, t2.people.ADMIN!, t2.people.MEMBER!);
    expect((await patch(t2.people.OWNER!, t2.slug, t2.membershipOf(t2.people.ADMIN!), { role: 'MANAGER' })).status).toBe(200);
    expect((await connectionState(biz)).status).toBe('NEEDS_REAUTH');
    expect((await admin.query("SELECT metadata->>'cause' AS cause FROM audit_events WHERE action = 'communications.connection.holder_departed' AND target_id = $1", [biz])).rows)
      .toEqual([{ cause: 'member_demoted' }]);
    // OWNER → ADMIN keeps authority: no cutoff.
    await makeOwner(t, 'ADMIN');
    const ownerBox = await personalMailbox(t, t.people.OWNER!);
    expect((await stepDown(t.people.OWNER!, t.slug)).status).toBe(200);
    expect(await connectionState(ownerBox.connectionId)).toMatchObject({ status: 'ACTIVE', credentials: 1 });
  });

  it('removal racing a worker’s failSyncJob(reauth_required) and an in-flight refresh store: both orders end stopped, no credential survives', async () => {
    const t = await team();
    const box = await personalMailbox(t, t.people.MANAGER!);
    // Worker 1 is inside failSyncJob: it holds the job row (job → connection lock order).
    const worker = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await worker.connect();
    await worker.query('BEGIN');
    await worker.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', '', true)", [t.businessId]);
    await worker.query("UPDATE mail_sync_jobs SET status = 'FAILED', lease_id = NULL, lease_expires_at = NULL, finished_at = now(), last_error_code = 'reauth_required' WHERE id = $1", [box.jobId]);
    // Worker 2 is storing refreshed tokens: it holds the credential row (credential → connection order).
    const refresher = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await refresher.connect();
    await refresher.query('BEGIN');
    await refresher.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', '', true)", [t.businessId]);
    await refresher.query("UPDATE mail_connection_credentials SET refresh_token_enc = $3, credential_version = gen_random_uuid(), updated_at = now() WHERE connection_id = $1 AND credential_version = $2",
      [box.connectionId, box.version, ENC('refreshed')]);
    // The removal locks the connection and stops it: the status trigger's credential delete waits for
    // the refresh store. When that commits, the delete takes its row (the refreshed tokens go too) and
    // the removal moves on to the jobs, where it waits for worker 1.
    const pending = remove(t.people.ADMIN!, t.slug, t.membershipOf(t.people.MANAGER!));
    await waitUntilBlocked(admin, await backendPid(refresher));
    expect(await settle(refresher, 'COMMIT')).toBe('ok');
    await waitUntilBlocked(admin, await backendPid(worker));
    // Worker 1 now wants the connection (markReauthRequired), which the removal holds: a deadlock cycle.
    // PostgreSQL aborts one side; if it is the removal, the route retries the whole unit of work (40P01).
    const workerDone = await worker.query("UPDATE mail_connections SET status = 'NEEDS_REAUTH', last_error_code = 'reauth_required', updated_at = now() WHERE id = $1 AND status = 'ACTIVE'", [box.connectionId])
      .then(() => worker.query('COMMIT')).then(() => 'committed', async (e: Error) => { await worker.query('ROLLBACK').catch(() => {}); return e.message; });
    expect(['committed', expect.stringMatching(/deadlock/)]).toContainEqual(workerDone);
    const removed = await pending;
    await worker.end();
    expect(removed.status).toBe(200);
    expect((await admin.query('SELECT 1 FROM memberships WHERE id = $1', [t.membershipOf(t.people.MANAGER!)])).rowCount).toBe(0);
    const state = await connectionState(box.connectionId);
    expect(state.status).toBe('NEEDS_REAUTH');
    expect(state.credentials).toBe(0);
    // A refresh fenced on the old version stores nothing now.
    const late = await tenantTx(t.businessId, t.people.ADMIN!.id);
    const stored = await late.query('UPDATE mail_connection_credentials SET updated_at = now() WHERE connection_id = $1 AND credential_version = $2', [box.connectionId, box.version]);
    expect(stored.rowCount).toBe(0);
    await late.query('ROLLBACK');
    await late.end();
  });
});

// ---------------------------------------------------------------------------------------------
describe('the invitation link token stays out of the database and audit', () => {
  it('stores only the SHA-256 of a resent token', async () => {
    const t = await team();
    const email = `hash-${randomUUID()}@example.com`;
    const first = await invite(t.people.OWNER!, t.slug, email, 'MEMBER');
    const id = (await first.res.json()).invitation.id;
    await admin.query("UPDATE invitations SET created_at = now() - interval '2 minutes' WHERE id = $1", [id]);
    expect((await resend(t.people.OWNER!, t.slug, id)).status).toBe(201);
    const token = tokenFromOutbox(email)!;
    const rows = (await admin.query('SELECT token_hash FROM invitations WHERE business_id = $1 AND email = $2 AND revoked_at IS NULL', [t.businessId, email])).rows;
    expect(rows).toEqual([{ token_hash: createHash('sha256').update(token).digest('hex') }]);
  });
});
