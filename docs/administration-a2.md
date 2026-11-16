# Administration A2: business settings, team access and roles

Status: **A2-0 audit and plan. Decisions D-A2-1..13 APPROVED by Regan on 2026-11-16 08:44Z as recommended**, with the six
mandatory requirements in §12. Nothing here is applied to production.
Audited against `main` at 81ff625 (2026-11-16). Branch for this document and A2-A: `claude/project-thread-ouwgnj`.

The short version: most of the membership machinery A2 asks for **already exists** from Phase 1b (PR 5): four roles,
permission keys, role-assignment rules, hashed single-use invitations, a database last-owner guard, a self-role-change
guard, per-request membership resolution and an accept screen. A2 is therefore an **extension and hardening** job, not
a new system. The real gaps are: no way to edit business details, no Settings UI at all, no resend, no suspension, no
ownership transfer, a last-owner race, a revoke-after-accept race, duplicate open invitations, member emails not
readable by the app, and mailbox credentials surviving a member's removal until the next sync.

---

## 1. Current implementation inventory

| Area | What exists | Where |
|---|---|---|
| Authentication | Better Auth (ADR 0001); sessions hashed in `sessions`; browser cookie, desktop bearer token (ADR 0005); verified email required to create or join a business | `modules/identity`, `core/db/auth-client.ts` |
| Tenant resolution | Every `/api/v1/b/{slug}/…` request resolves the slug through `app_private.my_memberships(session_token)` (SECURITY DEFINER, ACTIVE memberships in unarchived businesses only), then opens one transaction with `app.business_id` and `app.user_id` set | `app/api/_lib/routes.ts` `resolveTenant`, `core/db/with-tenant.ts` |
| Business creation | `app_private.create_business` (trusted path): business + OWNER membership + audit in one statement; region from `deployment_config`; 5 per user per day | `prisma/privileged/001_trusted_paths.sql`, `POST /businesses`, `shell/onboarding.tsx` |
| Business switching | `GET /businesses` (switcher) and `GET /b/{slug}` (business + caller's role and permission keys) | `businesses/route.ts`, `b/[slug]/route.ts` |
| Business record | `businesses`: name, slug, legal_name, country_code, time_zone, locale, currency, home_region, archived_at. `bos_app` may UPDATE only `name`, `legal_name`, `updated_at`. **No update API exists.** | migration `20261113150000_tenancy` |
| Roles | `OWNER`, `ADMIN`, `MANAGER`, `MEMBER` (enum `MembershipRole`). Exactly the roles the brief proposes | `modules/access/server/permissions.ts` |
| Permissions | Code checks keys, never roles: `business:*`, `members:read/invite/manage`, `audit:read`, and each Zone's own keys. `ROLE_PERMISSIONS` maps roles to keys. One documented role rule: only an OWNER attests a consumer mailbox (D-C2-3) | same |
| Role-assignment rules | `canManageMember`: owners act on anyone, others only on roles strictly below their own, never on themselves. `canAssignRole`: no escalation, only OWNER makes an OWNER, invitations never grant OWNER | same |
| Membership status | Enum `ACTIVE`/`SUSPENDED`; `my_memberships` ignores SUSPENDED, so a suspended member is already locked out. **No API sets SUSPENDED.** | tenancy migration |
| Members API | `GET /b/{slug}/members` (members:read), `PATCH /members/{id}` role change and `DELETE /members/{id}` removal (members:manage) | `modules/tenancy/server/members.ts` |
| Removal clean-up | Locks the membership, un-assigns customers, opportunities, projects, tasks (in id order), unlinks the People employee record, deletes the membership, audits | `removeMember` |
| Invitations | `GET/POST /b/{slug}/invitations`, `DELETE /invitations/{id}` (members:invite). 32-byte random token, **only SHA-256 stored**, 7-day expiry, 50 open max, email lower-cased, OWNER role forbidden by CHECK | `createInvitation`, `revokeInvitation` |
| Acceptance | `POST /invitations/accept` → `app_private.accept_invitation`: binds to session user, requires verified email equal to the invited address, row locked `FOR UPDATE`, membership insert + `accepted_at` + audit in one transaction, one generic failure for every refusal | trusted paths SQL |
| Accept screen | `/invite?token=…` read once and stripped from the address bar; signed-out visitors land on sign-up; explicit "Accept" click | `packages/app/src/app.tsx`, `auth/auth-screens.tsx` |
| DB invariants | `memberships_no_self_role_change` (BEFORE UPDATE), `memberships_keep_an_owner` (deferred constraint trigger at commit), FORCE RLS on all four tenancy tables, `bos_app` has no INSERT on businesses or memberships | tenancy migration |
| Composite FKs | `(business_id, user_id) → memberships` from customers, opportunities, projects, project_tasks, people_employees (NO ACTION) and mail_connection_members (CASCADE) | Zone migrations |
| Audit log | `audit_events`, append-only (no UPDATE/DELETE grant), RLS: tenant reads its own; tenant writes must carry the session user as actor; system writes only for `communications.system.*` / `finance.system.*`. Helper `recordAudit`. **No audit viewer API yet** (`audit:read` key unused) | `core/audit` |
| Email | `core/email/sendEmail`: transactional email over Resend HTTPS (production sender `mail.pixakova.com`), or a `log` transport in dev/CI. Already sends invitation emails after commit | `core/email/index.ts` |
| Communications C2 | Mailbox credentials belong to a holder; sync jobs check the holder's ACTIVE membership at claim time (`holder_inactive`/`owner_inactive`), so invalidation on departure is **lazy**. `mail_connection_members` rows cascade with the membership | `modules/communications/server/sync-jobs.ts`, C2-B1 audit note |
| Finance settings | `finance_settings` (finance:manage): seller legal name, address, email, phone, identifiers (list of label/value), payment instructions, default terms, default tax rate. Seller is **snapshotted at issue**; legal name falls back to `businesses.legal_name` then `name` | `modules/finance/server/settings.ts` |
| Business defaults in use | `currency` = default for new quotes, invoices, payments, expenses, opportunities, recurring schedules (each record stores its own currency). `time_zone` = "today" for finance date checks, Scheduling day boundaries, Reporting periods, People dates; recurring schedules copy it at creation | grep of `business.currency` / `business.timeZone` |
| Client shell | Zone registry with a **planned** `settings` entry (not openable); permission-filtered nav; shared states (`problem.tsx`, `states.tsx`); Finance already has its own Settings sub-page | `shell/registry.ts`, `zones/finance/settings.tsx` |
| Tests | `tests/integration/tenancy.test.ts` covers creation, invitations (hash, once, email match, expiry, revoke, owner ban, below-own-role), role rules, last owner (API and SQL), self role change, removal on next request, route gating, tenant isolation, audit isolation, definer hygiene, forced RLS. `tests/unit/access.test.ts` covers the role matrix | CI "Database tests" job |

## 2. Gaps (verified, not assumed)

| # | Gap | Severity | Evidence |
|---|---|---|---|
| G1 | **Last-owner write skew.** Two owners demoting or removing each other in concurrent transactions each see the other still OWNER at commit (READ COMMITTED), so both commit and the business has no owner | High (invariant 1) | `memberships_keep_an_owner` reads without any lock; reproduced locally with two connections, see §6.1 |
| G2 | **Revoke after accept.** `revokeInvitation` checks `accepted_at IS NULL`, then updates by id only. If acceptance commits in between, the accepted invitation is marked revoked and audited as revoked while the membership exists | Medium | `members.ts` `revokeInvitation` |
| G3 | **Duplicate open invitations.** Nothing stops several open invitations for the same email, with different roles | Medium | no unique index on open invitations |
| G4 | **No resend.** The raw token is returned once; a lost or failed email has no recovery except revoke + re-invite. A failed send after commit currently returns HTTP 500 although the invitation exists | Medium | `invitations/route.ts` `afterCommit` |
| G5 | **Stale actor role inside the transaction.** The actor's role is read by `my_memberships` before the unit of work opens. A demoted or removed admin's in-flight request can still change other members | Low–Medium (invariant 7) | `resolveTenant` |
| G6 | **No suspension API**, though the status exists and is already honoured by `my_memberships` | Feature | — |
| G7 | **No ownership transfer or step-down.** An owner cannot demote themself (DB trigger), so a sole owner can never hand over | Feature (invariant 7) | `memberships_no_self_role_change` |
| G8 | **No "leave business"** | Feature | — |
| G9 | **Member emails are not readable by the app.** `bos_app` has `SELECT (id, name, image_url)` on users only; the members list shows names only | Feature + privacy decision | identity migration grants |
| G10 | **Mailbox credentials survive removal/suspension** until the next sync claim (lazy). The C2-B1 audit asked for membership-event invalidation | Medium (invariant 5, 6) | C2-B1 audit note C2B1-01 |
| G11 | **No business details update** (name, legal name, regional settings) and no contact/address fields | Feature | no route |
| G12 | **No Settings UI** (Zone is `planned`); no members or invitations screens | Feature | `registry.ts` |
| G13 | **No audit viewer**; `audit:read` is granted but unused | Feature | — |
| G14 | Self **status** change is not blocked in the database (only self role change is). The API already refuses it | Low | trigger only compares `role` |
| G15 | Invitation token is held in React state only; if sign-up email verification sends the person to another tab, they must click the invitation link again | Low UX | `app.tsx` |

## 3. Architecture decisions (alternatives and recommendation)

### 3.1 Roles: keep the four existing roles (recommend)
The proposed Owner/Admin/Manager/Member set **is** the current enum, with rank-based assignment rules and Zone keys
already tuned by FD-P1 (Finance), PD-1 (People), C2 and R1 decisions. Alternatives: (a) add custom roles now, (b) add
a "Billing/Accountant" role. Both are premature (no customer need yet) and `ROLE_PERMISSIONS` is already the single
seam a custom-role table would replace. **Recommendation: no role or grant changes in A2.** A2-C only documents the
matrix (§5), exposes it read-only to the UI, and adds tests that pin it.

### 3.2 Business details: where each field lives
| Field | Lives in | Why |
|---|---|---|
| Display name, legal name | `businesses` (existing columns) | already there; Finance falls back to them |
| Trading name, email, phone, website, address | **new** `businesses` columns (A2-A) | business identity, not finance-specific |
| Registration / tax identifiers | `finance_settings.seller_identifiers` (existing) | already a label/value list sealed into documents; a second copy would drift. Shown in Settings as a link to Finance settings |
| Country, time zone, locale, currency | `businesses` (existing) | authoritative today; A2-A makes them editable |
| Financial year start | **new** `businesses.fiscal_year_start_month` (1–12, nullable = not set) | asked for; nothing reads it yet (Reporting can later) |
| Default tax rate, payment terms, quote validity, seller overrides | `finance_settings` (existing, finance:manage) | Finance-owned; not duplicated |

Alternative rejected: moving seller fields out of Finance into the business profile. It changes F1/F5 behaviour and
their audits for no user gain; the existing fallback (`seller legal name → business legal name → name`) already
gives the profile priority when Finance has no override.

### 3.3 Changing regional defaults must not rewrite history
Verified: every financial record stores its own `currency_code` and dates; issued documents seal a seller snapshot;
recurring schedules copy the time zone at creation. So changing `currency` or `time_zone` affects **only new records
and "today" calculations**. Consequences that need to be visible in the UI and the audit entry: Scheduling day views,
Reporting periods and finance "not in the future" checks switch to the new zone immediately. A2-A records old and new
values in the audit event and asks for confirmation in the UI. `country_code` also changes the seller country on
**future** documents only.

### 3.4 Invitation email: reuse `core/email`, not C2 (recommend)
Invitations are platform email from Business OS (like verification and password reset), sent from the verified
`mail.pixakova.com` domain through the existing transport. C2 is the business's *own* mailboxes (gmail.send /
Mail.Send) and must not be used for platform mail. No new email system is introduced. C2 is touched only for G10.

