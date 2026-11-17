# People P3-B: leave requests and approvals (architecture specification)

> **Version 1.0 (P3-B-0), 2026-11-17. Status: proposed, documentation only.** This PR adds this file and a
> one-line pointer in [people-leave-p3.md](./people-leave-p3.md). No migration, route, contract, client code or
> production action. **P3-B is not implementation-ready**: its ledger dependency (P3-C) does not exist on
> `main` or in any open PR, and the security gates in §5.4 and §16 are unverified (see §5).
> Implementation packages B1 to B4 (§17) are **not authorised** until the ChatGPT architecture audit, Regan's
> decisions in §15.3 and the entry conditions in §17.
>
> **Base:** `main` at `84271b3` (2026-11-17). Every "verified" statement cites a file on that commit. Statements
> marked **(proposal)**, **(recommendation)** or **(assumption)** are not facts about the code.
>
> **Builds on:** [people-leave-p3.md](./people-leave-p3.md) (P3-A merged #68; D-P3-1..11 accepted; D-P3-12..25
> proposed), [people-data-model.md](./people-data-model.md) (P1), [scheduling-s2.md](./scheduling-s2.md) and
> [ADR 0008](./adr/0008-scheduling-ordered-lock-conflict-prevention.md), [notifications-n1-architecture.md](./notifications-n1-architecture.md),
> [settings-a3-architecture.md](./settings-a3-architecture.md), the Pixa identity
> [V2-B2](./ui/pixa-visual-identity-v2-b2.md) and the structure of [WF-1](./cross-zone-workflows-wf1.md).
> Nothing accepted is overridden silently: every change to an earlier proposal is listed in §15.2 with evidence.
>
> **Version 1.1 (2026-11-17)** after the ChatGPT architecture audit of `a4d68a0` (conditional design pass, not
> implementation-ready): (1) year-aware balance contract for P3-C with per-leave-year buckets, lock scope, carry-over,
> future-year availability and reversal attribution (§5.6, C-10, C-20, D-P3-50); (2) work-pattern changes inside a
> request counted per date, leave-year edge tests (§9.2a, T-39); (3) transition and occupancy provenance verified by
> the database from the session user, not from service-written claims (§6.8, D-P3-51); (4) notes protected by a
> data-derived restrictive RLS policy instead of a transaction flag, explicit race acceptance and tests (§12.2,
> D-P3-48 revised, T-28, T-29); (5) auto-approval runs the identical checks, with tests (§10.3, T-49a/b); escalation
> wording in §18.2 aligned with the protocol.
>
> **Version 1.2 (2026-11-17)** after the focused re-audit of `f11cdcf` (design audit pass with implementation gates):
> §10 wording aligned to `pending_actor_basis`; §5.6 states the `projectedOpening` no-double-count invariant and leaves
> multi-year reversal propagation and leap-day anniversaries for P3-C's spec. No design change.
>
> **Version 1.3 (2026-11-17)** after the owner decision record on #116 (posted through the ChatGPT connector,
> 10:11 UTC): **D-P3-45 accepted**; **D-P3-50 accepted as revised** — projected availability through the leave dates
> replaces the conservative proposal. Changed: §5.6 rules 3, 4 and new rule 8, C-04, C-14, C-20, C-21, new C-26,
> §9.6, §10.3, §15 (D-P3-42 superseded; new D-P3-52..54), tests T-59, T-60a. No other decision is accepted.
>
> **Consolidation note.** An earlier draft of this spec was opened as #115 from a separate local session. This
> version supersedes it and folds in its distinct findings: leave-year attribution (D-P3-45, a conflict with the
> D-P3-25 proposal), per-employee work patterns (D-P3-46), the "verified link" decision (D-P3-47), restrictive
> RLS on notes (D-P3-48) and Regan's escalation of B2/B3 as authorisation changes (§18.2).

## Contents

