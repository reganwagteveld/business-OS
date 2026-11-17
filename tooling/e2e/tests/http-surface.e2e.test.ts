/** The server as a client sees it: admission, authentication responses, cookies, CORS and headers. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUser, PASSWORD } from '../src/actors';
import { admin, closeAdmin, connectAdmin, grantBusinessCreation, markEmailVerified, admitForSignup } from '../src/db';
import { Client } from '../src/http';

beforeAll(connectAdmin);
afterAll(closeAdmin);

describe('server surface', () => {
  it('reports healthy without leaking configuration', async () => {
    const res = await new Client().get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/postgres(ql)?:\/\/|bos_(app|owner|auth|jobs)|AUTH_SECRET|DATABASE_URL/);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('answers a preflight from an unlisted origin without granting it access', async () => {
    const res = await new Client().request('OPTIONS', '/api/v1/me', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('sets a session cookie that scripts cannot read, and rejects the same user on a wrong password identically to an unknown user', async () => {
    const email = `surface-${randomUUID().slice(0, 8)}@example.com`;
    await admitForSignup(email);
    const c = new Client();
    expect((await c.post('/api/v1/auth/sign-up/email', { email, password: PASSWORD, name: 'S' })).status).toBeLessThan(300);
    await markEmailVerified(email);
    const ok = await new Client().request('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD } });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.getSetCookie().find((x) => /session_token=/.test(x))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=(Lax|Strict)/i);

    const wrong = await new Client().post('/api/v1/auth/sign-in/email', { email, password: 'not the password at all' });
    const unknown = await new Client().post('/api/v1/auth/sign-in/email', { email: `nobody-${randomUUID()}@example.com`, password: 'not the password at all' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });
});

describe('invite-only beta admission', () => {
  it('stores nothing for an address that was never invited (the response is a synthetic success, by design)', async () => {
    const email = `uninvited-${randomUUID().slice(0, 8)}@example.com`;
    const res = await new Client().post('/api/v1/auth/sign-up/email', { email, password: PASSWORD, name: 'Nobody' });
    // docs/private-beta-lockdown.md: the status is deliberately not a registration signal (anti-enumeration).
    expect(res.status).toBeLessThan(500);
    expect((await admin.query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount).toBe(0);
    expect((await admin.query('SELECT 1 FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.email = $1', [email]).catch(() => ({ rowCount: 0 }))).rowCount).toBe(0);
    const signIn = await new Client().post('/api/v1/auth/sign-in/email', { email, password: PASSWORD });
    expect(signIn.status).toBe(401);
  });

  it('lets an admitted user in but refuses business creation without the explicit grant', async () => {
    const email = `nogrant-${randomUUID().slice(0, 8)}@example.com`;
    await admitForSignup(email);
    const c = new Client();
    await c.post('/api/v1/auth/sign-up/email', { email, password: PASSWORD, name: 'No grant' });
    await markEmailVerified(email);
    expect((await c.post('/api/v1/auth/sign-in/email', { email, password: PASSWORD })).status).toBe(200);
    const slug = `ng-${randomUUID().slice(0, 8)}`;
    const body = { name: 'No Grant Co', slug, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' };
    const denied = await c.post('/api/v1/businesses', body);
    expect(denied.status).toBe(403);
    expect((await admin.query('SELECT 1 FROM businesses WHERE slug = $1', [slug])).rowCount).toBe(0);
    await grantBusinessCreation(email);
    expect((await c.post('/api/v1/businesses', body)).status).toBe(201);
  });

  it('a verified user without a business sees none, and /me reports the account', async () => {
    const u = await newUser('lonely');
    const me = await u.get('/api/v1/me');
    expect(me.status).toBe(200);
    expect(JSON.stringify(me.body)).toContain(u.email);
  });
});
