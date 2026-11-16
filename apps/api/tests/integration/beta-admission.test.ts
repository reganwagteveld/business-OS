/** Real PostgreSQL admission/RLS regressions. Requires the reviewed privileged SQL to be applied. */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAuth } from '@/modules/identity/server/auth-adapter';
import { signSessionToken } from '@/modules/identity/server/session';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businesses from '@/app/api/v1/businesses/route';
import * as accept from '@/app/api/v1/invitations/accept/route';
import * as tenant from '@/app/api/v1/b/[slug]/route';
import { inviteForSignup, admitFixture } from './support/admission';

const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
const authRole = new pg.Client({ connectionString: process.env.AUTH_DATABASE_URL });
const BASE = process.env.APP_BASE_URL!;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
beforeAll(async () => { await Promise.all([admin.connect(), app.connect(), authRole.connect()]); });
afterAll(async () => { await Promise.all([admin.end(), app.end(), authRole.end()]); });

// Deliberately provision a pre-existing session without going through admission, to test stale
// sessions and database backstops independently of the login hook.
async function identity(verified = true) {
  const id = randomUUID(), email = `${id}@example.com`, token = randomUUID();
  await admin.query('INSERT INTO users (id, email, email_verified, name, updated_at) VALUES ($1, $2, $3, $4, now())', [id, email, verified, 'Beta fixture']);
  await admin.query("INSERT INTO sessions (id, user_id, token_hash, expires_at, updated_at) VALUES ($1, $2, $3, now() + interval '1 hour', now())", [randomUUID(), id, hash(token)]);
  return { id, email, token };
}
function req(path: string, token: string, body?: unknown) {
  return new Request(`${BASE}/api/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${signSessionToken(token)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const details = () => ({ name: 'Beta business', slug: `beta-${randomUUID().slice(0, 8)}`, countryCode: 'US', timeZone: 'UTC', locale: 'en-US', currency: 'USD' });

describe('private beta database and HTTP enforcement', () => {
  it('uninvited direct email signup writes no identity', async () => {
    const email = `${randomUUID()}@example.com`;
    const response = await authRoute.POST(new Request(`${BASE}/api/v1/auth/sign-up/email`, {
      method: 'POST', headers: { origin: new URL(BASE).origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email, name: 'Stranger', password: 'correct horse battery staple' }),
    }));
    expect(response.headers.getSetCookie().some((v) => v.includes('session_token='))).toBe(false);
    expect((await admin.query('SELECT id FROM users WHERE email = $1', [email])).rows).toEqual([]);
  });

  it.each(['google', 'github'])('rejects %s provider first-login at the production auth instance', async (providerId) => {
    const email = `${randomUUID()}@example.com`;
    const ctx = await getAuth().$context;
    await expect(ctx.internalAdapter.createOAuthUser({ email, name: 'OAuth', emailVerified: true }, { providerId, accountId: randomUUID() })).rejects.toMatchObject({ status: 'FORBIDDEN' });
    expect((await admin.query('SELECT id FROM users WHERE email = $1', [email])).rows).toEqual([]);
  });

  it('blocks an old uninvited session through HTTP and direct database business creation', async () => {
    const user = await identity();
    expect((await businesses.POST(req('businesses', user.token, details()))).status).toBe(403);
    expect((await businesses.GET(req('businesses', user.token))).status).toBe(403);
    await expect(app.query("SELECT * FROM app_private.create_business($1, 'X', $2, 'US', 'UTC', 'en-US', 'USD')", [user.token, details().slug])).rejects.toMatchObject({ code: '42501' });
  });

  it('retains admitted accounts and keeps tenant isolation intact', async () => {
    const owner = await identity();
    await admitFixture(admin, owner.email);
    const other = await identity();
    await admitFixture(admin, other.email);
    const input = details();
    expect((await businesses.POST(req('businesses', owner.token, input))).status).toBe(201);
    expect((await tenant.GET(req(`b/${input.slug}`, other.token), { params: Promise.resolve({ slug: input.slug }) })).status).toBe(404);
    expect((await app.query('SELECT slug FROM app_private.my_memberships($1)', [other.token])).rows).toEqual([]);
    expect((await app.query('SELECT id FROM businesses')).rows).toEqual([]); // RLS: no tenant context
    const signedIn = await (await getAuth().$context).internalAdapter.createSession(owner.id);
    expect(signedIn).toBeTruthy();
  });

  it('requires verified email + correct token, then admits exactly once atomically', async () => {
    const user = await identity(false);
    const invite = await inviteForSignup(admin, user.email);
    const redeem = () => accept.POST(req('invitations/accept', user.token, { token: invite.token }));
    expect((await redeem()).status).toBe(403);
    await admin.query('UPDATE users SET email_verified = true WHERE id = $1', [user.id]);
    const wrong = await identity();
    expect((await accept.POST(req('invitations/accept', wrong.token, { token: invite.token }))).status).toBe(400);
    expect((await businesses.POST(req('businesses', user.token, details()))).status).toBe(403);
    const results = await Promise.all([redeem(), redeem()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await app.query('SELECT app_private.beta_session_admitted($1) AS allowed', [user.token])).rows[0].allowed).toBe(true);
    expect((await businesses.GET(req('businesses', user.token))).status).toBe(200);
    expect((await admin.query('SELECT source FROM app_private.beta_admissions WHERE user_id = $1', [user.id])).rows).toEqual([{ source: 'invitation' }]);
    expect((await app.query('SELECT slug FROM app_private.my_memberships($1)', [user.token])).rows).toEqual([{ slug: invite.slug }]);
  });

  it.each(['expired', 'revoked', 'accepted', 'archived'])('rejects a %s invitation at registration and redemption', async (state) => {
    const user = await identity();
    const invite = await inviteForSignup(admin, user.email);
    if (state === 'archived') await admin.query('UPDATE businesses SET archived_at = now() WHERE id = $1', [invite.businessId]);
    else {
      const column = { expired: 'expires_at', revoked: 'revoked_at', accepted: 'accepted_at' }[state]!;
      await admin.query(`UPDATE invitations SET ${column} = now() - interval '1 day' WHERE id = $1`, [invite.invitationId]);
    }
    expect((await app.query('SELECT app_private.beta_can_register($1) AS allowed', [user.email])).rows[0].allowed).toBe(false);
    expect((await accept.POST(req('invitations/accept', user.token, { token: invite.token }))).status).toBe(400);
    expect((await app.query('SELECT app_private.beta_session_admitted($1) AS allowed', [user.token])).rows[0].allowed).toBe(false);
  });

  it('revokes existing sessions and refuses re-admission through another invitation', async () => {
    const user = await identity();
    await admitFixture(admin, user.email);
    const invite = await inviteForSignup(admin, user.email);
    await admin.query('UPDATE app_private.beta_admissions SET revoked_at = now() WHERE user_id = $1', [user.id]);
    expect((await businesses.GET(req('businesses', user.token))).status).toBe(403);
    expect((await accept.POST(req('invitations/accept', user.token, { token: invite.token }))).status).toBe(400);
    await expect((await getAuth().$context).internalAdapter.createSession(user.id)).rejects.toMatchObject({ status: 'FORBIDDEN' });
  });

  it('runtime roles cannot grant admission or inspect the ledger', async () => {
    const user = await identity();
    for (const client of [app, authRole]) {
      await expect(client.query('SELECT * FROM app_private.beta_admissions')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query("INSERT INTO app_private.beta_admissions (user_id, source) VALUES ($1, 'forged')", [user.id])).rejects.toMatchObject({ code: '42501' });
    }
  });
});
