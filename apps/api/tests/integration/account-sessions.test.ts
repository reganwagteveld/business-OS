/**
 * Account management component 3: signed-in devices (Settings A3-A, settings-a3 §15.3, §15.4, §17 "Sessions").
 * List with opaque ids only; end one other session; end every other session with the password (step-up).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountSessionsResponse } from '@business-os/contracts';
import { ACCOUNT_RATE_LIMITS } from '@/modules/identity/server/account-support';
import { account, desktopSession, identityEvents, PASSWORD, person, sessionIdOf, sha256, signIn, stillSignedIn } from './support/account';

const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
beforeAll(() => admin.connect());
afterAll(() => admin.end());

const list = async (credential: { cookie?: string; bearer?: string }) => {
  const res = await account('GET', '/api/v1/me/sessions', credential);
  expect(res.status).toBe(200);
  return AccountSessionsResponse.parse(await res.json());
};

describe('GET /api/v1/me/sessions', () => {
  it('lists only my live sessions, current first, with opaque ids and no token, hash, IP or user agent', async () => {
    const me = await person(admin);
    const second = (await signIn(me.email))!;
    const desktop = await desktopSession(admin, me.id);
    const other = await person(admin);
    await admin.query("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, updated_at) VALUES ($1, $2, $3, now() - interval '1 minute', now(), now())", [randomUUID(), me.id, sha256(randomUUID())]);

    const res = await account('GET', '/api/v1/me/sessions', { cookie: me.cookie });
    const raw = await res.text();
    const { sessions, truncated } = AccountSessionsResponse.parse(JSON.parse(raw));
    expect(truncated).toBe(false);
    expect(sessions).toHaveLength(3);
    expect(sessions[0]).toMatchObject({ id: await sessionIdOf(admin, me.cookie), current: true, client: 'browser' });
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.find((s) => s.id === desktop.id)?.client).toBe('desktop');
    expect(sessions.map((s) => s.id)).toContain(await sessionIdOf(admin, second));
    expect(sessions.map((s) => s.id)).not.toContain(await sessionIdOf(admin, other.cookie));

    const { rows } = await admin.query('SELECT token_hash, ip_address, user_agent FROM sessions WHERE user_id = $1', [me.id]);
    for (const row of rows) {
      expect(raw).not.toContain(row.token_hash);
      if (row.ip_address) expect(raw).not.toContain(row.ip_address);
      if (row.user_agent) expect(raw).not.toContain(row.user_agent);
    }
    expect(raw).not.toContain(decodeURIComponent(me.cookie.split('=')[1]!).split('.')[0]!);
    // The desktop sees itself as current.
    expect((await list({ bearer: desktop.bearer })).sessions[0]).toMatchObject({ id: desktop.id, current: true, client: 'desktop' });
  });

  it('caps the list at 50 and always includes the current session', async () => {
    const me = await person(admin);
    await admin.query(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, updated_at)
      SELECT gen_random_uuid(), $1, md5(random()::text) || md5(random()::text), now() + interval '1 day', now(), now() + interval '1 hour'
      FROM generate_series(1, 55)`, [me.id]);
    const { sessions, truncated } = await list({ cookie: me.cookie });
    expect(truncated).toBe(true);
    expect(sessions).toHaveLength(50);
    expect(sessions[0]!.current).toBe(true);
  });

  it('needs a signed-in, admitted session', async () => {
    expect((await account('GET', '/api/v1/me/sessions')).status).toBe(401);
    const outsider = await person(admin, { admitted: false });
    expect((await account('GET', '/api/v1/me/sessions', { cookie: outsider.cookie })).status).toBe(403);
  });
});

describe('DELETE /api/v1/me/sessions/:sessionId', () => {
  it('ends one other session (browser or desktop) on its next request, and audits the opaque id', async () => {
    const me = await person(admin);
    const second = (await signIn(me.email))!;
    const desktop = await desktopSession(admin, me.id);
    const secondId = await sessionIdOf(admin, second);

    expect((await account('DELETE', `/api/v1/me/sessions/${secondId}`, { cookie: me.cookie })).status).toBe(200);
    expect(await stillSignedIn({ cookie: second })).toBe(false);
    expect(await stillSignedIn({ bearer: desktop.bearer })).toBe(true);
    expect((await account('DELETE', `/api/v1/me/sessions/${desktop.id}`, { cookie: me.cookie })).status).toBe(200);
    expect(await stillSignedIn({ bearer: desktop.bearer })).toBe(false);
    expect(await stillSignedIn({ cookie: me.cookie })).toBe(true);

    const events = await identityEvents(admin, me.id);
    expect(events.map((e) => [e.action, e.target_type, e.target_id])).toEqual([
      ['identity.session.revoked', 'session', secondId], ['identity.session.revoked', 'session', desktop.id],
    ]);
  });

  it('refuses to end the current session (use sign out instead)', async () => {
    const me = await person(admin);
    const res = await account('DELETE', `/api/v1/me/sessions/${await sessionIdOf(admin, me.cookie)}`, { cookie: me.cookie });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'use_sign_out' });
    expect(await stillSignedIn({ cookie: me.cookie })).toBe(true);
  });

  it('answers 404 alike for another person’s session, an unknown id, an ended one and a malformed id', async () => {
    const me = await person(admin);
    const victim = await person(admin);
    const victimSession = await sessionIdOf(admin, victim.cookie);
    for (const id of [victimSession, randomUUID(), 'not-a-uuid', '..%2F..%2Fsessions']) {
      const res = await account('DELETE', `/api/v1/me/sessions/${id}`, { cookie: me.cookie });
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    expect(await stillSignedIn({ cookie: victim.cookie })).toBe(true);
    expect(await identityEvents(admin, me.id)).toEqual([]);
  });

  it('needs the app Origin for cookies (CSRF) and admission', async () => {
    const me = await person(admin);
    const second = (await signIn(me.email))!;
    const id = await sessionIdOf(admin, second);
    expect((await account('DELETE', `/api/v1/me/sessions/${id}`, { cookie: me.cookie, origin: 'https://evil.example' })).status).toBe(403);
    expect((await account('DELETE', `/api/v1/me/sessions/${id}`, { cookie: me.cookie, origin: null })).status).toBe(403);
    expect(await stillSignedIn({ cookie: second })).toBe(true);
  });
});

describe('POST /api/v1/me/sessions/revoke-others', () => {
  it('needs the password, then ends every other session in one go and keeps this one', async () => {
    const me = await person(admin);
    const second = (await signIn(me.email))!;
    const desktop = await desktopSession(admin, me.id);
    const bystander = await person(admin);

    const wrong = await account('POST', '/api/v1/me/sessions/revoke-others', { cookie: me.cookie, body: { password: 'not the password' } });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe('invalid_password');
    expect(await stillSignedIn({ cookie: second })).toBe(true);

    const res = await account('POST', '/api/v1/me/sessions/revoke-others', { cookie: me.cookie, body: { password: PASSWORD } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ended: 2 });
    expect(await stillSignedIn({ cookie: me.cookie })).toBe(true);
    expect(await stillSignedIn({ cookie: second })).toBe(false);
    expect(await stillSignedIn({ bearer: desktop.bearer })).toBe(false);
    expect(await stillSignedIn({ cookie: bystander.cookie })).toBe(true);
    expect((await list({ cookie: me.cookie })).sessions).toHaveLength(1);

    const events = await identityEvents(admin, me.id);
    expect(events.map((e) => e.action)).toEqual(['identity.sessions.revoke_others_failed', 'identity.sessions.revoked_others']);
    expect(events[1]!.metadata).toEqual({ ended: 2, actorSessionId: await sessionIdOf(admin, me.cookie) });
    expect(JSON.stringify(events)).not.toMatch(/not the password|correct horse/);
  });

  it('works from the desktop and ends the browser sessions', async () => {
    const me = await person(admin);
    const desktop = await desktopSession(admin, me.id);
    const res = await account('POST', '/api/v1/me/sessions/revoke-others', { bearer: desktop.bearer, origin: null, body: { password: PASSWORD } });
    expect(res.status).toBe(200);
    expect(await stillSignedIn({ cookie: me.cookie })).toBe(false);
    expect(await stillSignedIn({ bearer: desktop.bearer })).toBe(true);
  });

  it('two devices racing to sign each other out: exactly one wins and keeps its session', async () => {
    const me = await person(admin);
    const second = (await signIn(me.email))!;
    const [a, b] = await Promise.all([
      account('POST', '/api/v1/me/sessions/revoke-others', { cookie: me.cookie, body: { password: PASSWORD } }),
      account('POST', '/api/v1/me/sessions/revoke-others', { cookie: second, body: { password: PASSWORD } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect([await stillSignedIn({ cookie: me.cookie }), await stillSignedIn({ cookie: second })].filter(Boolean)).toHaveLength(1);
  });

  it('shares one per-account limit with single revocations, and refuses extra fields', async () => {
    const me = await person(admin);
    expect((await account('POST', '/api/v1/me/sessions/revoke-others', { cookie: me.cookie, body: { password: PASSWORD, keep: [randomUUID()] } })).status).toBe(400);
    const { max } = ACCOUNT_RATE_LIMITS.revoke;
    for (let i = 0; i < max; i++) {
      expect((await account('DELETE', `/api/v1/me/sessions/${randomUUID()}`, { cookie: me.cookie })).status).toBe(404);
    }
    expect((await account('POST', '/api/v1/me/sessions/revoke-others', { cookie: me.cookie, body: { password: PASSWORD } })).status).toBe(429);
  });
});
