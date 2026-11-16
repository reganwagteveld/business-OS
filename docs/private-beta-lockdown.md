# Private beta admission lockdown

Status: proposed in PR 71. No database change, merge or deployment has been made by this work. Every production step below needs Regan's explicit approval.

## 1. What changes

Before this change anyone could register with email and password, verify the address, create a business and become its OWNER. Now there are three separate levels:

| Level | Who has it | What it allows |
| --- | --- | --- |
| Identity | Anyone with a live invitation to that email (or an existing account) | Verify email, sign in to redeem an invitation, sign out, reset password, read `/me`. Nothing else. |
| Platform admission | Users on the admission ledger, added by an operator or by redeeming an invitation | Reach the businesses they are members of, with their existing role and permissions. |
| Business creation | Admitted users an operator has explicitly granted it to | Create a business (POST `/api/v1/businesses`, `app_private.create_business`). |

An invited employee (ADMIN, MANAGER or MEMBER) is admitted when they redeem the invitation, but **never** gets business creation. Membership roles, RBAC, tenant scoping, RLS and composite foreign keys are unchanged; admission and the creation grant are extra checks in front of them.

## 2. Enforcement points

| Path | Enforcement |
| --- | --- |
| Email/password registration | Better Auth `user.create.before` hook: an identity is created only for an email with a live invitation (not accepted, revoked or expired, business not archived). Denied sign-ups store no user, account, session or verification email. Better Auth still answers a synthetic success (anti-enumeration), so the HTTP status is not a registration signal. |
| Google/GitHub first login | Not configured as app login providers today. The same user-create and session-create hooks run on Better Auth's OAuth user creation, tested for both provider ids, so enabling a provider later cannot bypass admission. (Communications Google/Microsoft OAuth connects mailboxes; it is not app login and requires an admitted, signed-in member.) |
| Sign-in and new sessions | Better Auth `session.create.before` hook: admitted users, or a not-yet-admitted user with a live invitation (to redeem it). A revoked admission blocks new sessions even with a pending invitation. |
| Existing sessions and session refresh | Every application route wrapper (`publicRoute`, `tenantRoute`, `tenantRunRoute`, `tenantFileRoute`, `browserRoute`) checks admission in the database on every request, from the server-verified session token. Session refresh only extends an existing session; it grants nothing because the per-request check still applies. Revocation takes effect on the next request. |
| Direct API | Same wrappers: all v1 routes except auth, desktop auth, `/me` and health. The only route open before admission is invitation acceptance (explicit `invitationRedemption` flag). |
| Business creation | HTTP: POST `/api/v1/businesses` requires the creation grant (403 `business_creation_not_permitted`). Database: `app_private.create_business` independently requires admission plus the grant, so a bug in the API cannot bypass it. |
| Tenant resolution | `app_private.my_memberships` returns nothing for a non-admitted session. Tenant membership and permissions still apply after admission. |
| Invitation acceptance | Unchanged checks (verified email equals invitation email, hashed single-use token, expiry, revocation, unarchived business, atomic). Redemption also admits the user (never with creation rights) and writes an audit event. A user whose admission was revoked cannot redeem another invitation. |
| Desktop authentication | Admission checked at authorize, confirm and code exchange. A code issued before revocation cannot release a bearer token. |
| Client | Shows "Invitation required" before admission. Offers "create a business" only when GET `/api/v1/access` says `canCreateBusiness: true`; otherwise a user with no business sees "No workspace yet". The server enforces the rule regardless of the client. |

### Remaining limitations (accepted, documented)

