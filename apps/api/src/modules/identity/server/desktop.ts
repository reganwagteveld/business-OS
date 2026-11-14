import 'server-only';
// Desktop sign-in (D9a, ADR 0001 addendum, RFC 8252 + RFC 7636):
//   1. The desktop app opens the system browser at GET /api/v1/auth/desktop/authorize with a PKCE
//      S256 challenge, a state value and a loopback redirect (http://127.0.0.1:<port>/callback).
//   2. The browser signs in normally (cookie session). The person confirms on a page served by the
//      API. The confirmation POST must carry a one-time CSRF token bound to the browser session and
//      to this exact request (challenge, redirect, state), and must come from our own origin.
//   3. The API stores a one-time code (hashed, 2 minutes) and redirects (303) to the loopback address.
//   4. The app exchanges code + verifier at POST /api/v1/auth/desktop/token for a NEW session of its
//      own, returned once as a signed token that the app keeps only in the OS credential store.
// The desktop session is a normal row in `sessions`: hashed, expiring and revocable like any other.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getEnv } from '@/core/config/env';
import { getAuth } from './auth-adapter';
import { getCurrentSession, signSessionToken } from './session';

const LOOPBACK = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/callback$/;
const CODE_TTL_MS = 2 * 60 * 1000;
const CONFIRM_TTL_MS = 10 * 60 * 1000;
const B64URL = /^[A-Za-z0-9_-]+$/;

const authorizeParams = z.object({
  code_challenge: z.string().length(43).regex(B64URL),
  code_challenge_method: z.literal('S256'),
  redirect_uri: z.string().regex(LOOPBACK),
  state: z.string().min(16).max(256).regex(B64URL),
});
type AuthorizeParams = z.infer<typeof authorizeParams>;

const confirmBody = authorizeParams.extend({ csrf: z.string().min(20).max(200) });

const tokenBody = z.object({
  code: z.string().min(32).max(128).regex(B64URL),
  code_verifier: z.string().min(43).max(128).regex(/^[A-Za-z0-9._~-]+$/),
  redirect_uri: z.string().regex(LOOPBACK),
});

const stored = z.object({ userId: z.string().uuid(), challenge: z.string(), redirectUri: z.string() });

/**
 * Security headers for the authorise/confirm pages.
 * - `form-action` must list the loopback origin as well as 'self': browsers (Safari included) apply
 *   form-action to every redirect that follows a form submission, so the 303 from our own POST to
 *   http://127.0.0.1:<port>/callback is checked against it. Only that exact, validated origin
 *   (scheme, host and port) is added; never a wildcard.
 * - `Referrer-Policy: same-origin`: with `no-referrer`, WebKit sends `Origin: null` on the form POST,
 *   which defeats the same-origin check. `same-origin` still sends nothing to other sites.
 */
const html = (body: string, status = 200, callbackOrigin?: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Business OS</title><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem">${body}</body>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${callbackOrigin ? ` ${callbackOrigin}` : ''}; frame-ancestors 'none'; base-uri 'none'`,
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
    },
  });

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The loopback origin of a validated redirect, e.g. "http://127.0.0.1:53682". */
export function loopbackOrigin(redirectUri: string): string | null {
  if (!LOOPBACK.test(redirectUri)) return null;
  let url: URL;
  try {
    url = new URL(redirectUri); // throws for an out-of-range port such as 99999
  } catch {
    return null;
  }
  const port = Number(url.port);
  return port >= 1024 && port <= 65535 ? url.origin : null;
}

function readParams(source: URLSearchParams) {
  return authorizeParams.safeParse(Object.fromEntries(source.entries()));
}

// --- CSRF token: session-bound and transaction-specific ------------------------------------------

function confirmMac(sessionId: string, params: AuthorizeParams, expiresAt: number): Buffer {
  const material = ['desktop-confirm', sessionId, params.code_challenge, params.redirect_uri, params.state, String(expiresAt)].join('\n');
  return createHmac('sha256', getEnv().AUTH_SECRET).update(material).digest();
}

/** `<expiresAt>.<base64url HMAC(session, challenge, redirect, state, expiry)>` — useless for any other session or request. */
export function createConfirmToken(sessionId: string, params: AuthorizeParams, now = Date.now()): string {
  const expiresAt = now + CONFIRM_TTL_MS;
  return `${expiresAt}.${confirmMac(sessionId, params, expiresAt).toString('base64url')}`;
}

