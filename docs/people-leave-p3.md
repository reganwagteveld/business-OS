# People P3: Leave Management (audit, staged plan, decisions, P3-A)

> Status: **P3-A released 2026-11-16.** Migration `20261204000000_people_leave_policies` applied to production
> 11:21 UTC (§6), then PR #68 merged.
> Regan approved D-P3-1 and D-P3-2 to D-P3-11 on 2026-11-16 (review on PR #68). That approval does not
> cover D-P3-12 onward, the migration or merging. Decisions for later stages (§3.2) are proposals only;
> nothing for P3-B to P3-E is built.

## 1. Architecture audit (main at 15f7746, 2026-11-16)

| Area | Finding | Consequence for P3 |
|---|---|---|
| People P1/P2 | Employees are not users. `people_employees` has an optional `user_id` link to an active member (grants nothing). Effective-dated department and manager assignments, append-only status history, `ON_LEAVE` is only a status. P2 is client-only on this API. | Leave references employees by composite `(business_id, employee_id)` FK; no employee fields are copied. Self-service (P3-B) must go through the existing `user_id` link, not a new identity. `ON_LEAVE` stays a manual employment status, separate from leave requests. |
| Permissions | `people:read` (OWNER, ADMIN, MANAGER), `people:read_sensitive`, `people:manage`, `people:configure` (OWNER, ADMIN). MEMBER has no People access. The reporting line grants nothing (no record-scoped rules). | P3-A needs no new key. P3-B needs self-service and approver rules, which are the first record-scoped rules in People: an owner decision (D-P3-12, D-P3-13). |
| Time | Businesses have an IANA `time_zone`; People effective dates are business calendar dates (`businessToday`), never in the future. Locations have no time zone. | Leave dates are calendar dates in the business time zone (D-P3-18). Per-location time zones would be a People change, not assumed. |
| Scheduling S1/S2 | Business-wide calendars, events, resources (`PERSON`, `ROOM`, …). PERSON resources are standalone (D-S2-1): no employee link, and `people-boundaries.test.ts` forbids Scheduling reading People. Private events and busy-only privacy (ADR 0006 §4–§7) are **not built**. Conflicts show event titles to every `scheduling:read` holder. | Leave must not be written into Scheduling until P3-E is approved: a leave event today would expose its title (and so possibly a reason) to everyone. The People-owned link path in `docs/scheduling-s2.md` §9 is the integration boundary. |
| Concurrency patterns | Optimistic `version` with conditional `updateMany`; guard triggers forcing version +1; `FOR SHARE` on referenced rows vs `FOR UPDATE` on archive; one-open-row unique indexes; ordered locks (ADR 0007, ADR 0008); deterministic race tests via `pg_blocking_pids`; pooler re-runs in CI. | P3-A reuses all of these. The P3-C balance ledger will lock one balance row per employee and leave type (`FOR UPDATE`) so two approvals cannot overspend (D-P3-20). |
| Reusable pieces | Route wrapper (`tenantRoute`), cursor helpers bound to filters (F7-A), audit with references only, `effectiveDateOf`, People org-unit and assignment patterns, Finance F7-A catalog lifecycle (active/inactive + archive/restore). | Used as-is. No new shared component. |
| Open PRs and migrations | Main's newest migration: `20261130000000_finance_catalog`. Open: PR 64 Communications E1 (`20261201000000_communications_erasure`); `20261202000000` and `20261203000000` are reserved for other open work, PR 66 Neon housekeeping (no new migration), PR 53 and 48 (docs/tooling). | P3-A migration `20261204000000_people_leave_policies` sorts after all of them and depends on none. Shared files touched: `tenancy.prisma` (four relation lines), `people.prisma` (one back-relation), `routes.ts` (error maps), `errors.ts`, `app-client.ts`, `contracts/src/index.ts`, `api-v1.json`, `ci.yml` (one step). Expect trivial merge conflicts only. |

## 2. Staged plan

Each stage: own branch, own draft PR, own tests, ChatGPT audit, owner approval before merge, migration applied separately with Regan's approval.

| Stage | Scope | Depends on | Migration |
|---|---|---|---|
| **P3-A** (this PR) | Leave types, leave policies (rules), policy revisions, effective-dated policy assignment to employees. Config API only, no UI. | — | `20261204000000_people_leave_policies` |
| **P3-B** | Requests and approvals: submit, withdraw, approve, reject, cancel after approval; append-only transition history; overlap, notice, backdating, waiting-period and balance checks; deduction and reversal through the ledger under its lock. Self-service through the `user_id` link. | P3-A, P3-C, D-P3-12 to 19 | new |
| **P3-C** | Balance ledger and accrual foundation: append-only ledger (opening balance, grant, accrual, deduction, reversal, adjustment, carry-over, expiry), one locked balance row per employee and type, as-of-date balances, explicit idempotent accrual run (no cron). | P3-A, D-P3-20/21 | new |
| **P3-D** | Leave UI in the People Zone (Sonnet, on the established contracts): My Leave, Request Leave, Balances, Team Requests, Approval Queue, Leave Calendar, Leave Types & Policies. Role-aware tabs. | P3-A to C, D-P3-24 | none |
| **P3-E** | Scheduling integration (separate privacy and architecture approval first). | P3-B, Scheduling private/busy-only work, D-P3-23 | new |

**Recommended order change (D-P3-1):** build P3-C (ledger) before P3-B (requests), keeping the names. Approval is the moment that deducts a balance, and the "two approvals must not overspend" guarantee lives in the ledger's lock. Building requests first would mean either shipping approvals without balances or building a throwaway check that P3-C then replaces.

## 3. Decisions

### 3.1 P3-A (approved by Regan, 2026-11-16)

| # | Decision | Default built |
|---|---|---|
| D-P3-2 | Who configures leave | No new keys. View: `people:read`. Types and policies: `people:configure` (OWNER, ADMIN). Assigning policies to employees: `people:manage` (OWNER, ADMIN). |
| D-P3-3 | How employees get a policy | Explicit, effective-dated assignment (one current policy per employee per leave type), in batches of up to 100, all or nothing. No automatic eligibility rules (by employment type, location or country) yet. |
| D-P3-4 | Rule vocabulary | Unit DAYS or HOURS (fixed per policy); granularity full/half day, or hour/half/quarter hour; entitlement NONE (no balance), GRANT (amount per leave year) or ACCRUAL (annual amount accrues weekly, fortnightly or monthly); leave year calendar, anniversary or custom day (no 29 February); carry-over none, unlimited or capped; optional maximum balance; negative balance limit (0 = never negative); requires approval; minimum notice days; backdating allowed; waiting period days; optional country label. **Not included:** statutory presets, accrual by hours worked (needs timesheets), carry-over expiry dates, payout on termination, pay calculations. |
| D-P3-5 | Changing a policy in use | Rules stay editable; the database appends a revision (the full rule set) for every version, so later stages know which rules applied when. Leave type and unit can never change (create a new policy instead). Proposed for P3-C: rule changes apply from the change date forward, never recalculating past ledger entries. |
| D-P3-6 | Default leave types | Nothing is seeded. Contracts export a starter list (names, categories, paid and sensitive flags; **no entitlement numbers**) a client can offer as "add the usual types". |
| D-P3-7 | Sensitive types | A per-type `sensitive` flag, defaulting to on for sick, personal, carer, compassionate and parental. It drives privacy in P3-B, P3-D and P3-E (notes and type hidden from people without access). |
| D-P3-8 | Termination | Assignments stay open as history; no new assignment while terminated; rehire allows them again. P1 lifecycle code is unchanged. What happens to a balance at termination is a P3-C decision (no payout calculation). |
| D-P3-9 | Effective dates | Business calendar date, default today, never in the future (as P1); a replacement or end cannot precede the current assignment's start. |
| D-P3-10 | Business purge | Leave rows cascade with the business, as every People table (PD-9). Nothing else deletes them. |
| D-P3-11 | Migration | `20261204000000_people_leave_policies`, additive, no privileged SQL. |

### 3.2 Later stages (proposals; need approval before that stage is built)

| # | Question | Recommendation |
|---|---|---|
| D-P3-1 | Stage order | **Approved 2026-11-16.** Build P3-C (ledger) before P3-B (requests) (§2). |
| D-P3-12 | Who is "the employee" when someone requests leave | The signed-in user linked to the employee record (`user_id`). New keys: `people:leave_self` (every role, own leave only), `people:leave_approve` (MANAGER and up), `people:leave_manage` (OWNER, ADMIN: any employee, on behalf, balance adjustments, overrides). MEMBER gains self-service only, not the directory. |
| D-P3-13 | Who approves | The employee's current line manager (P1 reporting line) when that manager is linked to an active member holding `people:leave_approve`. Otherwise (no manager, manager unlinked or terminated) the request goes to `people:leave_manage` holders. This is the first record-scoped rule in People. |
| D-P3-14 | Self-approval and overrides | Nobody approves their own request. A `people:leave_manage` holder may decide any request, recorded as an override. Exception for a business with no other approver (sole owner): self-approval allowed and flagged in the audit. |
| D-P3-15 | Delegated approval | Not in P3-B. Admin fallback covers absence; delegation later. |
| D-P3-16 | State machine | `PENDING → APPROVED | REJECTED | WITHDRAWN`; `APPROVED → CANCELLED` (by approver or admin; by the employee before the leave starts, if the policy allows). Policies without approval are approved on submit. Every transition is an append-only row with actor and version; requests are never deleted. |
| D-P3-17 | Counting days and hours | Business work week (default Monday to Friday, configurable), per-employee override later. Public holidays: a business-maintained holiday list (optionally per location) in P3-B, no built-in national calendars. HOURS policies take explicit hours per day. |
| D-P3-18 | Time zone of leave | Calendar dates in the business time zone; partial days as hours, not instants. Per-location time zones only if People adds them. |
| D-P3-19 | Overlaps | No two pending or approved requests may overlap for one employee, any type, except morning and afternoon halves of the same day. |
| D-P3-20 | Balance safety | One balance row per employee and leave type, locked `FOR UPDATE` by every deduction; the policy's negative limit is checked under that lock. Deduct on approval; pending requests are shown as "requested" and checked again at approval. |
| D-P3-21 | Accrual | An explicit, idempotent "accrue up to date" operation (run on balance read and before approval), no scheduler. Part-time pro-rating via separate policies or manual adjustments, not automatic. |
| D-P3-22 | Privacy | For sensitive types, notes and the type name are visible only to the employee, their approver and `people:read_sensitive` holders; everyone else sees "Away". No attachments or medical documents in P3. |
| D-P3-23 | Scheduling (P3-E) | People-owned `employee_id` on PERSON resources (S2 §9), one-way busy-only blocks with no leave type or notes, retry from an outbox, sync disabled until private/busy-only Scheduling is built and approved. |
| D-P3-25 | Which rules govern a past date | §4.7: each revision gets a business calendar date it takes effect from; every ledger entry records the policy version it used and is never recalculated. Gate for P3-C. |
| D-P3-24 | Navigation | Leave as tabs inside People. MEMBER sees only My Leave. Needs People to open for self-service holders without `people:read`. |

## 4. P3-A specification

### 4.1 Tables

| Table | Purpose |
|---|---|
| `people_leave_types` | Name (unique among current types, ignoring case), description, neutral category (`ANNUAL`, `SICK`, `PERSONAL`, `CARER`, `UNPAID`, `COMPASSIONATE`, `PARENTAL`, `STUDY`, `OTHER`), paid flag (informational), sensitive flag, `ACTIVE`/`INACTIVE`, archive. |
| `people_leave_policies` | The rules (§3.1 D-P3-4) for one leave type. Name unique among current policies. `ACTIVE`/`INACTIVE` (inactive = kept for current assignments, not assignable), archive. Amounts `numeric(9,4)` in the policy's unit. |
| `people_leave_policy_revisions` | Append-only: the full rule set at each version (JSON), who changed it, when. Written by the database. |
| `people_leave_policy_assignments` | Effective-dated `[starts_on, ends_on)`: which policy governs an employee's leave of one type. One open row per employee and type. Composite FK on `(business_id, policy_id, leave_type_id)` so a row cannot pair a policy with another type. |

### 4.2 Guards (SQLSTATE class PE)

- Types and policies: identity fixed; policy leave type and unit fixed (PE004); version advances by exactly one (PE009); archived rows read-only, archive changes nothing else (PE010); archive refused while in use (type with a current policy, policy with a current assignment: PE008); a policy is created or restored only under an unarchived type (PE007). Times and archive stamps come from the database.
- Every rule combination is a CHECK, matching `leavePolicyProblems` in the contracts.
- Revisions: inserted by an `AFTER` trigger on policies; the revision guard derives the rules and author from the policy row itself and requires the policy's current version, so a revision cannot be forged, written ahead, rewritten (no UPDATE grant, PE004) or deleted.
- Assignments: created open, closed once (PE004); the employee must not be terminated (PE006) and the policy must be active (PE012) and not archived (PE007); a new row cannot overlap the employee's history for that type (PE011).
- Least privilege: `bos_app` has no DELETE or TRUNCATE on any leave table and no UPDATE on identity, type, unit or creation columns. Forced RLS with the standard tenant policy on all four.

### 4.3 API (all under `/api/v1/b/:slug/people`)

| Method and path | Permission |
|---|---|
| `GET /leave-types?q&status&category&cursor&limit`, `GET /leave-types/:id` | `people:read` |
| `POST /leave-types`, `PATCH /leave-types/:id`, `POST /leave-types/:id/archive`, `/restore` | `people:configure` |
| `GET /leave-policies?q&leaveTypeId&status&cursor&limit`, `GET /leave-policies/:id`, `GET /leave-policies/:id/revisions`, `GET /leave-policies/:id/assignments?include` | `people:read` |
| `POST /leave-policies`, `PATCH /leave-policies/:id`, `POST /leave-policies/:id/archive`, `/restore` | `people:configure` |
| `POST /leave-policies/:id/assignments` `{ employeeIds[≤100], effectiveDate? }` | `people:manage` |
| `GET /employees/:id/leave-policies` | `people:read` |
| `POST /employees/:id/leave-policies/end` `{ leaveTypeId, effectiveDate? }` | `people:manage` |

Errors: `400 invalid_input`/`invalid_query`/`invalid_cursor`, `invalid_policy` (with a plain message), `invalid_leave_type`, `future_effective_date`, `effective_date_order`; `409 stale`, `duplicate_name`, `archived`, `not_archived`, `archived_reference`, `inactive_reference`, `in_use`, `terminated`, `not_assigned`; another business's id is `404`. Cursors are bound to their list and filters (as F7-A). No DELETE endpoint.

### 4.4 Assignments

Assigning a policy closes the employee's current policy of the same type at the effective date and opens the new one on it; an employee already on that policy is left unchanged. Ending an assignment closes it without a replacement. Neither changes the employee record or its version.

### 4.5 Lock order

Policy row `FOR SHARE` → employee rows `FOR SHARE` in ascending id order → assignment rows. Archiving a policy takes its row `FOR UPDATE`; terminating takes the employee row; archiving a type takes the type row `FOR UPDATE` against policy creation's `FOR SHARE`. No path takes these in the opposite order. Racing assignments for the same employee and type are settled by the one-open-row index (`409 stale`, nothing written).

Ending an assignment takes the same locks in the same order (employee `FOR SHARE`, then the open row). An end and an assignment (or two ends) of the same employee and type race on the open row itself: each closes it with a conditional update (`ends_on IS NULL`), so whichever commits first wins and the other blocks on the row, finds it closed and gets `409 stale` with nothing written and no audit entry. The order is therefore serial and visible: an end never reports success while a replacement it did not see stays open, and an assignment never starts on top of a row someone else just closed. The client re-reads and retries. Same-day races leave a zero-length `[d, d)` row, which is allowed. Three deterministic tests stage each order (§5).

### 4.6 Audit

| Action | Target | Metadata |
|---|---|---|
| `people.leave_type.created` / `.archived` / `.restored` | type | `category` |
| `people.leave_type.updated` | type | `fields`, `statusFrom`/`statusTo` |
| `people.leave_policy.created` | policy | `leaveTypeId`, `unit`, `entitlementMethod` |
| `people.leave_policy.updated` | policy | `leaveTypeId`, `fields`, `statusFrom`/`statusTo` |
| `people.leave_policy.archived` / `.restored` | policy | `leaveTypeId` |
| `people.leave_policy.assigned` | employee | `policyId`, `leaveTypeId`, `effectiveDate`, `replacedPolicyId` |
| `people.leave_policy.unassigned` | employee | `policyId`, `leaveTypeId`, `effectiveDate` |

Never names, descriptions or amounts (a test checks this). The full rule history is in the revisions table, readable with `people:read`.

### 4.7 Which rules govern a past date (gate for P3-C, D-P3-25)

Revisions carry `recorded_at` (an instant), not a calendar date, and the business time zone can change later, so P3-C must not derive "which rules applied on day D" from `recorded_at` at read time. Proposed rules, to be built in P3-C's migration and approved before it starts:

1. **Effective date of a revision.** Add `effective_from DATE` to `people_leave_policy_revisions`, written by the database trigger as the business-local date at the moment of recording, and never changed. Revisions cannot be backdated or future-dated (as for assignments, D-P3-9). Existing rows are filled from `recorded_at` in the business's time zone when that migration runs; no business has leave data yet, so this is exact in practice.
2. **Rules in force on day D** for an employee = the policy of their assignment covering D (`starts_on <= D < ends_on`), at its highest version whose `effective_from <= D`. Several edits on one day: the last one governs that whole day.
3. **Every ledger entry is immutable and records `policy_id` and `policy_version`.** Posted entries are never recalculated or edited; a correction is a new, audited adjustment entry. A rule change only affects entries posted after it.
4. **Accrual** ("accrue up to date", D-P3-21) posts one entry per completed period, using the rules in force on the period's last day. Catching up late gives the same result as running on time, because revisions are never backdated. A period split by an assignment change accrues per assignment, pro rata by days in each.
5. **Grants** for a leave year use the rules in force on the year's first day (or the assignment's start, if later). A mid-year edit does not regrant the current year; a change to the leave year start takes effect from the next boundary under the new rules.
6. **Approvals and backdated leave** (P3-B) deduct on the approval date, checking the negative limit and maximum balance with the rules in force on that date. Leave dates in the past (`allow_backdated`) do not reopen older rules. Counting days and hours uses the rules in force on approval, and the count is stored on the entry.
7. **No legal rule is inferred** from `country_code` or anything else; every number comes from the business's own policy.