### 3.5 Resend: revoke-and-reissue vs rotate in place
(a) Rotate `token_hash` and `expires_at` on the same row: needs a new column grant; loses the history of the old link.
(b) **Recommend:** resend = revoke the open row and insert a new one in the same transaction (new token, new 7-day
expiry, same email and role). The old link stops working at once, history stays append-only, no grant change.

### 3.6 One open invitation per email per business
Partial unique index `(business_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL`. Expired rows would
block it (expiry cannot be in a partial index predicate), so `createInvitation` first marks any expired open row
revoked, inside the same transaction. A concurrent duplicate gets `23505` → `409 invitation_exists`. An address that
already belongs to an **active member of this business** gets `409 already_member` (that reveals nothing outside the
business; an address with an account elsewhere is never distinguished from one without).

### 3.7 Ownership transfer and step-down
Recommend a dedicated action, `POST /b/{slug}/members/{id}/transfer-ownership` (OWNER only): in one transaction,
promote the target (must be ACTIVE, not self) to OWNER and, if `stepDown: true`, demote the caller to ADMIN. The
self-role trigger gains one narrow exception: an owner may lower **their own** OWNER role to ADMIN when another
ACTIVE owner exists at commit (still guarded by the last-owner trigger, now locked; §6.1). Same rule powers a plain
"step down" when there are already two owners. Alternative: require a second owner to demote you. Rejected: a sole
owner could never hand over.