export function verifyConfirmToken(token: string, sessionId: string, params: AuthorizeParams, now = Date.now()): boolean {
  const match = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (!(expiresAt > now) || expiresAt > now + CONFIRM_TTL_MS) return false;
  const given = Buffer.from(match[2]!, 'base64url');
  const expected = confirmMac(sessionId, params, expiresAt);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// --- Origin policy for the confirmation POST ------------------------------------------------------

/**
 * Origins allowed to submit the confirmation form: the app's public origin. In local development
 * only, also the API's own origin, because the desktop app may open the API directly
 * (http://localhost:3000) while the browser app runs on the Vite dev server.
 */
export function trustedConfirmOrigins(request: Request): string[] {
  const origins = [new URL(getEnv().APP_BASE_URL).origin];
  if (process.env.NODE_ENV === 'development') origins.push(new URL(request.url).origin);
  return origins;
}

/**
 * - A real Origin must be one of ours.
 * - `Origin: null` (or absent) is accepted only when Fetch Metadata proves a same-origin, top-level
 *   form navigation. Older WebKit sends `null` for such POSTs in some cases.
 * Either way the CSRF token is still required; this check never stands alone.
 */
export function confirmOriginAllowed(headers: Headers, trusted: readonly string[]): boolean {
  const origin = headers.get('origin');
  if (origin !== null && origin !== 'null') return trusted.includes(origin);
  return (
    headers.get('sec-fetch-site') === 'same-origin' &&
    headers.get('sec-fetch-mode') === 'navigate' &&
    headers.get('sec-fetch-dest') === 'document'
  );
}

// --- Handlers -------------------------------------------------------------------------------------

/** GET: show a confirmation page to a signed-in, verified user, or send them to sign in first. */
export async function authorizeDesktop(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const params = readParams(url.searchParams);
  const callback = params.success ? loopbackOrigin(params.data.redirect_uri) : null;
  if (!params.success || !callback) return html('<h1>Invalid sign-in request</h1><p>Start again from the Business OS desktop app.</p>', 400);
  const current = await getCurrentSession(request);
  if (!current || !current.user.emailVerified) {
    const appBase = getEnv().APP_BASE_URL;
    const next = `${url.pathname}${url.search}`;
    return Response.redirect(`${appBase}/sign-in?next=${encodeURIComponent(next)}`, 303);
  }
  const fields = { ...params.data, csrf: createConfirmToken(current.sessionId, params.data) };
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escape(v)}">`)
    .join('');
  return html(
    `<h1>Sign in to the desktop app?</h1><p>You are signed in as <strong>${escape(current.user.email)}</strong>. Continue only if you just started sign-in from the Business OS desktop app on this computer.</p><form method="post">${hidden}<button type="submit">Continue to the desktop app</button></form>`,
    200,
    callback,
  );
}

/** POST from the confirmation page: issue a one-time code and hand it to the loopback listener. */
export async function confirmDesktop(request: Request): Promise<Response> {
  if (!confirmOriginAllowed(request.headers, trustedConfirmOrigins(request))) return html('<h1>Request blocked</h1>', 403);
  const body = confirmBody.safeParse(Object.fromEntries(new URLSearchParams(await request.text()).entries()));
  if (!body.success || !loopbackOrigin(body.data.redirect_uri)) return html('<h1>Invalid sign-in request</h1>', 400);
  const { csrf, ...params } = body.data;
  const current = await getCurrentSession(request);
  if (!current || !current.user.emailVerified) return html('<h1>Please sign in again</h1>', 401);
  if (!verifyConfirmToken(csrf, current.sessionId, params)) return html('<h1>Request blocked</h1><p>Start again from the Business OS desktop app.</p>', 403);

  const code = randomBytes(32).toString('base64url');
  const ctx = await getAuth().$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: `desktop-code:${code}`,
    value: JSON.stringify({ userId: current.user.id, challenge: params.code_challenge, redirectUri: params.redirect_uri }),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  const target = new URL(params.redirect_uri);
  target.searchParams.set('code', code);
  target.searchParams.set('state', params.state);
  return Response.redirect(target.toString(), 303);
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** POST JSON { code, code_verifier, redirect_uri } → { token } for a new desktop session. */
export async function exchangeDesktopCode(request: Request): Promise<Response> {
  const fail = () => Response.json({ error: 'invalid_grant' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  const body = tokenBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return fail();
  const ctx = await getAuth().$context;
  // Single use: the row is consumed atomically whether or not the checks below pass.
  const consumed = await ctx.internalAdapter.consumeVerificationValue(`desktop-code:${body.data.code}`);
  if (!consumed || consumed.expiresAt.getTime() < Date.now()) return fail();
  const data = stored.safeParse(JSON.parse(consumed.value));
  if (!data.success) return fail();
  if (data.data.redirectUri !== body.data.redirect_uri || s256(body.data.code_verifier) !== data.data.challenge) return fail();

  const user = await ctx.internalAdapter.findUserById(data.data.userId);
  if (!user || !user.emailVerified) return fail();
  const session = await ctx.internalAdapter.createSession(user.id, false, { userAgent: 'Business OS desktop', ipAddress: '' });
  if (!session) return fail();
  return Response.json(
    { token: signSessionToken(session.token), expiresAt: session.expiresAt.toISOString() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
