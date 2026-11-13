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
