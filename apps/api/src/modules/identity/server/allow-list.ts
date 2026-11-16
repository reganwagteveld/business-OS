import 'server-only';
import { AUTH_BASE_PATH } from './auth-adapter';

/**
 * Explicit (method, path) allow-list for the auth catch-all /api/v1/auth/[...all] (A3-0, settings-a3 §15.1,
 * owner decision D-A3-7). Better Auth registers many built-in account endpoints (update-user,
 * change-password, list-sessions, delete-user, ...) that Pixa has not adopted: they have no contract, no
 * Pixa audit event and no rate-limit rule of their own. Only the flows below reach Better Auth over HTTP.
 *
 * Matching is exact and deliberately stricter than Better Auth's router: the pathname of the request URL
 * (after WHATWG URL parsing, which is also what Better Auth sees) must equal an entry, with no trailing
 * slash, no percent-encoding, no repeated slashes and no change of case. The query string is ignored for
 * matching. The method must match exactly; HEAD is not treated as GET.
 *
 * Account endpoints that A3-A adopts later are added here one at a time, each with its own contract,
 * audit event, rate-limit rule and tests. Never add one pre-emptively.
 *
 * Server-side calls such as getAuth().api.getSession() do not go through HTTP and are unaffected.
 *
 * OPTIONS is the one method outside this list that the route answers: app/api/v1/auth/[...all]/route.ts
 * exports OPTIONS as the shared CORS preflight (core/http `preflight`), a bodyless 204 with CORS headers
 * for allow-listed origins only. It never calls handleAuthRequest, so a preflight never reaches Better
 * Auth, never touches the database and grants nothing by itself: the GET or POST that follows is still
 * checked here. If handleAuthRequest were ever called with OPTIONS, it is refused like any other
 * unlisted method.
 */
type AllowedRoute = { method: 'GET' | 'POST'; path: string };

export const AUTH_ALLOWED_ROUTES: readonly AllowedRoute[] = [
  { method: 'POST', path: '/sign-up/email' },
  { method: 'POST', path: '/sign-in/email' },
  { method: 'POST', path: '/sign-out' },
  { method: 'POST', path: '/request-password-reset' },
  // The emailed reset link: redirects to the app's /reset-password page with the token.
  { method: 'GET', path: '/reset-password/:token' },
  { method: 'POST', path: '/reset-password' },
  // The emailed verification link.
  { method: 'GET', path: '/verify-email' },
  { method: 'POST', path: '/send-verification-email' },
];

// Better Auth generates reset tokens as 24 alphanumeric characters. A wider, still path-safe alphabet is
// accepted so a library change does not break links, but nothing that could form another path ("/", ".",
// "%") ever matches.
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{1,256}$/;

function matches(pattern: string, path: string): boolean {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return false;
  return want.every((segment, i) => (segment.startsWith(':') ? TOKEN_SEGMENT.test(got[i]!) : segment === got[i]));
}

/** The allow-listed route a request targets, or null. */
export function allowedAuthRoute(request: Request): AllowedRoute | null {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  const prefix = `${AUTH_BASE_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const path = pathname.slice(AUTH_BASE_PATH.length);
  return AUTH_ALLOWED_ROUTES.find((route) => route.method === request.method && matches(route.path, path)) ?? null;
}

/**
 * The one code every refused request is logged under. Logs never carry any part of the request URL (path,
 * segments or query) or any other attacker-controlled text: only this fixed code, the method from a fixed
 * set, and the process-local aggregate count.
 */
export const AUTH_REJECTION_CODE = 'auth_route_not_allowed';
const LOGGED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

const rejected = { count: 0 };

/** Number of requests refused by the allow-list in this process (aggregate metric and test hook). */
export function rejectedAuthRequestCount(): number {
  return rejected.count;
}

/**
 * The response for every path that is not on the allow-list. The body is identical whatever the path or
 * method, so it reveals nothing about which built-in endpoints exist.
 */
export function rejectAuthRequest(request: Request): Response {
  rejected.count += 1;
  const method = LOGGED_METHODS.has(request.method) ? request.method : 'OTHER';
  console.warn(`[auth:rejected] code=${AUTH_REJECTION_CODE} method=${method} total=${rejected.count}`);
  return Response.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