### 3.8 Suspend vs remove
Recommend both. **Suspend** (`status = SUSPENDED`): immediate loss of access, assignments and history kept, reversible.
**Remove**: existing behaviour (assignments cleared, membership deleted). Both apply the same rank rules and the
last-owner guard, and both invalidate the member's mailbox credentials at once (§3.10).

### 3.9 Who can see member emails
Options: (a) every member (grant `users.email` to `bos_app`), (b) **recommend:** only holders of `members:invite`
(OWNER, ADMIN, MANAGER), through a SECURITY DEFINER function that returns emails only for members of the current
business, (c) nobody (names only). (b) keeps MEMBER-role staff from harvesting colleagues' addresses and leaves the
users-table column grant untouched.

### 3.10 Mailbox credentials on removal, suspension or demotion (C2-reviewed 2026-11-16)
Invalidation is **eager**, and the lazy holder check at sync claim stays as defence in depth. C2's review is in
`/mnt/project-files/administration-a2/a2-b-mailbox-cutoff-review.md`. A2-B scope gate:

- **Triggers:** removal, suspension, **and role demotion**. A demotion that drops the holder's authority counts: ADMIN
  to MANAGER/MEMBER loses `manage_connections`, and MANAGER to MEMBER loses `connect`. The same `holderActive` rule
  as the sync claim decides.