**What P3-C must test before approvals ship (P3-B):** negative-balance limits under the ledger lock; idempotent "accrue up to date" (running it twice, or late, posts nothing extra); leave-year boundaries (calendar, anniversary, custom start; carry-over and caps at the boundary); rule changes mid-period and mid-year per the rules above; assignment changes mid-period; and parallel deductions against one balance (deterministic races, as in P3-A).

**What P3-A does not do (second audit, 2026-11-16):** the `paid` flag and `country_code` are descriptive labels only. They are not statutory compliance, payroll or pay calculations, and no jurisdictional entitlement or automatic leave right follows from them. The `sensitive` flag is stored in P3-A but enforced only when P3-B and P3-D show requests (D-P3-22); P3-A has no requests to hide.

## 5. Tests

- `apps/api/tests/integration/people-leave.test.ts` (37): permissions by key (including custom role sets); starter types and sensitive defaults; validation and unknown fields; name uniqueness, archive, restore; optimistic versions; list filters, paging and filter-bound cursors; untracked, granted, accruing and hourly policies; every invalid rule combination; fixed type and unit; clearing rules when switching to no balance; revisions; batch assignment, replacement, unchanged; effective dates in two time zones (Perth and New York) and history order; all-or-nothing batches; inactive and archived policies; termination and rehire; assignment paging; tenant isolation through every route and raw SQL under RLS; RLS, grants and DELETE inventory; guards on their own (PE004, 008, 009, 010, 011, CHECKs, composite FK); nine deterministic races (same-version edits, archive vs assign both ways, termination vs assign, two policies for one employee, type archive vs policy create, end vs same-day replacement in both orders, two ends at once); audit content; failed changes write nothing.
- `packages/contracts/tests/people-leave.test.ts` (3): the shared rule checker, starter types without numbers, strict create contract.
- `apps/api/tests/unit/people-boundaries.test.ts`: the leave tables are People tables (no other module may touch them); non-People contracts cannot carry leave fields.
- CI: the leave suite runs a second time behind PgBouncer in transaction mode.

