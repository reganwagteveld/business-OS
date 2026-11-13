# ADR 0001: Authentication provider

- Status: **Accepted**, 2026-11-13 (Regan's third architecture review on PR #1), subject to the conditions below being verified at the start of Phase 1b
- Date: 2026-11-13
- Decision ID: D1 (architecture.md §10)

## Context

Business OS needs email/password or magic-link sign-in, Google sign-in, email verification, optional TOTP 2FA, server-side session revocation and rate limiting. Tenancy (businesses, memberships, roles) is our own data model and must stay the single source of truth. The database isolation design (data-model.md §5) also requires that sessions can be verified **inside PostgreSQL** by a hashed session token, so pre-tenant `SECURITY DEFINER` functions never trust a caller-supplied user id.

## Options considered

1. **Better Auth** (open-source, self-hosted, Prisma adapter). Data in our Postgres, no per-user cost, broad method support. We operate it: patches, email delivery, rate limits. Auth.js development has moved under the same project.
2. **Clerk** (hosted). Fastest integration and polished UI. Per-MAU cost; user data lives with the vendor and must be synced by webhook; its organisations overlap our memberships.
3. **WorkOS AuthKit** (hosted). Best path to enterprise SSO/SCIM, ahead of SMB needs; same sync concern.
4. **Supabase Auth**. Couples auth to the database host.

## Decision

Use **Better Auth** with its core user, session, account and verification tables only. Do **not** use its organisation plugin; `businesses` and `memberships` remain ours.

The auth library connects through its own `bos_auth` database role (data-model.md §5.1), isolated from tenant code.

## Conditions to verify (first task of Phase 1b; if any fails, this ADR is reopened)

- Sessions can be stored as a **hash** of the token with expiry and revocation columns that `app_private.session_user_id()` can verify. If Better Auth stores raw tokens, either configure/extend it to store a hash, or add a hashed mirror column maintained in the same write. A design that falls back to a free `user_id` parameter is not acceptable.
- Rate limiting can be backed by Postgres (or a shared store) so it works across serverless instances.
- Account-enumeration-safe responses for sign-up and password reset are achievable.

## Consequences

- Easier: one database holds identity and business data; no webhook sync; no per-seat cost.
- Harder: we own security patching and email deliverability for auth.
- Revisit if enterprise SSO/SCIM becomes a near-term requirement (favours WorkOS), or if the hashed-session condition cannot be met.

## Addendum 2026-11-13: desktop and browser clients (ADR 0005)

The decision stands: Better Auth, sessions and users in our database, our own tenancy tables. The desktop-first decision adds a second kind of client:

- **Browser app:** HTTP-only `Secure` `SameSite=Lax` session cookie, with the browser app served from the same site as the API (D9b) and an `Origin` check on mutating requests.
- **Desktop app:** sign-in in the system browser, one-time code returned to the app and exchanged with PKCE for a session token; the token is stored only in the OS credential store and sent as `Authorization: Bearer` (D9a).
- Both are rows in the same session table, stored as a **hash** (the existing condition above), revocable and audited the same way. Add to the Phase 1b verification list: Better Auth supports bearer-token sessions for native clients (or a thin, reviewed extension provides them) without weakening the hashed-session condition.
- Revisit trigger added: if a secure native sign-in flow cannot be built on Better Auth without forking it.

## Verification of the conditions (Phase 1b, 2026-11-13, PR 4)

Better Auth **1.7.22** (pinned exactly). All three conditions are met; this ADR stands.

| Condition | Result | Evidence |
|---|---|---|
| Sessions stored as a hash, verifiable in PostgreSQL | **Met with a thin, reviewed extension.** Better Auth stores the raw token by default. `modules/identity/server/hashed-adapter.ts` wraps its Prisma adapter so `sessions.token_hash` holds `hex(sha256(token))` (a `CHECK` constraint enforces the format) and lookups hash the presented token. Password-reset and desktop sign-in codes in `verifications` are hashed the same way. No fork. | `tests/integration/auth.test.ts`: the stored row equals `sha256(cookie token)` and contains no raw token; forged, unsigned and hash-as-token cookies and bearers are rejected |
| Rate limiting across serverless instances | **Met.** Better Auth's `storage: "database"` keeps counters in `rate_limits` (PostgreSQL). Stricter limits on sign-in, sign-up, password reset and verification email. | Repeated sign-ins from one address get 429 and the counter row exists |
| Enumeration-safe sign-up and password reset | **Met.** `requireEmailVerification` makes duplicate sign-ups return the same body as new ones (the owner gets an email instead); password reset answers identically for unknown emails; sign-in returns the same error for an unknown email and a wrong password. | Identical status and body asserted for each pair |
| Bearer sessions for native clients (addendum) | **Met without Better Auth's bearer plugin**, which would also expose the token to browser JavaScript in a response header. The desktop sends the same HMAC-signed token Better Auth puts in its cookie; the identity module verifies the signature and presents it as the cookie. An invalid bearer never falls back to an ambient cookie. | Desktop flow tests: exchange, bearer use, tampered/unsigned rejection, revocation |

Other settings: passwords 12 to 128 characters, email verification required before sign-in, no cookie cache (revocation is immediate), sessions 30 days rolling, all sessions revoked on password reset, Better Auth telemetry off. Better Auth is reachable only from `modules/identity` and the `bos_auth` client only from its auth adapter (source rules).

## Email provider (accepted 2026-11-13)

**Resend**, accepted by Regan on 2026-11-13, for verification, password-reset and account-notice emails. It is called over its HTTPS API from `core/email` (no SDK), so the provider can change behind one function. Production refuses to boot with the development `log` transport. Before the first production sign-up: a Resend account with a verified sending domain, and `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY` and `EMAIL_FROM` set in Vercel. Resend is a sub-processor that receives recipients' email addresses (ADR 0002 residency table).
