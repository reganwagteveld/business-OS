# Phase 1b verification status

**Verified** means a command, test or CI job was run and its result is recorded here. **Outstanding** means it needs a deployed environment and has not been done; nothing in that column is claimed as verified.

## Authentication (PR 4)

### Verified in CI

| Area | Evidence |
|---|---|
| ADR 0001 conditions (hashed sessions, shared rate limits, enumeration safety, native bearer sessions) | `apps/api/tests/integration/auth.test.ts`; table in ADR 0001 |
| CSRF: cookie-authenticated state changes need the exact browser-app origin; missing or other origins (including the desktop webview's) get 403; the session survives | `tests/unit/auth-csrf.test.ts`, `auth.test.ts` |
| Desktop bearer: valid signed token works without Origin; tampered, unsigned or hash tokens get 401 and never fall back to a cookie; a valid token from a foreign page gets 403 | same |
| Desktop PKCE flow: loopback-only redirect, S256 only, same-origin confirmation, hashed single-use code, wrong verifier burns the code, independent revocation | `auth.test.ts` |
| Desktop shell opens only the configured API origin's authorisation page; callback parsing | Rust unit tests in `apps/desktop/src-tauri/src/auth.rs` (`cargo test`, CI on Windows, macOS, Linux) |
| Client flows (cookie/bearer transports, PKCE, state check, token only in the native store) | `packages/app/tests/auth.test.tsx` |

### Outstanding: deployed end-to-end checks

These need the production rollout first, which requires Regan's approval: `bos_auth` on Neon, `prisma migrate deploy`, `AUTH_DATABASE_URL`/`AUTH_SECRET`/Resend settings in Vercel, a verified Resend sending domain, and the browser app on the same origin as the API (D9b).

| # | Check | How | Result |
|---|---|---|---|
| E1 | Sign-up sends a real verification email via Resend; link verifies; sign-in works | Browser app on the deployed origin | Not verified |
| E2 | Cookie is `__Secure-bos.session_token`, `HttpOnly`, `Secure`, `SameSite=Lax`, host-only | Browser dev tools on the deployed origin | Not verified |
| E3 | A cross-site form POST to `/api/v1/auth/sign-out` from another domain returns 403 and the session stays | Small test page on another host | Not verified |
| E4 | Password reset email arrives, link opens `/reset-password`, new password works, other sessions are signed out | Browser app | Not verified |
| E5 | Rate limit returns 429 after repeated failed sign-ins from one address, across several function instances | Scripted requests against the deployment | Not verified |
| E6 | Desktop (macOS and Windows): "Sign in with your browser" opens the deployed API's authorise page, confirmation returns to the app, token appears in Keychain / Credential Manager, `/api/v1/me` works, sign-out removes the token and revokes the session | Signed-off build pointed at the deployment | Not verified |
| E7 | Desktop build pointed at a different origin refuses to open the authorise page | Build with another `VITE_API_BASE_URL`, compare | Not verified |
| E8 | Database: `sessions.token_hash` rows only (no raw token), `verifications` reset/desktop identifiers hashed, `bos_app` denied on auth tables | SQL against Neon as an administrative role | Not verified |
| E9 | Vercel logs contain no email bodies, tokens or connection strings | Vercel log search | Not verified |