- **Mechanism:** a Communications public function, `revokeHeldConnections(db, actorUserId, userId, cause)`.
  - It runs in the membership transaction and locks the person's ACTIVE held connections `ORDER BY id FOR UPDATE`.
  - Each connection moves to NEEDS_REAUTH. The status trigger deletes the token ciphertext, and QUEUED and RUNNING
    sync jobs are cancelled.
  - Existing fences then refuse any further heartbeat, completion, refresh store or `invalid_grant` write:
    `credential_version` plus the exact `refresh_lease_id`.
- **Audit:** recorded under the **acting administrator** with `recordAudit`, as
  `communications.connection.holder_departed` with provider, user and cause. It is not a system event: the RLS policy
  for system audit stays unchanged, and a system insert would fail inside a user transaction.
- **Holder credentials vs shared access:** the person's *own* credentials are revoked. Their `mail_connection_members`
  rows (access to other people's mailboxes) are **kept on suspension** for reactivation, since they grant nothing
  while suspended. They still cascade on removal, and the lost access is recorded in the removal audit.
- **Concurrency:** the membership transaction retries on 40P01/40001, because its lock order differs from C2's paths.
  One concurrency test covers removal racing a sync claim or refresh.
- **Out of A2 scope:** an access token already in a worker's memory stays usable until the next fence check.
  C2-B3 must re-check the lease and the connection's ACTIVE state before every provider call.
- The approved 30-day grace (D-C2) applies to purging PERSONAL mail content only, never to credentials.

### 3.11 Revalidating authority inside the transaction (G5)
Every A2 mutation locks the actor's own membership `FOR SHARE` inside the unit of work and re-checks role and status
before acting. A concurrent demotion then either waits for the admin action or makes it fail with 403. Other Zones
keep today's per-request resolution (a millisecond window; documented, not changed in A2).

## 4. Proposed schema changes

All forward-only, additive, no backfill of real data needed (production has no businesses yet).

**A2-A `20261202000000_business_profile`** (exact stamp chosen at PR time; see §8):
- `businesses` + `trading_name text`, `contact_email text`, `contact_phone text`, `website text`,
  `address_line1/line2/city/region/postal_code text`, `address_country_code char(2)`,
  `fiscal_year_start_month smallint`, `version integer not null default 1`.
- CHECK constraints: lengths, email shape, `website` https/http URL, country format, month 1–12, version > 0.
- `GRANT UPDATE` on the new columns plus `country_code, time_zone, locale, currency` to `bos_app` (RLS unchanged:
  `tenant_isolation` on `businesses` still binds every row to `app.business_id`).
- Trigger: time zone must exist in `pg_timezone_names` (same rule as `create_business`).

**A2-B `…_membership_lifecycle`:**
- Partial unique index on open invitations (§3.6); `GRANT UPDATE (revoked_at)` already exists.
- `memberships_keep_an_owner`: take a row lock on the business (`SELECT … FROM businesses … FOR UPDATE`) before
  counting, so concurrent owner changes serialise (§6.1).
- `memberships_no_self_role_change`: also block self **status** changes; allow OWNER → ADMIN self step-down only.
- `memberships` + `suspended_at timestamptz`, `suspended_by uuid` (for display and audit; status stays the source).
- `app_private.member_emails()` SECURITY DEFINER (privileged SQL `005_…`), reading the session's business and
  returning `(user_id, email)` for its members only, executable by `bos_app`; the service calls it only after
  `members:invite`.
- `invitations` + `last_sent_at timestamptz` (resend throttle, e.g. once per 60 s).

**A2-C, A2-D:** no schema change. **A2-E:** audit viewer read API only (no schema change).

## 5. Authorization matrix (current grants, unchanged by A2)

✔ = granted, — = not granted. "Below own" = only for members whose role is strictly lower than the actor's.

| Capability (key) | Owner | Admin | Manager | Member |
|---|---|---|---|---|
| View business profile (`business:read`) | ✔ | ✔ | ✔ | ✔ |
| Edit business profile and regional settings (`business:manage`) | ✔ | ✔ | — | — |
| Archive/delete business (`business:delete`) | ✔ | — | — | — |
| See member list, names, roles (`members:read`) | ✔ | ✔ | ✔ | ✔ |
| See member emails (proposed: `members:invite`) | ✔ | ✔ | ✔ | — |
| Invite (`members:invite`) | ADMIN, MANAGER, MEMBER | MANAGER, MEMBER | MEMBER | — |
| Resend/revoke invitation | any open | roles below own | MEMBER invites | — |
| Change role (`members:manage`) | anyone except self, incl. make OWNER | below own, to below own | MEMBER only, to MEMBER | — |
| Suspend/reactivate/remove (`members:manage`) | anyone except self (last-owner guard) | below own | MEMBER only | — |
| Transfer ownership / step down | ✔ (OWNER only role rule) | — | — | — |
| Leave business | ✔ unless last owner | ✔ | ✔ | ✔ |
| Read audit log (`audit:read`) | ✔ | ✔ | — | — |
| Customers (`customers:*`) | all | all | all | read, write |
| Activity / restricted notes | all + restricted | all + restricted | read, write | read, write |
| Sales (`sales:read/write`, `sales:manage` pipeline) | all | all | read, write | read, write |
| Projects | all | all | all | work, no archive |
| Finance | all | all | read, drafts, expenses, documents | — |
| People | all | all | directory only | — |
| Scheduling | all | all | all | events only |
| Communications | all, incl. manage connections and consumer-mailbox attestation (role rule) | all except attestation | read, record, connect own | read, record |
| Reporting | all | all | read, save, share | read, save |
| Administration Zone (opens with) | `business:read` | `business:read` | `business:read` (read-only profile, members, MEMBER invites) | `business:read` (read-only profile and member names) |

Nothing in A2 adds a Zone key to any role. Finance, People and credential access remain exactly as approved in
FD-P1, PD-1 and D-C2.

## 6. Security and concurrency

### 6.1 Last owner (G1) — fix in A2-B
Reproduction (local PG16, `main` schema, 2026-11-16): owners A and B; tx1 demotes A, tx2 demotes B, and each runs
the owner check (`SET CONSTRAINTS ALL IMMEDIATE`, to widen the window) before either commits. Both checks see the
other still OWNER and both commit: **zero owners**. With the default deferred mode the same thing happens whenever
the two commits overlap, so the window is narrow but real; run sequentially, the second one is correctly refused. Fix: the deferred trigger first locks the
business row, then counts with a fresh snapshot (plpgsql runs each statement with a new snapshot under READ
COMMITTED), so the second commit sees the first and raises `23514`. Test: two-connection interleaving in
`tenancy.test.ts`.

### 6.2 Invitation lifecycle
```
            create (members:invite, rank rule, one open per email)
                 │
                 ▼
   ┌──────── OPEN ────────┐  resend = revoke + new OPEN (new token, new expiry)
   │   │           │      │
 accept revoke   expires  member already exists → accept fails generically
   │   │           │
ACCEPTED REVOKED  EXPIRED (derived: expires_at <= now(); revoked on next create)
```
- Token: 32 random bytes, base64url, sent once in the email link, SHA-256 at rest, never logged or audited.
- Accept binds to the session user's **verified** email, equal to the invited address; one generic error for wrong
  user, unverified, expired, revoked, used, unknown token or existing member (no oracle).
- Atomicity: `accept_invitation` locks the invitation row, inserts the membership and marks it accepted in one
  transaction. Revoke becomes `UPDATE … WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL` and checks the
  row count, so accept-vs-revoke has exactly one winner (G2).
- Users without accounts: the link opens sign-up; after email verification they open the link again (G15: A2-D keeps
  the token in session storage for the tab so they do not have to).
- Multiple businesses: membership is per business; the switcher already lists all active memberships.
- Email failure: the invitation is committed; the API answers `201` with `delivery: "failed"` and the UI offers
  Resend, instead of today's 500.
- Rate limits: 50 open per business (existing); resend at most once per 60 s per invitation.

### 6.3 Other invariants
| Invariant | Enforcement |
|---|---|
| 1 One active owner | deferred trigger + business-row lock (A2-B) |
| 2 Non-owners never grant ownership | `canAssignRole` + invitations CHECK `role <> 'OWNER'` + trigger: only an OWNER actor may set role OWNER (A2-B adds the DB check) |
| 3 No privilege beyond own | rank rules in `modules/access`; re-checked against the locked actor row (§3.11) |
| 4 Tenant boundaries | unchanged FORCE RLS; all new columns on already-isolated tables; new definer function reads `app.business_id`, never a parameter |
| 5 Removed/suspended lose access | `my_memberships` per request (existing); eager C2 credential invalidation (§3.10) |
| 6 Background jobs revalidate | C2 sync checks holder at claim (existing) and at each provider call (C2-B3 requirement, unchanged). F6 billing and reminders act for the **business**, not a member, and do not depend on a member's authority; reminder sending stays off |
| 7 Ownership transfer | single transaction, OWNER-only, locked rows (§3.7) |

## 7. API design (all under `/api/v1/b/{slug}`; contracts in `packages/contracts/src/tenancy.ts`)

| Method and path | Key | Stage | Notes |
|---|---|---|---|
| `GET /business` | business:read | A2-A | full profile + `version` (the existing `GET /b/{slug}` stays for context) |
| `PATCH /business` | business:manage | A2-A | partial update, `expectedVersion` required (409 `stale`), server validation of every field, audit `business.updated` with changed field names and old/new regional values only |
| `GET /members` | members:read | exists; A2-B adds `email` (if `members:invite`), `suspendedAt` | |
| `PATCH /members/{id}` | members:manage | exists; A2-B adds `{ status }` for suspend/reactivate | |
| `DELETE /members/{id}` | members:manage | exists; A2-B adds credential invalidation | |
| `POST /members/{id}/transfer-ownership` | OWNER rule | A2-B | `{ stepDown: boolean }` |
| `POST /membership/leave` | business:read | A2-B | self, last-owner guard |
| `POST /invitations` | members:invite | exists; A2-B adds duplicate/member checks and `delivery` | |
| `POST /invitations/{id}/resend` | members:invite | A2-B | revoke + reissue |
| `DELETE /invitations/{id}` | members:invite | exists; A2-B makes it conditional | |
| `GET /access/roles` | business:read | A2-C | role descriptions and the key matrix from `ROLE_PERMISSIONS` (read-only) |
| `GET /audit-events` | audit:read | A2-E | cursor-paged, filter by action prefix; metadata as stored (never tokens) |

Errors follow the existing mapping: 400 `invalid_input` with field names, 403, 404 (also for other businesses' ids),
409 `stale` / `invitation_exists` / `already_member` / `last_owner`, 429.

## 8. Migration dependencies and ordering

- Newest on `main`: `20261130000000_finance_catalog` (applied to production per the F7-A thread).
- Open branches: PR 64 (E1) `20261201000000_communications_erasure`; PR 68 (P3-A) was renamed to
  `20261204000000_people_leave_policies` after this audit flagged the collision (both had used `20261201000000`).
- A2-A uses **`20261202000000_business_profile`**; A2-B reserved `20261203000000_membership_lifecycle` (re-stamped `20261205000000` in §13.5) and its
  privileged file `005_member_emails.sql` (E1 already takes `004`). Re-check both before each PR leaves draft; rename
  if anything newer lands first.
- Overlap: E1 rewrites the `Business` relation list in `tenancy.prisma`; P3-A adds to it. A2-A edits the same model
  (new scalar fields only), so expect a trivial rebase conflict, nothing semantic.
- Deploy order (existing rule): apply each A2 migration to production, after a fresh Neon recovery branch, **before**
  its PR merges, because `main` auto-deploys. Needs Regan's approval each time.

## 9. Implementation sequence (adjusted)

| Stage | Scope | Migration | Depends on | Model |
|---|---|---|---|---|
| **A2-A** Business profile | schema + `GET/PATCH /business` + validation + audit + tests (API only) | yes | none | Opus |
| **A2-B** Membership lifecycle | G1–G10, G14: owner lock, conditional revoke, one open invite, resend, delivery status, suspend/reactivate, transfer/step-down, leave, member emails, eager C2 invalidation, actor re-check | yes | A2-A merged (shared migration order), C2 ack on §3.10 | Opus |
| **A2-C** Roles & permissions | matrix tests pinning §5, `GET /access/roles`, role descriptions; no grant changes | no | A2-B | Opus |
| **A2-D** Administration UI | Settings Zone goes `built`: Business profile (A2-A API), Team members, Invitations, Roles & permissions; permission-denied, empty, loading, error states; confirmation dialogs; light/dark, 390 px. **Required (audit of PR 70):** a confirmation before saving a currency, country or time zone change, saying that existing records keep their stored currency and document snapshots while "today", day boundaries and reporting periods change immediately | no | A2-A..C APIs | Sonnet |
| **A2-E** Security & integration | concurrency suites (two connections), cross-business switching, revoked-member access across every Zone route, escalation attempts, audit viewer API, RLS regression proof | no | A2-B..D | Opus |

All Settings UI, including the business profile screen, is A2-D (Sonnet, per Regan). Tests ship with every stage;
A2-E is the cross-cutting suite. Each stage gets its own thread, branch and draft PR.

## 10. Risks

- Time zone change shifts day boundaries for Scheduling, Reporting and finance date checks instantly (by design;
  needs a clear UI warning).
- Making regional settings editable by ADMIN (not only OWNER) is a policy choice (D-A2-3).
- Eager credential invalidation crosses into Communications; must be reviewed with C2 to keep its fencing
  (credential_version, refresh lease) intact.
- Removing a member still clears their assignments (existing behaviour); suspension is the non-destructive option.
- No step-up authentication exists; ownership transfer relies on an active session plus typed confirmation in v1.

## 11. Decisions for Regan

| ID | Decision | Recommendation |
|---|---|---|
| D-A2-1 | Keep the existing four roles and their grants unchanged in A2 | Yes |
| D-A2-2 | Field ownership as in §3.2 (registration/tax identifiers stay in Finance; new contact/address/fiscal-year fields on the business) | Yes |
| D-A2-3 | Who edits regional settings (time zone, currency, country, locale) | OWNER and ADMIN (`business:manage`), with confirmation and audit |
| D-A2-4 | Store financial year start month now (nothing uses it yet) | Yes, nullable, month only |
| D-A2-5 | Invitations use existing platform email (`core/email`), not C2 | Yes |
| D-A2-6 | Resend = revoke and reissue | Yes |
| D-A2-7 | One open invitation per email per business; `already_member` shown to the inviter | Yes |
| D-A2-8 | Ownership transfer action plus owner self step-down when another owner exists | Yes, no step-up auth in v1 |
| D-A2-9 | Add suspend/reactivate alongside remove | Yes |
| D-A2-10 | Members may leave a business (not the last owner) | Yes |
| D-A2-11 | Member emails visible only to `members:invite` holders | Yes |
| D-A2-12 | Eager mailbox-credential invalidation on removal/suspension (C2 coordination) | Yes |
| D-A2-13 | Invitation expiry stays 7 days; resend throttle 60 s | Yes |

All approved 2026-11-16.

## 12. Mandatory requirements added at approval (Regan, 2026-11-16)

1. Fix the last-owner race (§6.1) and prove the invariant under simultaneous demotion, removal, suspension and
   ownership transfer (A2-B, two-connection tests).
2. Ownership transfer: transactional, explicitly confirmed, audited, active members only; no step-up auth in v1.
3. Eager mailbox-credential invalidation coordinated with C2: in-flight jobs, refresh leases and credential-version
   fencing must not allow provider operations after revocation (C2 review requested before A2-B builds it).
4. Invitation acceptance and revocation mutually exclusive under concurrency; history and email protections kept.
5. Re-validate the acting member's authority inside every A2 membership-changing transaction (`lockActor`, used
   already by A2-A's profile update).
6. Verify the complete migration order before requesting any migration approval.

No merges, production migrations or deployments without separate approval. Existing grants and tenant isolation stay
unchanged unless a separately reviewed change is necessary.

## 13. A2-B as built (draft PR, 2026-11-16)

Branch `claude/project-thread-dyn16d`, on `main` after A2-A (#70), E1 (#64) and private-beta admission (#71).

### 13.1 Database: migration `20261205000000_membership_lifecycle` and privileged `005_member_emails.sql`

| Change | Detail |
|---|---|
| `memberships.suspended_at`, `suspended_by` | nullable; CHECK `memberships_suspension_consistent` (set exactly while SUSPENDED); trigger `memberships_stamp_suspension` stamps `suspended_at` when only the status is set and clears both on ACTIVE (so tooling that sets only the status still satisfies the CHECK); `GRANT UPDATE` on both to `bos_app` |
| `invitations_open_email_key` | partial unique `(business_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL` (G3) |
| `memberships_keep_an_owner` | now takes `pg_advisory_xact_lock(hashtextextended('memberships.owners:' || business_id, 0))` before counting (G1); refuses an owner change under REPEATABLE READ |
| `memberships_no_self_role_change` | now BEFORE UPDATE **or DELETE**; with a session user: no self status change (G14); only self role change is OWNER → ADMIN while ACTIVE; only an ACTIVE OWNER may promote to OWNER (invariant 2) or change/delete an OWNER row other than their own; without a session user `bos_app` may not touch an owner row |
| `app_private.member_emails()` (005) | SECURITY DEFINER, no parameters; reads `app.business_id`/`app.user_id`; returns `(user_id, email)` for the business's memberships only if the session user is an ACTIVE OWNER/ADMIN/MANAGER; one added `bos_definer` read policy for the current business's memberships (only active when a business context is set) |
| `accept_invitation` (001, in place) | the row lookup also states `revoked_at IS NULL AND expires_at > now()` (already enforced by the definer policies; now explicit beside the `FOR UPDATE`) |

RLS on memberships and invitations, and every existing grant, are unchanged. No data backfill (no suspended rows or
duplicate open invitations exist in production).

**Deviations from §4, for audit:**
- §4 proposed a row lock on `businesses`; built with a per-business **transaction advisory lock** instead (same
  pattern as Projects and Scheduling). Reason: a `FOR UPDATE`/`NO KEY UPDATE` on the business row needs an UPDATE
  grant for whichever role deletes the membership, waits behind every tenant insert's FK `KEY SHARE`, and would
  serialise with profile edits. The advisory lock is released only after the holder's commit is visible, and the
  count that follows is a new statement with a new snapshot, so the second commit sees the first.
- §4 proposed `invitations.last_sent_at`; not added. Resend is revoke-and-reissue, so the open row's `created_at` **is**
  the last send time; the 60 s throttle reads it under the row lock.

### 13.2 API

| Method and path | Key | Notes |
|---|---|---|
| `GET /members` | members:read | adds `suspendedAt`; `email` only for members:invite holders (D-A2-11) |
| `PATCH /members/{id}` | members:manage | `{ role }` or `{ status: ACTIVE \| SUSPENDED }`; making an OWNER needs an ACTIVE target (409 `member_not_active`) |
| `DELETE /members/{id}` | members:manage | now also stops held mailboxes and audits lost shared-mailbox access |
| `POST /members/{id}/transfer-ownership` | members:manage + OWNER | `{ stepDown, confirm: true }`; ACTIVE target, not self, not already OWNER (409 `already_owner`) |
| `POST /membership/step-down` | business:read + OWNER | `{ confirm: true }`; 409 `last_owner` without another active owner |
| `POST /membership/leave` | business:read | `{ confirm: true }`; 409 `last_owner` for the last active owner |
| `POST /invitations` | members:invite | 409 `invitation_exists` / `already_member`; response adds `delivery: sent \| failed` |
| `POST /invitations/{id}/resend` | members:invite | revoke + reissue; 429 within 60 s; 409 `invitation_closed` if accepted/revoked |
| `DELETE /invitations/{id}` | members:invite | conditional; 409 `invitation_closed` when acceptance won |

Every membership-changing service locks the actor (`lockActor`, FOR SHARE) and then the target (FOR UPDATE) and uses
the roles read **after** the locks (requirement 5). These routes opt in to `retryOnConflict` (up to 3 attempts on
40P01/40001; the whole unit of work rolled back, email is sent once after the committed attempt).

### 13.3 Mailbox credentials (requirement 3, C2 review)

`revokeHeldConnections(db, actorUserId, userId, cause, remainingRole)` in `communications/server/credentials.ts`:
locks the person's ACTIVE held connections `ORDER BY id FOR UPDATE`, stops each one whose kind they no longer have
authority for (shared rule `holderKeepsAuthority`, also used by the sync claim) and audits
`communications.connection.holder_departed` as the acting member. Called on removal, suspension, leaving and every
role change (demotions that keep authority, such as OWNER → ADMIN, stop nothing). `markReauthRequired` keeps its
system audit for C2 paths. `mail_connection_members` rows stay on suspension; on removal/leave each is audited as
`communications.member.revoked` before the cascade. Out of scope (C2-B3): re-checking lease and ACTIVE state before
every provider call.

### 13.4 Tests (`tests/integration/membership-lifecycle.test.ts`, 29)

- Last owner: demote/demote, remove/remove, suspend/suspend, suspend/remove and self step-down/step-down, each with
  two connections committing together (exactly one commits); the §6.1 reproduction (second check blocks, then
  fails); REPEATABLE READ refused; API races (two owners demoting each other; transfer + step-down + suspension).
- Actor re-check: an admin demoted while their request waits gets 403; a target promoted mid-request is re-read.
- Database actor rules: invariant 2, owner protection, self status, suspension CHECK, no session user.
- Invitations: one open per address (sequential and concurrent), `already_member`, expired replaced with history,
  resend (old link dies, throttle, rank rule, no token in audit), accept-vs-revoke both orders with lock waits, and
  fired together.
- Mailbox cutoff: removal, suspension (shared rows kept), reactivation, removal cascade audit, demotion of PERSONAL
  and BUSINESS holders, OWNER → ADMIN unaffected, and removal racing `failSyncJob` plus an in-flight refresh store
  (deadlock resolved by retry, no credential survives, a late fenced store writes nothing).

Existing test changed: `tenancy.test.ts` "keeps at least one owner" deleted the remaining owner's row while the
session user was the former owner (now a MEMBER). The new owner-protection rule refuses that before commit, so the
test now acts as the remaining owner, which still proves the commit-time last-owner check.

### 13.5 Migration order (verified 2026-11-16 against `main` and open PRs)

`main`: … `20261130000000_finance_catalog`, `20261201000000_communications_erasure` (+ `004`),
`20261202000000_business_profile`, then P3-A `20261204000000_people_leave_policies` (applied to production
2026-11-16 11:21 UTC; PR 68 merging). This PR was re-stamped from `20261203000000` to
**`20261205000000_membership_lifecycle`** so it sorts after every production-applied migration (no out-of-order
apply) + `005_member_emails.sql`. F7-B (#69), #71, #66 and #74 added no Prisma migration. Re-read production
`_prisma_migrations` before the apply; re-stamp again if anything newer lands first. Production apply (needs Regan's
approval): fresh Neon recovery branch → `prisma migrate deploy` → `pnpm db:privileged` (re-applies 001–005
idempotently; 001 changes `accept_invitation`) → verify → then merge.
