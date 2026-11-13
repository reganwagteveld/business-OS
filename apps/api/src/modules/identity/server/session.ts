import 'server-only';
// One session model for both clients (ADR 0001 addendum): the browser app sends the HTTP-only
// session cookie; the desktop app sends the same signed session token as `Authorization: Bearer`.
// Both resolve to the same hashed, revocable row in `sessions`.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getEnv } from '@/core/config/env';
import { getAuth } from './auth-adapter';

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
}

/** `<token>.<base64 HMAC-SHA256(secret, token)>`: the same signature Better Auth puts on its cookie. */
export function signSessionToken(token: string): string {
  return `${token}.${createHmac('sha256', getEnv().AUTH_SECRET).update(token).digest('base64')}`;
}

/** Returns the raw token if the signature is valid, otherwise null. */
export function verifySignedToken(signed: string): string | null {
  const dot = signed.lastIndexOf('.');
  if (dot < 1) return null;
  const token = signed.slice(0, dot);
  const given = Buffer.from(signed.slice(dot + 1), 'base64');
  const expected = createHmac('sha256', getEnv().AUTH_SECRET).update(token).digest();
  return given.length === expected.length && timingSafeEqual(given, expected) ? token : null;
}

/**
 * Headers Better Auth should see for this request. A valid signed bearer token becomes the session
 * cookie; an invalid one is dropped (and any cookie with it), so a bad bearer never falls back to
 * an ambient cookie. Requests without a bearer are passed through unchanged.
 */
export async function authHeaders(request: Request): Promise<Headers> {
  const headers = new Headers(request.headers);
  const authorization = headers.get('authorization');
  if (!authorization) return headers;
  headers.delete('authorization');
  headers.delete('cookie');
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match || !verifySignedToken(match[1]!)) return headers;
  const cookieName = (await getAuth().$context).authCookies.sessionToken.name;
  headers.set('cookie', `${cookieName}=${encodeURIComponent(match[1]!)}`);
  return headers;
}

/**
 * The raw session token presented by this request (signed cookie or signed bearer), after checking
 * its signature, or null. Used only to call the pre-tenant database functions, which verify the
 * session themselves; never logged or returned.
 */
export async function getSessionToken(request: Request): Promise<string | null> {
  const authorization = request.headers.get('authorization');
  if (authorization) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization);
    return match ? verifySignedToken(match[1]!) : null;
  }
  const cookieName = (await getAuth().$context).authCookies.sessionToken.name;
  const cookie = request.headers.get('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === cookieName) {
      try {
        return verifySignedToken(decodeURIComponent(part.slice(eq + 1).trim()));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The signed-in user, from our users table, or null. Never trusts any user id sent by the client. */
export async function getCurrentUser(request: Request): Promise<CurrentUser | null> {
  const result = await getAuth().api.getSession({ headers: await authHeaders(request) });
  if (!result) return null;
  const { user } = result;
  return { id: user.id, email: user.email, name: user.name ?? null, emailVerified: user.emailVerified };
}

export class UnauthenticatedError extends Error {
  readonly status = 401;
  constructor() {
    super('Sign-in required');
    this.name = 'UnauthenticatedError';
  }
}

/** Throws UnauthenticatedError unless there is a signed-in user with a verified email. */
export async function requireUser(request: Request): Promise<CurrentUser> {
  const user = await getCurrentUser(request);
  if (!user || !user.emailVerified) throw new UnauthenticatedError();
  return user;
}
