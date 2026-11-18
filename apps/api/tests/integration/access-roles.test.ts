import { inviteForSignup, admitFixture } from './support/admission';
/**
 * Administration A2-C: GET /api/v1/b/{slug}/access/roles (docs/administration-a2.md §7). Runs the real route handler
 * against PostgreSQL with migrations and prisma/privileged applied as in production. The description is the same for
 * every business and every member; access to it still goes through the normal tenant checks.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessRolesResponse } from '@business-os/contracts';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as rolesRoute from '@/app/api/v1/b/[slug]/access/roles/route';
import * as memberRoute from '@/app/api/v1/b/[slug]/members/[membershipId]/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import { devOutbox } from '@/core/email';
import { describeAccessModel, permissionsFor } from '@/modules/access';

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
  await inviteForSignup(admin, email);
  await authRoute.POST(request('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: prefix } }));
  await admitFixture(admin, email);
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

const get = (by: User | null, slug: string, opts: { origin?: string | null } = {}) =>
  rolesRoute.GET(request('GET', `/api/v1/b/${slug}/access/roles`, { cookie: by?.cookie, origin: opts.origin }), ctx({ slug }));

describe('roles and access read API (A2-C)', () => {
  it('every role reads the same description, which matches the contract and the enforced grants', async () => {
    const t = await team();
    const bodies: unknown[] = [];
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER']) {
      const res = await get(t.people[role]!, t.slug);
      expect(res.status, role).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      bodies.push(AccessRolesResponse.parse(await res.json()));
    }
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    const parsed = bodies[0] as AccessRolesResponse;
    expect(parsed).toEqual(describeAccessModel());
    expect(parsed.model).toEqual({ customRoles: false, editable: false });
    for (const r of parsed.roles) expect(r.permissions).toEqual(permissionsFor(r.role));
  });

  it('answers 401 without a session, 404 to a non-member and for an unknown slug, never leaking the business', async () => {
    const t = await team();
    expect((await get(null, t.slug)).status).toBe(401);
    const stranger = await newUser('stranger');
    const foreign = await get(stranger, t.slug);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'not_found' });
    expect((await get(t.people.OWNER!, `nope-${randomUUID().slice(0, 8)}`)).status).toBe(404);
  });

  it('a suspended member loses access at the next request', async () => {
    const t = await team();
    expect((await get(t.people.MEMBER!, t.slug)).status).toBe(200);
    const { rows } = await admin.query('SELECT m.id FROM memberships m JOIN businesses b ON b.id = m.business_id WHERE b.slug = $1 AND m.user_id = $2', [t.slug, t.people.MEMBER!.id]);
    const membershipId = rows[0].id as string;
    const res = await memberRoute.PATCH(
      request('PATCH', `/api/v1/b/${t.slug}/members/${membershipId}`, { cookie: t.people.OWNER!.cookie, body: { status: 'SUSPENDED' } }),
      ctx({ slug: t.slug, membershipId }),
    );
    expect(res.status).toBe(200);
    expect((await get(t.people.MEMBER!, t.slug)).status).toBe(404);
  });

  it('is read-only: the route exports GET and OPTIONS only', () => {
    expect(Object.keys(rolesRoute).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(['GET', 'OPTIONS']);
  });

  it('gives a page on another origin no CORS grant, so a browser cannot read the answer', async () => {
    const t = await team();
    const res = await get(t.people.OWNER!, t.slug, { origin: 'https://evil.example' });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const allowed = await get(t.people.OWNER!, t.slug, { origin: 'http://localhost:5173' });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});