1. **Invited emails can create an identity before redemption.** That is intended: it is how an invitee verifies and redeems. If the invitation later expires or is revoked, the identity row stays (dormant) but can neither sign in nor reach anything.
2. **Pre-registration of an invited address.** Someone who knows an invited email could register it first. They cannot verify it (no mailbox access), so they get nothing. The real owner can take the account over with password reset, which goes to their mailbox. This predates PR 71.
3. **Uninvited users get no identity at all** with email/password. With Google/GitHub no provider is configured; if one is added later, the hooks reject first login before a user row is written (tested). Nothing is created at the provider by us.
4. **Existing identities stay.** Accounts that registered before this change keep their identity rows and any sessions, but are not admitted, so every application request answers 403 `invite_required`. Optionally, their sessions can be deleted at deploy time (a production data change; needs separate approval).
5. **One extra uncached database query per application request** (two on POST `/businesses`). Deliberate, so revocation is immediate.

## 3. Database objects (`apps/api/prisma/privileged/001_trusted_paths.sql`)

There is **no Prisma migration**. Everything is in the privileged SQL, applied by the administrative role with `pnpm db:privileged` (each file in its own transaction).

- `app_private.beta_admissions` (user id, admitted/revoked times, source, `can_create_business`, updated time). Runtime roles (`bos_app`, `bos_auth`) have no access. RLS: `bos_definer` may read, and may insert only `source = 'invitation'` rows without creation rights.
- `app_private.beta_admission_events`: an append-only audit trail (update, delete and truncate raise). Every operator change and every invitation admission is recorded with operator name, reason and time. There is no runtime-role access.
- Definer functions (owned by `bos_definer`, fixed `search_path`, no PUBLIC execute). These are executable by `bos_app`: `beta_can_register`, `beta_can_sign_in`, `beta_session_admitted`, `beta_session_can_create_business`. They are boolean-only and take no client-supplied user id except the server-side hook's.
- Operator functions: `operator_admit_user`, `operator_revoke_user`, `operator_set_business_creation`. They are owned by the administrative role and executable by nobody else, because they are not granted to any runtime role.
- **No automatic seed.** Nobody is admitted by applying the SQL. The initial roster (Regan's account only; Regan supplied the id on 2026-11-16, and the deploy re-confirms it with `find` before `admit`) is set explicitly with the operator tool right after applying it (§6).
- Changed: `create_business` (requires the creation grant), `my_memberships` (requires admission), `accept_invitation` (admits and audits; refuses revoked users). Signatures and return types are unchanged, so the currently deployed application works with the new SQL (§5).

## 4. Operator admission tool

**Now (in this PR): `pnpm --filter @business-os/api db:beta-admission`** (`apps/api/scripts/beta-admission.mjs`). Only platform operators can run it, because it needs the administrative database connection, which the running app never has. Users are identified by id only.

```sh
cd apps/api
ADMIN_DATABASE_URL=... node scripts/beta-admission.mjs find <email>        # read-only: id, verified, admission
ADMIN_DATABASE_URL=... node scripts/beta-admission.mjs list                # read-only roster
ADMIN_DATABASE_URL=... node scripts/beta-admission.mjs history [user-id]   # read-only audit trail
ADMIN_DATABASE_URL=... OPERATOR="Regan" node scripts/beta-admission.mjs admit <user-id> --reason "..."
ADMIN_DATABASE_URL=... OPERATOR="Regan" node scripts/beta-admission.mjs allow-create <user-id> --reason "..."
ADMIN_DATABASE_URL=... OPERATOR="Regan" node scripts/beta-admission.mjs deny-create <user-id> --reason "..."
ADMIN_DATABASE_URL=... OPERATOR="Regan" node scripts/beta-admission.mjs revoke <user-id> --reason "..."
```

The rules are enforced in the database functions, not the script:
- Every change needs an operator name and a reason, and is audited.
- Admission never grants business creation. Revoking also withdraws creation, and re-admitting (reinstating) a revoked user restores access only.
- The creation grant applies only to admitted users. An unknown or deactivated user id is refused.

**Follow-up workstream (not blocking PR 71): in-app platform-operator console.** Proposed design, for approval separately:
- A platform operator is a new platform-level role (`app_private.platform_operators`, keyed by user id), granted only by the administrative tool. It is unrelated to business roles, so a tenant OWNER or ADMIN never gets it.
- Routes under `/api/v1/platform/...`, using a new `platformOperatorRoute` wrapper. The wrapper requires admission, operator status checked in the database each request, a recent re-authentication (step-up), and the app origin. These routes are never under `/b/:slug`, so they don't go through tenant permissions.
- Actions: search a user by exact email, then admit, revoke, grant or withdraw business creation, each with a reason. The actions go through new definer functions that write the same ledger and audit table, with `operator = <operator user id>`.
- An audit viewer for the admission history, with operator-only access. Email addresses are masked in lists.
- Tests: an ordinary OWNER/ADMIN is denied, a non-admitted operator is denied, every change is audited, and an operator can't escalate themselves (operators can't grant operator status).

