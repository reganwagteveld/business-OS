import 'server-only';
import { getEnv } from '@/core/config/env';
import { getAuth } from './auth-adapter';
import { authHeaders, verifySignedToken } from './session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type AuthRequestMode =
  | { kind: 'safe' }
  | { kind: 'cookie' }
  | { kind: 'bearer' }
  | { kind: 'reject'; status: 401 | 403; error: string };

/**
 * CSRF policy for requests to /api/v1/auth (ADR 0001 addendum, D9b).
 *
 * - Safe methods change nothing and pass.
 * - Bearer requests (desktop app): authentication comes only from the signed token in the
 *   Authorization header, which a third-party site cannot obtain or make a browser attach. Cookies are
 *   stripped before Better Auth sees the request (see authHeaders), so an ambient session can never
 *   be used. An invalid token is rejected outright. A browser-supplied Origin, if any, must be one of
 *   our own client origins.
 * - Every other state-changing request is treated as cookie-authenticated (including sign-in and
 *   sign-up, which create the cookie) and must carry an Origin header exactly equal to the browser
 *   app's origin. A missing Origin is rejected: browsers always send it on POST, so only non-browser
 *   clients omit it, and they must use a bearer token instead.
 */
export function classifyAuthRequest(request: Request): AuthRequestMode {
  if (SAFE_METHODS.has(request.method)) return { kind: 'safe' };
  const env = getEnv();
  const appOrigin = new URL(env.APP_BASE_URL).origin;
  const origin = request.headers.get('origin');
  const authorization = request.headers.get('authorization');

  if (authorization !== null) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization);
    if (!match || !verifySignedToken(match[1]!)) return { kind: 'reject', status: 401, error: 'invalid_token' };
    if (origin !== null && origin !== appOrigin && !env.CORS_ALLOWED_ORIGINS.includes(origin)) {
      return { kind: 'reject', status: 403, error: 'forbidden_origin' };
    }
    return { kind: 'bearer' };
  }

  if (origin !== appOrigin) return { kind: 'reject', status: 403, error: 'forbidden_origin' };
  return { kind: 'cookie' };
}

/** Passes a request under /api/v1/auth to Better Auth, with desktop bearer tokens converted. */
export async function handleAuthRequest(request: Request): Promise<Response> {
  const mode = classifyAuthRequest(request);
  if (mode.kind === 'reject') {
    return Response.json({ error: mode.error }, { status: mode.status, headers: { 'Cache-Control': 'no-store' } });
  }
  const headers = await authHeaders(request);
  const forwarded = new Request(request.url, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
  });
  return getAuth().handler(forwarded);
}
