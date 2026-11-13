import 'server-only';
// Desktop sign-in (D9a, ADR 0001 addendum, RFC 8252 + RFC 7636):
//   1. The desktop app opens the system browser at GET /api/v1/auth/desktop/authorize with a PKCE
//      S256 challenge, a state value and a loopback redirect (http://127.0.0.1:<port>/callback).
//   2. The browser signs in normally (cookie session). The person confirms on a page served by the
//      API; the confirmation is a same-origin POST (Origin checked), so another site cannot trigger it.
//   3. The API stores a one-time code (hashed, 2 minutes) and redirects to the loopback address.
//   4. The app exchanges code + verifier at POST /api/v1/auth/desktop/token for a NEW session of its
//      own, returned once as a signed token that the app keeps only in the OS credential store.
// The desktop session is a normal row in `sessions`: hashed, expiring and revocable like any other.
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getEnv } from '@/core/config/env';
import { getAuth } from './auth-adapter';
import { getCurrentUser, signSessionToken } from './session';

const LOOPBACK = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/callback$/;
const CODE_TTL_MS = 2 * 60 * 1000;
const B64URL = /^[A-Za-z0-9_-]+$/;

const authorizeParams = z.object({
  code_challenge: z.string().length(43).regex(B64URL),
  code_challenge_method: z.literal('S256'),
  redirect_uri: z.string().regex(LOOPBACK),
  state: z.string().min(16).max(256).regex(B64URL),
});

const tokenBody = z.object({
  code: z.string().min(32).max(128).regex(B64URL),
  code_verifier: z.string().min(43).max(128).regex(/^[A-Za-z0-9._~-]+$/),
  redirect_uri: z.string().regex(LOOPBACK),
});

const stored = z.object({ userId: z.string().uuid(), challenge: z.string(), redirectUri: z.string() });

const html = (body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Business OS</title><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem">${body}</body>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function readParams(source: URLSearchParams) {
  return authorizeParams.safeParse(Object.fromEntries(source.entries()));
}

/** GET: show a confirmation page to a signed-in, verified user, or send them to sign in first. */
export async function authorizeDesktop(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const params = readParams(url.searchParams);
  if (!params.success) return html('<h1>Invalid sign-in request</h1><p>Start again from the Business OS desktop app.</p>', 400);
  const user = await getCurrentUser(request);
  if (!user || !user.emailVerified) {
    const appBase = getEnv().APP_BASE_URL;
    const next = `${url.pathname}${url.search}`;
    return Response.redirect(`${appBase}/sign-in?next=${encodeURIComponent(next)}`, 303);
  }
  const hidden = Object.entries(params.data)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escape(v)}">`)
    .join('');
  return html(`<h1>Sign in to the desktop app?</h1><p>You are signed in as <strong>${escape(user.email)}</strong>. Continue only if you just started sign-in from the Business OS desktop app on this computer.</p><form method="post">${hidden}<button type="submit">Continue to the desktop app</button></form>`);
}

/** POST from the confirmation page: issue a one-time code and hand it to the loopback listener. */
export async function confirmDesktop(request: Request): Promise<Response> {
  const appOrigin = new URL(getEnv().APP_BASE_URL).origin;
  if (request.headers.get('origin') !== appOrigin) return html('<h1>Request blocked</h1>', 403);
  const params = readParams(new URLSearchParams(await request.text()));
  if (!params.success) return html('<h1>Invalid sign-in request</h1>', 400);
  const user = await getCurrentUser(request);
  if (!user || !user.emailVerified) return html('<h1>Please sign in again</h1>', 401);

  const code = randomBytes(32).toString('base64url');
  const ctx = await getAuth().$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: `desktop-code:${code}`,
    value: JSON.stringify({ userId: user.id, challenge: params.data.code_challenge, redirectUri: params.data.redirect_uri }),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  const target = new URL(params.data.redirect_uri);
  target.searchParams.set('code', code);
  target.searchParams.set('state', params.data.state);
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
