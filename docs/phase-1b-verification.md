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

### Deployed end-to-end checks (production, 2026-11-13)

Run against `https://app.pixakova.com` (browser app and API on one origin) with Resend test addresses (`delivered+…@resend.dev`), reading the emails through the Resend API. The test accounts, businesses and audit rows were deleted afterwards; production had no other data. **49 checks passed.** One result differs from the design and is recorded under "Findings".

| # | Check | Result |
|---|---|---|
| E1 | Sign-up sends a real verification email through Resend; the link verifies; sign-in works; sign-in is refused before verification; duplicate sign-up answers like a new one | **Verified** |
| E2 | Cookie is `__Secure-bos.session_token`, `HttpOnly`, `Secure`, `SameSite=Lax`, host-only | **Verified** (response header) |
| E3 | Cross-site POST to `/api/v1/auth/sign-out` and a cookie request without the app origin return 403; the session survives | **Verified** (scripted with a foreign `Origin`; not tested from a real page on another domain) |
| E4 | Password reset email arrives, the token resets the password once, replay fails, old sessions end | **Verified** (reset link path `/reset-password/<token>`; the browser screen for it was not clicked through) |
| E5 | Rate limit across function instances | **Partly verified**: counters are stored in PostgreSQL (7 rows during the run) and sign-up/sign-in were not throttled below the limits; the 429 itself was not provoked in production, to avoid locking out the test address |
| E6 | Desktop sign-in | **Server side verified** (PKCE, loopback redirect only, state, confirmation needs the app origin, wrong verifier burns the code, single use, bearer works from `tauri://localhost`, tampered token refused, sign-out revokes only that session). **Not verified:** the native app itself (system browser opening, loopback listener, Keychain / Credential Manager) on macOS and Windows |
| E7 | Desktop build pointed at another origin refuses the sign-in page | **Not verified in production** (Rust unit tests cover the check) |
| E8 | Database: only hashes stored; `bos_app` denied on auth tables and cannot read emails; forced RLS on all 9 tables; definer functions return nothing for forged tokens | **Verified** against Neon |
| E9 | Vercel logs contain no email bodies, tokens or connection strings | **Not verified** (logs were not searched) |
| E10 | Tenant isolation: another business's context, members and invitations answer 404; a membership id from another business through your own URL answers 404; no session is 401; the only owner cannot demote or remove themselves; a MEMBER cannot list invitations | **Verified** |
| E11 | Invitation by email: link points at `app.pixakova.com/invite`; a different verified user cannot use it; the invitee accepts once; replay fails | **Verified** through the API (the `/invite` screen in PR 7 was not deployed or clicked through) |
| E12 | Sign-out: browser session revoked server-side (`/me` and tenant API 401) | **Verified** |

#### Findings

- **Bearer requests without an `Origin` header are refused (403) in production.** Better Auth runs its own Origin check on cookie-bearing requests and the identity module presents a bearer as a cookie, so it applies. The check is disabled under test, so CI did not see this. The real desktop app is unaffected: its webview sends `Origin: tauri://localhost` (or `http://tauri.localhost` on Windows), both on the allow-list, and that path passed. A native non-browser client without an Origin would need to send one. Follow-up: make the integration tests exercise the same check as production, and align the `classifyAuthRequest` comment.
- The reset and desktop-code rows are consumed on use, so E8 could not inspect an unconsumed one in production; the hashed identifiers are covered by CI.

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