1. [Executive summary](#1-executive-summary)
2. [Owner decisions in force and how this design honours them](#2-owner-decisions-in-force-and-how-this-design-honours-them)
3. [Verified current-state inventory](#3-verified-current-state-inventory)
4. [Architecture overview](#4-architecture-overview)
5. [P3-C prerequisite verification checklist](#5-p3-c-prerequisite-verification-checklist)
6. [Data model](#6-data-model)
7. [Request lifecycle and state machine](#7-request-lifecycle-and-state-machine)
8. [Identity and approval authority](#8-identity-and-approval-authority)
9. [Policy engine: dates, duration and rules](#9-policy-engine-dates-duration-and-rules)
10. [Ledger integration and the approval transaction](#10-ledger-integration-and-the-approval-transaction)
11. [API contracts and permission matrix](#11-api-contracts-and-permission-matrix)
12. [Privacy](#12-privacy)
13. [Scheduling boundary](#13-scheduling-boundary)
14. [UI screen and component inventory](#14-ui-screen-and-component-inventory)
15. [Decision register](#15-decision-register)
16. [Test matrix](#16-test-matrix)
17. [Implementation packages B1 to B4](#17-implementation-packages-b1-to-b4)
18. [Migration plan, rollout and rollback](#18-migration-plan-rollout-and-rollback)
19. [Integration boundaries and risk register](#19-integration-boundaries-and-risk-register)

---

## 1. Executive summary

P3-B adds leave **requests** to the People Zone: an employee (through their verified member link) or an
administrator (on their behalf) asks for leave of one type over a range of business-local dates; the request is
routed to the employee's line manager or, failing that, to leave administrators; a decision approves (deducting
the balance through the P3-C ledger in the same transaction), rejects, or later cancels it (reversing the
deduction with a new ledger entry). Every state change is an append-only transition row written by the database.

The design in one paragraph:

- **People owns all of it.** New People tables only: a leave calendar (work week and holidays), requests,
  per-day occupancy rows, transitions and restricted notes. No other Zone reads them; Scheduling is given a
  read-through, busy-only projection later (P3-E), never a copy (§13).
- **Correctness lives in PostgreSQL.** Overlaps are refused by a partial unique index on per-day occupancy
  rows (no extension, no exclusion constraint, consistent with ADR 0008); transitions are written by a
  trigger so history cannot be forged; versions advance by exactly one; approval locks the request row, then
  the People rows in P3-A's order, then the P3-C balance bucket of the leave year, and deducts under that lock.
- **Authority is server-side and record-scoped**, the first record-scoped rule in People: the approver is
  resolved at decision time from the reporting line, membership status and permission keys; nobody decides
  their own request except under a narrow, explicit, audited sole-owner rule (§8.4).
- **Privacy is structural:** notes live in a separate table selected only after an authority check; sensitive
  types are shown as "Away" to everyone else, and once a request is sensitive it stays sensitive (§12).
- **One conflict must be settled before P3-C is built (D-P3-45):** the D-P3-25 proposal deducts on the
  approval date, which charges leave booked in a *later* leave year against the current year's balance. P3-B
  proposes attributing each deduction to the leave year of the leave dates and refusing requests that cross a
  leave-year boundary. This changes the ledger design, so it is a P3-C input.
- **Blocked on P3-C.** P3-C (the balance ledger) has no branch, PR, migration or approved decision set today
  (§3.6). B1 (calendar and duration engine) can proceed in parallel with P3-C if Regan agrees (D-P3-40); B2 to
  B4 cannot start until P3-C is merged, applied and checked against §5.

---

## 2. Owner decisions in force and how this design honours them

Accepted by Regan on 2026-11-16 (PR #68 review); binding on this design.

| Id | Decision | How P3-B honours it |
|---|---|---|
| D-P3-1 | P3-C ledger before P3-B approvals | No approval, rejection-with-balance or cancellation path is built before P3-C is merged and applied. B1 has no ledger dependency and is the only package proposed to run in parallel (D-P3-40). |
| D-P3-2 | No new keys for configuration; view `people:read`, configure `people:configure`, assign `people:manage` | Work week and holidays reuse `people:configure` (they are configuration). New keys appear only for requests and approvals, as D-P3-12 proposed. |
| D-P3-3 | Explicit, effective-dated assignment, one current policy per employee and type | A request needs one assignment of its type covering every requested date (§9.5); nothing infers eligibility. |
| D-P3-4 | Rule vocabulary (unit, granularity, notice, backdating, waiting period, negative limit, requires approval …) | The policy engine (§9) uses exactly these fields and adds no rule field to policies. |
| D-P3-5 | Rules editable; DB appends a revision per version; type and unit fixed | Requests record `policy_id` and `policy_version`; approval uses the rules in force on the approval date (D-P3-25 rule 6, still proposed). |
| D-P3-6 | Nothing seeded | No default calendar rows, holidays or requests are seeded. A business without a calendar row uses the documented default (Monday to Friday, §6.1). |
| D-P3-7 | Per-type `sensitive` flag | Drives every redaction in §12; the flag is snapshotted onto the request and can only tighten (D-P3-43). |
| D-P3-8 | Termination keeps assignments; balance at termination is a P3-C decision | Terminated employees cannot submit or be approved; existing requests stay (§7.4, D-P3-41). |
| D-P3-9 | Effective dates: business calendar date, never in the future | Applies to configuration (assignments, calendar edits). Leave **dates** are a different thing and may be in the future; see §9.1. |
| D-P3-10 | Cascade with the business purge | All new tables cascade with `businesses` like every People table; nothing else deletes them. |
| D-P3-11 | P3-A migration additive, no privileged SQL | P3-B's migrations are additive and need no privileged SQL either (§18). |

Also binding: tenant isolation rules (CLAUDE.md, ADR 0004), ADR 0007/0008 concurrency patterns, the delegated
approval policy in `docs/agent-task-protocol.md` "Approvals", D-S2-1 (PERSON resources standalone), the N1
`PEOPLE` notification class rule (no record text), and D-V2B2-1..8 (Direction A "Ledger", no pills).

---

## 3. Verified current-state inventory

### 3.1 People P1/P2 (verified)

- `people_employees.user_id` is an optional composite FK to `memberships (business_id, user_id)`, unique per
  business (`20261118000000_people/migration.sql:200,283`). Linking grants nothing (`people-data-model.md` §2.1).
- Removing a member clears the link, bumps the employee version and audits it
  (`modules/people/server/members.ts`, called from `tenancy/server/members.ts` `departMember`).
- **Suspending** a member (A2-B, `tenancy/server/members.ts` `setMemberStatus`) does **not** clear the link;
  the member simply cannot reach the business (`my_memberships` ignores `SUSPENDED`). P3-B must therefore check
  membership status explicitly when resolving approvers (§8.2).
- Manager assignments are effective-dated `[starts_on, ends_on)` with a no-cycle guard under a per-business
  advisory lock; an employee cannot manage themselves (CHECK). Being a manager grants nothing today.
- Employment status `ON_LEAVE` is a manual status, unrelated to leave requests (`people-data-model.md` §3). P3-B
  does not change it (§19).

### 3.2 People P3-A (verified on `main`, migration `20261204000000_people_leave_policies`)

- Tables `people_leave_types`, `people_leave_policies`, `people_leave_policy_revisions`,
  `people_leave_policy_assignments`; SQLSTATEs PE001–PE012 in use (`app/api/_lib/routes.ts:51-54`).
- Policy fields (`packages/contracts/src/people-leave.ts:91-101`): `unit` DAYS|HOURS, `granularity`
  FULL_DAY|HALF_DAY|HOUR|HALF_HOUR|QUARTER_HOUR, `entitlementMethod` NONE|GRANT|ACCRUAL, `negativeBalanceLimit`,
  `maxBalance`, `requiresApproval`, `minimumNoticeDays`, `allowBackdated`, `waitingPeriodDays`.
  **There is no "employee may cancel" rule field** (relevant to D-P3-16, §15.2).
- The type's `sensitive` flag is **editable** after creation (`UpdateLeaveTypeRequest`, same file line 58).
- Revisions carry `recorded_at` only; **no `effective_from`** (D-P3-25 proposed, not built). Confirmed in the
  migration file on `main`.
- P3-A lock order: policy `FOR SHARE` → employee rows `FOR SHARE` (ascending id) → assignment rows
  (`people-leave-p3.md` §4.5).

### 3.3 Access and routing (verified)

- Permission keys are fixed per role in `modules/access/server/permissions.ts`. People has four keys; MEMBER has
  none. `can()` ignores its `resource` argument today: there is no record-scoped rule anywhere.
- `tenantRoute` accepts exactly **one** `permission` (`app/api/_lib/routes.ts:236-240`). There is no any-of
  option. WF-1B-1 (#110) proposes an all-of helper in the same file (§19, conflict note).
- The client registry opens a Zone only when the caller holds **every** key in `requires`
  (`packages/app/src/shell/registry.ts:119`); People requires `people:read`, so a MEMBER cannot open People.
- `retryOnConflict` exists for handlers whose whole unit of work is inside the transaction (A2-B).

### 3.4 Scheduling (verified)

- S2 PERSON resources have no employee link (D-S2-1). `people-boundaries.test.ts` forbids other modules from
  reading People tables. Private and busy-only events (ADR 0006 §4–§7) are not built; every `scheduling:read`
  holder sees event titles in conflicts (`scheduling-s2.md` §4.1).
- Conflict prevention uses globally ordered locks (ADR 0008); every future write path must follow it.

### 3.5 Notifications, settings, search (verified docs)

- N1 is architecture only (#80 merged); it reserves `people.leave.submitted|decided|withdrawn` with class
  `PEOPLE` (ids and enums only) and a `people.leave.approver` resolver (`notifications-n1-architecture.md`
  lines 165, 196-198, 312). No notification runtime exists.
- A3 Settings links to Zone-owned configuration and never re-implements it (D-A3-2); leave configuration stays
  in People.
- Global search (GS1) indexes no People leave data; P3-B must not add leave to the index (§12).

### 3.6 P3-C and migrations (verified on GitHub and `main`, 2026-11-17 09:10 UTC)

| Item | State |
|---|---|
| P3-C branch, PR or doc | **None.** No open PR, no remote branch, no ledger table, no `leave_balance`/`leave_ledger`/`leave_request` table on `main`. `active-workstreams.md` (snapshot 2026-11-16) records "P3-C needs decisions D-P3-20/21/25". |
| D-P3-20, 21, 25 | Proposed only (`people-leave-p3.md` §3.2, §4.7). |
| Newest migration on `main` | `20261205000000_membership_lifecycle` (23 migrations). |
| Stamps in open PRs | `20261206000000_search_indexes` (#97), `20261207000000_workflow_links` (#110). |
| Production `_prisma_migrations` | **Not freshly read** (cloud threads have no production access; the Mac read was not run, see the PR). Last recorded: 23 applied through `20261205000000` (`migration-readiness.md` §9); a later Mac note (07:11 UTC, unverified here) says 24, including `20261206000000_search_indexes` ahead of #97's merge. Treat as **unverified** until a fresh read-only check. |

### 3.7 Gap summary

P3-B needs, and nothing on `main` provides: a work week and holiday list; a duration calculator; request,
occupancy, transition and note tables; record-scoped approver resolution; an any-of route option and any-of
Zone gating; the four new permission keys; the P3-C ledger API; and leave UI. Reusable as-is: composite tenant
FKs, forced RLS, PE-class guard triggers, `version` guards, DB-written history (P3-A revisions), cursor helpers,
audit with references only, deterministic race tests with `pg_blocking_pids`, PgBouncer re-runs in CI.

---

## 4. Architecture overview

### 4.1 Module view

```
packages/contracts/src/people-leave-requests.ts   (new: DTOs, error codes, shared duration engine)
apps/api/src/modules/people/server/
  leave-calendar.ts        B1  work week + holidays (people:configure)
  leave-duration.ts        B1  pure: dates × calendar × policy → per-day amounts (also used by the client estimate)
  leave-authority.ts       B2  who is the employee (self link), who may decide (approver resolution), sole-owner rule
  leave-requests.ts        B2  submit, withdraw, reads, privacy projections
  leave-decisions.ts       B3  approve, reject, cancel; ledger calls; idempotency
  leave-busy.ts            P3-E only (not P3-B): busy-only projection for Scheduling
apps/api/src/modules/people/server/leave-ledger*.ts   P3-C (prerequisite; interface in §5)
apps/api/src/app/api/v1/b/[slug]/people/{me/leave,leave-requests,leave-calendar,holidays,...}  routes
packages/app/src/zones/people/leave/*              B4 UI
```

No new module: leave is People (people-boundaries test keeps everyone else out).

### 4.2 Data view

```
people_employees ─┬─< people_leave_policy_assignments >── people_leave_policies ──< people_leave_policy_revisions
                  │                                                    │
                  ├─< people_leave_requests >──────────────────────────┘ (business_id, policy_id, leave_type_id)
                  │        │ ├─< people_leave_request_days      (occupancy; unique active (employee, date, part))
                  │        │ ├─< people_leave_request_transitions (DB-written, append-only)
                  │        │ └─< people_leave_request_notes     (restricted, append-only)
                  │        └── ledger entry ids  ──> P3-C people_leave_ledger_entries (deduction, reversal)
                  └─< P3-C people_leave_balances (one per employee × type; locked FOR UPDATE)
people_leave_calendars (one per business: work week) · people_holidays (business-wide or per location)
```

### 4.3 Single sources of truth

| Fact | Owner | Never duplicated in |
|---|---|---|
| Who the employee is, reporting line | P1 tables | requests (only `employee_id`) |
| Which rules apply | P3-A assignment + revision | requests (only `policy_id`, `policy_version`) |
| Balance | P3-C ledger | requests (only ledger entry ids and the stored deducted amount, which the ledger entry also holds) |
| Whether a date is taken | `people_leave_request_days` (active rows) | Scheduling (reads a projection in P3-E, §13) |
| Request status history | transitions (DB-written) | audit (references only) |

---

## 5. P3-C prerequisite verification checklist

P3-B approval, rejection and cancellation (B2 schema FKs, B3 code) **must not start** until each item is
verified on `main` **and** the P3-C migration is applied and verified in production. Each row says how to check.
State on 2026-11-17: **every row is unmet** (P3-C does not exist).

### 5.1 Decisions

| # | Requirement | Verify by | State |
|---|---|---|---|
| C-01 | D-P3-20, amended to per-leave-year buckets (§5.6), accepted: target bucket locked `FOR UPDATE`, negative limit under the lock, deduct on approval | Decision record in `people-leave-p3.md` §3 | Unmet (proposed) |
| C-02 | D-P3-21 (on-demand idempotent accrual, no cron) accepted | same | Unmet |
| C-04 | D-P3-45 and D-P3-50 (as revised) reflected in P3-C's spec: year buckets, carry-over without trapping, date-ordered projection (§5.6) | P3-C spec and audit | **Decisions accepted 2026-11-17 (owner decision record on #116); P3-C spec unmet** |
| C-03 | D-P3-25 (revision `effective_from`, entries record `policy_version`, never recalculated) accepted and built | `effective_from` column on `people_leave_policy_revisions` on `main` and in production | Unmet (column absent) |

### 5.2 Schema and guarantees

| # | Requirement on P3-C | Verify by | State |
|---|---|---|---|
| C-10 | One balance **bucket** row per `(business_id, employee_id, leave_type_id, leave_year_start)` (§5.6), unique, composite tenant FKs, forced RLS | schema test, `tests/isolation` | Unmet |
| C-11 | Ledger entries append-only: no UPDATE or DELETE grant to `bos_app`, guard trigger refuses changes | grants inventory test | Unmet |
| C-12 | Entry kinds include `DEDUCTION` and `REVERSAL`; a reversal references the entry it reverses, at most one reversal per entry (unique) | schema + direct SQL test | Unmet |
| C-13 | Source reference on entries: `(source_kind, source_id)` with a unique index on `(business_id, source_kind, source_id, kind)` so a request can be deducted at most once and reversed at most once (ledger-level idempotency) | schema + race test | Unmet |
| C-14 | Entries store `amount numeric(9,4)`, `unit`, `policy_id`, `policy_version`, `effective_date` (business date, posting), `applies_on` (first leave date, for deductions and their reversals) and the `leave_year_start` they are charged to (D-P3-45) | contract test | Unmet |
| C-15 | Composite FK from entry to `people_leave_policies (business_id, id)` and to employee | schema test | Unmet |

### 5.3 Server interface P3-B calls (People-internal, not HTTP)

| # | Function (proposal; P3-C may rename, the semantics are the requirement) | Requirement | State |
|---|---|---|---|
| C-20 | `lockBucket(db, employeeId, leaveTypeId, leaveYearStart)` | Opens any missing buckets from the current leave year up to the target year and locks them `FOR UPDATE` **in ascending year order** (race-safe `INSERT … ON CONFLICT DO NOTHING` then `SELECT … FOR UPDATE`), runs "accrue up to date" for the current year inside the lock, and returns the locked buckets' real figures `{ leaveYearStart, posted, accruedThrough }` per year (§5.6). It never returns a single cross-year "available" figure; availability comes only from C-26 | Unmet |
| C-21 | `postDeduction(db, bucket, { amount, effectiveDate, policyId, policyVersion, source: { kind: 'LEAVE_REQUEST', id } })` | Posts into the locked target-year bucket with `applies_on`; refuses unless `project(...)` under the same lock (C-26) shows the request fits (D-P3-45, D-P3-50); throws a typed `insufficient_balance` error with no partial write; returns the entry id | Unmet |
| C-22 | `postReversal(db, { entryId, effectiveDate, source })` | Locks the bucket the deduction was charged to (and, if that year is closed, the following open buckets in ascending order), posts the exact opposite amount **into the original bucket**, references `entryId`, never touches the original; a closed year's carry-over correction follows §5.6 rule 6; idempotent by C-12/C-13; respects `maxBalance` as P3-C defines (decision for P3-C: a reversal is never refused for exceeding `maxBalance`, recommended) | Unmet |
| C-23 | `bucketSummary(db, employeeId, leaveTypeId, leaveYearStart)` | Read-only, same figures as C-20 without locks, plus a `pending` figure P3-B supplies (sum of pending requested amounts charged to that year) | Unmet |
| C-24 | Lock discipline | Buckets of one employee and type are always locked in ascending `leave_year_start`; P3-C takes **no People row lock after** a bucket (it may read policies and revisions without locks). Documented and tested, so P3-B's order (§10.2) cannot cycle | Unmet |
| C-26 | `project(db, employeeId, leaveTypeId, { horizon, extraBookings })` | §5.6 rule 8: date-ordered simulation with forecast accrual, carry-over, grants, caps and bookings; pure given its inputs; read-only; callable with or without the lock (advisory without, authoritative with) | Unmet |
| C-25 | Entitlement `NONE` | Policies with no balance post nothing; `lockBucket` is not called (P3-B skips the ledger) | Unmet (P3-B side defined) |

### 5.4 Tests P3-C must have passed (from `people-leave-p3.md` §4.7)

| # | Test | State |
|---|---|---|
| C-30 | Negative-balance limit under the lock; two parallel deductions on one balance (deterministic, `pg_blocking_pids`) | Unmet |
| C-31 | Idempotent accrue-up-to-date (twice, late) | Unmet |
| C-32 | Leave-year boundaries (calendar, anniversary, custom), carry-over and caps | Unmet |
| C-33 | Mid-period and mid-year rule changes; assignment changes mid-period | Unmet |
| C-34 | Isolation suite and PgBouncer re-run cover every ledger table | Unmet |

### 5.6 Year-aware balance and projection contract (requirement on P3-C; D-P3-45 and D-P3-50 accepted as revised)

The audit found that "one balance row per employee and type" (the D-P3-20 proposal) cannot answer "how much is
available for leave in next leave year". P3-B therefore requires P3-C to keep balances **per leave year**. This is a
requirement on P3-C's design, to be confirmed in P3-C's own spec and audit; P3-B does not build it.

1. **Bucket.** One row per `(employee, leave type, leave_year_start)`, where `leave_year_start` is the start of the
   policy leave year (CALENDAR, ANNIVERSARY from the employee's `start_date`, CUSTOM month/day). Every ledger entry
   belongs to exactly one bucket. A bucket's balance is the sum of its entries; nothing is stored that could drift.
2. **Opening.** A bucket is opened lazily (by `lockBucket`, or accrual reaching the year) with entries computed by the
   rules in force on the year's first day (D-P3-25 rule 5): the grant (GRANT policies) and the carry-over from the
   previous bucket (`NONE` 0, `UNLIMITED` all, `CAPPED` min(cap, available)), posted as `CARRY_OUT` in the old bucket
   and `CARRY_IN` in the new one in one transaction, old bucket locked first. Expiry of unused balance is not in P3-A's
   vocabulary, so none.
3. **Future buckets hold bookings, not entitlement (D-P3-45 as accepted).** A deduction for leave in a future leave
   year is posted into that year's bucket when approved, so the bucket can sit below zero until the year opens and
   its real grant and `CARRY_IN` are posted (rule 2). Leave-year attribution is an **accounting dimension only**: it
   never expires or traps earned entitlement. Earned, unused leave flows forward through `CARRY_OUT`/`CARRY_IN` under
   the policy's carry-over rule, computed from the previous bucket's real closing balance when the year opens. Nothing
   in a bucket is a forecast; forecasts live only in the projection (rule 8), so a projected amount can never be
   counted twice when the real entries arrive.
4. **Lock scope.** Every deduction, reversal, adjustment, accrual and year opening for an employee and type locks the
   **current-year bucket first**, then any later buckets it touches in ascending year order (C-20, C-24). All changes
   to one employee's bookings and entitlement of one type therefore serialise on one row, which is what makes the
   projection (rule 8) stable inside the lock.
5. **Accrual** (D-P3-21) posts only into the current bucket and closes periods per D-P3-25 rule 4; reaching a new
   leave year opens the next bucket under rule 2.
6. **Reversal attribution.** A reversal is always posted into the bucket of the deduction it reverses. If that year is
   already closed, the extra closing balance is carried forward under the policy's carry-over rule as an
   additional `CARRY_OUT`/`CARRY_IN` pair into the following bucket (capped as the original carry-over was, using
   the cap in force when that year closed), in the same transaction and lock order. Propagation through more than
   one closed year, and leap-day anniversary starts (§9.2a), need definitive invariants in P3-C's spec before it is
   implemented.
7. **Compatibility.** D-P3-20 becomes "the target bucket row is locked `FOR UPDATE`"; D-P3-21 unchanged; D-P3-25
   rule 6 becomes "deduct with the rules in force on the approval date, **into the bucket of the leave dates**, after the projection (rule 8) shows it fits"; D-P3-42 is superseded.
   Concurrency tests must span years (T-41a).
8. **Projected availability (D-P3-50 accepted as revised).** For a request of type T with dates `[s, e]` charged to
   leave year Y, P3-C provides `project(employee, T, horizon, bookings)`, a **date-ordered simulation** from today to
   the horizon (the later of `e` and the last approved booking of T, bounded by D-P3-53):
   - **Start:** real posted balance of the current bucket (after accrue-up-to-date), **excluding** deductions whose
     `applies_on` is after today (they re-enter as events on their own dates).
   - **Events, in date order** (ties: credits before debits on the same date, then by booking id):
     forecast accrual credits at each future period end (rules in force today, the work pattern in force today,
     `maxBalance` cap applied at each credit); at each leave-year boundary, carry-over with the policy cap, then the
     grant for the new year (rules in force today); each booking as a debit on its first leave date, with its
     chargeable amount; expiry only if a later accepted policy rule introduces it (P3-A has none).
   - **Bookings included:** at **submission**, approved bookings (from the ledger) plus every other `PENDING` request
     of that type as a provisional reservation, plus the new request. At **approval**, approved bookings plus this
     request; other pending requests are reported in the response (their own approval re-checks them), never
     blocking this one (D-P3-52).
   - **Result:** the projected balance after each event and the minimum over the horizon. A request **fits** when the
     projected balance never falls below `−negativeBalanceLimit` at any event from its first date to the horizon
     (so it can never starve leave that is already approved later in time).
   - **Determinism:** inputs are today's rules, today's pattern, the posted ledger and the booking set; revisions are
     never future-dated (D-P3-9), so the same inputs always give the same projection. Rule changes and actual
     accruals later replace forecasts with real entries; approved deductions are never revisited.
   - **Not posted:** the projection writes nothing. Only an approval posts a deduction (`applies_on` = first leave
     date, into the bucket of Y); only a cancellation posts a reversal.
   - **Submission vs approval are distinct (D-P3-54):** a projected shortfall at submission is a warning shown to
     the employee and the approver, and the request can still be submitted for manager review; approval refuses
     (`409 insufficient_balance`, with the projection) unless it fits. Auto-approved policies (`requiresApproval =
     false`) refuse at submission when it does not fit, because submitting is approving. No approver can override
     a shortfall in P3-B; a leave manager corrects entitlement with a P3-C adjustment instead.

### 5.5 Release state

| # | Requirement | State |
|---|---|---|
| C-40 | P3-C PR merged after its own audit and merge verdict | Unmet |
| C-41 | P3-C migration applied and verified in production (fresh `_prisma_migrations` read, recovery branch, verification per `migration-readiness.md` §5) | Unmet |
| C-42 | P3-C interface (5.3) unchanged since this spec, or this spec amended | Unmet |

**Implementation-ready rule.** P3-B is implementation-ready for B2 and B3 only when C-01..C-42 (including C-04) are met **and**
the security gates G-S1..G-S6 in §16.1 are accepted as entry criteria by the audit. B1 needs only D-P3-40 and
the B1 decisions (§17).

---

## 6. Data model

All tables: `business_id` first in the primary key-adjacent unique `(business_id, id)`, `business_id`-leading
indexes, composite tenant FKs, `ENABLE` + `FORCE ROW LEVEL SECURITY` with the standard `tenant_isolation`
policy, cascade with the business (D-P3-10), no `DELETE`/`TRUNCATE` grant to `bos_app`, column-level `UPDATE`
grants only where listed, times from the database. Amounts `numeric(9,4)` in the policy's unit (as P3-A).

### 6.1 `people_leave_calendars` (B1)

One row per business (unique `business_id`). Absent row = default.

| Column | Type | Notes |
|---|---|---|
| `id`, `business_id` | uuid | |
| `work_days` | smallint | bitmask Mon=1 … Sun=64; CHECK `> 0`; default (absent row) Mon–Fri = 31 |
| `version` | int | guard: +1 per update (PE-class stale) |
| `updated_by_id`, `created_at`, `updated_at` | | |

UPDATE grant: `work_days`, `version`, `updated_by_id`, `updated_at`. Changing the work week never recalculates
existing requests (§9.6).

### 6.1a `people_employee_work_patterns` (B1, D-P3-46)

Effective-dated per-employee work week that overrides the business default for counting: `employee_id`
(composite FK), `work_days` bitmask, `hours_per_day numeric(5,2)` (default fill for HOURS requests, CHECK
`0 < h <= 24`), `[starts_on, ends_on)`, one open row per employee (partial unique index), closed once (guard),
effective dates per D-P3-9 (business today, never future). Managed with `people:manage` (it is about an employee,
not business configuration, D-P3-2). Without it a part-timer booking a week is charged for days they never work,
and every correction would need a ledger adjustment.

### 6.2 `people_holidays` (B1)

| Column | Type | Notes |
|---|---|---|
| `id`, `business_id` | uuid | |
| `holiday_date` | date | business-local |
| `name` | text 1–100 | not sensitive |
| `location_id` | uuid null | composite FK to `people_locations`; null = whole business |
| `archived_at` | timestamptz null | archive instead of delete; restore allowed |
| `version`, `created_by_id`, `updated_by_id`, timestamps | | |

Unique among current rows: `(business_id, holiday_date, coalesce(location_id, '00000000-…'))`
`WHERE archived_at IS NULL`. No recurrence rules and no national calendars (D-P3-17); a holiday is a date.
A location holiday applies to employees whose **current** location matches (P1 keeps no location history), so a
location change re-quotes pending requests; approved ones are unaffected.

### 6.3 `people_leave_requests` (B2)

| Column | Type | Notes |
|---|---|---|
| `id`, `business_id` | uuid | |
| `employee_id` | uuid | composite FK `(business_id, employee_id)` → employees |
| `leave_type_id`, `policy_id` | uuid | composite FK `(business_id, policy_id, leave_type_id)` → policies (as P3-A assignments), so a request cannot pair a policy with another type |
| `assignment_id` | uuid | composite FK → the assignment that covered the dates at submission (informational; approval re-resolves) |
| `policy_version_at_submit` | int | |
| `unit` | DAYS\|HOURS | copied from the policy (fixed per policy, D-P3-5), CHECK matches |
| `start_date`, `end_date` | date | CHECK `start_date <= end_date`, `end_date - start_date < 366` (D-P3-36) |
| `start_part` | `FULL`\|`PM` | DAYS + HALF_DAY only; `PM` = starts at midday |
| `end_part` | `FULL`\|`AM` | DAYS + HALF_DAY only; `AM` = ends at midday; one-day half: `start_part=PM,end_part=FULL` or `FULL/AM` |
| `hours_per_day` | numeric(5,2) null | HOURS only, CHECK `> 0 AND <= 24`, multiple of the policy granularity (service-checked) |
| `requested_amount` | numeric(9,4) | computed at submit (§9) |
| `approved_amount` | numeric(9,4) null | set once, by approval, recomputed on the approval date (D-P3-33) |
| `leave_year_start` | date | start of the policy leave year containing `start_date`; the request may not cross into the next leave year (D-P3-45). Recomputed and re-checked at approval |
| `status` | `PENDING`\|`APPROVED`\|`REJECTED`\|`WITHDRAWN`\|`CANCELLED` | |
| `sensitive` | bool | snapshot of the type flag at submit, may only go false→true (D-P3-43) |
| `submitted_by_user_id` | uuid | composite FK → memberships? **No**: plain uuid, like audit actors, so member removal does not block (A2-B pattern clears FKs); kept as history |
| `submission_basis` | `SELF`\|`ON_BEHALF` | |
| `client_request_id` | uuid | idempotency key from the client; unique `(business_id, submitted_by_user_id, client_request_id)` |
| `pending_actor_basis` | text | the basis the service **claims** for this change, set in the same `UPDATE` as the status; the guard requires it non-null on every status change and the trigger re-derives and verifies it from the session user (§6.8) before recording the transition. It is a claim, never proof |
| `deduction_entry_id`, `reversal_entry_id` | uuid null | composite FK → P3-C ledger entries; each set once |
| `version` | int | +1 on every update (guard) |
| `created_at`, `updated_at`, `decided_at` | timestamptz | DB time |

Indexes: `(business_id, employee_id, start_date)`, `(business_id, status, start_date)`,
`(business_id, leave_type_id)`, `(business_id, created_at desc, id)`.

UPDATE grant (column-level): `status`, `approved_amount`, `sensitive`, `pending_actor_basis`, `deduction_entry_id`, `reversal_entry_id`, `version`, `updated_at`, `decided_at`.
Identity, employee, type, policy, dates, parts, hours, requested amount and submitter are immutable (PE004).

### 6.4 `people_leave_request_days` (B2) — occupancy

One row per date **and half** a request occupies: a full day is two rows (`AM`, `PM`); a half day one; an HOURS
request occupies both halves of every date (D-P3-34). Non-work days and holidays inside the range are occupied
too (the range is the request; only the *charge* skips them), which keeps "no overlapping requests" simple.

| Column | Type | Notes |
|---|---|---|
| `business_id`, `request_id`, `employee_id` | uuid | composite FK `(business_id, request_id, employee_id)` → requests (unique `(business_id, id, employee_id)` added on requests) so a day row cannot claim another employee |
| `leave_date` | date | |
| `part` | `AM`\|`PM` | |
| `released_at` | timestamptz null | set once when the request leaves `PENDING`/`APPROVED` |

**Overlap guarantee (D-P3-19):** `UNIQUE (business_id, employee_id, leave_date, part) WHERE released_at IS NULL`.
Two concurrent submissions that overlap: the second blocks on the first's uncommitted index entry and then fails
with `23505` → `409 leave_overlap`, nothing written. No extension and no advisory lock needed; works under
PgBouncer transaction mode. Rows are inserted only in the submit transaction, released (never deleted) by the
transition trigger when the status becomes `REJECTED`, `WITHDRAWN` or `CANCELLED`. Grants: INSERT, UPDATE
(`released_at`) only. ≤ 732 rows per request (366 days × 2).

### 6.5 `people_leave_request_transitions` (B2) — DB-written history

Inserted only by an `AFTER INSERT OR UPDATE OF status` trigger on requests (pattern of P3-A revisions): the
trigger derives everything from the request row, so a transition cannot be forged, written ahead, edited or
deleted (no INSERT, UPDATE or DELETE grant to `bos_app`; the trigger function is `SECURITY DEFINER` owned by the
migration owner **or** the table grants INSERT only to the trigger path — P3-A's revisions approach is reused
exactly, whichever it is).

| Column | Notes |
|---|---|
| `id`, `business_id`, `request_id` | composite FK |
| `seq` | 1, 2, 3 … per request, unique `(business_id, request_id, seq)` |
| `from_status` (null for submission), `to_status` | |
| `actor_user_id`, `actor_basis` | actor from `current_setting('app.user_id')`, basis verified by the trigger (§6.8): `SELF`, `ON_BEHALF`, `AUTO_NO_APPROVAL`, `LINE_MANAGER`, `LEAVE_MANAGER`, `LEAVE_MANAGER_OVERRIDE`, `SOLE_OWNER_SELF` |
| `request_version` | the version the change produced |
| `amount` | requested amount at submit; approved amount at approval; null otherwise |
| `policy_version` | policy version used for that computation |
| `ledger_entry_id` | deduction (approve) or reversal (cancel) |
| `recorded_at` | DB time |

The status guard (below) and this table are the "explicit transition matrix and append-only history" of the
brief. No notes, no names, no type text.

### 6.6 `people_leave_request_notes` (B2) — restricted text

| Column | Notes |
|---|---|
| `id`, `business_id`, `request_id` | composite FK |
| `kind` | `EMPLOYEE` (with submission or withdrawal/cancel), `DECISION` (approve/reject/cancel) |
| `transition_seq` | which transition it accompanies |
| `body` | 1–1000 chars, trimmed |
| `author_user_id`, `created_at` | |

Append-only (INSERT only). Selected only by `leave-requests.ts` after the note-visibility check (§12.2), exactly
like personal details in P1. No attachments (D-P3-22).

### 6.7 Guards (SQLSTATE class PE; numbers assigned at build, after P3-C's)

| Guard | Refuses | API code |
|---|---|---|
| Status transition | anything outside §7.2 | `409 invalid_transition` |
| Version | not exactly +1 | `409 stale` |
| Immutable columns | identity, employee, type, policy, dates, parts, hours, requested amount, submitter, `approved_amount`/ledger ids once set | `409 immutable` |
| Actor and basis (§6.8) | missing `app.user_id`; a basis the session user does not satisfy; own request without `SELF`/`SOLE_OWNER_SELF` | `403 forbidden` / `self_approval` (service checks first; trigger is the backstop) |
| Approved needs ledger | `APPROVED` without `deduction_entry_id` unless the policy entitlement is `NONE` (checked via the policy row) | 500 (bug) |
| Cancel needs reversal | `APPROVED→CANCELLED` without `reversal_entry_id` when a deduction exists | 500 (bug) |
| Terminated employee | insert or `→APPROVED` while the employee is `TERMINATED` (reads employee under the caller's lock, §10.2) | `409 terminated` |
| Day rows | insert for a request not in `PENDING`/`APPROVED`; `released_at` changed twice | `409 immutable` |
| CHECKs | units, parts only with DAYS, hours only with HOURS, span, amounts ≥ 0 | `400 invalid_input` |

### 6.8 Provenance: what the database proves on its own (D-P3-51)

The audit noted that `pending_actor_*` columns written by the service prove nothing against a forged direct `UPDATE`
by `bos_app`. Design, in increasing strength:

1. **Actor from the session, not the statement.** The transition trigger records `actor_user_id :=
   current_setting('app.user_id')`, which `withTenant` sets from the verified session (`core/db/with-tenant.ts:122`),
   exactly as Communications' restricted notes and Finance recurring runs already rely on. A supplied
   `pending_actor_user_id` is not stored; the column is dropped from the design. A missing setting fails closed
   (status change refused).
2. **Basis re-derived in SQL.** The trigger (`SECURITY INVOKER`) recomputes whether the session user may make this
   transition and refuses otherwise; `pending_actor_basis` is only the claim it checks:
   - `SELF`: session user is the request's submitter or the user linked to its employee, and the transition is one
     §7.2 allows the employee (withdraw; cancel only while `current_date` in the business time zone `< start_date`);
   - `LINE_MANAGER`: an open manager assignment (on the business-local date) makes the session user's linked employee
     the manager of the request's employee, that manager is not terminated, and the session user's membership is
     `ACTIVE` with role in the roles that hold `people:leave_approve`;
   - `LEAVE_MANAGER` / `LEAVE_MANAGER_OVERRIDE`: membership `ACTIVE` with a role holding `people:leave_manage`;
   - `SOLE_OWNER_SELF`: role `OWNER`, own request, and no other `ACTIVE` membership with a `leave_manage` role and no
     other eligible line manager;
   - `AUTO_NO_APPROVAL`: only on insert, and only when the policy row's `requires_approval` is false;
   - always: not own request unless `SELF` or `SOLE_OWNER_SELF`.
   The database cannot read `ROLE_PERMISSIONS`, so the role lists are written in the migration (the `erasure_actor`
   pattern in ADR 0006 §7) and a unit test fails if they drift from `permissions.ts`. When custom roles arrive these
   checks must read the role tables instead (recorded as a known follow-up).
3. **Occupancy.** Day rows may be inserted only in the transaction that inserted their request (`request.created_at
   = now()`, the transaction timestamp), only for dates and halves inside the request's range and parts, and only
   while it is `PENDING`/`APPROVED`. `released_at` may be set only when the request is terminal, only once, never
   cleared; no DELETE grant. A forged release therefore requires a forged terminal status, which (2) refuses.
4. **Trust boundary (stated).** This defends against bugs and against every request that passes through the API.
   It does **not** defend against arbitrary SQL that sets `app.user_id` to someone else: that is the same boundary as
   tenant isolation itself (ADR 0006 §6). The stronger option, a privileged `SECURITY DEFINER` transition function that
   verifies the raw session token (the E1 erasure pattern), needs privileged SQL on production (not delegated) and is
   **not recommended for P3-B** (D-P3-51).

---

## 7. Request lifecycle and state machine

### 7.1 States

`PENDING` (awaiting decision) · `APPROVED` (balance deducted) · `REJECTED` · `WITHDRAWN` (by the employee
before a decision) · `CANCELLED` (after approval). `REJECTED`, `WITHDRAWN`, `CANCELLED` are terminal. Requests
are never deleted or edited (D-P3-30: withdraw and resubmit instead).

### 7.2 Transition matrix

| From → To | Who (§8) | Preconditions | Ledger | Occupancy |
|---|---|---|---|---|
| (new) → `PENDING` | employee (self) or leave manager (on behalf) | §9 checks pass; policy `requiresApproval = true` | none | inserted |
| (new) → `APPROVED` | same | §9 checks; `requiresApproval = false` (auto-approval, basis `AUTO_NO_APPROVAL`), **or** a leave manager recording on behalf with `approve: true` (basis `LEAVE_MANAGER`, still not their own request) | deduction under lock | inserted |
| `PENDING` → `APPROVED` | resolved approver, or leave manager (override) | not own request (§8.4); employee not terminated; recomputed amount equals `expectedAmount` | deduction under lock | kept |
| `PENDING` → `REJECTED` | resolved approver or leave manager | not own request (sole-owner rule does not apply to rejection of one's own: an owner simply withdraws) | none | released |
| `PENDING` → `WITHDRAWN` | the employee (self) or leave manager (on behalf) | — | none | released |
| `APPROVED` → `CANCELLED` | employee: only before the first leave date (business today `< start_date`) (D-P3-29); resolved approver or leave manager: any time | whole request only | reversal of the deduction | released |
| anything else | — | — | — | `409 invalid_transition` |

### 7.3 Diagram

```
           submit (requires approval)                approve (deduct)
  (new) ─────────────────────────────▶ PENDING ─────────────────────────▶ APPROVED ──cancel (reverse)──▶ CANCELLED
    │                                   │   │                                ▲
    │                                   │   └──reject──▶ REJECTED            │
    │                                   └──withdraw──▶ WITHDRAWN             │
    └──────── submit (no approval needed, or recorded approved by leave manager; deduct) ──────────────────┘
```

### 7.4 Rules that span states

- **Termination (D-P3-41):** existing requests stay as they are; no new submission and no approval while the
  employee is `TERMINATED`; rejection, withdrawal and cancellation remain possible. Rehire restores submission.
  Approved leave after `end_date` is listed for the administrator (B4 shows a notice); nothing is cancelled
  automatically (no jobs).
- **Policy or assignment changes while pending:** approval re-resolves the assignment covering the dates on the
  approval date and recomputes; if no single assignment covers them any more → `409 no_policy`; if the amount
  differs → `409 amount_changed` with the new amount, and the approver confirms again (D-P3-33).
- **Type archived or made inactive while pending:** approval still allowed (the request was valid when made);
  archiving a type is already refused while it has a current policy (P3-A PE008).
- **Manager reassignment race (accepted, explicit):** a reporting-line change that commits after the decision
  transaction's authority check is not retroactive: the decision stands with basis `LINE_MANAGER` for the manager
  who was eligible when it ran. The check runs after the request lock, so a change committed earlier is always seen.
- **Membership changes:** the employee's link being removed does not touch requests; the self view simply stops
  being reachable for that user (§8.1).

---

## 8. Identity and approval authority

### 8.1 Who is "the employee" (self-service, D-P3-12)

The caller's employee is the single `people_employees` row with `user_id = actor.userId` in this business
(unique by index). It is resolved **inside the unit of work on every request**, never cached or taken from the
client. Every `/me/leave/*` route answers `404 not_linked` (body only, no detail) when there is none. A
self-service caller can only ever address requests whose `employee_id` is that row: any other id answers
`404 not_found`, indistinguishable from a missing id.

Consequence (accepted risk, §19): whoever an administrator links to an employee sees that employee's leave
history. Linking is `people:manage`, audited, and already the trust anchor P1 chose for self-service. The brief
asks for a "verified" link: today it is verified by the administrator only, not confirmed by the user. D-P3-47
recommends accepting that for P3-B (the self view shows the linked employee's name prominently); a user
confirmation step would be a separate People change.

### 8.2 Eligible line manager (D-P3-13 as reconciled, D-P3-27)

Resolved **at decision time** and at read time for the inbox; never frozen at submission (the reporting line and
roles may change while a request waits). For employee E on business date T (today, business time zone):

1. the open manager assignment of E covering T (`starts_on <= T < ends_on`, `ends_on` null = open) gives manager M;
2. M is not `TERMINATED`;
3. M has a `user_id` link;
4. that membership is `ACTIVE` (A2-B: a `SUSPENDED` member is not eligible even though the link remains);
5. that member's role holds `people:leave_approve`.

If all hold, M's user is the **routed approver**. Otherwise the request is routed to **leave managers** (members
holding `people:leave_manage`). No walk up the chain and no delegation (D-P3-15).

### 8.3 Who may decide

| Actor | Approve / reject a `PENDING` request | Cancel an `APPROVED` request | Basis recorded |
|---|---|---|---|
| Routed approver (eligible line manager) | ✓ | ✓ | `LINE_MANAGER` |
| Holder of `people:leave_manage` when no eligible line manager exists | ✓ | ✓ | `LEAVE_MANAGER` |
| Holder of `people:leave_manage` when an eligible line manager exists | ✓ (override) | ✓ (override) | `LEAVE_MANAGER_OVERRIDE` |
| Holder of `people:leave_approve` who is **not** the routed approver | ✗ `404 not_found` (cannot see it) | ✗ | — |
| The employee themselves | ✗ (§8.4) | before start only (§7.2) | `SELF` |

### 8.4 No self-decision; sole-owner exception (D-P3-14 as amended by D-P3-28)

A request is the actor's **own** when `actor.userId` equals the request's `submitted_by_user_id` **or** the user
currently linked to the request's employee. (Checking both closes a gap where re-linking would let someone
approve a request they submitted for themselves.)

Own requests can never be approved, rejected or cancelled-as-approver, **except** approval under the sole-owner
rule, which needs all of:

1. the actor's role is `OWNER`;
2. there is **no other** `ACTIVE` member who holds `people:leave_manage`, and the employee has no eligible line
   manager other than the actor (§8.2) — evaluated in the decision transaction;
3. the request body carries `selfApproval: true` (the client shows an explicit confirmation);
4. Regan's decision D-P3-28 has enabled the rule (recommendation: enabled, because single-owner businesses are
   the target market and the alternative is that they can never take leave in the product).

It is recorded with basis `SOLE_OWNER_SELF` and audited with `selfApproved: true`. A concurrent membership change
that adds a second leave manager after the check but before commit cannot make the approval wrong in a way that
matters (the second manager could have approved it too); this race is accepted and documented, not locked.

### 8.5 On-behalf submission

A leave manager may submit for any employee (basis `ON_BEHALF`) and may record it as already approved
(`approve: true`, e.g. leave agreed by phone), which goes straight to `APPROVED` with a deduction. It is never
"own" unless the employee is the manager's own linked employee (then §8.4 applies). On behalf, notice and
backdating rules may be bypassed with `overrideNotice: true` (recorded); overlap, balance, policy coverage,
employment dates and granularity are never bypassed (D-P3-32).

---

## 9. Policy engine: dates, duration and rules

The engine is a **pure function** in `packages/contracts` (so the client estimate and the server agree) with the
server as the only authority:
`calculate(request, calendar, holidays, policyRules, employee, today) → { days: [{date, part, chargeable}], amount, problems[] }`.

### 9.1 Dates and time zone (D-P3-18)

All leave dates are `date` values in the business time zone; there are no instants. "Today" is the business-local
date at the moment of the action (P3-A helper). A later change of business time zone never changes stored dates.
Leave dates may be in the future; D-P3-9's "never in the future" applies to configuration effective dates only.

### 9.2 Chargeable duration (D-P3-17)

For each date `d` in `[start_date, end_date]`:

- **Not chargeable** if `d`'s weekday is not in the employee's work pattern in force on `d` (D-P3-46), else the
  business work week, or `d` is a current holiday (business-wide, or for the employee's current location).
- **DAYS:** chargeable 1.0 per work day, 0.5 for a half (`start_part=PM` on the first day, `end_part=AM` on the
  last). A half day on a non-work day or holiday is 0.
- **HOURS:** chargeable `hours_per_day` per work day (default from the work pattern, never above it);
  non-work days and holidays 0.
- **Total** = sum; must be > 0 (`400 zero_duration`) and a multiple of the policy granularity
  (`400 invalid_granularity`): `FULL_DAY` refuses halves; `HALF_DAY` allows them; `HOUR`/`HALF_HOUR`/
  `QUARTER_HOUR` constrain `hours_per_day`.

The per-day breakdown is shown to the person and stored in the submit and approve transitions' computation
(`amount`, `policy_version`); the days rows hold occupancy only.

### 9.2a Work-pattern and leave-year edges

- **Work-pattern change inside a request:** each date is counted with the pattern in force **on that date** (per
  segment). Patterns cannot be future-dated (D-P3-9), so for future dates the current pattern applies; a pattern change
  made while a request is pending re-quotes it at approval (`amount_changed`). Approved requests never change.
- **Policy assignment change inside a request:** refused (D-P3-35). **Leave-year boundary inside a request:** refused
  (`crosses_leave_year`, D-P3-45), for CALENDAR, ANNIVERSARY and CUSTOM years.
- **Holidays for part-timers:** a holiday on a date outside the employee's pattern counts 0 once (never negative).
- **Leap years:** 29 February counts as an ordinary date; ANNIVERSARY years starting on 29 February are impossible
  (P3-A forbids 29 February as a custom start; an anniversary on 29 February starts the year on 1 March in non-leap
  years — **P3-C to confirm**).

### 9.3 Notice, backdating, waiting period (D-P3-32)

| Rule | Definition (recommendation) | Error |
|---|---|---|
| Backdating | if `allowBackdated = false`: `start_date >= today` | `400 backdated_not_allowed` |
| Notice | if `minimumNoticeDays = n`: `start_date >= today + n` **calendar** days | `400 notice_period` |
| Waiting period | if `waitingPeriodDays = w`: `start_date >= employee.start_date + w` calendar days | `400 waiting_period` |
| Employment dates | `start_date >= employee.start_date` (when set) and, if terminated, never; leave cannot be requested for `PENDING` employees without a `start_date` | `400 outside_employment`, `409 terminated` |

Checked at submission and **again at approval** (rules may have changed; notice is not rechecked at approval —
it is about when the request was made, recommendation in D-P3-32).

### 9.4 Overlap (D-P3-19, D-P3-34)

No two `PENDING`/`APPROVED` requests of one employee may share a date-half, any type. Enforced by the index in
§6.4; the service pre-checks for a friendly error listing the conflicting request ids **the caller may see**.

### 9.5 Policy applicability (D-P3-35)

The employee must have **one** assignment of the requested type covering every date in the range. If two
assignments cover parts of it (a policy change inside the range) the request is refused
(`409 policy_changes_within_request`) and the person splits it. No assignment → `409 no_policy`.

### 9.6 Balance check

- Entitlement `NONE`: no balance, no ledger (the request is a record of absence only).
- Otherwise every check is the **projection** of §5.6 rule 8 (D-P3-50 as revised):
  - **estimate / submission:** without locks, with approved bookings and all pending requests of the type as
    provisional reservations. A shortfall is a **warning** (`projectedShortfall` with the date and amount), and the
    request may still be submitted for manager review, except under auto-approval, where it is refused
    (`409 insufficient_balance`) (D-P3-54);
  - **approval:** inside the bucket lock (§10), with approved bookings plus this request; refused unless it fits over
    the whole horizon. Other pending requests are listed as "would no longer fit" information for the approver.
- The response always shows the figures by date (balance before, on the leave dates and at the horizon), never a
  bare "available" number that hides forecast accrual.
- **Leave-year boundary:** a request whose dates fall in two leave years of its policy is refused
  (`400 crosses_leave_year`); the person splits it (D-P3-45). Leave years follow the policy (`CALENDAR`,
  `ANNIVERSARY`, `CUSTOM`). **Horizon:** a request may start no later than the end of the next leave year
  (D-P3-53), so forecasts never run more than about two years ahead.
- A calendar change (work week, holidays) after approval never recalculates an approved request; correcting it
  means cancelling and resubmitting.

---

## 10. Ledger integration and the approval transaction

### 10.1 Principles

- One database transaction per decision; no external call inside it; nothing after commit except the response
  (N1 notifications, when built, are an outbox row written **inside** the same transaction).
- Ledger records are never modified: approval posts a `DEDUCTION`; cancellation posts a `REVERSAL` referencing it.
- Idempotency at three levels: the request `version` (stale replays fail), the ledger's unique source reference
  (C-13: at most one deduction and one reversal per request even if service code were wrong), and
  `client_request_id` for submissions.
- Handlers use `retryOnConflict` (whole unit of work inside the transaction), so a `40P01`/`40001` is retried
  from the start, re-reading everything.

### 10.2 Global lock order (extends P3-A §4.5)

1. **Request row `FOR UPDATE`** with version check (decisions, withdraw, cancel). Submission has no row yet.
2. **Policy row `FOR SHARE`** (the policy of the assignment covering the dates on the approval date).
3. **Employee row `FOR SHARE`** (status, dates); with on-behalf batch operations (none in P3-B) ascending id.
4. **Assignment rows** read (P3-A order: policy → employee → assignment).
5. **Day rows** inserted (submit) or released (by the trigger, after the status update in step 7).
6. **Balance bucket rows `FOR UPDATE`** via `lockBucket` (P3-C, §5.6): current year, then the target year if later, ascending; accrues up to date inside the lock.
7. **Writes:** ledger entry → request `UPDATE` (status, amounts, `pending_actor_basis`, ledger id, version) → trigger
   writes the transition and releases day rows → note insert → audit.

Why no cycle: policy archive holds the policy `FOR UPDATE` and touches no request; termination holds the employee
`FOR UPDATE` and touches no request or balance; P3-C takes no People lock after the balance (C-24); two decisions
on one request serialise on step 1; two decisions on different requests of the same employee and type serialise on
step 6, after all their shared locks. Membership and reporting-line reads in §8 take no locks (accepted race,
§8.4); the approver check is repeated after step 1 so a reassignment committed before the lock is seen.

### 10.3 Approval sequence (B3)

```
POST /leave-requests/:id/approve { version, expectedAmount, note?, selfApproval? }
 1  tenantRoute(permission anyOf [leave_approve, leave_manage]); withTenant; retryOnConflict
 2  SELECT request FOR UPDATE; 404 if absent or not visible to actor; version ≠ → 409 stale
 3  status ≠ PENDING → 409 invalid_transition (a replay after success lands here or on stale)
 4  authority: resolve routed approver (§8.2); decide basis (§8.3); own-request rule (§8.4) → 403 self_approval
 5  today := business today; assignment covering [start,end] on today's records; policy FOR SHARE; employee FOR SHARE
 6  employee TERMINATED → 409 terminated; single assignment? else 409 no_policy / policy_changes_within_request
 7  rules := policy at highest version with effective_from ≤ today (D-P3-25); recheck backdating, waiting period
 8  amount := calculate(...) ; amount ≠ expectedAmount → 409 amount_changed {amount}
 9  if entitlement ≠ NONE:
       buckets := lockBucket(employee, type, leaveYearStart)    -- current year first, then later years, ascending; accrues
       proj := project(employee, type, horizon, approved + this) -- §5.6 rule 8, stable under the lock
       if not proj.fits → 409 insufficient_balance {projection}
       entry := postDeduction(buckets, amount, today, appliesOn=start_date, policy, version, source=request)
10  UPDATE request SET status=APPROVED, approved_amount, deduction_entry_id, pending_actor_basis=:basis, decided_at, version+1
       WHERE id AND version = :version                          -- guard triggers check matrix, ledger presence
    → trigger: transition row (seq+1, basis, amount, policy_version, ledger_entry_id)
11  INSERT note (DECISION) if given
12  audit people.leave_request.approved (ids, basis, amount, unit; never notes or type name when sensitive)
13  COMMIT → 200 { request (approver projection), balance after }
Any error at any step → ROLLBACK: no ledger entry, no transition, no note, no audit.
```

Reject: steps 1–4, then status update and note (no ledger, days released by trigger). Withdraw: steps 1–3, self
or leave manager check, status update. Cancel: steps 1–4 (employee: own request and `today < start_date`),
`postReversal(deduction_entry_id, today)` (locks the deduction's bucket, §5.6 rule 6), status update with `reversal_entry_id`. Submit: employee
resolution, steps 5–8 without step 1, insert request (+ day rows; `23505` → `409 leave_overlap`), and for
auto-approval step 9 and the `APPROVED` insert in the same transaction. **Auto-approval runs exactly the same checks
as manual approval** (employment, policy coverage, leave year, target-year bucket under lock, negative limit), with
no `expectedAmount` round trip because the amount is computed in the same transaction; the only difference is that
there is no approver (basis `AUTO_NO_APPROVAL`, verified by the trigger against `requires_approval`). Cancellation of
auto-approved leave follows §7.2: the employee before start, otherwise leave managers (there is no line-manager
approval to point to, so `LINE_MANAGER` may also cancel per §8.3).

### 10.4 Failure, replay and recovery

| Situation | Outcome |
|---|---|
| Two approvers click at once | second waits on step 2, then `409 stale`; one deduction |
| Approve vs withdraw race | whichever locks first wins; the other gets `409 stale` |
| Two approvals of different requests overspending one balance | serialised at step 9; second sees the first's deduction → `409 insufficient_balance` |
| Network retry of an approve that committed | `409 stale`; client re-reads, sees `APPROVED`, shows success (no second deduction: version and C-13) |
| Submission retried with same `client_request_id` and same body | `200` with the existing request; different body → `409 idempotency_conflict` |
| Crash or timeout mid-transaction | rollback; request unchanged; client retries with the same version |
| Deadlock (should not happen per §10.2) | `retryOnConflict` up to 3 attempts; test T-46 asserts none on service paths |
| Cancellation after a policy change | reversal posts the exact original amount, never recomputed |

---

## 11. API contracts and permission matrix

### 11.1 New permission keys (D-P3-12, D-P3-26)

| Key | OWNER | ADMIN | MANAGER | MEMBER | Covers |
|---|:-:|:-:|:-:|:-:|---|
| `people:leave_self` | ✓ | ✓ | ✓ | ✓ | own leave via the member link: summary, requests, submit, withdraw, cancel before start |
| `people:leave_approve` | ✓ | ✓ | ✓ | — | decide requests where the actor is the routed approver; team view of their reports |
| `people:leave_manage` | ✓ | ✓ | — | — | any employee: read all, decide (override), on behalf, cancel |
| existing `people:configure` | ✓ | ✓ | — | — | work week, holidays (B1) |
| existing `people:read` | ✓ | ✓ | ✓ | — | team leave calendar (redacted, §12) |

`people:leave_*` grant nothing outside leave, and People's existing keys grant no leave decisions. MEMBER gains
self-service only, not the directory.

### 11.2 Route infrastructure (controlled surface)

- `tenantRoute` gains `permission: Permission | { anyOf: Permission[] }` (proposal), coordinated with WF-1B-1's
  all-of helper (#110) so `routes.ts` changes once. The handler still enforces the record scope (§8).
- Zone gating gains `requiresAny` (People opens with `people:read` **or** `people:leave_self`); tabs are shown by
  key (D-P3-24).
- Every new route is registered with `available: () => leaveRequestsEnabled()` (off by default) until B4 and
  Regan's switch-on decision (§18.3), the GS2 pattern.

### 11.3 Endpoints (all under `/api/v1/b/:slug/people`)

| Method and path | Key (route) | Record scope | Package |
|---|---|---|---|
| `GET /leave-calendar` | `people:read` or `people:leave_self` | business | B1 |
| `PUT /leave-calendar` `{ workDays[], version? }` | `people:configure` | business | B1 |
| `GET /holidays?from&to&locationId&status&cursor&limit` | `people:read` or `people:leave_self` | business | B1 |
| `POST /holidays` `{ date, name, locationId? }`; `PATCH /holidays/:id`; `POST /holidays/:id/archive`, `/restore` | `people:configure` | business | B1 |
| `GET /me/leave` | `people:leave_self` | own employee | B2 |
| `POST /me/leave/estimate` `{ leaveTypeId, startDate, endDate, startPart?, endPart?, hoursPerDay? }` | `people:leave_self` | own | B2 |
| `GET /me/leave/requests?status&from&to&cursor&limit`; `GET /me/leave/requests/:id` (with history) | `people:leave_self` | own | B2 |
| `POST /me/leave/requests` `{ …estimate fields, note?, clientRequestId }` | `people:leave_self` | own | B2 (pending only) / B3 (auto-approve) |
| `POST /me/leave/requests/:id/withdraw` `{ version, note? }` | `people:leave_self` | own, `PENDING` | B2 |
| `POST /me/leave/requests/:id/cancel` `{ version, note? }` | `people:leave_self` | own, `APPROVED`, before start | B3 |
| `GET /leave-requests?view=inbox\|team\|all&status&employeeId&leaveTypeId&from&to&cursor&limit` | any of `leave_approve`, `leave_manage` | inbox = routed to actor; team = actor's current reports; all = `leave_manage` only | B2 |
| `GET /leave-requests/:id` (with history and notes when visible) | any of `leave_approve`, `leave_manage` | routed approver, reports' requests (redacted), or manage | B2 |
| `POST /leave-requests/:id/approve` `{ version, expectedAmount, note?, selfApproval? }` | any of `leave_approve`, `leave_manage` | §8.3 | B3 |
| `POST /leave-requests/:id/reject` `{ version, note? }` | same | §8.3 | B3 |
| `POST /leave-requests/:id/cancel` `{ version, note? }` | same | §8.3 | B3 |
| `POST /employees/:id/leave-requests` `{ …, approve?, overrideNotice?, clientRequestId }` | `people:leave_manage` | any employee | B3 |
| `POST /employees/:id/leave/estimate` | `people:leave_manage` | any | B2 |
| `GET /employees/:id/leave-requests` | `people:leave_manage` | any | B2 |
| `GET /leave/calendar?from&to&departmentId&locationId&cursor` (≤ 62 days) | any of `people:read`, `leave_approve`, `leave_manage` | §12.3 projection | B2 |

No DELETE and no PATCH on requests. Cursors bound to view and filters (F7-A). Request DTO (approver
projection): `{ id, employee: {id, displayName}, leaveType: {id, name} | null, away: bool, unit, startDate,
endDate, startPart, endPart, hoursPerDay, requestedAmount, approvedAmount, status, routedTo: 'you'|'line_manager'|'leave_managers',
submissionBasis, createdAt, decidedAt, version, history?: Transition[], notes?: Note[] }`. Self projection adds
balances; redacted projection (§12.3) omits type, amounts, notes and history.

### 11.4 Errors (new, additive)

`400`: `invalid_input`, `invalid_query`, `invalid_cursor`, `zero_duration`, `invalid_granularity`, `crosses_leave_year`,
`backdated_not_allowed`, `notice_period`, `waiting_period`, `outside_employment`, `request_too_long`.
`403`: `forbidden`, `self_approval`. `404`: `not_found` (incl. other businesses' and invisible requests),
`not_linked`. `409`: `stale`, `invalid_transition`, `leave_overlap`, `no_policy`,
`policy_changes_within_request`, `insufficient_balance` (with `available`, `requested`, `limit`),
`amount_changed` (with `amount`), `terminated`, `idempotency_conflict`, `immutable`.

### 11.5 Audit (references only; regression-tested like P1/P3-A)

| Action | Target | Metadata |
|---|---|---|
| `people.leave_request.submitted` | request | `employeeId`, `leaveTypeId`*, `status`, `basis`, `unit`, `amount` |
| `.approved` / `.rejected` / `.withdrawn` / `.cancelled` | request | `employeeId`, `basis`, `selfApproved?`, `amount`, `ledgerEntryId` |
| `people.leave_calendar.updated` | business | `workDaysFrom`, `workDaysTo` |
| `people.holiday.created` / `.updated` / `.archived` / `.restored` | holiday | `date`, `locationId` |

\* For sensitive requests `leaveTypeId` is replaced by `sensitive: true` (audit is read by `audit:read`, which may
not hold `people:read_sensitive` once custom roles exist). Never notes, names, dates text of sensitive leave
beyond the request id, or balances.

---

## 12. Privacy

### 12.1 Classification

| Data | Ordinary type | Sensitive type (D-P3-7, D-P3-43) |
|---|---|---|
| That the employee is away on dates | team viewers | team viewers (as "Away") |
| Type name and category | team viewers | employee, routed approver, leave managers, `people:read_sensitive` |
| Amounts, balances | employee, routed approver, leave managers | same |
| Notes (any type) | employee, routed approver, leave managers (`read_sensitive` not required) | same |
| History (actors, bases, times) | employee, routed approver, leave managers | same |

Sensitivity is `request.sensitive OR type.sensitive` at read time: turning a type's flag **off** never exposes
past requests made while it was on; turning it **on** protects all its requests immediately.

### 12.2 Enforcement

- One projection function per audience in `leave-requests.ts` (`selfView`, `approverView`, `teamView`); routes
  never serialise rows directly. Contract schemas for the redacted view do not have the hidden keys at all
  (absent, not null), like WF-1's finance redaction.
- Notes are selected only after the note check passes; the list endpoints never join notes. Defence in depth
  (D-P3-48, revised after audit): a **restrictive** RLS policy on `people_leave_request_notes` derived from data, not
  from a writable flag: a row is visible only when `current_setting('app.user_id')` is the note's author, the
  request's submitter, the user linked to the request's employee, an `ACTIVE` member whose role holds
  `people:leave_manage`, or the linked user of the employee's current line manager whose role holds
  `people:leave_approve` (same SQL predicates and role lists as §6.8). Communications' restricted notes already use
  the session user in RLS. The service check remains the primary authorisation; the policy only makes a stray query
  return nothing. Same trust boundary as §6.8 item 4.
- Error bodies never reveal a request's existence, type or dates to someone who cannot see it.
- No leave data in global search, reporting metrics, notification text (N1 `PEOPLE` class: ids and enums only),
  Scheduling or logs. A boundaries test asserts that only People imports the leave tables and that no non-People
  contract carries leave fields.
- Attachments and medical documents: out of scope (D-P3-22).

### 12.3 Team leave calendar

`people:read` holders (and approvers for their reports) see, per employee and date: `away` + part, and the type
name only for non-sensitive requests; pending requests appear as "Requested" only to the employee, their routed
approver and leave managers (others see approved leave only). MEMBER sees only their own (via `/me`).

---

## 13. Scheduling boundary

**P3-B writes nothing to Scheduling and Scheduling reads nothing from People in P3-B.** The design for P3-E,
recorded so P3-B does not foreclose it:

- **Source of truth:** active `people_leave_request_days` rows of `APPROVED` requests. No copy in Scheduling.
- **Read-through projection (D-P3-37, amends D-P3-23):** People exposes `leaveBusyBlocks(db, employeeIds, range)`
  returning `{ employeeId, date, part }` only (no type, notes, status other than approved). Scheduling's
  availability query and conflict check call it for PERSON resources that have the People-owned `employee_id`
  link (S2 §9), through one allowed boundary call.
- **Non-blocking:** leave appears as a conflict entry `kind: 'leave'`, `blocking: false`, title "Away", so no
  cross-Zone lock is added to ADR 0008's order and approving leave never waits on Scheduling (or vice versa).
  A booking made at the same instant as an approval may miss the warning; the next read shows it. Blocking would
  require People locks inside Scheduling's order: rejected for P3-E's first release.
- **Why not an outbox copy (D-P3-23 original):** a copied busy event is a second source of truth that drifts on
  cancellation, retries need a worker (a scheduled job, which needs Regan's approval), and the copy would be
  visible to every `scheduling:read` holder until ADR 0006 §4 private events exist.
- **Gate:** P3-E still needs its own privacy approval and the People→Scheduling link; nothing here enables it.

---

## 14. UI screen and component inventory

People Zone, Pixa V2-B2 Direction A ("Ledger"): ruled section headers, figure strips, ledger tables, pixel
markers with words, **no pills**, light and dark from tokens only, widths 900/1280/1440 as V2-B2 §11.1, keyboard
and focus per §11.2. Leave is **tabs inside People** (D-P3-24); no inspector (V2-B2 limits the inspector to
Finance and Projects, D-V2B2-5): detail is its own view.

### 14.1 Screens

| Screen | Who | Content | Package |
|---|---|---|---|
| **My leave** (tab) | `leave_self` with link | Figure strip of balances per type (available, requested, used this leave year; one unit per cell); "Request leave" primary action; ledger table of my requests (dates, type, amount, status marker); empty state; "not linked" state with a plain explanation (ask an administrator to link your account) | B4 |
| **Request leave** (dialog or page) | same; leave manager "on behalf" variant with employee picker | Type (only types with a current assignment), start/end date, half-day parts (HALF_DAY policies), hours per day (HOURS), live estimate from `/estimate` with per-day breakdown (work days, holidays, weekends shown as not counted), notice/backdating/waiting-period problems inline, balance after, optional note with a privacy hint ("visible to you, your approver and leave administrators"); unsaved-changes guard (`drafts.tsx`); on-behalf: "Record as approved" and "Override notice" checkboxes | B4 |
| **Request detail** | everyone who may see it | Header (status marker + word), dates and amount, routed-to line ("Waiting for your manager" / "Waiting for leave administrators"), history timeline from transitions, notes; actions by permission: Withdraw, Cancel, Approve, Reject; stale handling (`problem.tsx` pattern) | B4 |
| **Approvals** (tab, inbox) | `leave_approve` / `leave_manage` | Ledger table: employee, type (or "Away"), dates, amount, balance after, submitted; filters (rectangular filter controls, not chips); Approve opens a confirm dialog showing the recomputed amount and balance after (`expectedAmount`); Reject with optional note; `amount_changed` re-prompts; sole-owner confirmation | B4 |
| **Team leave** (tab) | `people:read`, approvers | Month grid (employees × days) with square markers per half day, "Away" for sensitive, legend with words, department/location filters, list fallback at 900 px and for screen readers | B4 |
| **Leave calendar settings** (People › Leave settings) | `people:configure` | Work week toggles, holiday list (ledger table, add/edit/archive/restore, optional location) | B4 (API in B1) |

### 14.2 Status presentation

| Status | Marker | Word |
|---|---|---|
| Pending | hollow, `--status-warning-solid` | "Pending" |
| Approved | filled, `--status-success-solid` | "Approved" |
| Rejected | filled, `--status-danger-solid`, danger word weight 500 | "Rejected" |
| Withdrawn | hollow, `--fg-subtle` | "Withdrawn" |
| Cancelled | filled, `--fg-subtle` | "Cancelled" |

Markers are never the only signal; forced-colours mode keeps the word.

### 14.3 Components

| Need | Existing piece (`packages/ui`, `packages/app`) | Change |
|---|---|---|
| Status | `PixelMarker`/`Marker` (B2-2, merged) | reuse |
| Balances | `FigureStrip`, `Figure` (B2-2) | reuse |
| Section headers | `SectionHeader` ruled variant | reuse |
| Tables | `Table` (V2-B4 `DataTable` when it lands) | reuse |
| Dialogs, forms | `dialog.tsx`, `field.tsx`, `drafts.tsx`, `problem.tsx` | reuse |
| Employee picker | `manager-picker.tsx` | reuse for on-behalf |
| Date range with half-day parts | none | **new local component** in `zones/people/leave/` (not a shared design-system component until a second Zone needs it) |
| Month grid | none | **new local component**; table semantics (`role="grid"` only if keyboard navigation is built; else a plain table with captions) |

### 14.4 UI tests (B4)

Role × tab visibility; not-linked state; estimate updates and problem messages; half-day and hours inputs by
policy; approve confirm with `amount_changed`; stale and session-ended paths; sensitive shown as "Away" in team
view for `people:read`; dark and light snapshots through the B2-1 harness (non-gating); 900 px layout; keyboard
order and focus return after dialogs.

---

## 15. Decision register

### 15.1 Accepted (binding)

D-P3-1 to D-P3-11 (§2). D-S2-1, D-V2B2-1..8, N1 class rules (architecture accepted as documentation), the
delegated approval policy.

### 15.2 Reconciliation of proposed D-P3-12 to D-P3-19 (and 22–25) against the repository

| Id | Proposal (people-leave-p3.md §3.2) | Finding (evidence) | Outcome |
|---|---|---|---|
| D-P3-12 | Self via `user_id`; keys `leave_self` (all), `leave_approve` (MANAGER+), `leave_manage` (OWNER, ADMIN) | Compatible. Two infrastructure gaps: `tenantRoute` takes one key (`routes.ts:236`); the registry requires all keys (`registry.ts:119`) so MEMBER cannot open People | **Keep**, plus D-P3-26 (any-of route and Zone gating) |
| D-P3-13 | Approver = current line manager if linked to an active member holding `leave_approve`, else leave managers | "Active" is ambiguous: suspension keeps the link (`tenancy/server/members.ts` `setMemberStatus`); "current" needs a time of evaluation; a MEMBER-role line manager never approves (no key) | **Keep with clarifications** D-P3-27 (resolve at decision time; membership `ACTIVE`; open assignment on business today) |
| D-P3-14 | No self-approval; `leave_manage` may decide any (override); sole owner may self-approve | "Own" is undefined when links change; "sole owner" undefined; brief requires the exception to be separately authorised | **Amend** → D-P3-28 (own = submitter or linked user; precise sole-owner conditions; explicit flag) |
| D-P3-15 | No delegation in P3-B | Matches the brief | **Keep** |
| D-P3-16 | `PENDING→APPROVED\|REJECTED\|WITHDRAWN`, `APPROVED→CANCELLED` (employee before start "if the policy allows"); auto-approve without approval | P3-A policies have **no** cancellation rule field (`people-leave.ts:91-101`); adding one changes the P3-A revision trigger and contract | **Amend** → D-P3-29 (employee may cancel before start, no policy field); plus D-P3-30 (no editing) |
| D-P3-17 | Business work week (default Mon–Fri), holiday list (optionally per location) in P3-B; per-employee override later; HOURS take hours per day | No work week or holiday storage exists anywhere (`grep` on schema and docs). Storing the work week on `businesses` would touch Administration's table. "Per-employee later" over-charges part-timers | **Keep** with D-P3-31 (People-owned tables) and **amend** by D-P3-46 (per-employee pattern in B1) |
| D-P3-18 | Calendar dates in business time zone | Matches P1/P3-A | **Keep** |
| D-P3-19 | No overlap, any type, except AM/PM halves | HOURS requests carry no time of day, so hour-level overlap is undefined; enforcement mechanism unspecified (ADR 0008 avoids extensions) | **Keep with clarification** D-P3-34 (HOURS occupy the whole date; unique index on day rows) |
| D-P3-20/21 | Ledger rules | P3-C scope; unbuilt and unaccepted. D-P3-20's single balance row per employee and type is incompatible with D-P3-45 | **Amend D-P3-20** to per-leave-year buckets (§5.6); prerequisites C-01, C-02 |
| D-P3-25 | Rules by date; rule 6 deducts "on the approval date" | Wrong for leave in a later leave year (balance resets / grants); also needs a year-aware balance model, not a field on the entry | **Conflict** → D-P3-45 and D-P3-50, contract §5.6; prerequisites C-03, C-04, C-10 |
| D-P3-22 | Sensitive: notes and type visible only to employee, approver, `read_sensitive`; others see "Away" | Type flag is editable later (`UpdateLeaveTypeRequest`), which would re-expose history | **Keep** + D-P3-43 (sticky sensitivity) and D-P3-38 (notes restricted for every type) |
| D-P3-23 | P3-E: busy-only blocks via outbox, sync disabled | An outbox copy duplicates the source of truth and needs a worker (escalation item) | **Amend for P3-E** → D-P3-37 (read-through projection, non-blocking) |
| D-P3-24 | Leave as People tabs; MEMBER sees My Leave | Needs any-of Zone gating (§3.3) | **Keep**, implemented via D-P3-26 |

### 15.3 New proposals (recommendation in bold; Regan decides)

| Id | Question | Options | Recommendation and why |
|---|---|---|---|
| D-P3-26 | How do routes and the Zone accept several keys? | separate route families per key / **`anyOf` on `tenantRoute` + `requiresAny` in the registry**, record scope in handlers | **anyOf**: one route per resource, one place for the record-scope check; coordinate with #110's all-of helper |
| D-P3-27 | When and how is the approver resolved? | frozen at submission / **at decision time** (open manager assignment on business today, manager not terminated, linked, membership ACTIVE, holds `leave_approve`) | **Decision time**: handles reorganisations, suspensions and role changes without stale routing |
| D-P3-28 | Sole-owner self-approval | never / **OWNER, no other active `leave_manage` holder or eligible line manager, explicit `selfApproval: true`, audited** / any owner | **Conditional**: lets a one-person business record its own leave with a visible audit trail |
| D-P3-29 | Employee cancelling approved leave | never / policy field (D-P3-16) / **before the first leave date, whole request, no policy field** | **Before start**: no P3-A schema change; after start only approver or leave manager |
| D-P3-30 | Editing a request | edit while pending / **no edits; withdraw and resubmit** | **No edits**: simpler history and no amount/occupancy rewrite |
| D-P3-31 | Where work week and holidays live | `businesses` columns / **People-owned `people_leave_calendars`, `people_holidays`** | **People-owned**: no Administration change; `people:configure` |
| D-P3-32 | Notice, waiting period, backdating semantics | business days / **calendar days; waiting from employment `start_date` to first leave day; notice checked at submission only; leave managers on behalf may override notice and backdating (recorded)** | **As stated**: predictable, matches "days" in P3-A |
| D-P3-33 | Amount at approval | keep submitted / **recompute with rules in force on approval date; approver confirms `expectedAmount`** | **Recompute + confirm**: implements D-P3-25 rule 6 without surprises |
| D-P3-34 | Overlap enforcement | advisory lock / exclusion constraint (extension) / **per-day AM/PM occupancy rows with a partial unique index; HOURS occupy whole dates** | **Occupancy rows**: database guarantee without extensions, pooler-safe |
| D-P3-35 | Policy change inside a requested range | split automatically / **refuse; person splits** | **Refuse**: one policy per request keeps ledger entries single-policy |
| D-P3-36 | Maximum span | none / **366 calendar days per request** | **366**: covers long parental leave in one or two requests, bounds row counts |
| D-P3-37 | Scheduling (P3-E) | outbox copy (D-P3-23) / **read-through busy projection, non-blocking leave conflicts** | **Read-through**: one source of truth, no worker; P3-E still needs its privacy approval |
| D-P3-38 | Who sees notes | by sensitivity / **always only employee, routed approver, leave managers** | **Always restricted**: notes often contain reasons |
| D-P3-39 | Stage split with P3-D | P3-D builds all leave UI / **B4 builds request and approval UI; P3-D narrows to balances and policy configuration screens** | **Split**: P3-B ships end to end; P3-D stays focused |
| D-P3-40 | D-P3-1 reading for B1 | nothing before P3-C / **B1 (calendar + duration engine, no ledger) may run in parallel with P3-C; B2–B4 after P3-C is applied** | **Parallel B1**: no ledger dependency, saves a cycle |
| D-P3-41 | Termination with open requests | auto-cancel / **leave as is; no submit or approval while terminated; admin decides** | **Leave as is**: no automatic financial effect, no job |
| D-P3-42 | Future accruals at approval | ~~current balance only~~ | **Superseded** by D-P3-50 as accepted (projection through the leave dates) |
| D-P3-43 | Changing a type's `sensitive` flag | follows the type / **sticky: request snapshot OR current flag** | **Sticky**: never re-exposes history |
| D-P3-45 | **Leave-year attribution — ACCEPTED (owner decision record on #116, 2026-11-17)**: accounting dimension only; earned unused leave carries over per policy and is never trapped | deduct from the balance on the approval date (D-P3-25 rule 6 as proposed) / **charge each deduction to the leave year of the leave dates; split requests crossing a leave-year boundary** | **Leave year of the dates.** Under the proposal, leave booked now for next leave year is charged against this year's balance, which is wrong for GRANT policies without carry-over and for any reset. **Conflicts with the D-P3-25 proposal as written** (still only a proposal) |
| D-P3-46 | Per-employee work pattern | later (D-P3-17) / **effective-dated per-employee pattern in B1** | **In B1**: otherwise part-timers are over-charged and every fix is a ledger adjustment. Amends D-P3-17's "later" |
| D-P3-47 | What "verified" user link means | require user confirmation (new People change) / **accept the admin-asserted, audited link; show the linked employee to the user** | **Accept for P3-B**; confirmation can follow if pilots need it |
| D-P3-48 | Restrictive RLS on notes | service check only / transaction-flag RLS / **service check plus restrictive RLS derived from the session user and the data** | **Data-derived RLS** (revised after audit): a writable flag proves nothing; the session user is the existing trust anchor |
| D-P3-50 | Future availability | **ACCEPTED AS REVISED (owner decision record on #116, 2026-11-17):** projected entitlement on the leave dates: earned balance and carry-over, forecast accrual through the dates, grants, caps and year boundaries, approved and pending bookings in date order, negative-balance allowance; submission distinct from approval; re-evaluated under the lock at decision time. The earlier conservative proposal is **withdrawn** | §5.6 rule 8 |
| D-P3-52 | Pending requests at approval | block on all pending / **pending reserve at submission; at approval only approved bookings + this request count, other pending ones are re-checked at their own approval and listed as affected** | **As stated**: first decided, first served; no deadlock between two pending requests that each fit alone |
| D-P3-53 | Projection horizon | unlimited / **start date no later than the end of the next leave year** | **Bounded**: forecasts beyond about two years are unreliable and costly |
| D-P3-54 | Shortfall at submission | refuse / **warn and allow submission for manager review; refuse only under auto-approval; no approver override of a shortfall in P3-B** | **Warn**: matches the owner record ("submit with a clear warning"); a leave manager fixes entitlement by adjustment, not by override |
| D-P3-51 | How the database proves who made a transition | service-written actor (v1.0) / **session user + basis re-derived in SQL by the trigger** / privileged session-token function | **Session user + SQL re-derivation**: no privileged SQL; same trust boundary as tenant isolation; the privileged option stays available if Regan wants it |
| D-P3-49 | Team leave audience | approvers only / **`people:read` holders (sensitive as "Away") plus approvers for their reports; MEMBER own only** | **As stated** (§12.3): the brief asks for filtered team visibility without fixing the audience |
| D-P3-44 | Release switch | ship enabled / **routes off (`available`) until B4 and Regan's explicit switch-on** | **Off**: enabling a feature in production escalates to Regan anyway (protocol "Merges are deployments") |

---

## 16. Test matrix

Level: **I** = API integration on real PostgreSQL with migrations (`apps/api/tests/integration`), **S** = direct
SQL as `bos_app`, **C** = deterministic two-session concurrency at READ COMMITTED with `pg_blocking_pids`
barriers that assert the intended interleaving actually happened, **U** = unit, **UI** = client, **P** = re-run
behind PgBouncer transaction mode. Every I row runs for two businesses and roles OWNER, ADMIN, MANAGER, MEMBER
plus a unit-level custom principal where noted.

### 16.1 Security gates (entry criteria for enabling, G-S1..G-S6)

| Gate | Requirement | Tests |
|---|---|---|
| G-S1 | Cross-tenant denial on every route and table | T-01..T-06 |
| G-S2 | Record-scoped authority and no self-decision | T-10..T-19 |
| G-S3 | Field-level privacy and sticky sensitivity | T-20..T-27 |
| G-S4 | Ledger atomicity, idempotency and no overspend | T-40..T-49 |
| G-S5 | Append-only history and guards by direct SQL | T-50..T-56 |
| G-S6 | P3-C checklist §5 met | C-01..C-42 |

### 16.2 Rows

| Id | Scenario | Level | Pkg |
|---|---|---|---|
| T-01 | Business B's request, employee, type, policy, holiday ids in every path, body and filter → 404/400, nothing written | I | B1–B3 |
| T-02 | Direct SQL inserting cross-business composite references (request→employee, request→policy/type pair, day→request/employee, note→request, transition) → FK error | S | B1–B2 |
| T-03 | RLS forced and `tenant_isolation` on all new tables; `tests/isolation` coverage; schema test | S | B1–B2 |
| T-04 | Grants inventory: no DELETE/TRUNCATE; only listed column UPDATEs; no INSERT on transitions | S | B1–B2 |
| T-05 | Self routes with a user linked in business A calling business B's slug → 404 | I | B2 |
| T-06 | Leave tables used only by People (boundaries); no leave fields in non-People contracts; not in search index | U | B2 |
| T-10 | Role × endpoint matrix generated from §11.3 (incl. custom principal with `leave_approve` only, `leave_self` only) | I, U | B2–B3 |
| T-11 | Approver resolution: manager linked+active+key → routed; unlinked, suspended, terminated, MEMBER-role, no manager → leave managers; manager changed while pending → new manager decides, old gets 404 | I | B2–B3 |
| T-12 | Non-routed `leave_approve` holder cannot list, read or decide → 404 | I | B2–B3 |
| T-13 | Self-approval refused (403 `self_approval`) for: own submission; own linked employee; after re-linking the employee to the actor; leave manager on own request | I | B3 |
| T-14 | Sole-owner rule: allowed only with all conditions; refused with a second active `leave_manage` member, with a suspended second admin (allowed), without `selfApproval: true`; audit `selfApproved` | I | B3 |
| T-15 | Override by leave manager recorded with basis `LEAVE_MANAGER_OVERRIDE` | I | B3 |
| T-16 | Not-linked caller → 404 `not_linked` on every `/me` route; linked member removed mid-session → next call 404 | I | B2 |
| T-17 | Employee cancel only before start; after start 409 `invalid_transition` for self, allowed for approver | I | B3 |
| T-18 | On-behalf with `overrideNotice` bypasses notice/backdating only; never overlap, balance, policy, employment | I | B3 |
| T-19 | Terminated employee: submit 409, approve 409, reject/withdraw/cancel allowed; rehire restores | I | B2–B3 |
| T-20 | Team calendar for `people:read`: sensitive → "Away" with no type key in JSON; non-sensitive shows type; no notes, amounts or history | I | B2 |
| T-21 | Notes visible only to employee, routed approver, leave managers; absent (not null) otherwise; never in lists; direct SQL without the note setting returns no rows (D-P3-48) | I, S | B2 |
| T-22 | Type made non-sensitive after a sensitive request → that request stays redacted; made sensitive → all redacted | I | B2 |
| T-23 | Error bodies for invisible requests identical to unknown ids | I | B2 |
| T-24 | Audit content: no notes, names, type id for sensitive (replaced by `sensitive: true`) | I | B2–B3 |
| T-25 | Pending requests visible only to employee, routed approver, leave managers in team views | I | B2 |
| T-26 | Contract schemas for redacted views have no hidden keys (strict) | U | B2 |
| T-27 | N1 payload rule pre-check: no leave event type declares text (placeholder test until N1 exists) | U | B2 |
| T-30 | Duration: Mon–Fri week; custom week (Sun–Thu); weekend-only range → `zero_duration`; holiday business-wide and per location; holiday on weekend counted once (0) | U, I | B1 |
| T-31 | Half days: PM start, AM end, one-day halves, half on holiday → 0, FULL_DAY policy refuses halves | U | B1 |
| T-32 | HOURS: hours per day × work days; granularity HOUR/HALF/QUARTER; invalid multiples refused | U | B1 |
| T-33 | Leap day (2028-02-29), year boundary span, 366-day span accepted, 367 refused | U | B1 |
| T-34 | "Today" in Perth vs New York at UTC midnight boundaries for backdating and notice; business time zone change after submission leaves dates unchanged | I | B2 |
| T-35 | Waiting period from employee `start_date`; no `start_date` → `outside_employment` | U, I | B2 |
| T-36 | Policy applicability: no assignment, assignment change inside range, policy changed while pending → recompute and `amount_changed` | I | B2–B3 |
| T-37 | Client and server engines agree on a generated corpus (property test, same module) | U | B1 |
| T-39 | Leave-year boundary: request crossing CALENDAR, ANNIVERSARY and CUSTOM year starts refused; next-year request checked by the projection (§5.6 rule 8); per-employee pattern change mid-request counted per date; part-timer with a holiday on a non-work day; leap day inside a request and an ANNIVERSARY start on 29 February | U, I | B1–B3 |
| T-38 | Calendar changes after approval do not alter approved amounts | I | B3 |
| T-40 | Approve deducts once; entry has policy id/version, amount, effective date; balance after correct | I | B3 |
| T-41 | Two approvals of different requests against one balance (C, both orders): second `insufficient_balance`, one entry | C, P | B3 |
| T-42 | Same request approved twice concurrently: one success, one `stale`; one entry | C | B3 |
| T-43 | Approve vs withdraw, approve vs reject, cancel vs cancel races | C | B3 |
| T-44 | Replay: approve retried after commit → `stale`, no entry; submit with same `clientRequestId` → same request; different body → `idempotency_conflict` | I | B2–B3 |
| T-45 | Cancel posts one reversal of the exact deducted amount (after a rule change too); second cancel `invalid_transition`; direct SQL second reversal → unique violation | I, S | B3 |
| T-46 | Lock order: shipped paths mixed with policy archive, termination, assignment change and P3-C accrual — no `40P01`; a deliberately wrong order reproduces `40P01` (proves the test detects it) | C | B3 |
| T-47 | Fault injection after the ledger insert and before the request update → full rollback, no entry, no transition, no audit | I | B3 |
| T-48 | Entitlement NONE: approval posts no ledger entry; guard accepts it | I, S | B3 |
| T-49 | Auto-approval (no approval required) deducts on submit in one transaction | I | B3 |
| T-49a | Auto-approval with insufficient target-year funds (current year and next year) → `insufficient_balance`, nothing written | I | B3 |
| T-49b | Two concurrent auto-approved submissions (different dates) on one bucket: second sees the first's deduction; both orders | C, P | B3 |
| T-41a | Cross-year concurrency: approvals charged to the current and next year of one employee and type, both orders; year opening (carry-over) racing a next-year deduction; reversal into a closed year with carry-over correction | C | B3 (needs P3-C) |
| T-59 | Projection (§5.6 rule 8), unit on a fixed calendar: monthly/weekly/fortnightly accrual forecast through the dates; `maxBalance` cap mid-horizon; carry-over NONE/UNLIMITED/CAPPED at the boundary; grant at a new year; an approved later booking starved by an earlier request → refused; pending reservations at submission vs approval (D-P3-52); same-date tie order; horizon limit (D-P3-53); same inputs → same output | U | B1 (pure engine) / P3-C |
| T-60a | Submission with projected shortfall → accepted with warning; approval of it → `insufficient_balance` with projection; auto-approval with shortfall → refused at submit; real accrual and year opening later never double-count forecasts | I | B2–B3 |
| T-28 | Notes RLS by direct SQL as `bos_app` with `app.user_id` set to each viewer class (author, submitter, linked user, line manager, leave manager, unrelated MEMBER, MANAGER without reports): only allowed classes see rows | S | B2 |
| T-29 | Linked-self visibility and approver changes under concurrency: link moved to another user while a request is open; manager reassigned during a decision (both commit orders); approver suspended mid-inbox | C, I | B2–B3 |
| T-57 | Forged direct SQL as `bos_app`: status change with a false basis, with no `app.user_id`, by the requester; extra day rows in a later transaction; release on a live request; each refused | S | B2 |
| T-58 | Role lists in the migration match `ROLE_PERMISSIONS` for `leave_approve` and `leave_manage` | U | B2 |
| T-50 | Transition rows written only by the trigger; seq contiguous; cannot insert/update/delete as `bos_app` | S | B2 |
| T-51 | Every transition outside §7.2 refused by the guard (generated matrix) | S | B2 |
| T-52 | Immutable columns refused; version must be +1 | S | B2 |
| T-53 | Day rows: overlap via unique index (incl. concurrent submissions, C); release on terminal states; double release refused | S, C, P | B2 |
| T-54 | AM+PM halves of one date by two requests allowed; HOURS + half on same date refused | I | B2 |
| T-55 | Status change without `pending_actor_basis` refused | S | B2 |
| T-56 | Audit rows exact per action; none on rollback | I | B2–B3 |
| T-60..69 | UI tests in §14.4 | UI | B4 |
| E-1 | Journey: admin configures week + holidays → assigns policy → member submits → manager approves → balance drops → member cancels before start → balance restored; history shows every step | E2E (API+UI) | B4 |
| E-2 | Negative journey: MEMBER, MANAGER without reports, other business, stale tabs | E2E | B4 |

---

## 17. Implementation packages B1 to B4

Each: own thread, branch, draft PR, ChatGPT audit, merge verdict through the merge queue; migrations applied by
the Mac session under the protocol before merge. Ownership is by path to keep cross-PR conflicts minimal.

| Order | Package | Scope | Owned paths | Depends on | Migration | Entry criteria |
|---|---|---|---|---|---|---|
| 1 | **B1** Leave calendar and duration engine | `people_leave_calendars`, `people_employee_work_patterns`, `people_holidays`, guards, config API, pure engine in contracts, unit corpus; tests T-01..04 (B1 tables), T-30..33, T-37 | `prisma/schema/people-leave-calendar.prisma`, `modules/people/server/leave-calendar.ts`, `leave-duration.ts`, `contracts/src/people-leave-calendar.ts`, routes `people/leave-calendar`, `people/holidays` | P3-A; D-P3-17, 31, 32 (calendar parts), 36, 40, 46 | **Yes** (`B1` stamp after every stamp on `main` and open PRs at build time) | D-P3-40 accepted. **Parallel with P3-C.** |
| 2 | **B2** Requests, self-service and reads | permission keys (D-P3-26), `anyOf` route option + `requiresAny` (shared files, coordinated with #110), requests/days/transitions/notes tables and guards with ledger FK columns, authority resolver, submit (pending only) / withdraw / estimate / reads / team calendar, privacy projections; routes registered `available: false`; tests T-01..06, 10..12, 16, 19..27, 34..36, 44 (submit), 50..56 | `prisma/schema/people-leave-requests.prisma`, `modules/people/server/leave-authority.ts`, `leave-requests.ts`, `contracts/src/people-leave-requests.ts`, routes `people/me/leave/*`, `people/leave-requests` (GET), `people/leave/calendar`; shared: `permissions.ts`, `routes.ts`, `contracts/src/index.ts`, `api-v1.json`, `tenancy.prisma`, `people.prisma` (relations) | B1 merged; **P3-C merged and applied (§5)**; D-P3-12, 13/27, 22/38/43, 26, 30, 34, 35, 41, 45, 47, 48, 49 | **Yes** | §5 C-01..C-42 met |
| 3 | **B3** Decisions and ledger | approve/reject/cancel, on-behalf, auto-approval, sole-owner rule, idempotency, ledger calls, race and fault suite; tests T-13..15, 17, 18, 38, 40..49 | `modules/people/server/leave-decisions.ts`, routes `people/leave-requests/:id/*`, `people/employees/:id/leave-requests` | B2 merged and applied; D-P3-14/28, 29, 33, 42 | No (schema from B2) | T-41..T-47 pass on real PostgreSQL and PgBouncer before the merge verdict |
| 4 | **B4** Leave UI | §14 screens and tests; Zone gating `requiresAny`; on-behalf form; settings screens | `packages/app/src/zones/people/leave/*`, `people-zone.tsx` (tabs), `packages/app/src/api/people-leave.ts`, `shell/registry.ts` (one line) | B3 merged; D-P3-24, 39 | No | Contracts frozen from B3 |
| 5 | **Switch-on** | flip `available` for leave routes in production | config | B4 merged, E-1/E-2 pass, Regan's explicit decision (D-P3-44) | No | Escalation (feature enablement) |

Sequencing: B1 ∥ P3-C → B2 → B3 → B4 → switch-on. B4 can start against B3's contracts on a branch once B3's PR
is audited (UI work does not need B3 merged to begin, only to merge). Estimated size (assumption, not measured):
B1 ≈ 12–18 files; B2 ≈ 30–40 (largest test addition); B3 ≈ 10–15; B4 ≈ 15–25.

---

## 18. Migration plan, rollout and rollback

### 18.1 Migrations

| Migration | Package | Content | Stamp |
|---|---|---|---|
| `…_people_leave_calendar` | B1 | 2 tables, guards, RLS, grants | after every stamp on `main` and open PRs **at build time** (today that means after `20261207000000`; P3-C will take one too) |
| `…_people_leave_requests` | B2 | 4 tables, guards, transition trigger, unique occupancy index, RLS, grants, composite FKs to P3-C ledger entries | after P3-C's |

Both additive, one transaction each (`BEGIN/COMMIT`, STAB-M6), no privileged SQL, empty tables, no backfill, no
change to existing rows. Index builds on empty tables (no rehearsal required by the protocol's trigger list, but
the audit may ask for one).

### 18.2 Production steps (Mac session, per migration)

As `docs/agent-task-protocol.md` "Production migrations": fresh read-only `_prisma_migrations` (exactly the
expected one pending, checksums match) → `pre-p3b1-migration` / `pre-p3b2-migration` recovery branch recorded and
validated → evidence posted → `APPROVED — EXECUTE: MIGRATION` verdict naming the file (additive, delegated) →
`prisma migrate deploy` → verify (`migration-readiness.md` §5: forced RLS, grants, triggers, zero rows) →
merge through the queue under a separate merge verdict → smoke (`/api/v1/health`; leave routes answer 404 while
switched off).

**Escalation.** B1 is routine (additive configuration tables, no authorisation change). **B2 and B3 add new
permission keys and the first record-scoped authorisation rule in People**, so they get an enhanced security audit
(the G-S gates in §16.1 and T-57/T-58). Under the protocol they escalate to Regan only if that audit leaves an
**unresolved** authorisation or tenant-isolation risk; otherwise their migration and merge follow the normal
delegated verdicts. Activation (switch-on, D-P3-44) is always Regan's, as is any material risk ChatGPT marks as a
business-owner decision.

### 18.3 Rollout

1. B1 merged: configuration API live (harmless, no requests).
2. B2, B3 merged with routes off: no user-visible change.
3. B4 merged: tabs hidden while routes are off (client checks a capability flag from `GET /b/{slug}`).
4. Switch-on (Regan): enable for the business(es) he chooses first (recommendation: one test business).

### 18.4 Rollback

Code revert leaves tables unused. Switch-off (`available: false`) hides the feature without data loss. Approved
requests keep their ledger entries (consistent pair); no request is deleted. Dropping tables is destructive and
needs Regan's explicit approval; it is never needed to roll back.

---

## 19. Integration boundaries and risk register

| Boundary | Rule |
|---|---|
| People ↔ P3-C ledger | People-internal functions only (§5.3); ledger never reads requests; requests reference entries by composite FK |
| People ↔ Administration | Reads membership status and role in the unit of work; never changes memberships; member removal keeps clearing links (unchanged) |
| People ↔ Scheduling | None in P3-B; P3-E read-through projection (§13) |
| People ↔ Notifications | None in P3-B; N1 event types reserved; when N1 lands, an outbox row in the same transaction |
| People ↔ Search, Reporting | None; leave never indexed or aggregated in P3-B |
| `ON_LEAVE` employment status | Unchanged and independent; no automatic status change from requests |

| Risk | Likelihood | Mitigation |
|---|---|---|
| P3-C interface differs from §5.3 | Medium | C-42; amend this spec before B2 |
| `routes.ts` / `permissions.ts` conflict with #110 and others | Medium | B2 claims these early; one any-of/all-of design with #110 |
| Mislinked user sees another employee's leave | Low | linking is `people:manage`, audited; self view shows the linked employee's name prominently |
| Sole-owner rule abused by a second owner hiding admins | Low | condition 2 counts all active `leave_manage` holders; audit flag; Regan can disable (D-P3-28) |
| Approver race with a reporting-line change | Low | re-check after the request lock; accepted window documented |
| Projection differs from what is later earned (rule change, termination, pattern change) | Medium (product) | approvals are never revisited; shortfall shows as a negative bucket to leave managers; adjustments correct it (D-P3-50) |
| Large month grid performance | Low | ≤ 62 days, paged by employee, indexed by `(business_id, status, start_date)` |
| Production state unverified in this PR | — | fresh read-only check before any B-package migration (protocol step 1) |

### Documentation checks run for this PR

- Every cited file and line checked on `main` at `84271b3` (`permissions.ts`, `routes.ts:51-54,236-240`,
  `registry.ts:68,119`, `people-leave.ts:44-62,91-101`, `people/server/members.ts`, `tenancy/server/members.ts`,
  `20261118000000_people/migration.sql:200,283`, `20261204000000_people_leave_policies`).
- Open PRs and their migration stamps read from GitHub on 2026-11-17 (#97 `20261206000000`, #110 `20261207000000`;
  no P3-C PR or branch).
- Production `_prisma_migrations` **not** read (no production access from this thread; Mac read not run).
