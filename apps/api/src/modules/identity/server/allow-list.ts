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

const rejected = { count: 0 };

/** Number of requests refused by the allow-list in this process (test and diagnostics hook). */
export function rejectedAuthRequestCount(): number {
  return rejected.count;
}

/**
 * A safe label for logs: the first path segment under the auth base path, lower-cased, limited to
 * [a-z0-9-] and 40 characters. Never the query string, never a later segment (which could hold a token).
 */
function logLabel(request: Request): string {
  try {
    const pathname = new URL(request.url).pathname;
    const first = pathname.startsWith(`${AUTH_BASE_PATH}/`) ? pathname.slice(AUTH_BASE_PATH.length + 1).split('/')[0]! : '';
    return first.toLowerCase().replace(/[^a-z0-9-]/g, '_').slice(0, 40) || '_';
  } catch {
    return '_';
  }
}

/**
 * The response for every path that is not on the allow-list. The body is identical whatever the path or
 * method, so it reveals nothing about which built-in endpoints exist.
 */
export function rejectAuthRequest(request: Request): Response {
  rejected.count += 1;
  console.warn(`[auth:rejected] method=${request.method.slice(0, 10)} route=${logLabel(request)} total=${rejected.count}`);
  return Response.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