Local results (Postgres 16, ICU en-US): leave suite 37/37; unit 134 (api) + 461 (app) + 27 (contracts) + 95 (ui) + 317 (root) passing; typecheck, lint (two existing warnings), boundaries, contract snapshot and migration check pass. Full integration and the pooler runs: see the PR.

## 6. Migration safety, rollout and rollback

- **Additive only:** four tables, indexes, CHECKs, five functions and their triggers, grants and RLS policies. No existing table, column or row changes. One transaction. No privileged SQL.
- **Order:** apply the migration just before merging (Vercel auto-deploys main), under the standing recovery-branch policy. A migrated-but-not-deployed state exposes nothing (no route uses the tables).
- **Migration gate (ChatGPT audit, 2026-11-16).** Each step needs Regan's separate, explicit approval; the design approval and the audit are not migration or merge approval:
  0. Last checked 2026-11-16 after merging `main` (1b2bf15, which includes E1 PR 64 and F7-B PR 69) into this branch: `main`'s newest migration is `20261201000000_communications_erasure` and its privileged files are 001–004; no conflict except the `Business` relation list in `tenancy.prisma` (resolved by adding the four leave relations to `main`'s list). On a fresh database the migrations apply in order, privileged SQL 001–004 applies, the migrations match the schema, and the full integration suite passes (717/717). `20261202000000`–`20261203000000` stay reserved for A2.
  1. At execution time, recheck the migration order against current `main` and production history (no pending migration other than this one, no later timestamp already applied, checksums match). Stop on any mismatch.
  2. Create and verify a fresh Neon recovery branch (standing policy; PITR is not a substitute).
  3. Apply `20261204000000_people_leave_policies` only with Regan's written go-ahead.
  4. Verify in production: the four tables have forced RLS and the tenant policy; `bos_app` has no DELETE or TRUNCATE and only the listed column UPDATEs; the guard triggers exist; a create, edit, archive and restore of a type and policy works through the API on a disposable test business (if Regan agrees to creating one), which is then archived.
  5. Merge only the checked head, with required CI green, and only with Regan's merge approval.
- **Production record (2026-11-16, approved by Regan in the P3-A thread):** preflight 11:19:52 UTC read-only: 21 migrations applied (through `20261202000000_business_profile`), no failed or rolled-back rows, no checksum mismatch, only `20261204000000_people_leave_policies` pending. Recovery branch `pre-p3a-migration` (`br-odd-star-bbn70rm9`) created 11:20:03 UTC from production at LSN 0/2CCF328. Applied 11:21:22–11:21:51 UTC with `prisma migrate deploy` from branch head 9aa6c6b (this migration only, no privileged SQL). Verified 11:22:10 UTC: 22 migrations, checksum matches; all four tables have RLS forced with `tenant_isolation`; `bos_app` has SELECT and INSERT, no DELETE, TRUNCATE or table UPDATE, column UPDATE only on types, policies and assignments; all five guard triggers present; zero rows. Merged after, on green CI.
- **Rollback:** revert the code; the tables are then unused. Dropping them is destructive and needs explicit approval; it is not needed to roll back.
