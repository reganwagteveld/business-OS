# People P3-C: leave balance ledger (architecture specification)

> **Version 1.0 (P3-C-0), 2026-11-17. Status: proposed, architecture and audit only.** Written against Regan's
> brief v1.1 (17 November 2026). No code, schema, migration, route, contract, pull request or production action
> comes with it. Nothing here authorises implementation: every package in §K needs the gate in §M first.
>
> **Base:** `main` at `06405a5` (2026-11-17). P3-B is read from **draft PR #116, head `ed88385` (v1.5), not merged**.
> Statements marked **verified** cite a file on `06405a5` (or on `ed88385` for P3-B). Statements marked
> **(proposal)**, **(recommendation)** or **(assumption)** are not facts about the code.
>
> **Version 1.2 (2026-11-17)** after ChatGPT's CONDITIONAL PASS of `9fc9751` (comment 6948953102 on #116): five
> corrections (type-aware RLS staged in C1, authority vs integrity for derived postings, constraint reconciliation,
> complete compute-on-read contract, commit-aware sealing and the back-fill as a data transformation). Index in
> handoff H-5. Design changes are limited to those points.
>
> **Version 1.1 (2026-11-17)** after ChatGPT's dependency triage on #116: adds the audit handoff (decision status
> split, dependency table on the accepted P3-B contract, options records for the open choices). No design change.
>
> **Owner decisions accepted in the brief (binding here): D-P3C-01 to D-P3C-06** (§B). They change two things P3-B
> v1.5 assumes: the ledger quantity becomes **hours** (D-P3C-01), and approval **reserves** instead of deducting
> (D-P3C-02). §B.3 lists every resulting amendment to P3-B; P3-B must be amended before its B2/B3 packages start.

## Contents