## 5. Compatibility evidence (rehearsed locally)

- Production's privileged functions (md5 of `pg_get_functiondef`, read-only, 2026-11-16) are `accept_invitation` 7e05fa34…, `create_business` 053642cc…, `my_memberships` d168aafc…, `session_user_id` 5f02e05e…. A database built from `main` (e5d19cd) produces **identical** hashes, so the rehearsal starts from production's exact function state.
- Applying the new SQL on top succeeds in about 0.15 s, re-applies cleanly (idempotent), and leaves function signatures unchanged.
- The **current application (`main`) works with the new SQL**: the full `main` integration suite passed against it (660 of 661; the one failure was the rehearsal's own test trigger, which the definer-owner guard correctly flagged), with every test user auto-admitted to simulate an admitted roster.
- Between applying the SQL and admitting Regan, his account sees no businesses and can't create one (seconds, during the deploy step). After `admit`, his memberships reappear. After `allow-create`, creation works. Another, unadmitted owner sees nothing and can't create.
- **SQL rollback is rehearsed:** re-applying `main`'s privileged SQL restores the exact production hashes. The admission tables are kept (harmless), and the `main` suites pass. Rolling forward again afterwards neither re-seeds nor changes the roster.

## 6. Production deployment sequence (approval required at each marked step)

Preconditions: CI green on PR 71's final commit, and Regan's production user id confirmed read-only (not inferred). The administrative connection must be available on the Mac (it is not saved there today).

1. **Read-only preflight** (allowed without approval):
   - Read `_prisma_migrations` and confirm the applied set is exactly the expected one with matching checksums. PR 71 adds no migration. As of 2026-11-16, production has 21, matching `main` after PR 70 (A2-A) merged. Stop on any unexpected or pending migration.
   - Confirm the 4 function hashes in §5 still match, and that `app_private.beta_admissions` does not exist.
   - Read `SELECT region FROM app_private.deployment_config`; the deploy must pass this exact value as `DEPLOYMENT_REGION`, because the script upserts it.
   - With the admin role, check `has_schema_privilege(current_user, 'app_private', 'CREATE')` and that it can read `public.users`. The operator functions run as the admin role and must see users through RLS: the Neon owner role normally has BYPASSRLS. Confirm this, and stop if not.
   - Confirm Vercel auto-deploys `main` for both projects (merge triggers the deploy).
2. **Rehearsal on a disposable Neon branch** made from production (allowed: dry run on a disposable environment). Apply the PR's privileged SQL, admit and grant Regan, and run the read-only checks in step 6. Then delete that temporary branch.
3. **Approval:** create a fresh recovery branch `pre-pr71-beta-admission` and verify it (point-in-time restore doesn't replace this).
4. **Approval:** from a checkout of PR 71's final commit, in `apps/api`, run `ADMIN_DATABASE_URL=… DEPLOYMENT_REGION=<value from step 1> pnpm db:privileged`. Each file is one transaction: a failure rolls that file back whole. No extra grants are needed; the file sets them. Traffic doesn't need pausing, because the deployed app is compatible (§5). Non-admitted accounts lose tenant access and business creation immediately, which is intended.
5. **Same approval, immediately after:**
   - `db:beta-admission admit <REGAN_ID> --reason "initial production allowlist"`
   - `db:beta-admission allow-create <REGAN_ID> --reason "platform owner"`
6. **Verify (read-only):**
   - `list` shows exactly one row (Regan, creation granted). `history` shows 2 events.
   - `has_function_privilege('bos_app', 'app_private.operator_admit_user(uuid,text,text)', 'EXECUTE')` is false.
   - The `bos_app` grants on the 4 beta functions are present.
   - Regan opens https://app.pixakova.com on the current deployment and still sees his business.
7. **Approval:** merge PR 71. Vercel then deploys `business-os` (API) and `business-os-web`.
8. **Smoke tests on production:**
   - Regan: browser sign-in, business opens, GET `/api/v1/access` → `canCreateBusiness: true`, desktop sign-in completes.
   - An uninvited test address signs up: it reports "check email", and the admin `find <address>` returns no row.
   - The other existing account (not admitted): `beta_can_sign_in` is false (read-only SQL).
   - Nothing else is changed in production.
9. Record the run (UTC times, SHAs, recovery branch id, roster) in the operational log.

## 7. Rollback (each step needs approval)

- **SQL step fails:** that file's transaction rolls back automatically, and production stays exactly as before. Stop and report.
- **Problem after the SQL step, before merge:** fix forward. If that's not possible, re-apply `main`'s privileged SQL (from `main`'s checkout, the same command and region). This restores the exact previous functions (rehearsed). Keep the admission tables: don't drop or truncate them.
- **Problem after deploy:** use Vercel Instant Rollback for both projects to the previous production deployment. The previous app works with the new SQL (rehearsed), so the database can stay as is. Re-applying `main`'s SQL is optional and only needed if a database function is at fault. Note: the old app reopens public sign-up, though with the new SQL kept, new accounts still can't reach businesses or create one.
- **Data damage (not expected; this change writes only the two new tables):** restore from the `pre-pr71-beta-admission` recovery branch. This loses writes made after it, so it needs explicit approval.

## 8. Tests

- `tests/integration/beta-admission.test.ts` (real PostgreSQL and HTTP handlers) covers:
  - uninvited sign-up stores nothing
  - Google/GitHub first login is rejected
  - stale sessions are blocked, over HTTP and by direct database business creation
  - admitted access works and tenant isolation holds
  - verified, matching, single-use, concurrent redemption
  - expired, revoked, used and archived invitations
  - global revocation
  - runtime roles can't read or write the ledger, the audit table or the operator functions
  - the definer can't write creation rights
  - admitted-without-grant is denied over HTTP and in the database
  - invited ADMIN, MANAGER and MEMBER keep tenant access but can't create a business
  - operator grant, withdraw, revoke and reinstate take effect on the next request and are audited in order
  - operator input validation and the append-only history

  Removing the database creation check fails 4 of these tests (checked).
- Unit tests: route wrappers deny before handlers, POST `/businesses` refuses without the grant before touching the database, desktop authorize/confirm/exchange, client hides creation without the grant.
- Existing integration suites provision accounts explicitly with `inviteForSignup` and `admitFixture` (`tests/integration/support/admission.ts`). By default, `admitFixture` also grants business creation, because those suites act as business owners.

### Fixture update needed by other open branches after PR 71 merges

PRs 69 (F7-B) and 70 (A2-A) merged before this PR; their suites are already updated here. Any integration test that signs users up through `/api/v1/auth/sign-up/email` must invite before sign-up and admit after it. Otherwise sign-up stores no user and later steps fail. As of 2026-11-16 this applies to:
- PR 68 (People P3-A): `people-leave.test.ts`, `finance-catalog-lines.test.ts`
- Any A2-B branch

```ts
import { inviteForSignup, admitFixture } from './support/admission';
// in the sign-up helper, around the existing sign-up call:
await inviteForSignup(admin, email);
await authRoute.POST(/* existing sign-up request */);
await admitFixture(admin, email); // pass { canCreateBusiness: false } for a non-owner account
```
