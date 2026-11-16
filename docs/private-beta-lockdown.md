# Private beta admission lockdown

Status: proposed; no database changes or deployment performed by this task. Do not merge or deploy until the PostgreSQL integration/isolation suites pass and the admission roster is approved.

## Findings and coverage

| Path | Finding before this change | Enforcement now |
| --- | --- | --- |
| Email/password registration | Any email could register and verify | Better Auth user-create hook requires a live invitation to that email; verification is still mandatory |
| Google/GitHub authentication | Neither social login provider is configured in this repository | The same user-create and session-create hooks cover provider first-login if enabled later; tests exercise Better Auth's actual OAuth user creation seam for both providers |
| Existing browser sessions | Verified identity was sufficient for non-tenant onboarding | Every application route wrapper checks the admission ledger from the signed, database-backed session token |
| Direct API / business creation | Any verified user could create a business and become OWNER | Both the HTTP wrapper and `app_private.create_business` require admission |
| Direct tenant navigation | Membership checked, but no beta admission concept | Admission precedes membership resolution; tenant membership, permissions, transaction scope, RLS and composite foreign keys remain required |
| Invitation acceptance | Verified email, hashed single-use token, expiry, revocation, business and membership checks already existed | These checks remain; successful redemption atomically adds admission, membership, acceptance timestamp and audit event; revoked admissions cannot redeem another invitation |
| Desktop authentication | Browser session could issue a PKCE code and new bearer session | Admission checked at authorize, confirmation and exchange; no bearer token is released after admission loss |
| Communications OAuth | Google/Microsoft mailbox connection, not application login | Existing authenticated browser callback now also requires beta admission; tenant membership still required |

All 197 v1 route files were inspected by wrapper classification (the exact count can change). The exceptions to application wrappers are auth, desktop auth, `/me` and health. Internal workers retain their separate server-secret authentication and are not public account onboarding paths. Public client bundles/static shells contain no authorised application data.

`/me` and Better Auth session/account-management endpoints intentionally remain identity-only: an existing pending session can inspect its own identity, verify email, reset a password or sign out. They do not grant application data access. Keeping `/me` available allows the invitation acceptance screen to function before admission. Health remains public.

## Admission policy and compatibility

- The ledger is `app_private.beta_admissions`, keyed by immutable user ID. No browser, desktop, application-role or auth-role write grants exist. The definer can insert admission only through the reviewed invitation function; runtime callers cannot execute its internal ID-based helper.
- First application of the privileged SQL snapshots non-deactivated users with ACTIVE memberships in unarchived businesses. This is a one-time compatibility seed, not a recurring grant. Reapplying does not undo revocation.
- **Roster review is a deployment gate.** Existing active membership is a compatibility proxy, not proof that a historical public signup was authorised. Review the seed against the actual authorised beta roster. Revoke any unwanted seeded users before reopening traffic. Explicitly seed approved existing accounts with no active membership; they cannot be inferred safely from the repository alone. No production roster was queried.
- An outstanding invitation allows account creation and a browser session for verification/redemption. It does not grant app access or business creation. Revoked, expired, used or archived-business invitations grant neither registration eligibility nor admission.
- Admission does not replace tenancy. A redeemed MEMBER has MEMBER rights only in the invited business. Like other admitted beta accounts, they may create a separate business under the existing create-business policy.
- Revocation of an admission denies subsequent app requests and new sessions even if an old browser/desktop token still exists. Requests already executing at revocation are not cancelled. Removing one tenant membership remains separate from global beta revocation.
- No environment switch can reopen public registration. A missing admission schema or failed lookup fails closed.
- Email signup retains Better Auth's anti-enumeration response: denied signup can return a synthetic HTTP 200 with no token, without persisting a user/account or sending verification email. The UI uses conditional check-email wording. Do not use the response status alone to monitor registration success.

## Tests and validation

Local validation:

- `pnpm test`: passed (1,034 tests before the final four desktop regression cases were added).
- Focused admission, route and desktop regression run: 14 passed, including actual Better Auth memory-adapter email signup/login and Google/GitHub first-login creation hooks.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed; two existing unused-variable warnings in communications-business-mailboxes and scheduling-resources integration tests.
- `pnpm boundaries`: passed.

The new `apps/api/tests/integration/beta-admission.test.ts` covers real PostgreSQL/HTTP denial, OAuth provisioning, authorised sessions, direct database business creation, verified recipient matching, concurrent single-use redemption, expired/revoked/used/archived invitations, global revocation, runtime ledger privileges and cross-tenant denial. Existing integration fixtures now explicitly provision invitations and operator-approved test accounts; there is no test-mode bypass in production code.

**Not run locally:** PostgreSQL integration and isolation suites, because no reviewed test database was supplied and this task explicitly forbids applying migrations. No migration, privileged SQL, production connection, merge or deployment was executed. OAuth tests exercise the real account-creation seam, not live provider redirects; no Google/GitHub application-login credentials are configured.

Before approval, run `pnpm test:integration` and `pnpm test:isolation` against an isolated, prepared database containing the proposed privileged SQL. Review CI results separately; local unit success does not establish PostgreSQL/RLS success.

## Deployment instructions — explicit approval required

1. Approve and record the intended beta roster (stable user IDs) and legitimate pending invitations. Identify authorised accounts with no active membership. Review active owners created through historic public signup; do not assume every active owner is authorised.
2. Take the standard database backup and record the application release SHA and current privileged-function definitions. Prepare an isolated staging database, apply the normal schema plus this privileged SQL only after approval, and run integration and isolation suites.
3. In the approved production maintenance window, pause application traffic to avoid a mixed-version admission window. Apply the repository's privileged scripts as the administrative role using the established `pnpm --filter @business-os/api db:privileged` procedure and production region. The new admission table and changed functions live in `prisma/privileged/001_trusted_paths.sql`; there is no Prisma migration or Prisma model change. Never supply administrative credentials to the running app.
4. Before reopening traffic, reconcile the one-time seed to the approved roster. For a verified authorised existing user with no active membership, an administrator can execute a parameterised statement:

   ```sql
   INSERT INTO app_private.beta_admissions (user_id, source)
   SELECT id, 'operator-approved-existing-account' FROM public.users
   WHERE id = $1::uuid AND deactivated_at IS NULL
   ON CONFLICT (user_id) DO NOTHING;
   ```

   This does not silently reinstate revoked users. To revoke an unwanted seed, set `revoked_at = now()` for that approved user ID. Review a reinstatement separately.
5. Deploy the reviewed API and web changes together. Existing desktop clients use the same protocol. Smoke-test an authorised browser account and desktop login, an uninvited signup, a pending invitation through verification/redemption, direct business POST denial and a cross-tenant request. Confirm new signups leave no identity rows when uninvited. Then reopen traffic.
6. Monitor admission errors, auth failures and invitation redemption failures without logging session tokens, invitation tokens, passwords or complete email addresses. The extra admission query is intentionally uncached for revocation; monitor database latency/pool utilisation.

## Rollback instructions — explicit approval required

Prefer a forward fix or temporary maintenance mode. Rolling back the old API would restore public account creation and may bypass HTTP admission on existing memberships, even if some new database guards remain.

For an approved emergency rollback, keep traffic paused, restore a known-good application and matching privileged-function definitions from the recorded release, and retain the admission ledger and backup for reconciliation. Do not drop or truncate the ledger: recreating it would rerun the compatibility seed. Restore traffic only with an independently enforced access restriction or after explicitly accepting the previous public-registration exposure. Restoring database function definitions is itself a production change requiring approval. No destructive rollback SQL is bundled.