- [Audit handoff (v1.1, corrections v1.2)](#audit-handoff-v11)
- [A. Repository evidence and implementation inventory](#a-repository-evidence-and-implementation-inventory)
- [B. Decision register](#b-decision-register)
- [C. Domain model and proposed Prisma schema](#c-domain-model-and-proposed-prisma-schema)
- [D. Ledger transaction and event catalogue](#d-ledger-transaction-and-event-catalogue)
- [E. Leave lifecycle state diagrams](#e-leave-lifecycle-state-diagrams)
- [F. Balance equations with worked examples](#f-balance-equations-with-worked-examples)
- [G. Accrual engine](#g-accrual-engine)
- [H. API, service and payroll-facing contracts](#h-api-service-and-payroll-facing-contracts)
- [I. Access, security and concurrency threat matrix](#i-access-security-and-concurrency-threat-matrix)
- [J. Migration, replay and reconciliation plan](#j-migration-replay-and-reconciliation-plan)
- [K. Test matrix and acceptance criteria](#k-test-matrix-and-acceptance-criteria)
- [L. Phased implementation plan P3-C1 to P3-C6](#l-phased-implementation-plan-p3-c1-to-p3-c6)
- [M. Unresolved decisions, readiness assessment and blockers](#m-unresolved-decisions-readiness-assessment-and-blockers)

---

## Summary

- **One append-only ledger, in hours, per employee and leave type.** Every quantity that changes a balance is an
  immutable entry with a signed `numeric(12,4)` hour amount, a business-local `applies_on` date (when it counts),
  a `recorded_at` instant (when we knew), the policy version that produced it, the actor and basis taken from the
  database session, a reason, a source reference and an idempotency key. Corrections are new entries linked to
  what they reverse. Nothing is updated or deleted.
- **Two books, so a reservation is never a debit.** The `BALANCE` book holds what is earned and consumed. The
  `RESERVED` book holds approved-but-not-yet-taken hours. Approval writes to `RESERVED` only. When a leave date
  arrives, one transaction moves that date's hours out of `RESERVED` and out of `BALANCE` together
  (`CONSUMPTION` + `RESERVATION_RELEASE`), so approved-then-taken leave is debited exactly once.
- **Lazy, deterministic catch-up instead of jobs.** Accrual and consumption are posted by an idempotent
  "bring up to date" step that runs inside any ledger write under the account lock, keyed by period and by date,
  so posting late gives exactly the same entries as posting on time. Reads compute the not-yet-posted part
  without writing. No cron, worker or scheduler (enabling one is Regan's decision).
- **Leave-year buckets (D-P3-45) and the date-ordered projection (D-P3-50, D-P3-52..54) are kept**, with
  "booking" now meaning "reservation". **Balances are always sums of entries**; nothing stored can drift.
- **Correctness lives in PostgreSQL:** forced RLS and composite tenant keys on every table, guard triggers that
  check sign, book, bucket, linkage and actor, unique indexes that make every posting idempotent, one
  `FOR UPDATE` account row that serialises all changes to one employee's balance of one type.
- **Payroll-ready, not payroll.** Hours only; no money, rates or liability in People. A read-only movement feed,
  external references and a reconciliation workflow are specified; nothing is built until a payroll stage is
  approved.

**Readiness (detail in §M): P3-C1 is CONDITIONALLY READY.** Its scope (schema and posting primitives, no accrual,
no routes) depends on nothing unbuilt. It may start only after the ChatGPT architecture audit of this spec,
Regan's implementation authorisation, acceptance of the decisions that shape C1's schema (D-P3-25 rule 1 and
D-P3C-09, -10, -27, -29 in §M.2), and a fresh migration-order check at build time. P3-C2 onward are **BLOCKED** on the hours source (B1 work patterns), the
D-P3C-03 interpretation and the P3-B amendment.

---

## Audit handoff (v1.1)

Added after ChatGPT's "P3-C dependency triage" comment on #116 (2026-11-17 12:53 UTC). There is no PR, by Regan's
instruction in this thread (brief v1.1: "Do not create or merge pull requests"). The reviewable repository document
is this file on branch `claude/project-thread-3feuws`; its exact commit is given in the thread reply that hands it
over (v1.0 was `90e1284`). Base `main` `06405a5`. Nothing here authorises implementation, migrations, imports,
back-fills, schedulers, permissions or production actions.

### H-1. Status of every decision this spec relies on

| Group | Items | Status | Audit may |
|---|---|---|---|
| **Accepted owner decisions (settled, not reopened)** | D-P3C-01..06; D-P3-1..11; D-P3-45; D-P3-50 (revised); D-P3-52; D-P3-53; D-P3-54 | ACCEPTED | check that the design implements them |
| **C1 schema choices (technical)** | D-P3C-09 account lock anchor; D-P3C-10 no stored totals; D-P3C-27 `effective_from` back-fill; D-P3C-29 `numeric(12,4)` and cumulative rounding; D-P3C-33 snapshot seals; D-P3C-34 RLS staged in C1 | PROPOSED, technical | accept or change under the delegation policy (the back-fill itself still needs its own migration evidence and verdict) |
| **C1 choices (owner/security)** | D-P3C-32 trust boundary for derived postings; D-P3C-35 inferred revision dates (only if a time-zone change is found) | OPEN | recommend; Regan decides |
| **C1 schema choice (owner)** | D-P3-25 rule 1 (revisions get `effective_from`) and rules 2–5, 7 | PROPOSED since P3-A; owner | recommend; Regan (or a ChatGPT owner decision record) decides |
| **Other technical choices** | D-P3C-08, -26, -30 | PROPOSED, technical | accept or change |
| **Owner choices, consequential** | D-P3C-07 (meaning of D-P3C-03's override), D-P3C-23 (days-to-hours), D-P3C-17 (termination), D-P3C-18 and -19 (second approver, self-correction) | OPEN, options in H-3 | recommend; Regan decides |
| **Owner choices, other** | D-P3C-11, -12, -13, -14, -15, -16, -20, -21, -22, -24, -25, -28, -31 | OPEN (§M.2) | recommend; Regan decides |

### H-2. Dependencies on the accepted P3-B contract (#116 at `ed88385`)

"Unchanged" means P3-C implements the P3-B text as written. "Restated" means same invariant, P3-C names. "Amended"
means the accepted owner decisions D-P3C-01 or D-P3C-02 force a change to P3-B text; none reopens a P3-B decision.

| # | P3-B reference | What P3-C relies on | P3-C treatment | Cause |
|---|---|---|---|---|
| P-01 | §5.6 r.1, §9.6, D-P3-45 | Leave-year buckets; a request never crosses a leave-year boundary; charged to the year of its dates | Unchanged (§C.4, §D.1) | — |
| P-02 | §5.6 r.2 | Year opening: grant and carry with rules in force at the boundary; old bucket locked first | Unchanged; lapse now posted as `EXPIRY`; negative closing is D-P3C-11 (open) | — |
| P-03 | §5.6 r.3 | Future buckets hold bookings only; nothing in a bucket is a forecast | Restated: `FUTURE` buckets hold `RESERVED`-book entries only (§E.3, I-5) | D-P3C-02 |
| P-04 | §5.6 r.4, C-24 | All changes to one employee and type serialise; buckets ascending; no People lock after the ledger | Restated and strengthened: account row first, then buckets ascending (§I.4) | D-P3C-09 (T) |
| P-05 | §5.6 r.5 | Accrual into the current bucket only | Unchanged (§G.4) | — |
| P-06 | §5.6 r.6, C-22 | Reversal into the original bucket, carry correction forward | Unchanged; multi-year rule completed (§G.7) | D-P3C-31 (T) |
| P-07 | §5.6 r.8a, T-59a | **Replay invariant**: each quantity from one source by date; every approved booking counted once | Restated for reservations: start value = realised `BALANCE` (consumed dates ≤ today); events = unsettled reservation dates after today (§F.5, I-2, V-10). Invariant unchanged | D-P3C-02 |
| P-08 | §5.6 r.8b, D-P3-53 | Booking window (current or next leave year, new requests only); horizon never cut | Unchanged | — |
| P-09 | §5.6 r.8c | Accrual basis separate from leave duration; forecast with today's rules and basis | Unchanged; both expressed in hours (§G.3) | D-P3C-01 |
| P-10 | §5.6 r.8d, D-P3-52, D-P3-54 | Decision order; pending reserve provisionally at submission only; warn at submission, refuse at approval and auto-approval | Unchanged; "debit at approval" becomes "reserve at approval" | D-P3C-02 |
| P-11 | C-20 `lockBucket` | Lock, open missing buckets, accrue up to date | Restated as `withAccount` (§H.1) | D-P3C-09 |
| P-12 | C-21 `postDeduction` | Post into the target-year bucket after the projection fits | **Amended** to `reserve` (per-date `RESERVATION`, no `BALANCE` debit until the date) | D-P3C-02 |
| P-13 | C-22 `postReversal` | Undo an approval | **Amended** to `release` (future dates) and `reverseConsumption` (taken dates, when recorded as not taken) | D-P3C-02 |
| P-14 | C-23 `bucketSummary` | Read-only figures plus P3-B's pending figure | Restated as `balances()` with `Pd` from P3-B (X-05) | — |
| P-15 | C-25 | Entitlement `NONE`: no ledger, no projection | Unchanged | — |
| P-16 | C-26 `project` | Date-ordered simulation, pure, advisory outside the lock, authoritative inside | Unchanged contract; inputs restated (P-07) | D-P3C-02 |
| P-17 | C-12, C-13 | One deduction and one reversal per request (source uniqueness) | Restated per date: one reservation per request and date; one release and one consumption per reservation date (§D.3) | D-P3C-02 |
| P-18 | C-14 | Entry fields: amount, unit, policy, version, `effective_date`, `applies_on`, leave year | **Amended**: hours only (no unit per entry), `applies_on` + `leave_date` + `recorded_at` (§C.6) | D-P3C-01, -02 |
| P-19 | §6.3 | `requested_amount`, `approved_amount` in policy units; `deduction_entry_id`, `reversal_entry_id` | **Amended**: hours (+ display days); `reservation_transaction_id`, release/reversal transaction ids (R-02, R-03) | D-P3C-01, -02 |
| P-20 | §10.2 | Global lock order | **Amended**: insert the account row between occupancy rows and buckets (X-04) | D-P3C-09 |
| P-21 | §10.3 step 9, cancel path | Approval and cancellation sequences | **Amended**: `reserve` / `release` / `reverseConsumption` | D-P3C-02 |
| P-22 | §6.8, D-P3-51 | Actor from the session user; basis re-derived in SQL | Reused for ledger actors and correction authority (§I.2) | — |
| P-23 | §8.2, D-P3-27 | Eligible line manager resolved on business today | Reused for manager balance visibility (§I.3) | D-P3C-06 |
| P-24 | §6.1a, §9.2, §9.2a | Work patterns, duration engine per date | Required for hours (X-01, X-02); must add ordinary weekly hours | D-P3C-01 |
| P-25 | §7.2 | Whole-request cancellation only | Unchanged; partial cancellation is D-P3C-14 (open) | — |

P3-B amendment needed before its B2/B3 packages: P-12, P-13, P-18, P-19, P-20, P-21 and the X-02 column on work
patterns. Until then the two specs disagree on approval semantics and this spec follows the accepted D-P3C-02.

### H-3. Options records for the consequential open choices

**D-P3C-07: meaning of D-P3C-03's "explicit audited policy override".** D-P3C-03 itself (deny by default, allow
only by explicit audited override) is accepted and not reopened; only which mechanism counts as "the override" is
open.

| Option | Mechanism | Schema impact | Audit trail | Fits D-P3-54? |
|---|---|---|---|---|
| **A (recommended)** | The policy's `negative_balance_limit` (P3-A, default 0). Setting it above 0 is the override; employees on that policy may go to −L | None (exists, E-02) | P3-A revision (full rules, actor, time) + `people.leave_policy.updated` audit | Yes |
| B | A, plus a per-employee, time-limited negative allowance granted by OWNER/ADMIN with a reason | New table `people_leave_negative_allowances` (C3 or later) | Own audit action; reason restricted | Yes (it is a grant, not an approver override) |
| C | Per-request override at approval by an authorised person with a reason | Flag + reason on the reservation transaction | Per-decision audit | **No**: D-P3-54 says no approver override of a shortfall |

**D-P3C-23: days-to-hours conversion for DAYS policies.**

| Option | Rule | 20 days for 38 h / 5 days | 20 days for 22.8 h / 3 days | Consequence |
|---|---|---|---|---|
| **A (recommended)** | days × (ordinary weekly hours ÷ 5) | 152 h (4 weeks) | 91.2 h (4 of their weeks) | Pro rata by FTE; same weeks off for everyone |
| B | days × average hours of the days actually worked | 152 h | 152 h (≈ 6.7 of their weeks) | A "day" means one of the employee's own working days; more hours for people who work fewer, longer days |
| C | Configurable per policy (adapter parameter) | either | either | Needs a P3-A vocabulary field; defer |

Either A or B is a product rule in the core adapter, not law. Needs ordinary weekly hours (X-02).

**D-P3C-17: balance at termination (answers D-P3-8).**

| Option | Ledger effect | Payroll | Consequence |
|---|---|---|---|
| **A (recommended)** | Accrue to the end date, release future reservations, freeze the bucket; balance kept | `PAYOUT` recorded only when payroll confirms, with its reference | No automatic financial effect; nothing lost |
| B | Forfeit (post `EXPIRY` for the balance) | none | Loses entitlement silently; often unlawful for paid leave |
| C | Compute a payout automatically | needs pay rules | Pay calculation is out of scope (D-P3-4) and an external effect |

**D-P3C-18 and D-P3C-19: second approver and self-correction.** D-P3C-04 (who may correct; reason, audit and
reversal linkage mandatory) is accepted and not reopened; the open part is whether a second person is also needed.

| Option | Second approver | Schema impact | Consequence |
|---|---|---|---|
| A | Never | none | Simplest; relies on reason + audit |
| **B (recommended)** | For opening-balance imports and payouts, when a second authorised person exists; corrections single-actor | Import batches already stage (C.10); `checked_by_user_id` on transactions | Guards the two bulk or money-adjacent actions without slowing routine fixes |
| C | For every manual posting | C.11 proposals table | Strongest; blocks one-admin businesses unless a sole-authoriser exception |

Self-correction (D-P3C-19, recommended): never on one's own account, except a sole authorised person in the
business, flagged and audited (P3-B D-P3-28 pattern).

**C1 schema choices (technical, for the audit):** D-P3C-09 (account row as the lock anchor vs current-year bucket
first), D-P3C-10 (no stored totals vs trigger-maintained totals), D-P3C-27 (back-fill `effective_from` in the
migration, rehearsed, vs null meaning "from creation"), D-P3C-29 (`numeric(12,4)` hours with an exact engine and
cumulative half-even rounding vs P3-A's `numeric(9,4)`). Recommendations and reasons in §M.2.

### H-5. v1.2 corrections for the audit of `9fc9751` (comment 6948953102 on #116, CONDITIONAL PASS)

| # | Audit finding | Correction | Where |
|---|---|---|---|
| 1 | Read privacy not type-aware; employee-level policy cannot separate balances from detail | Table-level split (balance level vs detail level); `people_leave_can_read(employee, type, sensitive, level)`; entry `sensitive` snapshot; policies shipped fail closed in C1, manager branch C4, grant branch C5; manager row of the matrix revised (D-P3C-25 options); direct-SQL tests incl. scope change and revocation | §C.6, §I.3, §J.1, T-C42a..c, D-P3C-25, -34 |
| 2 | Derived postings: integrity checks are not authority | Kind/basis matrix; no API input reaches a derived kind; SQL-verified pair and closing invariants; `ACCRUAL`/`GRANT` amounts stated as trusted application behaviour with detection; stronger privileged option offered; C1 stage gate refuses request and manual kinds (no claimed request backstop) | §I.2, §I.2a, T-C09c, D-P3C-32 |
| 3 | Constraints vs catalogue | Negative carry in `YEAR_OPEN` allowed via pair and closing invariants without deciding D-P3C-11 (`WRITE_OFF` reserved, refused until decided); conditional leave-date CHECK with the reversal rule; bidirectional consumption ⇔ release(CONSUMED) deferred check with matching fields; `release_reason` column | §C.6, §D.1, §G.6, T-C09..T-C09b |
| 4 | Compute-on-read incomplete | One `plan()` for reads and writes; complete virtual event set (year close/open, carry, lapse, grant, accrual, max-balance expiry, consumption, freeze) with per-date order; equality guarantee; projection never re-forecasts a virtually realised boundary | §F.1, §G.9, §I.4, T-C21a..c |
| 5 | `recorded_at` is transaction start; back-fill infers dates | `recorded_at` informational; commit-aware seals with `recorded_xid` + stored `pg_snapshot`; delayed-commit test. Back-fill marked `INFERRED`, never governs a posting (cutover ≥ apply + 1 day); whole-database visibility (NO FORCE during the update, count assertion), lock and statement limits, preflight and rehearsal evidence; classified as an existing-data transformation | §F.1a, §H.4, §J.2, §J.3, T-C63, T-C64, D-P3C-33, -35 |

Also: D-P3C-21 and D-P3C-31 reclassified as owner choices (they change carry and grant outcomes); the days-to-hours
options are described as different meanings of a policy day, without a value judgement.

### H-4. Requested audit scope

Independent security, tenant-isolation and concurrency review before any P3-C1 work: §C (schema, constraints,
grants, RLS), §D.3 (idempotency), §F.4 (invariants), §I (authority, visibility, lock order, threat matrix), §J.2
(back-fill under the revision guard) and the P3-B dependency table H-2. For the re-audit of v1.2: the five
corrections indexed in H-5, chiefly §C.6, §F.1a, §G.9, §I.2a, §I.3 and §J.2.

---

## A. Repository evidence and implementation inventory

All paths are relative to the repository root on `main` at `06405a5` unless stated.

### A.1 Classification

| # | Dependency | Classification | Evidence |
|---|---|---|---|
| E-01 | Leave types, policies, revisions, assignments (P3-A) | **Implemented** (merged #68, applied in production 2026-11-16 per `docs/people-leave-p3.md` §6) | `apps/api/prisma/schema/people-leave.prisma:13,45,100,118`; migration `apps/api/prisma/migrations/20261204000000_people_leave_policies/migration.sql` |
| E-02 | Policy rule vocabulary (unit, entitlement, accrual frequency, leave year, carry-over, max, negative limit) | **Implemented** | `people-leave.prisma:55-72`; CHECKs `migration.sql:176-213` |
| E-03 | Policy unit `DAYS` or `HOURS`, fixed per policy | **Implemented**; conflicts with D-P3C-01 unless converted (§B.3 R-01) | `migration.sql:178` CHECK, guard `migration.sql:283` (PE004) |
| E-04 | Revision `effective_from` date (D-P3-25 rule 1) | **Missing** (revisions carry `recorded_at` only) | `people-leave.prisma:100-106`; revision guard `migration.sql:329-344` refuses every UPDATE |
| E-05 | Revision integrity (rules derived by the database, append-only) | **Implemented** | `migration.sql:322-359` |
| E-06 | Assignment history, one open row per employee and type, no overlap | **Implemented** | `migration.sql:222` (open index), `366-406` (guard PE011) |
| E-07 | Employee identity, optional link to a member | **Implemented** | `apps/api/prisma/schema/people.prisma:65,83,92` (composite FK to `memberships`) |
| E-08 | Employment start, end and status | **Implemented**; `start_date` is reset on rehire, locked once employment began | `people.prisma:77-80`; `apps/api/src/modules/people/server/lifecycle.ts:67-80`; `employees.ts:176-177`; CHECKs `migrations/20261118000000_people/migration.sql:255-257` |
| E-09 | Employment type (FULL_TIME, PART_TIME, …) | **Implemented**, descriptive only | `people.prisma:12-19,74` |
| E-10 | Ordinary hours, FTE, hours per day | **Missing** in the schema. **Documented only** as P3-B B1 `people_employee_work_patterns.hours_per_day` | PR #116 `docs/people-leave-p3b-architecture.md` §6.1a |
| E-11 | Business work week and public holidays | **Documented only** (P3-B B1, not built) | PR #116 §6.1, §6.2 |
| E-12 | Leave requests, approvals, occupancy, transitions | **Documented only** (draft PR #116, not merged, not audited to merge) | PR #116 §6.3–§6.6, §7, §10 |
| E-13 | Ledger, balances, buckets, accrual | **Missing** (no table, branch or PR) | `git ls-tree` of `apps/api/prisma/schema` on `06405a5`; no remote branch matching `p3-c` or `ledger` |
| E-14 | Permission keys for leave (self, approve, manage) | **Documented only** (D-P3-12 proposal, P3-B §11.1) | `apps/api/src/modules/access/server/permissions.ts:44,87` (People has four keys only) |
| E-15 | Record-scoped authorisation | **Missing**: `can()` ignores its resource argument | `permissions.ts:162-166` |
| E-16 | Any-of permission on a route | **Missing** (one key per route); P3-B D-P3-26 proposes it | `apps/api/src/app/api/_lib/routes.ts:199,212,238` (`permission: Permission`, one key) |
| E-17 | Per-member grants ("explicitly authorised People manager", D-P3C-04) | **Missing**; custom roles not proposed (D-A2-1) | `docs/settings-a3-architecture.md:271` |
| E-18 | Maker-checker / four-eyes control | **Missing**; only an open finance question | `docs/finance-data-model.md:574` (FD-P2) |
| E-19 | Forced RLS with `tenant_isolation` policy | **Implemented** (pattern) | e.g. `migration.sql:423-440` (P3-A) |
| E-20 | Tenant session context (`app.business_id`, `app.user_id`) | **Implemented** | `apps/api/src/core/db/with-tenant.ts:118-122` |
| E-21 | Transaction isolation | **Implemented: READ COMMITTED only** (the type admits no other level) | `with-tenant.ts:50,128` |
| E-22 | Conflict retry (`40P01`, `40001`, `55P03`) | **Implemented** (opt-in per route) | `routes.ts:118-119,219-222,251,293` |
| E-23 | Optimistic versions (+1 guard) and `BUMP` helper | **Implemented** | `apps/api/src/modules/people/server/shared.ts:11`; guards PE009 `migration.sql:244,286` |
| E-24 | Transaction-scoped advisory lock (People reporting lines) | **Implemented** | `migrations/20261118000000_people/migration.sql:302`; `shared.ts:45-51`; `lifecycle.ts:57,145` |
| E-25 | Business-local "today" and effective dates | **Implemented** | `shared.ts:24,35` (`businessToday`, `effectiveDateOf`) |
| E-26 | Exact decimals | **Implemented** (`Prisma.Decimal`) | `apps/api/src/core/db/decimal.ts:6-7` |
| E-27 | Audit log, actor bound to the session user by RLS | **Implemented** | `apps/api/src/core/audit/index.ts:8-18`; policies `migrations/20261113150000_tenancy/migration.sql:162-168` |
| E-28 | Idempotency key + request hash pattern | **Implemented in Finance**, not in People | `migrations/20261115000000_finance/migration.sql:110,163,471,517-518` |
| E-29 | Reversal-with-reason pattern | **Partial precedent** (Finance payments: status `REVERSED` + reason, not an append-only reversal entry) | `migrations/20261116000000_finance_payments/migration.sql:16-18,70-73` |
| E-30 | Isolation and integration test infrastructure, PgBouncer re-run | **Implemented** | `apps/api/tests/isolation/`, `apps/api/tests/integration/people-leave.test.ts`; P3-A doc §5 |
| E-31 | Jobs role `bos_jobs` | **Implemented, unused by People**; all jobs and cron switched off | `migrations/20261118000000_people/migration.sql:436`; `docs/active-workstreams.md` |
| E-32 | Notifications for leave | **Documented only** (N1 reserves `people.leave.*`, class `PEOPLE`, ids only) | `docs/notifications-n1-architecture.md:165,169` |
| E-33 | Payroll | **Missing**. N1 reserves a `PAYROLL` sensitivity class name only | `notifications-n1-architecture.md:169`; `packages/contracts/src/people.ts:6` (payroll excluded) |
| E-34 | Production migration history | **Unverified in this thread** (no production access from the cloud). Last recorded on `main`: 24 migrations through `20261206000000_search_indexes` (commit `06405a5` title) | protocol "Production migrations" step 1 must run before any C-package migration |
| E-35 | Migration stamps | Newest on `main`: `20261206000000`. In open PRs: `20261207000000_workflow_links` (#110). No other open PR adds a migration (checked #113, #114, #117–#123 changed files) | `git diff --name-only origin/main...<branch>` per open PR, 2026-11-17 12:25 UTC |

### A.2 What this means

- Everything P3-C needs from **P3-A exists**, except the revision `effective_from` date.
- Everything P3-C needs from **P3-B is a proposal in an unmerged draft**: requests, the duration engine, work
  patterns, holidays and the permission keys. P3-C treats them as dependencies with a stated contract (§H.2),
  not as facts.
- Two infrastructure items D-P3C-01 and D-P3C-04 require do not exist anywhere: an **hours-per-day source** per
  employee (E-10) and **per-member authorisation grants** (E-17).
- The repository's concurrency toolkit (READ COMMITTED, `FOR UPDATE`/`FOR SHARE`, guard triggers, partial unique
  indexes, conflict retry, deterministic race tests) is enough; P3-C needs no SERIALIZABLE transactions and no
  extensions.

---

## B. Decision register

### B.1 Accepted owner decisions (brief v1.1, 2026-11-17)

| Id | Decision | Status | How this design implements it |
|---|---|---|---|
| D-P3C-01 | Hours are the canonical balance quantity; days are displayed using applicable employment rules | **ACCEPTED** | Every ledger amount is hours (`numeric(12,4)`). DAYS policies are converted at posting time with the hours-per-day in force on the date (§G.3); display days are derived, never stored as balances (§F.6) |
| D-P3C-02 | Submitted requests remain pending; approved future leave reserves available hours without immediately consuming them | **ACCEPTED** | Submission posts nothing. Approval posts `RESERVATION` entries (per date) to the `RESERVED` book. Consumption happens per leave date (§D, §F.3) |
| D-P3C-03 | Negative balances denied by default, with explicit audited policy override | **ACCEPTED** (interpretation needs confirming, D-P3C-07) | Default limit 0 (P3-A already defaults `negative_balance_limit` to 0). The override is the policy's own limit, configured explicitly and audited; optional per-employee grant in §M.2 |
| D-P3C-04 | Corrections restricted to Owner/Admin or an explicitly authorised People manager, with mandatory reason, audit and reversal linkage | **ACCEPTED** | Correction transactions require `people:leave_manage` (OWNER, ADMIN) or an active `LEAVE_CORRECT` grant (§I.2); reason code and text mandatory (CHECK); every correction references the entry it reverses (FK + guard) |
| D-P3C-05 | Accrual is policy-defined, deterministic, idempotent and supports backdated reconciliation | **ACCEPTED** | §G: pure engine over (policy revision, hours basis, dates); one entry per period, unique per period; backdated changes produce linked correction entries, never edits |
| D-P3C-06 | Employees see their own balances, authorised managers see relevant employees, administrators see permitted business-wide records | **ACCEPTED** | §I.3 visibility matrix enforced in the service and backed by a data-derived restrictive RLS policy on balance reads |

### B.2 Earlier decisions this design keeps

| Id | Source | Kept as |
|---|---|---|
| D-P3-1 | P3-A doc §3.2 (approved) | P3-C before P3-B's approval packages |
| D-P3-2..11 | P3-A doc §3.1 (approved) | Unchanged; D-P3-8 (balance at termination) is answered in D-P3C-17 |
| D-P3-45 | PR #116, owner decision record 2026-11-17 | Every reservation, consumption and reversal is charged to the leave year of its date; a request may not cross a leave-year boundary |
| D-P3-50 (revised), D-P3-52, D-P3-53, D-P3-54 | PR #116, owner decision records 2026-11-17 | Projection through the leave dates, decision order, booking window, warn-at-submission. "Booking" now reads "reservation" (§F.5) |
| D-P3-25 rules 1–5, 7 | P3-A doc §4.7 (**proposed**, not accepted) | Adopted as P3-C's rules for which policy version governs a date; rule 6 superseded by D-P3-45 and D-P3C-02. Needs acceptance (§M.2) |

### B.3 Reconciliation with P3-A and P3-B (conflicts flagged, nothing overridden silently)

| # | Earlier text | Conflict with brief v1.1 | Resolution in this spec | Who decides |
|---|---|---|---|---|
| R-01 | P3-A D-P3-4: policy unit DAYS or HOURS, amounts in that unit | D-P3C-01 hours canonical | P3-A stays as configured. Policy amounts are **inputs**; the ledger converts DAYS to hours at posting with the hours-per-day of the date (§G.3). No P3-A change | Technical (audit) |
| R-02 | P3-B D-P3-20 / §5.3 C-21 `postDeduction` at approval; §10.3 step 9 | D-P3C-02 reserve, do not consume | C-21 becomes `reserve()`; P3-B `deduction_entry_id` becomes `reservation_transaction_id`; cancellation calls `release()` (future dates) and, for past dates, `reverseConsumption()` (§H.1) | **P3-B amendment required** before B2 |
| R-03 | P3-B §6.3 `requested_amount`/`approved_amount` in the policy unit | D-P3C-01 | Requests store hours (`requested_hours`, `approved_hours`) and, for display, the day count the engine derived. Per-date hours are part of the reservation (§C.6) | P3-B amendment |
| R-04 | P3-B §5.6 rule 8a "the start value counts deductions with `applies_on` ≤ today" | Approval no longer debits | Start value = realised `BALANCE` book; future reservations are the debit events. Same no-double-count invariant, restated in §F.5 | Technical |
| R-05 | P3-A doc §3.2 D-P3-21 "accrue up to date, run on balance read" | A read that writes contends for locks and turns GETs into writes | Reads **compute** unposted accrual and consumption; only write transactions post them (D-P3C-08) | Technical (audit) |
| R-06 | P3-B §5.6 rule 2 "expiry is not in P3-A's vocabulary, so none" | Brief asks for expiry | `EXPIRY` entry kind exists. The only automatic expiry is what P3-A already defines: balance above the carry-over cap (or all of it under carry-over `NONE`) lapses at the year boundary and is now posted explicitly (§D). Date-based expiry of carried leave needs a P3-A vocabulary extension (owner decision D-P3C-15). Manual expiry is a correction | Owner |
| R-07 | P3-A D-P3-4 "Not included: payout on termination, pay calculations" | Brief asks for payout | `PAYOUT` records **hours** paid out by an external payroll, with its reference. No pay calculation, no money (§H.4) | Owner (D-P3C-17) |
| R-08 | P3-B D-P3-54 "no approver can override a shortfall in P3-B" | D-P3C-03 "explicit audited policy override" | Read as policy-level allowance (consistent). A per-employee override grant is offered as an option, never a silent per-request override | Owner (D-P3C-07) |
| R-09 | P3-B D-P3-30 no editing of requests; whole-request cancellation only | Brief asks for editing and partial leave | Editing stays "withdraw or cancel, then resubmit". Partial **cancellation of remaining dates** (early return) is supported by the ledger (`release` per date) but needs a P3-B transition; recorded as dependency D-P3C-14 | Owner + P3-B |
| R-10 | P3-B §9.2a "anniversary on 29 February … P3-C to confirm" | — | 1 March in non-leap years (D-P3C-16) | Owner |
| R-11 | P3-B §6.1a work patterns are a B1 deliverable, "parallel with P3-C" | Hours conversion needs them before accrual | Work patterns (with ordinary hours) must merge **before P3-C2** (§L). B1 cannot remain fully parallel (D-P3C-12) | Owner (sequencing) |
| R-12 | P3-B §5.6 rule 4 "lock the current-year bucket first" | The "current year" changes at midnight and differs by policy; a missing bucket cannot be locked | One **account** row per employee and type is locked first, then buckets in ascending year (D-P3C-09). Strictly stronger; C-24 still holds | Technical (audit) |
| R-13 | P3-B §11.1 introduces the leave permission keys in B2 | P3-C read routes come first | The keys and the any-of route option move to **P3-C4** (shared with P3-B; B2 reuses them) (D-P3C-13) | Technical + owner (permission change) |

### B.4 New proposals

Listed with recommendations in §M.2 (D-P3C-07 to D-P3C-31). Technical items may be accepted by ChatGPT under the
delegation policy; owner items need Regan.

---

## C. Domain model and proposed Prisma schema

### C.1 Concepts

| Concept | Meaning | Stored as |
|---|---|---|
| **Account** | One employee's balance of one leave type. The lock anchor | `people_leave_accounts` |
| **Service period** | One continuous employment (a rehire starts a new one) | `service_period` number on buckets, from the employee's status history |
| **Bucket** | One leave year of one account (D-P3-45) | `people_leave_buckets` |
| **Book** | `BALANCE` (earned minus consumed) or `RESERVED` (approved, not yet taken) | `book` column on entries |
| **Transaction** | One atomic business event (an approval, a year opening, a correction …) with its idempotency key, actor, reason and source | `people_leave_transactions` |
| **Entry** | One signed hour amount in one book of one bucket. Immutable | `people_leave_entries` |
| **Leave-date entry** | Reservations, releases and consumptions are posted **one entry per leave date**, so taken and future leave are told apart exactly and payroll can be fed per period | `people_leave_entries` with `reservation_entry_id` |
| **Correction grant** | An explicit authorisation of one member to correct balances (D-P3C-04) | `people_leave_authorisations` |
| **Projection** | A computed view of balances (as-of, as-known-at, projected). Never authoritative, never stored in C1 | function results |

```
people_employees ──< people_leave_accounts (employee × leave type; unit = HOURS; FOR UPDATE anchor)
                          │
                          ├──< people_leave_buckets (leave year; service period; FUTURE/OPEN/CLOSED/FROZEN)
                          │          │
                          │          └──< people_leave_entries (book, kind, ±hours, applies_on, policy version)
                          │                       ├── reservation_entry_id ──> the RESERVATION it consumes or releases
                          │                       └── reverses_entry_id ──> people_leave_entries
                          └──< people_leave_transactions (kind, idempotency key, actor, basis, reason, source)
P3-B people_leave_requests ── reservation_transaction_id ──> people_leave_transactions   (after the P3-B amendment)
people_leave_authorisations (member × capability, granted/revoked; D-P3C-04)
people_leave_policy_revisions + effective_from (D-P3-25 rule 1)
```

### C.2 Common table rules

All tables: `business_id` first in `@@unique([businessId, id])`, `business_id`-leading indexes, composite tenant
FKs, `ENABLE` + `FORCE ROW LEVEL SECURITY` with the standard `tenant_isolation` policy (same text as
`migration.sql:425-427`), cascade with the business (D-P3-10), **no DELETE or TRUNCATE grant** to `bos_app`,
column-level UPDATE grants only where listed, times from the database (`now()` in triggers), SQLSTATEs in class
`PE` numbered after P3-B's at build time. Hours are `numeric(12,4)`: range ±99,999,999.9999, resolution 0.0001 h
(0.36 s). Engine arithmetic uses exact decimals (E-26) and rounds only at posting (§G.5).

### C.3 `people_leave_accounts`

```prisma
model PeopleLeaveAccount {
  id           String   @id @db.Uuid
  businessId   String   @map("business_id") @db.Uuid
  employeeId   String   @map("employee_id") @db.Uuid
  leaveTypeId  String   @map("leave_type_id") @db.Uuid
  /// Always HOURS (D-P3C-01). Kept as a column so a later unit decision is explicit, CHECK = 'HOURS'.
  unit         String   @default("HOURS")
  /// Bumped by every ledger transaction on this account (guard: +1). Clients use it to detect change.
  version      Int      @default(1)
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime @default(now()) @map("updated_at") @db.Timestamptz

  @@unique([businessId, id])
  @@unique([businessId, employeeId, leaveTypeId])
  @@unique([businessId, id, employeeId, leaveTypeId])   // target of composite FKs from buckets and entries
  @@map("people_leave_accounts")
}
```

Created lazily (`INSERT … ON CONFLICT DO NOTHING`, then `SELECT … FOR UPDATE`). UPDATE grant: `version`,
`updated_at` only. Holds **no balance figure** (P3-B §5.6 rule 1: nothing stored that could drift).

### C.4 `people_leave_buckets`

```prisma
model PeopleLeaveBucket {
  id             String    @id @db.Uuid
  businessId     String    @map("business_id") @db.Uuid
  accountId      String    @map("account_id") @db.Uuid
  employeeId     String    @map("employee_id") @db.Uuid
  leaveTypeId    String    @map("leave_type_id") @db.Uuid
  servicePeriod  Int       @map("service_period")            // 1 for the first employment, +1 per rehire
  yearStart      DateTime  @map("year_start") @db.Date        // inclusive
  yearEnd        DateTime  @map("year_end") @db.Date          // exclusive; CHECK year_end > year_start
  /// FUTURE (holds reservations only) | OPEN (entitlement posted) | CLOSED (carried out) | FROZEN (service ended)
  state          String
  openedAt       DateTime? @map("opened_at") @db.Timestamptz
  closedAt       DateTime? @map("closed_at") @db.Timestamptz
  version        Int       @default(1)
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz

  @@unique([businessId, id])
  @@unique([businessId, accountId, servicePeriod, yearStart])
  @@unique([businessId, id, accountId])
  @@index([businessId, employeeId, leaveTypeId, yearStart])
  @@map("people_leave_buckets")
}
```

Guard: state moves only `FUTURE→OPEN→CLOSED`, `OPEN|FUTURE→FROZEN`, `FROZEN→OPEN` is refused (a rehire opens new
buckets in a new service period); `year_start`, `year_end`, account and service period immutable; buckets of one
account and service period may not overlap (guard reads the neighbours under the account lock). UPDATE grant:
`state`, `opened_at`, `closed_at`, `version`.

### C.5 `people_leave_transactions`

```prisma
model PeopleLeaveTransaction {
  id               String   @id @db.Uuid
  businessId       String   @map("business_id") @db.Uuid
  accountId        String   @map("account_id") @db.Uuid
  employeeId       String   @map("employee_id") @db.Uuid
  leaveTypeId      String   @map("leave_type_id") @db.Uuid
  /// See §D: OPENING_BALANCE | IMPORT | YEAR_OPEN | ACCRUAL | RESERVE | CONSUME | RELEASE | REVERSE_CONSUMPTION
  /// | ADJUSTMENT | CORRECTION | CARRY_PROPAGATION | EXPIRY | PAYOUT | FREEZE
  kind             String
  /// Unique per business; derived for system kinds (§D.3), client-supplied for manual kinds.
  idempotencyKey   String   @map("idempotency_key")
  /// sha256 of the canonical request body for manual kinds (Finance pattern, E-28); null for system kinds.
  requestHash      String?  @map("request_hash")
  /// What caused it: LEAVE_REQUEST | POLICY_ACCRUAL | YEAR_BOUNDARY | MANUAL | IMPORT_BATCH | PAYROLL | TRANSACTION
  sourceKind       String   @map("source_kind")
  sourceId         String?  @map("source_id") @db.Uuid
  /// External system reference for IMPORT and PAYOUT (payroll run id, import file id). Never personal data.
  externalRef      String?  @map("external_ref")
  /// The transaction this one corrects or propagates from.
  relatedTransactionId String? @map("related_transaction_id") @db.Uuid
  /// Mandatory for ADJUSTMENT, CORRECTION, EXPIRY (manual), PAYOUT, OPENING_BALANCE, IMPORT (CHECK).
  reasonCode       String?  @map("reason_code")
  reasonText       String?  @map("reason_text")              // 1–500 chars; restricted visibility (§I.3)
  /// From current_setting('app.user_id'), set by the trigger, never by the statement (D-P3-51 pattern).
  actorUserId      String   @map("actor_user_id") @db.Uuid
  /// SELF | LINE_MANAGER | LEAVE_MANAGER | LEAVE_CORRECT_GRANT | SOLE_OWNER_SELF | DERIVED (system catch-up inside a user's unit of work)
  actorBasis       String   @map("actor_basis")
  /// Business date on which it was posted (business time zone, from the database).
  postedOn         DateTime @map("posted_on") @db.Date
  /// now() = the START of the database transaction, not its commit (§F.1a). Informational for people;
  /// never used alone to seal an export or a cutoff.
  recordedAt       DateTime @default(now()) @map("recorded_at") @db.Timestamptz
  /// pg_current_xact_id() of the inserting transaction (set by the trigger). With a stored pg_snapshot it
  /// answers "was this visible to that snapshot", which is commit-aware (§F.1a, §H.4).
  recordedXid      Unsupported("xid8") @map("recorded_xid")
  /// Maker-checker (D-P3C-18): the second person, when required. Set in the same INSERT by an approval call.
  checkedByUserId  String?  @map("checked_by_user_id") @db.Uuid

  @@unique([businessId, id])
  @@unique([businessId, idempotencyKey])
  @@unique([businessId, id, accountId])
  @@index([businessId, accountId, recordedAt])
  @@index([businessId, sourceKind, sourceId])
  @@map("people_leave_transactions")
}
```

INSERT only; no UPDATE grant at all. Transactions are immutable from the moment they exist.

### C.6 `people_leave_entries`

```prisma
model PeopleLeaveEntry {
  id               String   @id @db.Uuid
  businessId       String   @map("business_id") @db.Uuid
  transactionId    String   @map("transaction_id") @db.Uuid
  accountId        String   @map("account_id") @db.Uuid
  bucketId         String   @map("bucket_id") @db.Uuid
  employeeId       String   @map("employee_id") @db.Uuid
  leaveTypeId      String   @map("leave_type_id") @db.Uuid
  /// BALANCE | RESERVED
  book             String
  /// §D.1 catalogue; CHECK pairs kind with book and sign.
  kind             String
  /// Signed hours; credit > 0, debit < 0, never 0 (CHECK).
  hours            Decimal  @db.Decimal(12, 4)
  /// The business date from which the amount counts in its book (the as-of axis, §F.1):
  /// BALANCE entries: the economic date (accrual period's last day, year start, leave date for CONSUMPTION…);
  /// RESERVATION and cancellation releases: the business date of the approval or cancellation;
  /// release for consumption: the later of the leave date and the reservation's applies_on.
  appliesOn        DateTime @map("applies_on") @db.Date
  /// RESERVATION, RESERVATION_RELEASE, CONSUMPTION (and its reversal): the one leave date concerned.
  leaveDate        DateTime? @map("leave_date") @db.Date
  /// Accrual only: the period [period_start, period_end) it covers.
  periodStart      DateTime? @map("period_start") @db.Date
  periodEnd        DateTime? @map("period_end") @db.Date
  /// The policy and version whose rules produced the amount (D-P3-25 rule 3).
  policyId         String   @map("policy_id") @db.Uuid
  policyVersion    Int      @map("policy_version")
  /// Hours-per-day basis used for a DAYS→hours conversion, if any (audit of D-P3C-01).
  hoursPerDay      Decimal? @map("hours_per_day") @db.Decimal(6, 4)
  /// The entry this one reverses (exact opposite, same bucket and book). At most one reversal per entry.
  reversesEntryId  String?  @map("reverses_entry_id") @db.Uuid
  /// CONSUMPTION and RESERVATION_RELEASE: the one-date RESERVATION entry they settle.
  reservationEntryId String? @map("reservation_entry_id") @db.Uuid
  /// The other half of a carry pair (CARRY_OUT ↔ CARRY_IN).
  pairEntryId      String?  @map("pair_entry_id") @db.Uuid
  /// RESERVATION_RELEASE only: CONSUMED | CANCELLED | FROZEN (CHECK: non-null exactly for that kind).
  releaseReason    String?  @map("release_reason")
  /// Snapshot, set by the trigger at insert: the leave type's `sensitive` flag, OR'd with any P3-B request
  /// sensitivity it cites (from B2). Immutable; read policies use (snapshot OR current flag), so a type made
  /// non-sensitive later never re-exposes history (P3-B D-P3-43 pattern).
  sensitive        Boolean  @default(false)
  recordedAt       DateTime @default(now()) @map("recorded_at") @db.Timestamptz

  @@unique([businessId, id])
  @@unique([businessId, id, accountId])
  @@index([businessId, bucketId, book, appliesOn])
  @@index([businessId, accountId, recordedAt])
  @@map("people_leave_entries")
}
```

Constraints (migration SQL, not expressible in Prisma):

- Composite FKs: entry → transaction `(business_id, transaction_id, account_id)`; entry → bucket
  `(business_id, bucket_id, account_id)`; entry → account `(business_id, account_id, employee_id, leave_type_id)`;
  entry → policy `(business_id, policy_id, leave_type_id)` (so a policy of another type cannot be cited);
  entry → revision `(business_id, policy_id, policy_version)`; `reverses_entry_id` and `pair_entry_id` →
  entries `(business_id, id, account_id)` (same account only); `reservation_entry_id` likewise.
- CHECKs (single row):
  - `book IN ('BALANCE','RESERVED')`; `hours <> 0`; kind/book pairs as §D.1; fixed signs for the kinds §D.1 marks
    fixed (`GRANT`, `ACCRUAL` +; `CONSUMPTION`, `PAYOUT` −; `RESERVATION` +; `RESERVATION_RELEASE` −; `EXPIRY` −).
    `CARRY_OUT`, `CARRY_IN`, `OPENING_BALANCE`, `IMPORT`, `ADJUSTMENT` and `REVERSAL` may have either sign; their
    sign is constrained by the pair and transaction invariants below, not by a CHECK.
  - `ACCRUAL` ⇔ both period dates set, `period_start < period_end`.
  - `REVERSAL` ⇔ `reverses_entry_id IS NOT NULL`.
  - `RESERVATION_RELEASE` ⇔ `release_reason IS NOT NULL`, with `release_reason IN ('CONSUMED','CANCELLED','FROZEN')`.
  - `reservation_entry_id IS NOT NULL` ⇔ `kind IN ('RESERVATION_RELEASE','CONSUMPTION')`.
  - **Leave date:** `kind IN ('RESERVATION','RESERVATION_RELEASE','CONSUMPTION')` ⇒ `leave_date IS NOT NULL`;
    `kind NOT IN ('RESERVATION','RESERVATION_RELEASE','CONSUMPTION','REVERSAL')` ⇒ `leave_date IS NULL`;
    for `REVERSAL` the CHECK allows either and the guard requires `leave_date IS NOT DISTINCT FROM` the reversed
    entry's `leave_date` (so a reversal of a `CONSUMPTION` keeps its date, a reversal of an `ADJUSTMENT` has none).
  - `CONSUMPTION` ⇒ `applies_on = leave_date`.
- Unique indexes for idempotency (§D.3), `UNIQUE (business_id, reverses_entry_id) WHERE reverses_entry_id IS NOT
  NULL`, and one settlement per reservation date: `UNIQUE (business_id, reservation_entry_id) WHERE kind =
  'RESERVATION_RELEASE'` and the same `WHERE kind = 'CONSUMPTION'`.
- `leave_date` falls inside the bucket's `[year_start, year_end)` (D-P3-45). At most 366 dates per request
  (P3-B D-P3-36), so at most 1,098 entries per request.
- **Deferred pair and transaction invariants** (`CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`, checked at
  commit over the transaction's rows), each fails the commit with a PE-class error:
  - **Consumption ⇔ release, both directions.** Every `CONSUMPTION` has exactly one `RESERVATION_RELEASE` with
    `release_reason = 'CONSUMED'` in the same ledger transaction, and every such release has exactly one
    `CONSUMPTION`; both have the same `reservation_entry_id`, account, bucket and `leave_date`, and both have
    `hours = −(reservation hours)`. A `CANCELLED` or `FROZEN` release has **no** consumption. A `CONSUMED` release
    without its consumption cannot commit, so it can never free availability on its own.
  - **Reservation settlement:** the cited reservation is in the same account and bucket, not yet settled (unique
    indexes), and for `CONSUMED` its `leave_date ≤` business today.
  - **Carry pairs:** in a `YEAR_OPEN` or `CARRY_PROPAGATION` transaction, every `CARRY_OUT` has exactly one
    `CARRY_IN` linked by `pair_entry_id` both ways, `CARRY_IN.hours = −CARRY_OUT.hours`, the `CARRY_IN` bucket is
    the next bucket of the same account and service period (its `year_start` = the out bucket's `year_end`).
    Either sign is allowed: for a closing balance of −5 h carried in full, `CARRY_OUT = +5` and `CARRY_IN = −5`.
  - **Year closing:** after a `YEAR_OPEN` the closed bucket's `BALANCE` sum is exactly 0 and its `RESERVED` sum is
    0 (I-4). The entries that may achieve this are `CARRY_OUT` (either sign), `EXPIRY` (− only, for positive excess
    above what is carried) and `WRITE_OFF` (+ only, for a negative closing balance that is **not** carried). Which
    of these a given closing produces is the owner policy D-P3C-11 (still open): "carry negative in full" uses only
    `CARRY_OUT`; "apply the carry rule to negatives" uses `WRITE_OFF`. The schema accepts both; the guard refuses
    `WRITE_OFF` until D-P3C-11 is decided (fail closed).
  - **Reversal:** exact negated hours, same account, bucket, book and leave date as the reversed entry; carry
    entries are never reversed (they are corrected by propagation).
- Guard trigger on entries (INSERT only, no UPDATE grant):
  - the ledger transaction belongs to the same account; the bucket state allows the kind (no entitlement into
    `FUTURE`; nothing into `FROZEN` except the freeze transaction; nothing into `CLOSED` except reversals and
    corrections followed by propagation, §G.7);
  - **kind and basis authority** as §I.2a (which kinds a transaction kind may contain, which actor bases may
    create them; unsupported kinds fail closed by stage);
  - the writer holds the account lock. Every ledger transaction first bumps the account `version` (an UPDATE, which
    holds the row lock until commit), and the guard requires the account row's `xmin` to equal the current
    transaction id (`xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text`). Exact form fixed and
    tested in C1 (T-C05).

### C.7 `people_leave_authorisations` (D-P3C-04)

```prisma
model PeopleLeaveAuthorisation {
  id            String    @id @db.Uuid
  businessId    String    @map("business_id") @db.Uuid
  userId        String    @map("user_id") @db.Uuid            // composite FK to memberships (business_id, user_id)
  /// LEAVE_CORRECT (corrections and adjustments). LEAVE_VIEW reserved for delegated read scope (D-P3C-25).
  capability    String
  /// Optional scope: a department; null = every employee the grant holder may see.
  departmentId  String?   @map("department_id") @db.Uuid
  grantedById   String    @map("granted_by_id") @db.Uuid       // from app.user_id; must be OWNER or ADMIN (guard)
  grantedAt     DateTime  @default(now()) @map("granted_at") @db.Timestamptz
  revokedById   String?   @map("revoked_by_id") @db.Uuid
  revokedAt     DateTime? @map("revoked_at") @db.Timestamptz
  @@unique([businessId, id])
  @@map("people_leave_authorisations")
}
```

One active row per `(business_id, user_id, capability, coalesce(department_id, zero-uuid))` (partial unique
index). Granted only to a member whose role is MANAGER (OWNER and ADMIN already hold the power, MEMBER may not be
granted it, D-P3C-19). Revoked once, never deleted. Effective only while the membership is `ACTIVE`.
The guard records `granted_by_id` from the session and refuses a grantor who is not OWNER or ADMIN.

### C.8 Change to an existing table: `people_leave_policy_revisions.effective_from`

`effective_from DATE NOT NULL`, set by the existing revision guard as `businessToday` at insert (D-P3-25 rule 1).
Existing rows are back-filled in the same migration (§J.2). The policy-in-force lookup is
`max(version) WHERE effective_from <= D` for the assignment covering D.

### C.9 Not stored, deliberately

- **No balance totals** on accounts or buckets in C1–C5 (D-P3C-10). Volumes are small (≈ 26–52 accrual entries,
  up to a few hundred per-date reservation entries per employee, type and year), so sums are cheap. A cached
  projection is allowed later only with the rebuild and verify procedure in §J.5.
- **No money** anywhere in People (§H.4).

### C.10 `people_leave_import_batches` and `people_leave_import_rows` (opening balances, P3-C5)

| Table | Columns (all with `business_id`, composite FKs, forced RLS) |
|---|---|
| batches | `id`, `kind` (`OPENING_BALANCE` \| `HISTORY`), `cutover_date` (business date the opening balances are true at), `source_label` (free text ≤ 100, no personal data), `content_hash` (sha256 of the canonical rows), `row_count`, `state` (`STAGED` \| `POSTED` \| `DISCARDED`), `staged_by_user_id`, `posted_by_user_id`, `posted_transaction_count`, `version`, timestamps. Unique `(business_id, content_hash) WHERE state <> 'DISCARDED'` so the same file cannot be posted twice |
| rows | `batch_id`, `line_no`, `employee_id`, `leave_type_id`, `hours` (signed, `numeric(12,4)`), optional `days` + `hours_per_day` (when the source is in days; hours must equal `days × hours_per_day` to 4 dp), `external_ref` (source system id), `validation` (`OK` \| error code). Immutable once staged; a fix means discarding the batch and staging a new one |

Posting a batch (all or nothing) writes one `OPENING_BALANCE` transaction per row, `idempotency_key =
'ob:{batchId}:{lineNo}'`. A staged batch changes no balance.

### C.11 `people_leave_correction_proposals` (only if maker-checker is chosen, D-P3C-18)

`id`, `kind` (`ADJUSTMENT` \| `CORRECTION` \| `PAYOUT` \| `EXPIRY`), target account, signed hours, `applies_on`,
`reverses_entry_ids uuid[]` (for corrections), reason code and text, `external_ref`, `state` (`PROPOSED` \|
`POSTED` \| `REJECTED` \| `WITHDRAWN`), `proposed_by_user_id` (session), `decided_by_user_id` (session, must differ
unless the sole-authoriser exception applies), `transaction_id` once posted, `idempotency_key` + `request_hash`,
`version`. A proposal changes no balance. Lapse after 30 days is computed at decision time (no job). If Regan
does not choose maker-checker, this table is not built and `checked_by_user_id` stays null.

---

## D. Ledger transaction and event catalogue

### D.1 Entry kinds (book, sign, bucket rule)

| Kind | Book | Sign | Bucket | Meaning |
|---|---|---|---|---|
| `OPENING_BALANCE` | BALANCE | ± | the bucket containing the cutover date | Balance carried in from before Pixa, true at the cutover date |
| `IMPORT` | BALANCE | ± | bucket of `applies_on` | Historical movement imported for history only (D-P3C-24); sums to zero against `OPENING_BALANCE` if both are used |
| `GRANT` | BALANCE | + | the new year's bucket | GRANT policy entitlement at a year opening (pro rata if the assignment starts mid-year, D-P3C-20) |
| `ACCRUAL` | BALANCE | + | bucket containing the period | One ACCRUAL period's hours (§G) |
| `CARRY_OUT` | BALANCE | − | closing bucket | Amount carried to the next year |
| `CARRY_IN` | BALANCE | + | next bucket | Same amount, paired (`pair_entry_id`) |
| `EXPIRY` | BALANCE | − | closing bucket (carry lapse) or any open bucket (manual) | Hours that lapse: above the carry cap at year end, or a decided manual expiry |
| `CONSUMPTION` | BALANCE | − | bucket of the leave date | Approved leave taken on its date |
| `RESERVATION` | RESERVED | + | bucket of the leave date | Approved leave for one date, not yet taken |
| `RESERVATION_RELEASE` | RESERVED | − | same as its reservation | Settles one reservation date: reason `CONSUMED` (paired with a `CONSUMPTION`), `CANCELLED`, `FROZEN` |
| `ADJUSTMENT` | BALANCE | ± | bucket of `applies_on` | Authorised manual change (D-P3C-04) |
| `REVERSAL` | BALANCE | opposite of the original | same bucket as the original | Exact negation of one BALANCE entry (except carry entries, which are corrected by propagation) |
| `PAYOUT` | BALANCE | − | current or frozen bucket | Hours paid out by an external payroll, with its reference |
| `WRITE_OFF` | BALANCE | + | closing bucket | A negative closing balance that is not carried forward. **Reserved: refused until D-P3C-11 is decided** |

Sign rules are in §C.6: fixed by CHECK for most kinds; `CARRY_OUT`/`CARRY_IN` take either sign in both `YEAR_OPEN`
(negative closing carried) and `CARRY_PROPAGATION` (deltas), constrained by the carry-pair and year-closing
invariants. In a `CARRY_PROPAGATION`, `EXPIRY` deltas may also be positive (a correction that reduces an earlier
lapse); that is the only positive `EXPIRY`, and the guard allows it only in that transaction kind.

### D.2 Transaction catalogue

| Transaction | Trigger | Who (basis) | Entries | Idempotency key | Reason | Audit action |
|---|---|---|---|---|---|---|
| `OPENING_BALANCE` | posting an import batch (C5) | `leave_manage` or `LEAVE_CORRECT` grant | 1 × `OPENING_BALANCE` | `ob:{batch}:{line}` | `OPENING` + batch label | `people.leave_balance.opening_posted` |
| `IMPORT` | posting a HISTORY batch (C5, optional) | same | n × `IMPORT` | `im:{batch}:{line}` | `IMPORT` | `people.leave_balance.imported` |
| `YEAR_OPEN` | catch-up reaches a leave-year start (§G.6) | `DERIVED` (inside the caller's unit of work) | `CARRY_OUT`, `CARRY_IN`, `EXPIRY` (lapse), `GRANT` | `yo:{bucketId}` | — | none (high volume, derivable); counted in the ledger only |
| `ACCRUAL` | catch-up, one per completed period | `DERIVED` | 1 × `ACCRUAL` | `ac:{accountId}:{servicePeriod}:{periodStart}` | — | none |
| `RESERVE` | P3-B approval (incl. auto-approval and on-behalf) | P3-B basis (`LINE_MANAGER`, `LEAVE_MANAGER`, …) | n × `RESERVATION`; plus, for dates ≤ today (retroactive approval), the `CONSUMPTION` + `RESERVATION_RELEASE(CONSUMED)` pairs in the same transaction | `rs:{requestId}` | — | P3-B `people.leave_request.approved` (ids, hours) |
| `CONSUME` | catch-up for reservation dates ≤ today | `DERIVED` | per due date: `CONSUMPTION` + `RESERVATION_RELEASE(CONSUMED)` | `cs:{reservationEntryId}` per date pair; the transaction key `cs:{accountId}:{fromDate}:{toDate}` | — | none |
| `RELEASE` | P3-B cancellation (future dates), or partial cancellation (D-P3C-14) | P3-B basis | per future date: `RESERVATION_RELEASE(CANCELLED)` | `rl:{requestId}:{transitionSeq}` | P3-B note optional | P3-B `people.leave_request.cancelled` |
| `REVERSE_CONSUMPTION` | P3-B whole cancellation after dates were taken ("the leave did not happen") | approver or leave manager (P3-B §7.2) | per consumed date: `REVERSAL` of the `CONSUMPTION` | `rc:{requestId}:{transitionSeq}` | mandatory | P3-B `people.leave_request.cancelled` + `consumptionReversed: true` |
| `ADJUSTMENT` | manual | `leave_manage` or `LEAVE_CORRECT` grant | 1 × `ADJUSTMENT` (+ propagation if into a closed year) | client key | **mandatory** | `people.leave_balance.adjusted` |
| `CORRECTION` | manual fix of a wrong entry | same | `REVERSAL` of each wrong entry + replacement `ADJUSTMENT`(s), linked by `related_transaction_id` (+ propagation) | client key | **mandatory** | `people.leave_balance.corrected` |
| `CARRY_PROPAGATION` | any change to a closed bucket (§G.7) | `DERIVED`, within the causing transaction's unit of work | `CARRY_OUT`/`CARRY_IN` (or `EXPIRY`) deltas year by year | `cp:{causingTransactionId}:{bucketId}` | — | included in the causing audit |
| `EXPIRY` | manual (or a future policy rule, D-P3C-15) | `leave_manage` or grant | 1 × `EXPIRY` | client key | **mandatory** | `people.leave_balance.expired` |
| `PAYOUT` | recording a payout done in payroll | `leave_manage` or grant (maker-checker if chosen) | 1 × `PAYOUT` | `po:{externalRef}` or client key | **mandatory** + `external_ref` | `people.leave_balance.paid_out` |
| `FREEZE` | termination (D-P3C-17) | `DERIVED` in the termination unit of work, or at next ledger touch | `RESERVATION_RELEASE(FROZEN)` for dates after the end date; bucket → `FROZEN` | `fz:{accountId}:{servicePeriod}` | — | P1 termination audit + `people.leave_balance.frozen` |

Every transaction first bumps the account `version` (lock proof, §C.6) and is all-or-nothing.

### D.3 Idempotency, three levels

1. **Transaction key** `UNIQUE (business_id, idempotency_key)`. System keys are derived from the facts (period,
   bucket, request, reservation entry), so a second catch-up or a retried approval finds the row and posts nothing.
   Manual keys come from the client with a `request_hash`: the same key with the same body returns the existing
   transaction (`200`), with a different body `409 idempotency_conflict` (Finance pattern, E-28).
2. **Entry-level uniques**, independent of service code: one `ACCRUAL` per `(account, service_period,
   period_start)`; one `GRANT`, one opening `CARRY_IN` and one lapse `EXPIRY` per bucket; one `RESERVATION` per
   `(transaction, leave_date)` (`UNIQUE (business_id, transaction_id, leave_date) WHERE kind = 'RESERVATION'`),
   which with the transaction key `rs:{requestId}` gives one reservation per request and date (P3-B C-13 restated
   per date); one release and one consumption
   per reservation entry; one reversal per entry.
3. **Versions:** the account `version` (+1 per transaction) and P3-B's request `version` make stale replays fail.

### D.4 Reason codes (closed list, extendable additively)

`OPENING`, `IMPORT`, `DATA_ENTRY_ERROR`, `POLICY_MISCONFIGURED`, `HOURS_BASIS_CHANGED`, `LEAVE_NOT_TAKEN`,
`GOODWILL`, `AGREEMENT`, `CARRY_CAP`, `PAYOUT_TERMINATION`, `PAYOUT_CASH_OUT`, `UNIT_CONVERSION`, `OTHER` (text
required ≥ 10 characters). Reason text is restricted (§I.3) and never copied into audit or notifications.

---

## E. Leave lifecycle state diagrams

### E.1 Request (P3-B states) and what the ledger does

```
                       submit                       approve (RESERVE: + RESERVED per date)
      (new) ───────────────────────────▶ PENDING ──────────────────────────────────────────▶ APPROVED
        │   nothing posted (D-P3C-02)     │  │                                                │   │
        │                                 │  └─ reject ─▶ REJECTED   (nothing to undo)        │   │
        │                                 └── withdraw ─▶ WITHDRAWN (nothing to undo)          │   │
        │                                                                                     │   │
        └── submit, no approval needed / recorded approved on behalf ──(RESERVE)──────────────┘   │
                                                                                                  │
   APPROVED ── each leave date arrives (catch-up CONSUME: −BALANCE, −RESERVED for that date) ──────┤
                                                                                                  │
   APPROVED ── cancel ──▶ CANCELLED:  future dates → RELEASE(CANCELLED);                          │
                                       dates already consumed → kept (taken leave stays taken),   │
                                       or REVERSE_CONSUMPTION when the decider records that the    │
                                       leave did not happen (reason mandatory)                     │
   APPROVED ── partial cancel (early return, needs P3-B transition, D-P3C-14) ── RELEASE of        │
                                       the remaining future dates only; request stays APPROVED ────┘
```

### E.2 One reservation date

```
            RESERVE                       leave date ≤ business today (catch-up)
  (none) ───────────▶ RESERVED ─────────────────────────────────────────▶ CONSUMED ──REVERSAL──▶ CONSUMED+REVERSED
                         │                                                   (BALANCE −h,          (BALANCE back +h;
                         │                                                    RESERVED −h)          reservation stays settled)
                         ├── cancel before the date ─▶ RELEASED (RESERVED −h, BALANCE untouched)
                         └── employment ends before the date ─▶ RELEASED(FROZEN)
```

Every arrow is one immutable entry or pair. A date can never be both released and consumed (unique indexes, §D.3).

### E.3 Bucket

```
  FUTURE ──(year start reached: YEAR_OPEN posts CARRY_IN, GRANT)──▶ OPEN ──(next YEAR_OPEN posts CARRY_OUT, lapse EXPIRY)──▶ CLOSED
    │                                                                 │                                                     │
    └──────────────(service ends: FREEZE)──────────▶ FROZEN ◀─────────┘                     corrections + propagation only ─┘
```

A bucket is created `FUTURE` when the first reservation for that year arrives (P3-B D-P3-53 allows the next leave
year), or `OPEN` directly by catch-up. Only one bucket per account and service period is `OPEN` at a time.

### E.4 Correction proposal (only if maker-checker is chosen)

`PROPOSED → POSTED | REJECTED | WITHDRAWN`; lapsed proposals (older than 30 days) are refused at decision time.

---

## F. Balance equations with worked examples

### F.1 Views and notation

For an account (or one bucket) and a set of entries `E`:

- `D` = **as-of date** (business date). An entry counts when `applies_on(e) ≤ D`.
- `K` = **as-known-at instant**. An entry counts when `recorded_at(e) ≤ K`.
- Default view: `D` = business today, `K` = now. "As of D, as known at K" answers *what did our books say at K about
  day D*; "as of D, as known now" answers *what do we now know was true on D*. Backdated postings make the two
  differ, never silently: both are reproducible from the ledger because entries are never changed.
- **Realised view** (default for `K = now` only): posted entries **plus the complete virtual catch-up** through
  `min(D, today)`: every entry and bucket state change that a catch-up would post (§G.9), not only accrual and
  consumption. It is produced by the same function that posts, so a read just before a catch-up equals the read
  just after it (T-C21, T-C21a/b). Views with `K < now` show only what was posted, never virtual entries.
- `Q_k(D,K)` = the sum of `hours` of entries of kind `k` **plus their reversals**, counted under (D, K).

### F.1a What "as known at" can and cannot promise

- `recorded_at` is `now()`, the **start** time of the inserting database transaction, not its commit time. A
  transaction that starts before an instant `K` and commits after it appears under `recorded_at ≤ K` only after
  it commits, so an "as known at K" answer computed at time T1 can differ from the same question asked at T2 > T1.
  For people this is labelled "recorded (approximately) by K" and is good to within the transaction timeout
  (seconds); it is **not** used to seal anything.
- **Commit-aware sealing** uses visibility instead of time: each ledger transaction stores `recorded_xid`
  (`pg_current_xact_id()`). A seal (a payroll export, a reconciliation report, a cutover check) stores
  `pg_current_snapshot()` taken inside its own read transaction; "included in the seal" means
  `pg_visible_in_snapshot(recorded_xid, sealed_snapshot)`. The next seal includes exactly the transactions visible
  to its snapshot and not to the previous one, whatever their `recorded_at`. A transaction still in flight at a
  seal is therefore never lost and never counted twice (T-C63, delayed commit). This works under PgBouncer
  transaction mode (no session state).
- Prior exports are immutable because the sealed set is identified by the stored snapshot (and its line set is
  stored by the payroll stage, §H.4), not because a timestamp filter is re-run.
- `xid8` values do not wrap; a restore from a Neon recovery branch keeps them (same cluster history). A restore to
  a different cluster would need a new seal baseline; recorded in the payroll stage's design.

### F.2 Quantities (hours, per bucket; the account figure is the current open bucket, §F.4 I-5)

| Quantity | Formula |
|---|---|
| Accrued / earned | `Earned = Q_ACCRUAL + Q_GRANT + Q_OPENING_BALANCE + Q_IMPORT` |
| Carried forward in | `CarriedIn = Q_CARRY_IN` |
| Carried forward out | `CarriedOut = −Q_CARRY_OUT` |
| Adjusted | `Adjusted = Q_ADJUSTMENT` |
| Consumed (taken) | `Consumed = −Q_CONSUMPTION` (net of consumption reversals) |
| Expired | `Expired = −Q_EXPIRY` |
| Paid out | `PaidOut = −Q_PAYOUT` |
| **Balance** (BALANCE book) | `B = Earned + CarriedIn − CarriedOut + Adjusted − Consumed − Expired − PaidOut` = Σ BALANCE entries |
| **Reserved** (RESERVED book) | `Rv = Q_RESERVATION + Q_RESERVATION_RELEASE` = Σ RESERVED entries (approved, future, not taken) |
| Pending | `Pd = Σ requested_hours of P3-B PENDING requests charged to the bucket` (from P3-B; never in the ledger) |
| **Available** | `Av = B − Rv` |
| Available after pending (display only) | `Av − Pd` |
| Negative allowance | `L = negative_balance_limit` of the rules in force today, in hours (§G.3) |
| Headroom (no forecast) | `Av + L` |
| **Projected** | `P(t)` for `t ∈ [today, H]` by the simulation of §F.5; `fits ⇔ min P(t) ≥ −L` over the request's dates to `H` |
| Days (display) | `hours ÷ hpd` (§F.6); never stored, never used in a check |

### F.3 How each event moves the quantities

| Event | B | Rv | Av | Pd |
|---|---|---|---|---|
| Submit (PENDING) | 0 | 0 | 0 | +h |
| Withdraw / reject | 0 | 0 | 0 | −h |
| Approve, future dates | 0 | +h | **−h** | −h (was pending) |
| Leave date arrives (consume) | −h_d | −h_d | **0** | 0 |
| Approve retroactively (dates ≤ today) | −h | 0 (reserve and settle in one transaction) | −h | −h |
| Cancel before the dates | 0 | −h | +h | 0 |
| Cancel after some dates taken, leave did happen | 0 | −h_future | +h_future | 0 |
| … and decider records it did not happen | +h_past | −h_future | +h | 0 |
| Accrual / grant / carry-in | +a | 0 | +a | 0 |
| Payout, expiry, negative adjustment | −x | 0 | −x | 0 |

### F.4 Invariants (each has a SQL check in §J.4 and a test)

- **I-1** `Rv ≥ 0` for every bucket at every `(D, K)`; every reservation entry is settled at most once.
- **I-2 No double debit.** For every approved leave date `d` with hours `h`: before `d` it lowers `Av` through
  `Rv` and not `B`; from `d` it lowers `B` and is out of `Rv`; the sum of its effects on `Av` is exactly `−h` for
  ever (or `0` if released or reversed). Proof: the `RESERVATION` (+h in RESERVED) and the
  `CONSUMPTION`/`RESERVATION_RELEASE` pair (−h in BALANCE, −h in RESERVED) are the only entries that cite it, and
  each is unique (§D.3).
- **I-3** Consumption never changes `Av` (row 4 of §F.3).
- **I-4** A `CLOSED` bucket has `B = 0` and `Rv = 0`: closing posts `CARRY_OUT` (either sign), the lapse `EXPIRY`
  and, only if D-P3C-11 chooses it, `WRITE_OFF`, enforced at commit (§C.6), and every later change to it is
  propagated forward (§G.7). How a negative closing balance is treated is open (D-P3C-11; recommendation: carry
  in full, so debt never disappears at a year end).
- **I-5** Hence an account's balance is the `B` of its single `OPEN` bucket, and `FUTURE` buckets hold only
  `RESERVED` entries until they open.
- **I-6** Every `ACCRUAL` entry equals what the engine computes for its period from the inputs recorded on it
  (policy version, hours basis); the verifier (§J.4) replays and diffs.

### F.5 Projection (P3-B D-P3-50 as revised, restated for reservations)

Unchanged in shape from P3-B §5.6 rule 8, with these substitutions (R-04):

- **Start value** at today = realised `B` of the current bucket: all BALANCE entries with `applies_on ≤ today`
  plus the complete virtual catch-up through today (§G.9), so boundaries on or before today are never forecast.
- **Debit events** = every unsettled `RESERVATION` date after today (any bucket), each on its leave date, plus, at
  submission, every PENDING request of the type as provisional events, plus the candidate. At approval: unsettled
  reservations plus the candidate only (D-P3-52).
- **Credit events** after today: forecast accrual (§G), forecast carry and grant at each future year start; never
  manual adjustments.
- No double count: a reservation date ≤ today is in the start value (consumed, realised); a date after today is an
  event; never both (I-2). The same reconciliation check P3-B requires (T-59a) runs on the ledger alone.

### F.6 Days for display (D-P3C-01)

- A **booking's** days are the engine's day count from P3-B (whole and half dates on the employee's pattern),
  stored on the request for display; its hours are the sum of each date's hours. Days are never recomputed from
  hours.
- A **balance** in days is `hours ÷ hpd_today`, where `hpd_today` is the employee's ordinary hours per work day in
  force today (average of the pattern's working days when they differ), shown with one decimal and the basis
  ("≈ 8.3 days at 7.6 h/day"). If no pattern exists, days are not shown.

### F.7 Worked example

Policy "Annual leave": unit DAYS, ACCRUAL 20 days a year, MONTHLY, CALENDAR year, carry-over CAPPED at 10 days,
negative limit 0, no maximum. Employee full time, Monday to Friday, 7.6 h a day (38 h a week), so 152 h a year
and a cap of 76 h. Accrual entries are dated on the last day of each month (§G.4).

**1. Year opening, 1 January 2027.** 2026 closed with `B = 90.0000`. Catch-up posts `YEAR_OPEN`:
`CARRY_OUT −76.0000` and `EXPIRY −14.0000` (reason `CARRY_CAP`) in 2026, `CARRY_IN +76.0000` in 2027.
2026 now has `B = 0` (I-4).

**2. Accrual.** Month `k` posts `round4(152·k/12) − round4(152·(k−1)/12)`: January `12.6667`, February `12.6666`,
March `12.6667`, …; after December the year totals exactly `152.0000` (§G.5).

**3. 15 March 2027 (today), approve request A for 22–26 March (5 days = 38 h).** `RESERVE` posts five
`RESERVATION +7.6000` entries. Now `B = 76 + 25.3333 = 101.3333`, `Rv = 38.0000`, `Av = 63.3333` (≈ 8.3 days).
Request B for 5–6 April (15.2 h) is PENDING: `Pd = 15.2`, "available after pending" `48.1333`.

**4. 24 March.** Any ledger write (or a read, virtually) consumes 22, 23, 24 March: three
`CONSUMPTION −7.6` + `RESERVATION_RELEASE(CONSUMED) −7.6` pairs. `B = 78.5333`, `Rv = 15.2000`, `Av = 63.3333`:
unchanged (I-3).

**5. 24 March, the manager cancels A** (the employee is back at work). Without partial cancellation (P3-B v1.5,
whole request): 25 and 26 March are released (`Rv = 0`, `Av = 78.5333`); 22–24 stay consumed because the leave
was taken. If the manager records that the leave never happened, `REVERSE_CONSUMPTION` adds `+22.8` (`B =
101.3333`), reason mandatory.

**6. Retroactive approval.** On 20 April a sick-leave request for 2 April (7.6 h, backdating allowed) is approved:
one transaction posts `RESERVATION` (applies_on 20 April), `CONSUMPTION` (applies_on 2 April) and the settling
release. As of 5 April *as known at 10 April*, the sick balance shows no consumption on 2 April; *as known now* it
does. Both answers are reproducible (§F.1).

**7. Projection at approval of request C (1–5 November 2027, 38 h) on 15 March.** Start `B = 101.3333` (after
step 3, before any consumption); events: A's five reserved dates −38.0 (22–26 March); request B is pending and is
not counted at approval (D-P3-52, it is listed as possibly affected);
forecast accrual +12.6667/12.6666 at each month end from 31 March; C −38 on 1–5 November. Minimum projected
balance is never below 0, so C fits and is reserved into the 2027 bucket.

**8. Next-year booking.** On 15 March a request for 4–8 January 2028 (38 h) is approved: the 2028 bucket is
created `FUTURE` with `Rv = 38`, `B = 0`. On 1 January 2028 it opens with the real `CARRY_IN` (≤ 76) and
accrual follows; the projection had counted the forecast carry once and the reservation once (P3-B rule 8a).

---

## G. Accrual engine

### G.1 Shape: a pure engine behind policy adapters

```
apps/api/src/modules/people/server/
  leave-ledger.ts            C1  account lock, typed posting primitives, guards' service-side twins
  leave-ledger-engine.ts     C2  pure: (inputs snapshot) → expected system entries; no database access
  leave-policy-adapters/     C2  adapter registry; core.v1 only
  leave-ledger-catchup.ts    C2  reads inputs under the account lock, runs the engine, posts the missing entries
  leave-ledger-views.ts      C3/C4  balance views, projection (F.5), verifier (J.4)
```

```ts
interface LeavePolicyAdapter {            // proposal; names may change, semantics may not
  key: 'core.v1';                          // versioned; a posted entry records the adapter key via its transaction
  leaveYear(input: YearInput, date: BusinessDate): { start: BusinessDate; end: BusinessDate };
  accrualPeriods(year: YearRange, rules: PolicyRules): Period[];          // anchored at year start (G.4)
  periodAccrual(p: Period, ctx: AccrualContext): ExactDecimal;           // before cumulative rounding (G.5)
  yearOpening(closing: ExactDecimal, rulesAtClose: PolicyRules, rulesAtOpen: PolicyRules,
              ctx: OpeningContext): { carry: ExactDecimal; lapse: ExactDecimal; grant: ExactDecimal };
  daysToHours(days: ExactDecimal, basis: HoursBasis): ExactDecimal;       // D-P3C-23
}
```

- **Core adapter `core.v1`** implements exactly the P3-A vocabulary (E-02) plus the decisions in §M. It reads no
  country code and infers no legal rule (D-P3-4, P3-A §4.7 rule 7).
- **Jurisdiction adapters** (for example an Australian National Employment Standards adapter) are *not built*. One
  may be added only as a new adapter key, selected by an explicit policy field that P3-A does not have yet (a
  vocabulary change, its own decision), validated against the law by someone qualified, with its own test corpus.
  The ledger, guards and views never branch on jurisdiction.
- **Determinism:** the engine's output depends only on its inputs: dates, the policy revisions in force (by
  `effective_from`), assignments, the hours basis (work patterns), employment status history and service period,
  and the posted entries it builds on. None of these can be future-dated or backdated (D-P3-9), so a period's
  expected entry never changes after the period ends. Replaying the engine over an account reproduces every
  system entry bit for bit (I-6, T-C30).

### G.2 Inputs per account and day

| Input | Source | Status |
|---|---|---|
| Policy and rules on day `d` | assignment covering `d` (E-06) → highest revision with `effective_from ≤ d` (C.8) | P3-A implemented; `effective_from` missing (C1) |
| Hours basis on day `d` | work pattern covering `d`: working weekdays and ordinary hours (per day or per week) | **Dependency: P3-B B1 `people_employee_work_patterns`** (documented only, E-10); must add ordinary weekly hours (D-P3C-12, D-P3C-23) |
| Employed on `d` | employee `start_date`, `end_date`, status history (E-08) | Implemented |
| Service period | count of activations in the status history (E-08); a rehire after `TERMINATED` starts the next | Implemented data; rule D-P3C-28 |
| Public holidays | B1 `people_holidays` | Dependency; affects consumption hours only, never accrual |
| Unpaid or non-accruing leave | not in P3-A | Core accrues through all leave; pause rules need a vocabulary decision (D-P3C-22) |

### G.3 Hours as the canonical quantity (D-P3C-01)

- **HOURS policies:** amounts are already hours.
- **DAYS policies:** every amount the rules express in days (entitlement, carry cap, maximum, negative limit) is
  converted with `daysToHours` using the basis in force on the date the amount is applied: the period's last day
  for accrual, the year's first day for grants, the closing year's last day for carry caps, today for limits. The
  basis is stored on the entry (`hours_per_day`) so the conversion is auditable.
- **Basis (owner decision D-P3C-23, recommendation):** `hours_per_day = ordinary weekly hours ÷ 5`. A part-timer on
  22.8 h a week earns 20 "days" as `20 × 4.56 = 91.2 h`, which is four of their ordinary weeks, the same proportion
  as a full-timer. The alternative (average hours of the days they actually work) treats a "day" as one of the
  employee's own working days, which gives people who work fewer, longer days more hours. The two are different
  meanings of a policy day; which one Regan intends decides it. Either is a product rule, not law, and lives in the
  adapter.
- **Leave cost:** hours per date from the B1 duration engine (pattern hours that date; 0 on holidays and non-work
  days; half a date = half its hours; HOURS requests use the hours entered). Stored per date on the reservation.

### G.4 Periods

- Periods are **anchored at the leave-year start**: WEEKLY 7 days, FORTNIGHTLY 14 days, MONTHLY calendar months from
  the anchor day (a day 29–31 anchor clamps to month end). The last period of a year ends at the year end, so no
  period crosses a leave-year boundary and each accrual entry belongs to one bucket.
- An `ACCRUAL` entry `applies_on` its period's last day (`period_end − 1`), so as-of views include a period only
  once it is complete. Partial periods (start of employment or assignment, cutover, termination) accrue pro rata by
  days (G.5) and are posted at the period's end (termination: at the end date).
- Rules in force on the period's **last day** govern the whole period (P3-A §4.7 rule 4); the hours basis is
  weighted day by day, so an FTE change mid-period is pro rata by days.

### G.5 Amounts, precision and rounding

- Exact nominal share: MONTHLY = 1/12 of the annual hours per full month; WEEKLY and FORTNIGHTLY = 7 or 14 over the
  number of days in the leave year (365 or 366; a transition year uses its own length).
- Day weighting inside a period: `exact = share × Σ_d annualHours(d) / days(period)`, where `annualHours(d)` is the
  entitlement converted with that day's basis, or 0 when not employed or not assigned on `d`.
- **Cumulative rounding per bucket:** `posted_k = round(Σ_{i≤k} exact_i) − round(Σ_{i<k} exact_i)`, rounding half
  to even at 4 decimal places. The bucket's accrual total is therefore always within 0.00005 h of the exact total
  and a full year totals exactly the entitlement (§F.7: 12.6667, 12.6666, 12.6667 …). No drift accumulates.
- **Maximum balance:** the full computed accrual is posted, then any excess over `max_balance` (balance counting
  entries with `applies_on ≤` the credit date; reservations do not make room) is posted as `EXPIRY` reason
  `MAX_BALANCE` in the same transaction (D-P3C-30). This keeps accrual replay exact and makes the forfeited hours
  visible. Reversals, cancellations and corrections are never refused for exceeding the maximum (P3-B C-22).
- **Granularity** (FULL_DAY, HALF_DAY, QUARTER_HOUR …) governs what can be **requested**, not balances.

### G.6 Year opening, carry-forward and expiry

When catch-up reaches the end of the `OPEN` bucket (rules as P3-B §5.6 rule 2, now explicit):

1. `closing` = realised `B` of the old bucket through its last day (all its accrual posted first).
2. Rules at close: the revision in force on the old year's last day. For `closing ≥ 0`: `carry = 0` (NONE),
   `closing` (UNLIMITED), `min(capHours, closing)` (CAPPED). For `closing < 0`: **owner decision D-P3C-11**,
   recommended `carry = closing` whatever the rule (`CARRY_OUT = −closing > 0`, `CARRY_IN = closing < 0`); the
   alternative applies the rule and posts `WRITE_OFF = −closing` for the part not carried.
3. `lapse = closing − carry` when positive, posted as `EXPIRY` reason `CARRY_CAP` in the old bucket.
4. `CARRY_OUT −carry` in the old bucket, `CARRY_IN +carry` in the new one (paired); old bucket → `CLOSED` (I-4).
5. New bucket → `OPEN` (it may already exist as `FUTURE` with reservations). `GRANT` for GRANT policies with the
   rules in force on the new year's first day, pro rata by days if the assignment or service starts later
   (D-P3C-20).
6. All in one `YEAR_OPEN` transaction under the account lock, key `yo:{bucketId}`. Several missed years are opened
   one by one in ascending order in the same catch-up.

- **Leave-year definition changes** (CALENDAR → CUSTOM by revision or by a new assignment): the current year runs
  to its end under the old definition; the next bucket runs from there to the first boundary of the new definition
  (a transition year, possibly short, grant pro rata) (D-P3C-21; P3-A §4.7 rule 5).
- **ANNIVERSARY** years start on the service period's start date; a 29 February start uses 1 March in non-leap
  years (D-P3C-16).
- **Date-based expiry** of carried hours (for example "use within 12 months") is not in P3-A's vocabulary. When
  added (D-P3C-15), the engine posts `EXPIRY` reason `POLICY_EXPIRY` on the expiry date, consuming oldest carried
  hours first, as a system entry with its own key.

### G.7 Backdating, reconciliation and corrections (D-P3C-05)

| Situation | What happens |
|---|---|
| Catch-up runs late (nobody touched the account for months) | Posts the same entries as on time: keys and amounts depend only on inputs; `recorded_at` shows when it was known |
| Retroactive approval (leave dates ≤ today, P3-B `allowBackdated`) | Reserve and consume in one transaction; refused for a closed year (P3-B `leave_year_closed`) |
| An input was wrong in the past (hours basis, assignment, start date entered wrongly) | Inputs are not edited retroactively (D-P3-9). The verifier (J.4) replays with corrected inputs on request and produces a **proposed correction set** (reversal of affected system entries + replacement `ADJUSTMENT`s). An authorised person posts it as one `CORRECTION` (D-P3C-04). Nothing is auto-posted |
| A change lands in a `CLOSED` bucket (correction, consumption reversal of last year) | Posted into that bucket (attribution, D-P3-45), then **carry propagation** forward, year by year, ascending, in the same transaction: with `δ` entering year `i`, `newCarry = carryRule_i(closing_i + δ)` using the rules recorded on year `i`'s `CARRY_OUT`; post `δcarry = newCarry − oldCarry` as `CARRY_OUT`/`CARRY_IN` and `δlapse` as `EXPIRY` (signs may be negative in a `CARRY_PROPAGATION`); continue into year `i+1` with `δ = δcarry` until it is 0 or the open bucket is reached. Keys `cp:{causingTransactionId}:{bucketId}`. This closes the multi-year point P3-B rule 6 left open (D-P3C-31) |
| Policy edited | New revision effective today; posted entries untouched; future periods use it |
| Approved request found wrong | Cancel (release / reverse consumption) and resubmit, or a `CORRECTION` |

### G.8 Employment events

| Event | Ledger effect |
|---|---|
| `PENDING` employee | Nothing accrues; no account needed |
| Activation (start) | Service period begins; accrual from `start_date` (and the assignment start, and any cutover) |
| `ON_LEAVE` status (manual P1 status) | No effect in core (it is informational, P3-A doc §1); pausing is D-P3C-22 |
| Hours or work-pattern change | New basis from its effective date; accrual weighted by day; approved reservations keep their hours |
| Termination | Accrual through `end_date` (last period pro rata); `FREEZE`: reservations after `end_date` released (`FROZEN`), open bucket → `FROZEN`; balance kept, not forfeited, not paid (D-P3C-17). Payout only by a `PAYOUT` transaction with a payroll reference |
| Rehire | New service period, new buckets; frozen balance not reinstated automatically; an authorised adjustment may bring it across with reason `AGREEMENT` (D-P3C-28) |

### G.9 Catch-up contract and the virtual view (compute on read, D-P3C-08)

`catchUp(account, through)` is a single pure function `plan(inputs, posted, through) → ordered list of postings
and bucket state changes`. A write executes the plan under the account lock; a read applies the same plan in
memory to the posted entries. Because both use one function on the same inputs, they cannot disagree.

**Complete event set** (all derived kinds; nothing else is ever virtual):

| Order on a date `d` | Event | Postings (virtual or real) | Bucket state |
|---|---|---|---|
| 1 | Year boundary at `d` (`d` = old `year_end`): close the old year | accrual of the old year's last (possibly partial) period first; then `CARRY_OUT`/`CARRY_IN`, lapse `EXPIRY`, `WRITE_OFF` if decided | old → `CLOSED` |
| 2 | Open the new year at `d` | `GRANT` (GRANT policies, pro rata D-P3C-20) | new → `OPEN` (created, or `FUTURE` → `OPEN`) |
| 3 | Accrual period ending on `d − 1` (not already handled in 1) | `ACCRUAL`, then max-balance `EXPIRY` if any | — |
| 4 | Reservation dates `leave_date = d`, `d ≤ today` | `CONSUMPTION` + release(`CONSUMED`) per date | — |
| 5 | Termination with `end_date = d − 1` | final pro rata `ACCRUAL` (if not in 3); release(`FROZEN`) for every reservation date `> end_date` | open (and future) buckets → `FROZEN` |
| 6 | Later, a rehire | new service period: new buckets from the new start date (no event on the old ones) | — |

Days are processed in ascending order from the earliest unposted event up to `through`; within one date the order
above applies (credits before debits, as P3-B rule 8d). Several missed years are closed and opened one by one.
Termination stops all later events of that service period.

**Rules:**

- **Reads:** realised view = posted ∪ `plan(…, through = today)`. Virtual rows are marked `virtual: true` in DTOs,
  have no `recorded_at`, and are never shown in "as known at" views with `K < now` (§F.1a). Virtual bucket states
  are reported as such (`state: 'OPEN', virtual: true`).
- **Equality guarantee:** for every account, the realised view read immediately before a catch-up equals the
  posted view read immediately after it, entry for entry (same kinds, hours, dates, keys) and state for state.
  Tests T-C21a (new year with cap, lapse and grant) and T-C21b (termination with future reservations) assert it.
- **Projection:** the simulation (§F.5) starts from the realised state at today, so every boundary on or before
  today is already in the start value (posted or virtual) and is **never forecast**; only boundaries after today
  are forecast. This restates P3-B rule 8a for virtual entries.
- **Writes:** every ledger write runs `catchUp(account, today)` first, inside the lock, then its own posting.
  Manual postings dated in the past do not change the plan for earlier dates except through propagation (§G.7),
  which is part of the manual transaction, not of catch-up.
- **Bounded cost:** the plan is O(periods + due dates + boundaries); T-C70 measures a 24-month gap.

---

## H. API, service and payroll-facing contracts

### H.1 Internal ledger service (People-internal, not HTTP; replaces P3-B §5.3)

| Function (proposal) | Contract | P3-B item |
|---|---|---|
| `withAccount(db, employeeId, leaveTypeId, fn)` | Creates the account if missing, locks it (version bump), locks the buckets the call will touch in ascending `year_start`, runs catch-up through business today, then `fn`. Takes no People lock after the account | C-20, C-24 |
| `reserve(acct, { requestId, policyId, policyVersion, dates: [{ date, hours }], basis })` | Refuses (`insufficient_balance`, with the projection) unless `project` fits with `L` from today's rules (D-P3C-03); posts one `RESERVATION` per date in the bucket of each date (all in one leave year, D-P3-45), and consume-pairs for dates ≤ today; returns the transaction id and entry ids | C-21 (amended) |
| `release(acct, { requestId, transitionSeq, dates? })` | Releases every unsettled reservation date of the request after today (or the listed dates); never touches consumed dates | new (R-02) |
| `reverseConsumption(acct, { requestId, transitionSeq, reasonCode, reasonText })` | Reverses each `CONSUMPTION` of the request; propagates if a year is closed | C-22 (amended) |
| `project(db, employeeId, leaveTypeId, { candidate?, includePending, at: 'estimate' \| 'decision' })` | §F.5; read-only; authoritative only inside `withAccount` | C-26 |
| `balances(db, employeeId, leaveTypeId?, { asOf?, knownAt? })` | §F.2 quantities per bucket, realised when `knownAt` is now | C-23 |
| `post(acct, ManualTransaction)` | ADJUSTMENT, CORRECTION, EXPIRY, PAYOUT, OPENING_BALANCE; checks D-P3C-04 authority; idempotent by key + hash | new |
| `verify(db, employeeId?, leaveTypeId?)` | Runs §J.4 checks and engine replay; returns findings, never writes | T-59a |

Entitlement `NONE` policies: no account, no ledger, no projection (P3-B C-25, §9.6). Their requests are records
of absence only; consumption hours are still computed for display and payroll (D-P3C-22 decides whether unpaid
leave affects accrual of other types).

### H.2 What P3-C requires from P3-B and B1 (dependencies, not facts)

| # | Requirement | Where it must be specified |
|---|---|---|
| X-01 | Per-date hours for a request from the B1 duration engine (pattern, holidays, half days, HOURS entry) | P3-B B1 (§6.1a, §9.2) + D-P3C-23 |
| X-02 | Work patterns with ordinary weekly hours, effective-dated, not future-dated | P3-B §6.1a, amended |
| X-03 | Request stores hours (and display days); approval calls `reserve`; cancellation calls `release` and, when recorded, `reverseConsumption`; withdraw/reject call nothing | P3-B §6.3, §7.2, §10.3 amended (R-02, R-03) |
| X-04 | Lock order: request → policy → employee → assignments → occupancy → **account** → buckets | P3-B §10.2, amended to name the account |
| X-05 | Pending hours per bucket for views (`Pd`) | P3-B §5.3 C-23 |
| X-06 | Partial cancellation of remaining dates, if Regan wants it (D-P3C-14) | new P3-B transition |

### H.3 HTTP endpoints (P3-C4 and P3-C5; all under `/api/v1/b/:slug/people`, registered `available: false` until Regan switches them on)

| Method and path | Key (route) | Record scope (server-side, §I.3) | Package |
|---|---|---|---|
| `GET /me/leave/balances?asOf&knownAt` | `people:leave_self` | own linked employee | C4 |
| `GET /me/leave/ledger?leaveTypeId&year&cursor&limit` | `people:leave_self` | own | C4 |
| `GET /employees/:id/leave/balances?asOf&knownAt&leaveTypeId` | any of `leave_approve`, `leave_manage`, grant | line manager of `:id`, grant scope, or manage | C4 |
| `GET /employees/:id/leave/ledger?leaveTypeId&year&cursor&limit` | any of `leave_manage`, grant | grant scope or manage | C4 |
| `GET /leave/balances?departmentId&leaveTypeId&asOf&cursor&limit` | `leave_manage` | business-wide | C4 |
| `POST /employees/:id/leave/adjustments` `{ leaveTypeId, hours \| days, appliesOn, reasonCode, reasonText, idempotencyKey }` | any of `leave_manage`, grant | D-P3C-04 | C5 |
| `POST /employees/:id/leave/corrections` `{ leaveTypeId, reversesEntryIds[], replacements[{ hours, appliesOn }], reasonCode, reasonText, idempotencyKey }` | same | same | C5 |
| `POST /employees/:id/leave/expiries`, `/payouts` `{ …, payrollRef? }` | same | same | C5 |
| `POST /leave/imports` (stage), `GET /leave/imports/:id`, `POST /leave/imports/:id/post` `{ version }`, `/discard` | `leave_manage` | business | C5 |
| `GET /leave/authorisations`, `POST /leave/authorisations` `{ userId, capability, departmentId? }`, `POST /leave/authorisations/:id/revoke` | `leave_manage` with role OWNER or ADMIN | business | C5 |
| `GET /leave/verification?employeeId&leaveTypeId` | `leave_manage` | business | C6 |
| `POST /leave/realise` `{ through }` (catch-up for all accounts, in batches of 50, idempotent) | `leave_manage` | business | C6 |
| `GET /leave/payroll/movements?periodStart&periodEnd&cutoff&cursor` | `leave_manage` (a payroll key later) | business | C6 (contract), off |

Errors (additive): `400 invalid_input`, `invalid_query`, `invalid_cursor`, `reason_required`, `invalid_hours`,
`future_date`; `403 forbidden`, `self_correction`; `404 not_found`, `not_linked`; `409 stale`,
`idempotency_conflict`, `insufficient_balance` (with projection), `bucket_closed` (direct posting to a closed
bucket without propagation path, a bug), `frozen`, `already_settled`, `import_conflict`, `immutable`.
DTOs carry hours as decimal strings with 4 places and a `days` display object `{ value, basisHoursPerDay }` or
`null` (D-P3C-01). Forecast figures carry `basis: 'forecast'` (P3-B rule 8c).

### H.4 Payroll-facing contract (design only; nothing built until a payroll stage is approved)

**Separation.** People's ledger records **hours**. It never stores a rate, an amount of money, a loading, a
liability or a journal. These belong to a future payroll Zone or an external payroll system:

| Quantity | Owner | Source |
|---|---|---|
| Approved future leave | People | `RESERVED` book (not a liability movement by itself) |
| Leave taken (consumed) per pay period | People | `CONSUMPTION` entries by `leave_date` |
| Balance hours at a date | People | `B` as of / as known at |
| Hours paid out | People records, payroll decides | `PAYOUT` entries with `external_ref` |
| Leave liability (money), accrual journals, payments | Payroll / Finance | never People |

**Movement record** (stable, additive contract in `packages/contracts`, C6):

```ts
type LeaveMovement = {
  movementId: string;          // entry id (immutable)
  transactionId: string;
  employeeId: string; leaveTypeId: string;
  kind: 'ACCRUAL' | 'GRANT' | 'CARRY_IN' | 'CARRY_OUT' | 'EXPIRY' | 'CONSUMPTION' | 'ADJUSTMENT'
      | 'REVERSAL' | 'PAYOUT' | 'OPENING_BALANCE' | 'IMPORT';     // RESERVED-book kinds are excluded
  hours: string;               // signed, 4 dp
  appliesOn: string; leaveDate: string | null;
  recordedAt: string;
  reversesMovementId: string | null;
  priorPeriod: boolean;        // appliesOn before the export period, recorded after the previous cutoff
};
```

**Period export workflow (future):** realise through the period end → take a seal (§F.1a: a stored
`pg_current_snapshot()`) → the export contains movements with `applies_on` in the period that are visible to this
seal, plus prior-period movements visible to this seal and not to the previous one; the line set is stored by the
payroll stage and hashed → (`recorded_at` is shown, never used to decide membership) →
payroll imports it and returns its own per-employee totals (taken, paid out, closing hours) → People compares
against "as of period end, within the seal" → differences are listed, never auto-fixed; an authorised person
resolves each with a correction (D-P3C-04) that appears in the next export as a prior-period movement. Exported
movements are never changed. External references (payroll employee ids, leave codes) live in a future
`people_leave_external_refs` table owned by the payroll stage. A payout is recorded as `PAYOUT` only after payroll
confirms it, with its reference (`po:{externalRef}` makes it idempotent).

**Escalation:** connecting any payroll system is an external effect and possibly a paid service: Regan's decision.

### H.5 When a past request or policy changes

| Change | Effect |
|---|---|
| Policy rules edited | New revision from today; posted entries never recalculated; future accrual uses it; pending requests re-quoted at approval (P3-B `amount_changed`) |
| Assignment replaced | From its effective date; reservations already approved keep their hours and policy version |
| Work pattern or hours changed | Accrual weighted from the change; approved reservations unchanged (cancel and resubmit to re-cost) |
| Holiday added after approval | No recalculation (P3-B §9.6); cancel and resubmit, or correction |
| Approved past leave did not happen | `REVERSE_CONSUMPTION` (reason mandatory), propagated if the year is closed |
| Wrong posted entry | `CORRECTION`: reversal + linked replacement; both visible in the ledger and the payroll feed |
| Leave type made sensitive | No ledger effect; visibility follows D-P3C-25 |

---

## I. Access, security and concurrency threat matrix

### I.1 Identity

- "The employee" is the employee whose `user_id` link equals the session user (E-07), membership `ACTIVE`.
  Suspension keeps the link but blocks access (P3-B §3.1); removal clears it. No new identity, no user
  confirmation in this stage (P3-B D-P3-47).
- Actors on ledger rows come from `current_setting('app.user_id')`, never from the statement (E-20, P3-B D-P3-51).
  A missing setting fails closed.

### I.2 Who may write

| Operation | Allowed | DB backstop |
|---|---|---|
| Derived postings: accrual, year opening, consumption, freeze (basis `DERIVED`) | Only the catch-up code path, never an API input (§I.2a) | §I.2a: kind/basis matrix, pair and closing invariants, idempotency keys; amount correctness for `ACCRUAL` and `GRANT` is **trusted application behaviour**, detected (not prevented) by the verifier |
| Reserve, release, reverse consumption | Only P3-B decision paths, with P3-B's verified basis (P3-B §6.8) | **Refused by the C1 guard** (fail closed) until the P3-B request tables exist; the C3/B2 migration replaces that refusal with the request-transition backstop (§I.2a) |
| Adjustment, correction, expiry, payout, opening balance (D-P3C-04) | Role OWNER or ADMIN (`people:leave_manage`), or a member holding an active `LEAVE_CORRECT` grant whose department scope covers the employee's current department; reason mandatory; never on one's own account (D-P3C-19) | Trigger re-derives the basis from the session user, membership, role list (written into the migration, drift test against `permissions.ts`) and grants; refuses own account. **Refused by the C1 guard** until C5 ships the grants and the endpoints |
| Grant or revoke `LEAVE_CORRECT` | OWNER or ADMIN; a posting reads the grant `FOR SHARE` before the account lock, a revoke takes it `FOR UPDATE` | Guard on `people_leave_authorisations` |
| Maker-checker (if chosen, D-P3C-18) | Proposer and decider different authorised people | `decided_by ≠ proposed_by` in the guard, both from the session |

### I.2a Authority versus integrity (what is prevented, what is only detected)

**Threat.** Anyone able to run SQL as `bos_app` in a tenant transaction (the application, or an attacker who has
its credentials) can bump an account and insert a positive `ACCRUAL` or `GRANT` with a fresh period key. Sign,
book and lock checks pass. Labelling the actor `DERIVED` proves nothing about entitlement.

**What the design prevents at write time, for every API caller:**

1. **No API input selects a kind, a book, a basis or an amount source for a derived posting.** Manual endpoints
   (C5) accept only the manual kinds (`ADJUSTMENT`, `CORRECTION`, `EXPIRY`, `PAYOUT`, `OPENING_BALANCE`) through
   strict contract schemas (unknown fields rejected, as P3-A). Catch-up is not an endpoint; it is a server step
   whose amounts come from the engine and the database. P3-B endpoints call `reserve`/`release` with hours from the
   B1 engine, never from the client.
2. **Kind/basis matrix in the guard** (DB, every insert):

   | Ledger transaction kind | Entry kinds it may contain | Actor bases it accepts |
   |---|---|---|
   | `ACCRUAL`, `YEAR_OPEN`, `CONSUME`, `FREEZE`, `CARRY_PROPAGATION` | `ACCRUAL`; `GRANT`, `CARRY_*`, `EXPIRY`(CARRY_CAP), `WRITE_OFF`*; `CONSUMPTION` + release(CONSUMED); release(FROZEN); `CARRY_*`, `EXPIRY` | `DERIVED` only |
   | `RESERVE`, `RELEASE`, `REVERSE_CONSUMPTION` | `RESERVATION` (+ consume pairs for past dates); release(CANCELLED); `REVERSAL` of `CONSUMPTION` | P3-B bases only (`SELF`, `LINE_MANAGER`, `LEAVE_MANAGER`, `LEAVE_MANAGER_OVERRIDE`, `AUTO_NO_APPROVAL`, `SOLE_OWNER_SELF`) |
   | `ADJUSTMENT`, `CORRECTION`, `EXPIRY`, `PAYOUT`, `OPENING_BALANCE`, `IMPORT` | `ADJUSTMENT`, `REVERSAL` (not of carry), `EXPIRY`(MANUAL), `PAYOUT`, `OPENING_BALANCE`, `IMPORT`, + propagation | `LEAVE_MANAGER`, `LEAVE_CORRECT_GRANT`, `SOLE_AUTHORISER` — each re-derived from the session in SQL |

   \* `WRITE_OFF` only after D-P3C-11. A manual basis can never create a derived kind and `DERIVED` can never
   create a manual or request kind, so **choosing a kind or basis cannot grant balance-changing authority**: a
   manual kind needs a re-derived manual authority, and a derived kind cannot be reached from any API input.
3. **SQL-verified derived amounts where the inputs are in the database:** carry pairs and the year-closing sum
   (§C.6), lapse = closing − carry, consumption and release = −reservation, reversals mirror. These are
   *prevented*, not just detected.
4. **Stage gating (fail closed):** the C1 guard accepts only the transaction kinds C1 builds and tests; every other
   kind (request kinds before B2/C3, manual kinds before C5, `WRITE_OFF` before D-P3C-11) is refused with a PE
   error. Each later migration widens the list together with its own backstop. C1 therefore makes no claim about
   a request-transition backstop.

**What is trusted application behaviour (detected, not prevented), stated explicitly:** the hours of `ACCRUAL`
and `GRANT` entries, which depend on the engine (periods, hours basis, pro rata, rounding). Against direct SQL with
`bos_app` credentials this is the same trust boundary as tenant isolation and P3-B §6.8 point 4. Detection: the
verifier (V-08) replays the engine and reports any system entry it would not have produced; it runs in tests, on
the verification endpoint (C6) and before any payroll export.

**Stronger option (not recommended now, owner and security decision D-P3C-32):** move derived postings behind
`SECURITY DEFINER` functions that compute the amounts in SQL, owned by a non-login role, with `bos_app` holding
EXECUTE only and no INSERT on derived kinds. This duplicates the engine in PL/pgSQL and is a new privileged
boundary (privileged SQL on production is Regan's, per the protocol). It would need its own enhanced security
review. Recommended instead: accept the stated trust boundary for C1–C2 and revisit before payroll (C6+), where
money depends on the hours.

### I.3 Who may read (D-P3C-06), enforced in the database

**Levels.** RLS works per row, so the boundary between "balance" and "detail" must be a table boundary:

- **Balance level** = `people_leave_accounts`, `people_leave_buckets`, `people_leave_entries` (kinds, hours, dates,
  policy version; no actor, no reason, no external reference). Balances are sums of these rows.
- **Detail level** = `people_leave_transactions` (actor, basis, reason code and text, external reference,
  idempotency key), `people_leave_import_batches`/`rows`, `people_leave_correction_proposals`,
  `people_leave_authorisations`.

| Viewer | Balance level | Detail level | Sensitive types (entry `sensitive` snapshot OR type flag) |
|---|---|---|---|
| The employee (session user linked to the employee, membership `ACTIVE`) | own | own (reasons about them included) | own, all |
| Eligible line manager (P3-B §8.2 on business today; role holds the approve key) | current direct reports | **none** | only if the manager's role also holds `people:read_sensitive` |
| `LEAVE_CORRECT` grant holder (active grant, membership `ACTIVE`) | employees in grant scope | employees in grant scope | as line manager |
| OWNER, ADMIN | business-wide | business-wide | yes |
| `people:read` only | none | none | none |

This revises the v1.0 manager row ("balances and reservations only"): a manager can read the dated movements that
make up a report's balance (which P3-B's request views already show them) but never reasons, actors or external
references. A stricter "totals only" view for managers would need a privileged aggregate function (D-P3C-25
option C), because RLS cannot hide a row's columns from one viewer and not another.

**Policies** (in the **C1** migration, before any row can exist):

- Balance-level tables: `tenant_isolation` (permissive) **and** `RESTRICTIVE FOR SELECT … USING
  (people_leave_can_read(employee_id, leave_type_id, sensitive_or_type_flag, 'BALANCE'))`.
- Detail-level tables: same with `'DETAIL'`. Transactions carry `employee_id` and `leave_type_id`; their
  sensitivity is that of their entries (`EXISTS` a sensitive entry, or the type flag).
- `people_leave_can_read(employee, type, sensitive, level)` is `STABLE SECURITY INVOKER`, reads only tenant tables
  visible to `bos_app` (memberships, employees, manager assignments, leave types, authorisations) through indexed
  lookups, and takes the actor from `app.user_id`; a missing setting returns false. Role lists (which roles hold
  manage, approve, read_sensitive) are written into the migration with a drift test against `permissions.ts`.
- **Staged and fail closed:** C1 ships the function with the employee and OWNER/ADMIN branches only. The
  line-manager and grant branches are added by the migrations that introduce the approve key (C4) and the grants
  (C5). Until then those viewers see nothing.
- INSERT paths are governed by §I.2a; the restrictive policies are `FOR SELECT` only, so a writer that cannot read
  a row still cannot change it (no UPDATE/DELETE grants).

The service resolves scope first and never relies on RLS for correctness of what it shows; RLS is the backstop
that makes a service bug fail closed. The `jobs` role gets nothing. No balance appears in search, reporting,
notifications or audit text.

### I.4 Concurrency model

- READ COMMITTED (E-21) with explicit row locks; no SERIALIZABLE, no extensions, PgBouncer-safe (no session-level
  locks or settings; tenant settings are transaction-local, E-20).
- **One serialisation point per account:** every ledger write updates the account row first (version +1), so all
  writers of one employee's balance of one type queue on that row. Buckets are then locked `FOR UPDATE` in
  ascending `year_start`. The full set of buckets a transaction touches is computed before the first bucket lock.
- **Global order:** advisory reporting lock (P1 termination only) → P3-B request `FOR UPDATE` → policy `FOR SHARE`
  → employee `FOR SHARE` (`FOR UPDATE` in termination) → assignments → occupancy rows → **account** → buckets
  ascending → inserts. P3-C takes no People lock after the account (C-24). Manual postings take employee
  `FOR SHARE` then the account. No path takes them in another order, so no cycle.
- Projections used for a decision are computed **after** the account lock, from the state after catch-up;
  estimates outside the lock start from the realised view (posted + virtual, §G.9) and are labelled advisory.
- `retryOnConflict` (E-22) on every ledger-writing route; the whole unit of work re-runs and re-reads.

### I.5 Threat and failure matrix

| # | Threat or failure | Mitigation | Test |
|---|---|---|---|
| S-01 | Reading another business's balances | Forced RLS `tenant_isolation` on every table; composite tenant FKs; ids from other businesses are `404` | T-C40, T-C41 |
| S-02 | Employee reads a colleague's balance | Self scope by session link; restrictive RLS | T-C42 |
| S-03 | Manager reads non-reports or sensitive types | Scope resolved on business today; restrictive RLS; sensitive filter | T-C43, T-C44 |
| S-04 | MANAGER corrects without a grant, or a grant holder outside scope | Service check + trigger re-derivation | T-C45 |
| S-05 | Correcting one's own balance | `self_correction`; trigger refuses | T-C46 |
| S-06 | Forged entry via direct SQL as `bos_app` with a fake kind or amount | Guards (kind/book/sign, reversal mirrors, lock proof), no UPDATE/DELETE grants, verifier replay flags system entries that the engine would not produce | T-C05, T-C06, T-C30 |
| S-07 | Forged actor | Actor from `app.user_id` only; same trust boundary as tenant isolation (P3-B §6.8 point 4) | T-C47 |
| S-08 | Tampering by the migration owner | Out of the runtime trust boundary; detected by verifier and audit cross-checks; Neon recovery branches | — |
| S-09 | Reason text leaks to audit, notifications, search | Never copied; audit carries ids, kinds, hours; N1 `PEOPLE` class carries no text | T-C48 |
| S-10 | Revoked grant still used in a racing request | Grant row read `FOR SHARE` before posting; revoke takes `FOR UPDATE`: one waits | T-C49 |
| C-01 | Two approvals overspend one balance | Account lock serialises; second sees the first's reservation; `insufficient_balance` | T-C50 |
| C-02 | Approval races a correction or payout | Same account lock; the later sees the earlier | T-C51 |
| C-03 | Two catch-ups at once (two requests touching one account) | Account lock; second finds keys present, posts nothing | T-C52 |
| C-04 | Approval of a next-year request races year opening | Both lock account then buckets ascending | T-C53 |
| C-05 | Termination races an approval | Employee lock first (P3-B checks terminated under it); freeze under the account lock | T-C54 |
| C-06 | Deadlock | Global order; `retryOnConflict` up to 3 attempts; deterministic race tests assert none on service paths | T-C55 |
| F-01 | Client retries a manual posting after a timeout | Same key + same hash → `200` with the original; different body → `409` | T-C60 |
| F-02 | Approval committed, response lost, client retries | P3-B version → `409 stale`; `rs:{requestId}` and per-date uniques prevent a second reservation | T-C61 |
| F-03 | Crash mid-transaction | Rollback; nothing partial (single transaction; deferred pair checks) | T-C62 |
| F-04 | Catch-up after a long gap is large (2 years ≈ 52 accruals, 2 year openings, hundreds of consumption pairs) | Bounded work; measured in T-C70; if over budget, catch-up proceeds in chunks of whole months, each its own committed step, before the caller's transaction | T-C70 |
| F-05 | Business time zone changes | Entries store business dates; nothing recomputed; "today" changes from that moment | T-C33 |
| F-06 | Midnight between estimate and approval | Approval recomputes under the lock with its own business today | T-C34 |
| F-07 | Rounding drift | Cumulative rounding per bucket; year total exact | T-C20, T-C21 |
| F-08 | `numeric(12,4)` overflow | Range ±99,999,999 h; CHECK on single amounts ≤ 10,000 h | T-C07 |
| F-09 | Duplicate import file | Content hash unique among live batches | T-C80 |
| F-10 | Engine bug posts wrong system entries | Verifier detects; routes switched off; reviewed correction set, posted by an authorised person (large volumes: Regan decides, §J.6) | T-C31 |

---

## J. Migration, replay and reconciliation plan

### J.1 Migrations (design only; nothing created, applied or approved here)

| Migration | Package | Content | Class |
|---|---|---|---|
| `…_people_leave_ledger` | C1 | accounts, buckets, transactions, entries, authorisations table (empty, no API); CHECKs, guards with the stage gate (§I.2a), deferred invariants (§C.6), unique and partial unique indexes, composite FKs, grants (SELECT + INSERT; UPDATE only on account `version`/`updated_at` and bucket state columns), forced RLS **and the restrictive read policies with their fail-closed C1 branches (§I.3)**; revision `effective_from` (J.2) | Additive DDL **plus an existing-data transformation** (J.2): not routine; rehearsal, preflight evidence and lock limits required |
| `…_people_leave_visibility` | C4 | adds the line-manager branch to `people_leave_can_read` once the approve key exists; widens the stage gate for request kinds (with the request-transition backstop, coordinated with P3-B B2) | Additive; security-sensitive (enhanced audit) |
| `…_people_leave_corrections` | C5 | grant branch of `people_leave_can_read`, import batches and rows, (optional) correction proposals, their guards; widens the stage gate for manual kinds | Additive; authorisation change (enhanced audit; Regan's merge approval recommended, §M) |

Stamps: after every stamp on `main` and in open PRs **at build time** (today after `20261207000000`, #110), and
after P3-B B1's if B1 is built first. Each migration one transaction (`BEGIN/COMMIT`), no privileged SQL, no
extension. New indexes are built on empty tables.

### J.2 The revision `effective_from` back-fill (an existing-data transformation)

**What is known and what is inferred.** A revision row records `recorded_at` (an instant). Its business-local
date is `recorded_at` converted with the business time zone **in force at that instant**. The business time zone
can be changed (A2-A business profile; a change is audited as `business.updated` with `timeZoneFrom` and
`timeZoneTo` in its metadata, `apps/api/src/modules/tenancy/server/business-profile.ts:102-110`). Converting with today's time zone is
therefore an **inference**, exact only if the zone never changed after the revision, and at most one calendar day
off otherwise.

**Design (D-P3C-35, owner decision on the inference; recommendation):**

1. Add `effective_from date` and `effective_from_basis text` (`RECORDED` for rows the new guard writes,
   `INFERRED` for back-filled rows; CHECK).
2. Back-fill with the business's current time zone and mark the rows `INFERRED`. The migration does not read the
   audit log. The read-only preflight lists every business whose audit log shows a `timeZone` change after its
   earliest revision (those rows may be one day off); the list goes into the evidence.
3. **Make the inference irrelevant to postings:** the engine never uses an `INFERRED` revision to govern a date
   on or after the C1 apply date + 1 day, except as "the highest version recorded before that day", which does not
   depend on the inferred date. Opening-balance cutovers (J.3) and therefore accrual floors must be on or after the
   C1 apply date + 1 day (guard on import batches). So no ledger amount ever depends on an inferred date.
4. The new guard sets `effective_from` = business today and `RECORDED` for every new revision.

**Migration mechanics (same pattern as `20261125000000_communications_mailbox_identity/migration.sql:139-141`):**
inside the one migration transaction, `SET LOCAL lock_timeout = '3s'` and `SET LOCAL statement_timeout = '30s'`;
`ALTER TABLE people_leave_policy_revisions NO FORCE ROW LEVEL SECURITY` so the migration owner sees **every
tenant's rows** (whole-database visibility; with FORCE on, the owner would see none and the UPDATE would silently
change nothing); `DISABLE TRIGGER people_leave_policy_revisions_guard`; the UPDATE; **an in-migration assertion**
that `count(*) WHERE effective_from IS NULL` = 0 and that the updated count equals the pre-count (raise to abort
otherwise); re-enable the trigger, `FORCE ROW LEVEL SECURITY` again, `SET NOT NULL`, replace the guard. The P3-A
migration file is not edited.

**Preflight and evidence before the apply verdict** (protocol "Production migrations", nothing assumed):
fresh read-only `_prisma_migrations` (pending set = exactly this migration; checksums match); read-only counts of
revision rows and businesses with revisions; the list of businesses whose time zone changed after a revision;
rehearsal on a disposable Neon branch from production showing the counts before and after, the assertion passing,
the measured lock and statement durations, and the RLS and trigger state restored. Because this transforms
existing rows, it is not "routine additive DDL": the audit decides whether it needs Regan's approval; if any
business had a time-zone change after a revision, Regan decides the inference (D-P3C-35).

### J.3 Opening balances at go-live

1. Configure types and policies; assign policies with effective dates on or before the cutover date.
2. Choose the cutover date (a business date not in the future, and on or after the C1 apply date + 1 day, J.2). The opening balance is the balance true at the
   end of the cutover date, **excluding** approved future leave from the old system.
3. Stage the batch: every row validated (employee exists and not terminated, type exists, an assignment covers the
   cutover date, hours or days × basis, no account already has accrual on or before the cutover date). The staging
   report shows totals per type and every rejected line. Nothing posts.
4. Post (all or nothing): one `OPENING_BALANCE` per row into the bucket containing the cutover date. Accrual for
   that account starts the day after the cutover (the engine treats the earliest `OPENING_BALANCE` as the floor),
   so the period containing the cutover accrues pro rata for the remaining days only.
5. Future leave already approved in the old system is re-entered as P3-B requests recorded approved on behalf
   (reserving normally) after P3-B ships.
6. Reconcile: the import report total per type equals the ledger's `Q_OPENING_BALANCE`; spot-check employees.
   Mistakes are corrected by `CORRECTION` (reverse the opening entry, post the right one), never by deletion.

### J.4 Consistency checks (verifier; read-only SQL, also run by tests)

| Check | Rule |
|---|---|
| V-01 | `Rv ≥ 0` per bucket; every reservation entry has at most one release and at most one consumption; consumption ⇒ release(CONSUMED) |
| V-02 | Every `CLOSED` bucket has `B = 0`, `Rv = 0` (I-4) |
| V-03 | At most one `OPEN` bucket per account and service period; buckets do not overlap |
| V-04 | Reversal entries mirror their originals (hours, bucket, book, leave date) |
| V-05 | Every `RESERVATION`/`CONSUMPTION` date lies in its bucket's year; entries of a request are in one bucket |
| V-06 | Account `version − 1` = number of transactions on it |
| V-07 | Every transaction has ≥ 1 entry; manual kinds have reason code (and text where required) |
| V-08 | Engine replay: for every system key the engine would produce through today, the posted entry exists with equal hours; no posted system entry lacks a replay counterpart |
| V-09 | P3-B agreement (from B2): every APPROVED request has a `RESERVE` transaction whose dates and hours equal the request's; every cancelled one has its releases; no reservation without a request |
| V-10 | Projection reconciliation (P3-B T-59a): start value + future reservations counted once |

### J.5 Projections and rebuilding

C1–C5 store no projection, so there is nothing to rebuild: every view is recomputed from entries. If measurement
later shows a need (C6+), a cache table keyed by `(bucket_id, as_known_at watermark)` may be added, written only
under the account lock, ignored by every decision (decisions always recompute under the lock), and rebuildable at
any time by deleting the cache rows of an account (the cache is not ledger data; deletion of cache rows would be
the only DELETE grant, and needs its own review).

### J.6 Recovery and rollback

- Code revert: tables stay, unused; routes are off by default anyway.
- Wrong data: corrections, never deletes or updates. A defect that wrote many wrong system entries is fixed by:
  switching routes off, fixing the engine, running the verifier to produce a correction set, reviewing it, and
  posting it as authorised `CORRECTION` transactions. If the volume makes that impractical, a one-off data repair
  is a risky data transformation: Regan's explicit approval (protocol "Escalate to Regan").
- Production schema: each migration behind a fresh `pre-<change>-migration` Neon recovery branch per the protocol.
  Restoring a branch or dropping tables is destructive: Regan only, and never needed for a rollback.

### J.7 Production steps (per migration, Mac session)

Fresh read-only `_prisma_migrations` (only the expected migration pending, checksums match) → recovery branch
created and validated → rehearsal on a disposable branch (C1 always, others if the audit asks) → evidence posted →
`APPROVED — EXECUTE: MIGRATION` (or Regan where it escalates) → `prisma migrate deploy` → verify forced RLS,
grants, triggers, zero ledger rows, back-filled `effective_from` → merge through the queue under a separate
merge verdict → smoke (`/api/v1/health`; leave routes 404 while off).

---

## K. Test matrix and acceptance criteria

Level: **S** = direct SQL as `bos_app` on real PostgreSQL with migrations; **I** = API/service integration;
**U** = pure engine unit test; **R** = deterministic race (two connections, `pg_blocking_pids`, as P3-A). Every
I and R test also runs behind PgBouncer in transaction mode (E-30).

| Id | Area | Test | Level | Package |
|---|---|---|---|---|
| T-C01 | Schema | Forced RLS and `tenant_isolation` on every new table; grants inventory (no DELETE/TRUNCATE; UPDATE only on listed columns) | S | C1 |
| T-C02 | Schema | Composite FKs refuse cross-employee, cross-type, cross-account, cross-policy-type links | S | C1 |
| T-C03 | Schema | Kind/book/sign CHECKs; zero amount refused; leave date outside the bucket refused | S | C1 |
| T-C04 | Schema | Entries and transactions refuse UPDATE and DELETE; bucket state machine guard | S | C1 |
| T-C05 | Guard | Entry without the account bump in the same transaction refused (lock proof) | S | C1 |
| T-C06 | Guard | Reversal must mirror; second reversal of one entry refused; consumption without paired release refused at commit | S | C1 |
| T-C07 | Precision | 4-dp storage, single amount bound, sums of 10,000 entries exact | S/U | C1 |
| T-C08 | Revisions | `effective_from` set by the database; back-fill correct in two time zones (Perth, New York); insert still append-only | S | C1 |
| T-C10 | Idempotency | Each system key twice → one row; manual key same body → 200 same transaction, different body → 409 | S/I | C1/C5 |
| T-C11 | Reservation | Reserve, consume per date, release, reverse; I-1, I-2, I-3 hold after each step | I | C1/C3 |
| T-C12 | Reservation | Retroactive approval reserves and consumes in one transaction; as-known-at before/after differ as §F.7 step 6 | I | C3 |
| T-C13 | Reservation | Cancel after partial consumption: future released, past kept; with "not taken" reversed | I | C3 |
| T-C14 | Reservation | Next-year reservation creates a FUTURE bucket; year opening keeps it; projection counts it once | I | C3 |
| T-C20 | Rounding | Monthly 152 h → 12.6667/12.6666 pattern, year exactly 152; weekly in 365 and 366-day years; fortnightly | U | C2 |
| T-C21 | Determinism | Catch-up on time vs 14 months late → identical entries (except `recorded_at`); realised read = later posting | U/I | C2 |
| T-C22 | Accrual | Mid-period start, assignment change, FTE change, termination: pro rata by day | U | C2 |
| T-C23 | Accrual | Rule change mid-period: last-day rule governs whole period; mid-year grant not regranted | U | C2 |
| T-C24 | Hours | DAYS policy conversion with basis recorded; part-timer basis per D-P3C-23 | U | C2 |
| T-C25 | Max balance | Excess posted as `EXPIRY MAX_BALANCE`; reversal above max not refused | U/I | C2 |
| T-C26 | Year boundary | CALENDAR, CUSTOM, ANNIVERSARY (incl. 29 February start); carry NONE/UNLIMITED/CAPPED; negative closing carried in full; lapse posted; closed bucket B = 0 | U/I | C2 |
| T-C27 | Year boundary | Several missed years opened in order in one catch-up | I | C2 |
| T-C28 | Year definition change | Transition year length and pro rata grant | U | C2 |
| T-C29 | Employment | Termination freeze releases future reservations; rehire opens a new service period | I | C2 |
| T-C30 | Replay | Verifier replay finds no difference on a randomized 3-year history; a forged system entry is reported | I | C2/C6 |
| T-C31 | Recovery | Injected engine defect → verifier finds it → correction set posted → verifier clean | I | C6 |
| T-C32 | Propagation | Correction into a year closed two years ago propagates through two closings with each year's cap | I | C5 |
| T-C33 | Time | Business time-zone change does not alter posted dates | I | C2 |
| T-C34 | Time | Estimate before midnight, approval after: approval recomputes | I | C3 |
| T-C35 | Projection | P3-B rule 8a–8d corpus restated for reservations, incl. decision order (D-P3-52) and booking window (D-P3-53) | U/I | C3 |
| T-C36 | Negative | Default 0 refuses; policy limit allows exactly to −L; per-employee override if chosen (D-P3C-07) | I | C3 |
| T-C40 | Isolation | Every endpoint and raw SQL under RLS cannot see or write another business's rows; other business ids → 404 | I/S | C1/C4 |
| T-C41 | Isolation | Isolation suite (`tests/isolation`) covers every ledger table | S | C1 |
| T-C42 | Permissions | Employee sees own only; unlinked user `not_linked`; suspended member nothing | I | C4 |
| T-C43 | Permissions | Line manager sees current reports only; after reassignment, not the old ones | I | C4 |
| T-C44 | Permissions | Sensitive types hidden from manager without `read_sensitive` | I | C4 |
| T-C45 | Permissions | MANAGER without grant cannot correct; with grant in scope can; out of scope cannot; revoked cannot | I | C5 |
| T-C46 | Permissions | No self-correction, incl. OWNER (sole-authoriser exception only as decided) | I/S | C5 |
| T-C47 | Provenance | Actor from session; missing `app.user_id` fails closed | S | C1 |
| T-C48 | Privacy | Audit metadata, notifications and logs never contain reason text | I | C5 |
| T-C49 | Race | Grant revoke vs correction | R | C5 |
| T-C50 | Race | Two approvals overspending one balance: one succeeds, one `insufficient_balance` | R | C3 |
| T-C51 | Race | Approval vs correction, approval vs payout | R | C3/C5 |
| T-C52 | Race | Two catch-ups on one account: no duplicate, no error | R | C2 |
| T-C53 | Race | Next-year approval vs year opening | R | C3 |
| T-C54 | Race | Termination vs approval | R | C3 |
| T-C55 | Race | No deadlock on any pair of service paths (all orders staged) | R | C3/C5 |
| T-C60 | Retry | Manual posting retried after timeout | I | C5 |
| T-C61 | Retry | Approval retried after commit | I | C3 |
| T-C62 | Failure | Fault injection after each insert: nothing partial | I | C1 |
| T-C70 | Performance | Catch-up after 24 months idle within the transaction timeout; balance read p95 < 150 ms for 3 years of history; business-wide list of 500 employees paged | I | C2/C4 |
| T-C80 | Import | Staging validation, duplicate file refused, all-or-nothing post, floor for accrual, correction of a wrong opening | I | C5 |
| T-C81 | Verifier | V-01..V-10 each detect a seeded violation | S/I | C6 |
| T-C09 | Constraints (v1.2) | Direct SQL: `CONSUMPTION` without release(CONSUMED) fails at commit; release(CONSUMED) without consumption fails at commit; mismatched reservation/bucket/date/hours fail; CANCELLED release with a consumption fails | S | C1 |
| T-C09a | Constraints (v1.2) | Direct SQL: `YEAR_OPEN` for closing −5 h with `CARRY_OUT +5`/`CARRY_IN −5` commits and leaves the old bucket at 0; an unpaired or unequal carry fails; a closed bucket not summing to 0 fails; `WRITE_OFF` refused while D-P3C-11 is open | S | C1 |
| T-C09b | Constraints (v1.2) | Leave-date CHECK: reversal of a `CONSUMPTION` keeps its date; reversal of an `ADJUSTMENT` has none; a mismatch fails | S | C1 |
| T-C09c | Stage gate (v1.2) | Direct SQL in C1: request kinds and manual kinds refused; `DERIVED` basis on a manual kind refused; manual basis on a derived kind refused | S | C1 |
| T-C21a | Virtual view (v1.2) | Read before and after catch-up across a new year with a cap, lapse and grant: identical | I | C2 |
| T-C21b | Virtual view (v1.2) | Same across a termination with future reservations (released `FROZEN`, buckets `FROZEN`) | I | C2 |
| T-C21c | Virtual view (v1.2) | Projection on the day after a virtually realised boundary does not forecast that boundary again | U/I | C3 |
| T-C42a | RLS (v1.2) | Direct SQL as `bos_app` with `app.user_id` = current line manager without `read_sensitive`: sees non-sensitive entries of a report, none of a sensitive type, no transactions; after the reporting line changes, sees none | S | C4 |
| T-C42b | RLS (v1.2) | Direct SQL: grant holder sees in-scope detail; after revocation, after membership suspension, after department change out of scope, sees none; type made non-sensitive later does not re-expose sensitive-snapshot rows | S | C5 |
| T-C42c | RLS (v1.2) | C1 fail-closed: MANAGER and MEMBER (not self) see no ledger rows at all; missing `app.user_id` sees none | S | C1 |
| T-C63 | Sealing (v1.2) | Delayed commit: transaction A starts before seal S1 and commits after it; A is absent from S1, present in S2, never twice; re-reading S1 later gives the same set | S | C1 (primitive) / C6 |
| T-C64 | Back-fill (v1.2) | Rehearsal: every tenant's revision rows updated (count assertion), `INFERRED` basis, RLS FORCE and trigger restored, lock and statement timeouts honoured | S | C1 |
| T-C90 | Payroll contract | Movement feed: period, cutoff, prior-period flag, reversal links, hash stable | I | C6 |

**Release blockers** (no switch-on while any fails): T-C01..T-C09c, T-C21a..c, T-C42a..c, T-C63, T-C64, T-C40..T-C47, T-C50..T-C55, T-C11..T-C14,
T-C20..T-C26, T-C30, and the P3-B gates G-S1..G-S6 for anything a request touches.

**Performance notes:** per-date reservations cap at 1,098 entries per request; indexes lead with `business_id`
and then `bucket_id, book, applies_on` or `account_id, recorded_at`; restrictive RLS functions must use indexed
lookups (manager assignment, grants) and are measured in T-C70; catch-up is O(periods + due dates) per account.

---

## L. Phased implementation plan P3-C1 to P3-C6

Each package: own thread, branch and draft PR (once Regan allows PRs again), ChatGPT audit, merge verdict through
the merge queue, migrations applied first by the Mac session under the protocol. None is authorised by this spec.

| Package | Scope | Depends on | Migration | Acceptance criteria | Escalation |
|---|---|---|---|---|---|
| **P3-C1 Ledger core** | Accounts, buckets, transactions, entries, empty authorisations table; guards with the stage gate (only C1's derived transaction kinds accepted), deferred pair and closing invariants, uniques, forced RLS **plus the fail-closed restrictive read policies**, grants; `recorded_xid` and the seal primitive; revision `effective_from` (J.2); posting primitives for derived kinds with explicit hours (no engine, no routes); verifier V-01..V-07 | P3-A (implemented); decisions D-P3-25 r.1, D-P3C-09, -10, -27, -29, -32, -33 (and -35 only if the preflight finds a time-zone change) | Yes (rehearsal, preflight evidence, lock limits: existing-data transformation) | T-C01..T-C09c, T-C10 (system keys), T-C40, T-C41, T-C42c, T-C47, T-C62, T-C63, T-C64 green on PostgreSQL and PgBouncer | Enhanced audit (RLS read policies, data transformation); Regan if the audit leaves risk or D-P3C-35 is needed |
| **P3-C2 Accrual engine and hours basis** | Core adapter, periods, rounding, year opening, carry and lapse, max-balance expiry, freeze, rehire, catch-up and realised reads; verifier V-08 | C1; **B1 work patterns with ordinary hours merged and applied** (X-01, X-02); D-P3C-11, -15, -16, -17, -20..-23, -28, -30, -31 | No (or a small one if B1's pattern table needs a column) | T-C20..T-C30, T-C33, T-C52, T-C70 (catch-up) | Routine |
| **P3-C3 P3-B integration interface** | `withAccount`, `reserve`, `release`, `reverseConsumption`, `project` (D-P3-50 restated), negative-limit rule | C2; **P3-B amended (R-02, R-03, X-03, X-04) and re-audited**; D-P3C-07, -14 | No | T-C11..T-C14, T-C34..T-C36, T-C50..T-C55, T-C61; P3-B §5 checklist C-01..C-34 re-stated for reservations and met | Routine; it is the gate for P3-B B2/B3 |
| **P3-C4 Read APIs and visibility** | Leave permission keys (shared with P3-B, D-P3-12), any-of route option (D-P3-26), restrictive RLS, balance/ledger/as-of endpoints (off) | C3; D-P3C-13, -25, -26 | Yes (visibility) | T-C40..T-C44, T-C70 (reads); enhanced security audit | First record-scoped read rules: enhanced audit; Regan if risk unresolved |
| **P3-C5 Corrections, imports and grants** | Adjustments, corrections, expiries, payouts, opening-balance import, `LEAVE_CORRECT` grants, propagation, (maker-checker if chosen) | C4; D-P3C-04 (accepted), D-P3C-18, -19, -24 | Yes | T-C10, T-C32, T-C45..T-C49, T-C51, T-C60, T-C80 | **Recommended: Regan's own merge approval** (new per-member authorisation and balance-changing powers, D-P3C-18/19) |
| **P3-C6 Payroll readiness and operations** | Movement feed contract (off), `realise` endpoint, verifier endpoint, reconciliation report; projection cache only if T-C70 shows need | C5 | No | T-C30, T-C31, T-C81, T-C90 | Routine; any payroll connection is a separate, escalated stage |
| Switch-on | Enable leave balance routes for chosen businesses | C4 (reads) or C5 (writes), P3-B as applicable | No | E2E pass, opening balances loaded and reconciled | **Regan** (feature activation) |

Sequencing: **C1 ∥ B1 → C2 → C3 → (P3-B B2, B3) and C4 → C5 → C6**. B1 can still run in parallel with C1, but no
longer with C2 (R-11). P3-B's amendment can be written in parallel with C1–C2 and must be audited before C3.

---

## M. Unresolved decisions, readiness assessment and blockers

### M.1 Accepted (for completeness)

D-P3C-01..06 (§B.1); D-P3-1..11; D-P3-45, D-P3-50 (revised), D-P3-52, D-P3-53, D-P3-54.

### M.2 Open decisions (recommendation in bold)

**T** = technical (ChatGPT may accept under the delegation policy). **O** = owner (Regan). **C1** marks those
that shape P3-C1.

| Id | Question | Options | Recommendation | Type |
|---|---|---|---|---|
| D-P3-25 r.1–5, 7 | Revisions get `effective_from`; rules by date; entries record the policy version | accept / amend | **Accept** (rule 6 is superseded by D-P3-45 and D-P3C-02) | O (it was put to Regan) · C1 |
| D-P3C-07 | What is D-P3C-03's "explicit audited policy override"? | (a) the policy's negative limit, set by `people:configure` (revision + audit) / (b) (a) plus a per-employee, time-limited negative allowance granted by OWNER/ADMIN with reason / (c) per-request override at approval | **(a) now, (b) later if needed.** (c) contradicts D-P3-54 | O |
| D-P3C-08 | Reads post catch-up? | post on read (D-P3-21 text) / **compute on read, post on writes** | **Compute on read**: no writes in GETs, same figures | T |
| D-P3C-09 | Serialisation anchor | current-year bucket (P3-B rule 4) / **account row, then buckets ascending** | **Account row**: one stable lock per employee and type | T · C1 |
| D-P3C-10 | Stored balance totals | trigger-maintained totals / **none; sums of entries** | **None** in C1–C5 (P3-B rule 1) | T · C1 |
| D-P3C-11 | Negative closing balance at year end | apply the carry rule (debt may vanish) / **carry in full** | **Carry in full** | O |
| D-P3C-12 | Hours source and B1 order | P3-C owns a pattern table / **B1 work patterns (with ordinary weekly hours) merge before C2** | **B1 before C2**; amends D-P3-40's "parallel" | O |
| D-P3C-13 | Where leave permission keys land | P3-B B2 / **P3-C4, reused by B2** | **P3-C4** | T + O (permission change) |
| D-P3C-14 | Partial cancellation (early return) | none (whole only) / **release of remaining future dates as a P3-B transition** | **Support it** in P3-B's amendment | O |
| D-P3C-15 | Date-based expiry of carried hours | none / **vocabulary extension in a later P3-A change** | **Later**; only carry-cap lapse now | O |
| D-P3C-16 | ANNIVERSARY on 29 February | 28 February / **1 March in non-leap years** | **1 March** | O |
| D-P3C-17 | Balance at termination (D-P3-8) | forfeit / **freeze, keep, no automatic payout; `PAYOUT` recorded from payroll with a reference** / automatic payout calculation | **Freeze** | O |
| D-P3C-18 | Maker-checker for manual postings | none / **for imports and payouts only, when a second authorised person exists** / for every manual posting | **Imports and payouts**; corrections single-actor with mandatory reason (D-P3C-04 as accepted) | O |
| D-P3C-19 | Self-correction | allowed / **never, except a sole authorised person (audited, flagged)** | **Never, with the sole-authoriser exception** (P3-B D-P3-28 pattern) | O |
| D-P3C-20 | GRANT when the assignment or service starts mid-year | full grant / **pro rata by days** | **Pro rata** | O |
| D-P3C-21 | Leave-year definition change | immediate / **after the current year, through a transition year** | **Transition year** (changes grant and carry timing, so an owner choice, v1.2) | O |
| D-P3C-22 | Does unpaid leave or `ON_LEAVE` pause accrual? | **no in core; a policy rule later** / pause by category | **No in core** (jurisdiction-specific) | O |
| D-P3C-23 | Days-to-hours basis | **weekly ordinary hours ÷ 5** / average hours per worked day | **Weekly ÷ 5** (pro rata by FTE) | O |
| D-P3C-24 | Import scope | **opening balances only** / also history | **Opening only** in C5 | O |
| D-P3C-25 | Manager visibility | A: **current direct reports' balance-level rows (dated movements, no reasons, actors or references), sensitive types only with `read_sensitive`**, enforceable by RLS (§I.3) / B: same including sensitive types / C: totals only, which needs a privileged aggregate function (Regan, privileged SQL) | **A** | O |
| D-P3C-26 | Restrictive RLS on ledger reads | service check only / **service + restrictive RLS** | **Both** (P3-B D-P3-48 pattern), measured in T-C70 | T |
| D-P3C-27 | `effective_from` for existing revisions | **back-fill in the migration (rehearsed)** / null means "from creation" | **Back-fill** | T · C1 |
| D-P3C-28 | Rehire | reinstate balance / **new service period, old frozen, adjustment possible** | **New period** | O |
| D-P3C-29 | Precision | `numeric(9,4)` like P3-A / **`numeric(12,4)` hours, exact engine, cumulative rounding half-even** | **numeric(12,4)** | T · C1 |
| D-P3C-30 | Max-balance excess | credit only up to the cap / **post full accrual and an `EXPIRY MAX_BALANCE`** | **Post and expire** (visible, replay-exact) | T |
| D-P3C-31 | Multi-year propagation | recompute all later years / **delta propagation year by year with each year's own cap** | **Delta propagation** (decides how a correction carries forward, so an owner choice, v1.2) | O |
| D-P3C-32 | Authority for derived postings (§I.2a) | A: **API prevention + kind/basis matrix + SQL-verified pair invariants; `ACCRUAL`/`GRANT` amounts trusted application behaviour, detected by the verifier** / B: `SECURITY DEFINER` SQL engine for derived kinds (new privileged boundary, Regan) | **A for C1–C2; revisit before payroll** | O + security |
| D-P3C-33 | Recorded-time semantics (§F.1a) | timestamp cutoffs / **`recorded_at` informational; seals by stored `pg_snapshot` and `recorded_xid`** | **Snapshot seals** | T |
| D-P3C-34 | Restrictive RLS staging | all branches in C4 / **fail-closed policies in C1, manager branch in C4, grant branch in C5** | **Staged in C1** (no row exists without its read control) | T |
| D-P3C-35 | Effective dates of pre-C1 revisions | treat inferred as exact / **mark `INFERRED`, never let an inferred date govern a posting (cutover ≥ apply date + 1)** / recover per-row zones from audit | **Mark and isolate** | O (only if the preflight finds a time-zone change after a revision) |

### M.3 Readiness assessment

| Package | Verdict | Why |
|---|---|---|
| **P3-C1** | **CONDITIONALLY READY (after re-audit)** | v1.0 audit (9fc9751) was a CONDITIONAL PASS with five corrections; v1.2 makes them (§ handoff H-5). Conditions: (1) ChatGPT re-audit of v1.2 passes; (2) Regan authorises implementation (and allows a PR); (3) D-P3-25 r.1 and D-P3C-09, -10, -27, -29, -32, -33, -34 accepted (-35 only if needed); (4) at build time, migration order rechecked (stamp after `20261207000000` and any newer); (5) before apply, the J.2 preflight and rehearsal evidence |
| P3-C2 | **BLOCKED** | Needs B1 work patterns with ordinary hours (documented only, E-10), and owner decisions D-P3C-11, -15, -16, -17, -20, -22, -23, -28 |
| P3-C3 | **BLOCKED** | Needs C2, the P3-B amendment for D-P3C-01/02 (R-02, R-03, X-03, X-04) audited, and D-P3C-07, -14 |
| P3-C4 | **BLOCKED** | Needs C3 and D-P3C-13, -25, -26; enhanced security audit |
| P3-C5 | **BLOCKED** | Needs C4 and D-P3C-18, -19, -24; recommended owner merge approval |
| P3-C6 | **BLOCKED** | Needs C5 |
| P3-B B2/B3 | **BLOCKED** (unchanged) | Need C3 merged and applied, plus P3-B's own gates |

### M.4 Blockers and what unblocks them

1. **Architecture audit** of this spec (ChatGPT) — not yet requested; no PR exists by Regan's instruction, so the
   audit reads this file from the project folder or from branch `claude/project-thread-3feuws` (docs only, no PR).
2. **Regan's implementation authorisation** for P3-C1, and permission to open its PR.
3. **Owner decisions** in §M.2 marked O, especially D-P3C-07 (meaning of D-P3C-03), D-P3C-12 (B1 before C2) and
   D-P3C-23 (days-to-hours basis), which change downstream work most.
4. **P3-B amendment** (v1.6 of PR #116) for reserve-then-consume and hours. Until then P3-B v1.5 and this spec
   disagree on approval semantics; this spec follows the accepted D-P3C-02.
5. **Hours source**: B1 work patterns with ordinary weekly hours (E-10).
6. **Production state**: unverified from this thread (E-34); a fresh read is protocol step 1 before any apply.

### M.5 Needs Regan

- Confirm the reading of D-P3C-03 (D-P3C-07).
- Decide the owner items in §M.2 (recommendations given; ChatGPT may record them as owner decision records).
- Authorise P3-C1 implementation and its PR when the audit passes.
- Note: P3-C5 (corrections, grants) is recommended for **your own merge approval** because it introduces the first
  per-member authorisation grants and balance-changing powers in People.
