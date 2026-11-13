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

## Tenancy and access control (PR 5)

### Verified in CI

| Area | Evidence |
|---|---|
| Role → permission map (OWNER, ADMIN, MANAGER, MEMBER), zone-namespaced keys, no-escalation rules | `apps/api/tests/unit/access.test.ts` |
| Business creation through the session-bound definer function; region from `deployment_config`; invalid details, reserved/taken slugs, CSRF and unauthenticated requests refused; no user-id or region parameter | `apps/api/tests/integration/tenancy.test.ts` |
| Invitations: hash-only storage, matching verified email only, single use, replay/expired/revoked/wrong-token refused, never OWNER, only below the inviter's role | same |
| Role changes: no self change (API and database trigger), only below one's own role, owners may make owners, last owner kept (API has no path; deferred trigger blocks SQL), audit events written | same |
| Removal takes effect on the next request | same |
| Isolation: other businesses answer 404 by slug or id; audit events confined to the business, platform events invisible, append-only; `bos_app` cannot insert businesses or memberships and sees nothing without a context | same |
| Trusted paths: forged/hashed/revoked session tokens see nothing; only `bos_app` may execute; `session_user_id` not executable; schema guards (fixed `search_path`, owner `bos_definer`, no PUBLIC execute, no members of `bos_definer`/`bos_maint`) | same |
| Every `/api/v1/b/` handler uses `tenantRoute` | source rule in `scripts/check-boundaries.mjs` |

### Outstanding

- Apply `prisma/privileged` on Neon with the project's owner role (`pnpm db:privileged`), after the migrations (production approval needed).
- Boot-time check that `REGION` equals `app_private.deployment_config.region` (data-model §5.5 step 5) is not implemented yet.
- Member emails in the members list need a business-restricted definer function (data-model §5.6); the list returns names only.
