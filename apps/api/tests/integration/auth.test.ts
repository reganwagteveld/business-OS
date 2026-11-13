/**
 * Phase 1b authentication (ADR 0001 and its conditions, data-model §5.1/§5.6, D9a/D9b).
 * Runs the real route handlers in-process against PostgreSQL with the identity migration applied.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as desktopAuthorize from '@/app/api/v1/auth/desktop/authorize/route';
import * as desktopToken from '@/app/api/v1/auth/desktop/token/route';
import { devOutbox } from '@/core/email';
import { getCurrentUser } from '@/modules/identity';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';

// Administrative (superuser) connection for assertions only: identity tables force RLS, so even
// their owner sees nothing without a policy.
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
const app = new pg.Client({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  await admin.connect();
  await app.connect();
});
afterAll(async () => {
  await admin.end();
  await app.end();
});

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
let ipCounter = 1;
const newIp = () => `203.0.113.${ipCounter++}`;

type Opts = { body?: unknown; cookie?: string; bearer?: string; origin?: string | null; ip?: string };
async function call(method: 'GET' | 'POST', path: string, opts: Opts = {}) {
  const headers = new Headers({ 'x-forwarded-for': opts.ip ?? '198.51.100.1' });
  if (opts.origin !== null) headers.set('origin', opts.origin ?? ORIGIN);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.bearer) headers.set('authorization', `Bearer ${opts.bearer}`);
  const request = new Request(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  if (path.startsWith('/api/v1/auth/desktop/token')) return desktopToken.POST(request);
  if (path.startsWith('/api/v1/auth/desktop/authorize')) return method === 'GET' ? desktopAuthorize.GET(request) : desktopAuthorize.POST(request);
  return method === 'GET' ? authRoute.GET(request) : authRoute.POST(request);
}

function sessionCookie(response: Response) {
  const raw = response.headers.getSetCookie().find((c) => /session_token=/.test(c) && !/Max-Age=0/i.test(c));
  return raw ? { header: raw, pair: raw.split(';')[0]! } : null;
}

const lastEmailTo = (email: string) => [...devOutbox].reverse().find((m) => m.to === email);
const linkIn = (text: string) => /(https?:\/\/\S+)/.exec(text)![1]!;

async function signUpAndVerify(email = `user-${randomUUID()}@example.com`) {
  const res = await call('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: 'Test User' }, ip: newIp() });
  expect(res.status).toBe(200);
  const link = new URL(linkIn(lastEmailTo(email)!.text));
  const verified = await call('GET', `${link.pathname}${link.search}`, { origin: null });
  expect(verified.status).toBeLessThan(400);
  return email;
}

async function signIn(email: string, ip = newIp()) {
  const res = await call('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD }, ip });
  return { res, cookie: sessionCookie(res) };
}

describe('sign-up, verification and enumeration safety', () => {
  it('answers identically for a new and an existing email, and only emails the address owner', async () => {
    const email = `Owner-${randomUUID()}@Example.com`;
    const first = await call('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: 'A' }, ip: newIp() });
    const second = await call('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: 'B' }, ip: newIp() });
    expect(first.status).toBe(200);
    expect(second.status).toBe(first.status);
    const [a, b] = [await first.json(), await second.json()];
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    expect(a.token).toBeNull();
    expect(b.token).toBeNull();
    expect(sessionCookie(first)).toBeNull();
    expect(sessionCookie(second)).toBeNull();
    const mails = devOutbox.filter((m) => m.to === email.toLowerCase());
    expect(mails.map((m) => m.subject)).toEqual(['Verify your email for Business OS', 'Someone tried to create a Business OS account with your email']);
    const { rows } = await admin.query('SELECT email, email_verified FROM users WHERE email = $1', [email.toLowerCase()]);
    expect(rows).toEqual([{ email: email.toLowerCase(), email_verified: false }]);
  });

  it('refuses sign-in until the email is verified, then allows it', async () => {
    const email = `unverified-${randomUUID()}@example.com`;
    await call('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: 'U' }, ip: newIp() });
    const before = await signIn(email);
    expect(before.res.status).toBe(403);
    expect(before.cookie).toBeNull();
    const link = new URL(linkIn(lastEmailTo(email)!.text));
    await call('GET', `${link.pathname}${link.search}`, { origin: null });
    const after = await signIn(email);
    expect(after.res.status).toBe(200);
    expect(after.cookie).not.toBeNull();
  });

  it('rejects weak passwords', async () => {
    const res = await call('POST', '/api/v1/auth/sign-up/email', { body: { email: `weak-${randomUUID()}@example.com`, password: 'short', name: 'W' }, ip: newIp() });
    expect(res.status).toBe(400);
  });
});

describe('browser sessions (HTTP-only cookie, D9b)', () => {
  it('sets an HttpOnly SameSite=Lax cookie and stores only a hash of the token', async () => {
    const email = await signUpAndVerify();
    const { res, cookie } = await signIn(email);
    expect(res.status).toBe(200);
    expect(cookie!.header).toMatch(/HttpOnly/i);
    expect(cookie!.header).toMatch(/SameSite=Lax/i);
    expect(res.headers.get('set-auth-token')).toBeNull(); // the token is never exposed to JavaScript
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/token_hash/);

    const raw = decodeURIComponent(cookie!.pair.split('=')[1]!).split('.')[0]!;
    const { rows } = await admin.query("SELECT s.token_hash, row_to_json(s)::text AS everything FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1", [email]);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(sha256(raw));
    expect(rows[0].everything).not.toContain(raw);
  });

  it('resolves the current user from the cookie, and stops after sign-out', async () => {
    const email = await signUpAndVerify();
    const { cookie } = await signIn(email);
    const req = () => new Request(`${BASE}/api/v1/me`, { headers: { cookie: cookie!.pair } });
    expect((await getCurrentUser(req()))?.email).toBe(email);
    const out = await call('POST', '/api/v1/auth/sign-out', { cookie: cookie!.pair, body: {} });
    expect(out.status).toBe(200);
    expect(await getCurrentUser(req())).toBeNull();
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1', [email]);
    expect(rows[0].n).toBe(0);
  });

  it('rejects a forged or unsigned cookie', async () => {
    const email = await signUpAndVerify();
    const { cookie } = await signIn(email);
    const [name, value] = cookie!.pair.split('=') as [string, string];
    const raw = decodeURIComponent(value).split('.')[0]!;
    for (const forged of [raw, `${raw}.AAAA`, `h:${sha256(raw)}`]) {
      const req = new Request(`${BASE}/api/v1/me`, { headers: { cookie: `${name}=${encodeURIComponent(forged)}` } });
      expect(await getCurrentUser(req)).toBeNull();
    }
  });

  it('blocks a cross-site sign-in POST (CSRF origin check)', async () => {
    const email = await signUpAndVerify();
    const res = await call('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD }, origin: 'https://evil.example', ip: newIp() });
    expect(res.status).toBe(403);
    expect(sessionCookie(res)).toBeNull();
  });
});

describe('password reset', () => {
  it('answers identically whether or not the account exists, and emails only real accounts', async () => {
    const email = await signUpAndVerify();
    const ghost = `nobody-${randomUUID()}@example.com`;
    const a = await call('POST', '/api/v1/auth/request-password-reset', { body: { email, redirectTo: '/reset' }, ip: newIp() });
    const b = await call('POST', '/api/v1/auth/request-password-reset', { body: { email: ghost, redirectTo: '/reset' }, ip: newIp() });
    expect(a.status).toBe(200);
    expect(b.status).toBe(a.status);
    expect(await b.json()).toEqual(await a.json());
    expect(lastEmailTo(ghost)).toBeUndefined();
    expect(lastEmailTo(email)?.subject).toBe('Reset your Business OS password');
  });

  it('stores the reset token hashed, resets the password once, and revokes existing sessions', async () => {
    const email = await signUpAndVerify();
    const { cookie } = await signIn(email);
    await call('POST', '/api/v1/auth/request-password-reset', { body: { email, redirectTo: '/reset' }, ip: newIp() });
    const token = new URL(linkIn(lastEmailTo(email)!.text)).pathname.split('/').pop()!;
    const { rows } = await admin.query("SELECT identifier FROM verifications WHERE identifier LIKE 'reset-password:%'");
    expect(rows.map((r) => r.identifier)).toContain(`reset-password:${sha256(token)}`);
    expect(rows.map((r) => r.identifier)).not.toContain(`reset-password:${token}`);

    const newPassword = 'a much better passphrase 2026';
    const reset = await call('POST', '/api/v1/auth/reset-password', { body: { token, newPassword }, ip: newIp() });
    expect(reset.status).toBe(200);
    const replay = await call('POST', '/api/v1/auth/reset-password', { body: { token, newPassword: 'another passphrase 2026' }, ip: newIp() });
    expect(replay.status).toBe(400);
    expect(await getCurrentUser(new Request(`${BASE}/x`, { headers: { cookie: cookie!.pair } }))).toBeNull();
    const old = await call('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD }, ip: newIp() });
    expect(old.status).toBe(401);
    const fresh = await call('POST', '/api/v1/auth/sign-in/email', { body: { email, password: newPassword }, ip: newIp() });
    expect(fresh.status).toBe(200);
  });
});

describe('rate limiting (shared PostgreSQL counters)', () => {
  it('limits repeated sign-in attempts from one address and keeps the counter in the database', async () => {
    const ip = newIp();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await call('POST', '/api/v1/auth/sign-in/email', { body: { email: `nobody-${i}@example.com`, password: 'wrong password 123' }, ip });
      statuses.push(res.status);
    }
    expect(statuses[0]).toBe(401);
    expect(statuses).toContain(429);
    expect(statuses[statuses.length - 1]).toBe(429);
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM rate_limits WHERE key LIKE $1', [`%${ip}%`]);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const email = await signUpAndVerify();
    const wrong = await call('POST', '/api/v1/auth/sign-in/email', { body: { email, password: 'not the password 123' }, ip: newIp() });
    const unknown = await call('POST', '/api/v1/auth/sign-in/email', { body: { email: `ghost-${randomUUID()}@example.com`, password: 'not the password 123' }, ip: newIp() });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
  });
});

describe('desktop sign-in (system browser + PKCE, bearer session, D9a)', () => {
  const redirect = 'http://127.0.0.1:53682/callback';
  function pkce() {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(16).toString('base64url') };
  }
  const query = (p: ReturnType<typeof pkce>) =>
    new URLSearchParams({ code_challenge: p.challenge, code_challenge_method: 'S256', redirect_uri: redirect, state: p.state }).toString();

  async function authorize(cookie: string, p: ReturnType<typeof pkce>, origin = ORIGIN) {
    const page = await call('GET', `/api/v1/auth/desktop/authorize?${query(p)}`, { cookie, origin: null });
    expect(page.status).toBe(200);
    const headers = new Headers({ cookie, 'content-type': 'application/x-www-form-urlencoded', origin });
    return desktopAuthorize.POST(new Request(`${BASE}/api/v1/auth/desktop/authorize`, { method: 'POST', headers, body: query(p) }));
  }

  it('sends a signed-out browser to sign in first', async () => {
    const res = await call('GET', `/api/v1/auth/desktop/authorize?${query(pkce())}`, { origin: null });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/\/sign-in\?next=/);
  });

  it('rejects non-loopback redirects and plain PKCE', async () => {
    const p = pkce();
    for (const q of [
      query(p).replace(encodeURIComponent(redirect), encodeURIComponent('https://evil.example/callback')),
      query(p).replace('S256', 'plain'),
    ]) {
      const res = await call('GET', `/api/v1/auth/desktop/authorize?${q}`, { origin: null });
      expect(res.status).toBe(400);
    }
  });

  it('issues a code only on a same-origin confirmation, exchanges it once, and the bearer session works and can be revoked', async () => {
    const email = await signUpAndVerify();
    const { cookie } = await signIn(email);
    const p = pkce();

    expect((await authorize(cookie!.pair, p, 'https://evil.example')).status).toBe(403);
    const confirmed = await authorize(cookie!.pair, p);
    expect(confirmed.status).toBe(303);
    const location = new URL(confirmed.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(redirect);
    expect(location.searchParams.get('state')).toBe(p.state);
    const code = location.searchParams.get('code')!;
    const { rows } = await admin.query("SELECT identifier FROM verifications WHERE identifier LIKE 'desktop-code:%'");
    expect(rows.map((r) => r.identifier)).toContain(`desktop-code:${sha256(code)}`);

    const exchanged = await call('POST', '/api/v1/auth/desktop/token', { body: { code, code_verifier: p.verifier, redirect_uri: redirect }, origin: null });
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get('cache-control')).toBe('no-store');
    const { token } = await exchanged.json();
    const replay = await call('POST', '/api/v1/auth/desktop/token', { body: { code, code_verifier: p.verifier, redirect_uri: redirect }, origin: null });
    expect(replay.status).toBe(400);

    const me = (bearer: string) => getCurrentUser(new Request(`${BASE}/x`, { headers: { authorization: `Bearer ${bearer}` } }));
    expect((await me(token))?.email).toBe(email);
    const raw = token.slice(0, token.lastIndexOf('.'));
    expect(await me(raw)).toBeNull();
    expect(await me(`${raw}.${Buffer.alloc(32).toString('base64')}`)).toBeNull();
    expect(await me(`h:${sha256(raw)}`)).toBeNull();
    // A bad bearer never falls back to an ambient cookie.
    const both = new Request(`${BASE}/x`, { headers: { authorization: 'Bearer nope', cookie: cookie!.pair } });
    expect(await getCurrentUser(both)).toBeNull();

    // The desktop session is separate from the browser session and revocable on its own.
    const out = await call('POST', '/api/v1/auth/sign-out', { bearer: token, body: {}, origin: null });
    expect(out.status).toBe(200);
    expect(await me(token)).toBeNull();
    expect((await getCurrentUser(new Request(`${BASE}/x`, { headers: { cookie: cookie!.pair } })))?.email).toBe(email);
  });

  it('rejects a wrong verifier and burns the code', async () => {
    const email = await signUpAndVerify();
    const { cookie } = await signIn(email);
    const p = pkce();
    const code = new URL((await authorize(cookie!.pair, p)).headers.get('location')!).searchParams.get('code')!;
    const wrong = await call('POST', '/api/v1/auth/desktop/token', { body: { code, code_verifier: pkce().verifier, redirect_uri: redirect }, origin: null });
    expect(wrong.status).toBe(400);
    const right = await call('POST', '/api/v1/auth/desktop/token', { body: { code, code_verifier: p.verifier, redirect_uri: redirect }, origin: null });
    expect(right.status).toBe(400);
  });
});

describe('database roles for identity data (data-model §5.1, §5.6)', () => {
  it('tenant code (bos_app) cannot read sessions, accounts, verifications or rate limits', async () => {
    for (const table of ['sessions', 'accounts', 'verifications', 'rate_limits']) {
      await expect(app.query(`SELECT * FROM ${table} LIMIT 1`)).rejects.toThrow(/permission denied/);
    }
  });

  it('tenant code sees only non-sensitive user columns, and only its own row', async () => {
    await expect(app.query('SELECT email FROM users LIMIT 1')).rejects.toThrow(/permission denied/);
    const none = await app.query('SELECT id, name, image_url FROM users');
    expect(none.rows).toEqual([]);
    const email = await signUpAndVerify();
    const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.user_id', $1, true)", [rows[0].id]);
      const own = await app.query('SELECT id FROM users');
      expect(own.rows).toEqual([{ id: rows[0].id }]);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('every identity table forces row-level security', async () => {
    const { rows } = await admin.query(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('users','sessions','accounts','verifications','rate_limits') ORDER BY relname",
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
  });
});
