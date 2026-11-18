/**
 * Shared fixtures for the account-management suites (Settings A3-A): a signed-up, verified and admitted person
 * signed in through the real auth routes, a desktop bearer session, and a caller for the /api/v1/me routes.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { expect } from 'vitest';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as meRoute from '@/app/api/v1/me/route';
import * as passwordRoute from '@/app/api/v1/me/password/route';
import * as sessionsRoute from '@/app/api/v1/me/sessions/route';
import * as sessionRoute from '@/app/api/v1/me/sessions/[sessionId]/route';
import * as revokeOthersRoute from '@/app/api/v1/me/sessions/revoke-others/route';
import { devOutbox } from '@/core/email';
import { signSessionToken } from '@/modules/identity/server/session';
import { admitFixture, inviteForSignup } from './admission';

export const BASE = process.env.APP_BASE_URL!;
export const ORIGIN = new URL(BASE).origin;
export const PASSWORD = 'correct horse battery staple';
export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

// A fresh address per request (198.18.0.0/15, benchmarking range), so Better Auth's per-IP limits on sign-up and
// sign-in never carry over between suites or repeated local runs.
const newIp = () => `198.${18 + (randomBytes(1)[0]! & 1)}.${randomBytes(1)[0]!}.${randomBytes(1)[0]!}`;

export type Credential = { cookie?: string; bearer?: string };
type Opts = Credential & { body?: unknown; origin?: string | null };

function request(method: string, path: string, opts: Opts = {}) {
  const headers = new Headers({ 'x-forwarded-for': newIp() });
  if (opts.origin !== null) headers.set('origin', opts.origin ?? ORIGIN);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.bearer) headers.set('authorization', `Bearer ${opts.bearer}`);
  return new Request(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}

async function auth(method: 'GET' | 'POST', path: string, opts: Opts = {}) {
  const req = request(method, path, opts);
  return method === 'GET' ? authRoute.GET(req) : authRoute.POST(req);
}

/** Calls one of the account routes in-process, the way Next.js would (route params as a promise). */
export async function account(method: 'GET' | 'PATCH' | 'POST' | 'DELETE', path: string, opts: Opts = {}): Promise<Response> {
  const req = request(method, path, { origin: method === 'GET' ? null : undefined, ...opts });
  const sessionMatch = /^\/api\/v1\/me\/sessions\/([^/]+)$/.exec(path);
  if (path === '/api/v1/me') return method === 'GET' ? meRoute.GET(req) : meRoute.PATCH(req);
  if (path === '/api/v1/me/password') return passwordRoute.POST(req);
  if (path === '/api/v1/me/sessions') return sessionsRoute.GET(req);
  if (path === '/api/v1/me/sessions/revoke-others') return revokeOthersRoute.POST(req);
  if (sessionMatch) return sessionRoute.DELETE(req, { params: Promise.resolve({ sessionId: decodeURIComponent(sessionMatch[1]!) }) });
  throw new Error(`no route for ${path}`);
}

function sessionCookie(response: Response): string | null {
  const raw = response.headers.getSetCookie().find((c) => /session_token=/.test(c) && !/Max-Age=0/i.test(c));
  return raw ? raw.split(';')[0]! : null;
}

/** Asks for a real password-reset link through Better Auth (the emailed link's token stays in the dev outbox). */
export async function requestReset(email: string): Promise<void> {
  const res = await auth('POST', '/api/v1/auth/request-password-reset', { body: { email, redirectTo: '/reset-password' } });
  expect(res.status).toBe(200);
}

export async function signIn(email: string, password = PASSWORD): Promise<string | null> {
  return sessionCookie(await auth('POST', '/api/v1/auth/sign-in/email', { body: { email, password } }));
}

/** Signs up, verifies and (unless `admitted: false`) admits a person; returns their id, email and a browser cookie. */
export async function person(admin: pg.Client, opts: { admitted?: boolean; name?: string } = {}) {
  const email = `account-${randomUUID()}@example.com`;
  await inviteForSignup(admin, email);
  const res = await auth('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: opts.name ?? 'Test Person' } });
  expect(res.status).toBe(200);
  if (opts.admitted !== false) await admitFixture(admin, email);
  const mail = [...devOutbox].reverse().find((m) => m.to === email)!;
  const link = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!);
  const verified = await auth('GET', `${link.pathname}${link.search}`, { origin: null });
  expect(verified.status).toBeLessThan(400);
  const cookie = await signIn(email);
  expect(cookie).not.toBeNull();
  const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
  return { id: rows[0].id as string, email, cookie: cookie! };
}

/**
 * A desktop session exactly as the PKCE exchange creates it (desktop.ts): a hashed row stamped with the desktop
 * user agent, presented as the HMAC-signed token in `Authorization: Bearer`.
 */
export async function desktopSession(admin: pg.Client, userId: string): Promise<{ id: string; bearer: string }> {
  const token = randomBytes(24).toString('base64url');
  const id = randomUUID();
  await admin.query(`INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent, ip_address, created_at, updated_at)
    VALUES ($1, $2, $3, now() + interval '30 days', 'Business OS desktop', '', now(), now())`, [id, userId, sha256(token)]);
  return { id, bearer: signSessionToken(token) };
}

/** The session id behind a browser cookie (test assertions only). */
export async function sessionIdOf(admin: pg.Client, cookie: string): Promise<string> {
  const raw = decodeURIComponent(cookie.split('=')[1]!).split('.')[0]!;
  const { rows } = await admin.query('SELECT id FROM sessions WHERE token_hash = $1', [sha256(raw)]);
  return rows[0].id as string;
}

export async function identityEvents(admin: pg.Client, userId: string) {
  const { rows } = await admin.query(
    `SELECT action, business_id, actor_user_id, target_type, target_id, metadata FROM audit_events
     WHERE actor_user_id = $1 AND action LIKE 'identity.%' ORDER BY created_at, id`, [userId]);
  return rows as { action: string; business_id: string | null; actor_user_id: string; target_type: string; target_id: string; metadata: Record<string, unknown> }[];
}

/** Whether a credential still authenticates (GET /me answers 200). */
export async function stillSignedIn(credential: Credential): Promise<boolean> {
  return (await account('GET', '/api/v1/me', credential)).status === 200;
}
