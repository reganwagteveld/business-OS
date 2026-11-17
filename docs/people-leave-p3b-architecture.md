# People P3-B: Leave requests and approvals (architecture)

> **Status: architecture proposal, documentation only. Not implementation-ready.**
> There is no code, migration, contract or route change in this PR.
> P3-B cannot start until P3-C (the balance ledger) is merged and applied to production (D-P3-1, accepted).
> It also needs the owner decisions listed in §13. The prerequisite checklist in §11 shows **NOT MET**
> on `main` at `84271b3`.

Base: `main` at `84271b3`, fetched 2026-11-17. Read with [people-leave-p3.md](./people-leave-p3.md),
which has the P3 staged plan, decisions D-P3-1 to D-P3-25 and the P3-A specification, and with
[people-data-model.md](./people-data-model.md).

## Contents

1. Verified starting point
2. Scope and non-goals
3. Data model
4. Request state machine
5. Identity and approval authority
6. Policy engine: dates, duration and rule checks
7. Ledger integration and the approval transaction
8. Privacy and field-level visibility
9. API contracts and permission matrix
10. Scheduling, notifications and search boundaries
11. P3-C prerequisite checklist
12. UI screen and component inventory
13. Decision register
14. Delivery packages B1–B4 and migration plan
15. Test matrix
16. Risks and open questions

---

## 1. Verified starting point

I checked these against the repository, not against earlier conversations.

| Item | Finding on `main` `84271b3` | Source |
|---|---|---|
| Newest migration on `main` | `20261205000000_membership_lifecycle` (23 migrations) | `apps/api/prisma/migrations/` |
| Migration stamps held by open PRs | `20261206000000_search_indexes` (#97), `20261207000000_workflow_links` (#110) | `gh pr diff --name-only` |
| P3-A | Merged (#68). It has four tables: `people_leave_types`, `people_leave_policies`, `people_leave_policy_revisions` and `people_leave_policy_assignments` | migration `20261204000000_people_leave_policies` |
| `people_leave_policy_revisions.effective_from` | **Absent.** The table has `recorded_at` (timestamptz) only. D-P3-25 proposes the column for P3-C, and it is not built | migration SQL, `people-leave.prisma` |
| P3-C ledger, balances, accrual | **Absent.** No table, module, contract or open PR contains `leave_ledger`, `leave_balance` or anything like them | `git ls-tree`, `gh pr list` |
| Leave requests | **Absent.** No table, route or contract | same |
| Work week, public holidays | **Absent** everywhere. Scheduling working hours are in the S0 data model, but S2 §10 lists them as not built | `git grep` |
| Permission keys | `people:read`, `people:read_sensitive`, `people:manage`, `people:configure`. These are static in `apps/api/src/modules/access/server/permissions.ts`, so a new key needs no migration | code |
| Record-scoped rules in People | None. A reporting line grants nothing (PD-1) | `people-data-model.md` §5 |
| User ↔ employee link | `people_employees.user_id`: optional, at most one per user per business, must be an active member, set by `people:manage` holders. It is cleared, and the change audited, when the member is removed (`modules/people/server/members.ts`). Suspension (A2-B) does not clear it | code |
| Idempotency pattern | Finance: an `Idempotency-Key` header plus a stored `request_hash`, giving `200` with the original result on replay and `409 idempotency_conflict` on a mismatch | `modules/finance/server/documents.ts`, `_lib/routes.ts` |
| Scheduling private / busy-only | **Not built** (ADR 0006 §4–§7 are future work; S2 §10). PERSON resources have no employee link (D-S2-1). `people-boundaries.test.ts` forbids Scheduling from reading People | `scheduling-s2.md` §9–§10 |
| Notifications | N1 is architecture only (merged docs). Its `people.leave.*` producers are listed as "with P3-B". There is no notification runtime on `main` | `notifications-n1-architecture.md` |
| Production `_prisma_migrations` | **Not re-read in this session.** A read-only check relayed by the coordinator was blocked by the Mac permission guard. The last recorded state is in `active-workstreams.md` and the GS1-A record. It must be re-read before any P3-C or P3-B migration (protocol "Production migrations") | — |

**Consequence.** Every P3-B decision that touches balances depends on a ledger that does not exist yet.
This document therefore specifies the **interface P3-B needs from P3-C** (§7.1, §11) and does not
assume an implementation.

## 2. Scope and non-goals

**In scope (P3-B):**

- leave requests: submit, withdraw, approve, reject and cancel;
- append-only transition history;
- approver resolution;
- the duration and rule engine (work week, holidays, notice, backdating, waiting period, overlap);
- deduction and reversal through the P3-C ledger;
- field-level privacy;
- the request, approval and team-visibility API;
- People-owned availability data for later Scheduling use;
- the client screens (B4).

**Not in P3-B:**

- delegation (D-P3-15);
- partial cancellation (cancel the whole request and resubmit instead);
- attachments or medical documents (D-P3-22);
- payroll or payout;
- statutory rules;
- notifications and email (N1 runtime and Regan's approval);
- any write into Scheduling (P3-E);
- automatic accrual jobs (D-P3-21: no scheduler);
- per-location time zones;
- leave requests in global search (§10.3).

## 3. Data model

All tables are People tables (the boundaries test applies) and use the standard isolation layers:

- forced RLS with the `tenant_isolation` policy;
- a `business_id`-leading index;
- composite `(business_id, …)` foreign keys;
- for `bos_app`: no `DELETE` or `TRUNCATE`, and `UPDATE` only on the columns listed;
- guard triggers raising SQLSTATE class `PE` (new codes from PE013);
- database-set timestamps;
- an optimistic `version`, advanced by exactly one by a guard trigger (as P3-A's PE009).

### 3.1 B1: calendar configuration

| Table | Purpose | Key columns |
|---|---|---|
| `people_leave_work_weeks` | The business default work week. One row per business, created lazily, Monday–Friday until it is changed | `business_id` PK, `days` smallint bitmask (Mon=1 … Sun=64, CHECK non-zero), `hours_per_day numeric(5,2)` (default for HOURS policies, CHECK 0 < h ≤ 24), `version` |
| `people_employee_work_patterns` | **Proposed (D-P3-26).** Effective-dated per-employee work week that overrides the default. Same `[starts_on, ends_on)` pattern and one-open-row index as P3-A assignments | `employee_id`, `days`, `hours_per_day`, `starts_on`, `ends_on` |
| `people_leave_holidays` | Business-maintained non-working dates (D-P3-17). An optional `location_id` (composite FK) limits a date to employees whose **current** location matches. Archive rather than delete | `id`, `date`, `name`, `location_id?`, `archived_at`, `version`; unique active `(business_id, date, coalesce(location_id, nil))` |

Holiday and work-pattern changes **never** change a request that is already approved (its quantity is
stored, §3.2). They do change pending requests, which are re-quoted at decision time (§7.2).

### 3.2 B2: requests

**`people_leave_requests`**

| Column | Notes |
|---|---|
| `id`, `business_id` | Composite unique `(business_id, id)` |
| `employee_id` | Composite FK to `people_employees`. Requests belong to the **employee**, not the user, so they survive unlinking and rehire |
| `leave_type_id`, `policy_id` | Composite FK `(business_id, policy_id, leave_type_id)`, as P3-A assignments, so a policy cannot be paired with another type |
| `policy_version_quoted` | Policy version used for the submission quote (informational) |
| `unit` | `DAYS` or `HOURS`, copied from the policy (fixed per policy, D-P3-5). CHECK |
| `start_date`, `end_date` | Business calendar dates (D-P3-18). CHECK `start_date <= end_date` |
| `start_portion`, `end_portion` | `FULL`, `AM` or `PM` (DAYS only; a single-day request has one portion). CHECK that the portion is consistent with granularity |
| `quantity` | `numeric(9,4)`. Chargeable amount from the latest quote; on approval, the **deducted** amount. Never edited after approval |
| `status` | `PENDING`, `APPROVED`, `REJECTED`, `WITHDRAWN`, `CANCELLED` (§4) |
| `has_note` | Boolean flag. The text lives in `people_leave_request_notes` |
| `submitted_by_user_id`, `on_behalf` | Who submitted, and whether it was a `people:leave_manage` holder acting for the employee |
| `decided_by_user_id`, `decided_at`, `decision_basis` | `MANAGER`, `FALLBACK`, `OVERRIDE`, `SOLE_OWNER` or `POLICY_AUTO` (§5.3) |
| `deduction_entry_id`, `reversal_entry_id` | Composite FKs to P3-C ledger entries (names per P3-C). Set once (guard) |
| `idempotency_key`, `request_hash` | For submission (Finance pattern). Unique `(business_id, idempotency_key)` where not null |
| `version`, `created_at`, `updated_at` | |

`bos_app` UPDATE is limited to `status`, `quantity` (only while `PENDING`), the decision columns, the entry
ids, `version` and `updated_at`. A guard enforces the transition matrix (§4.2) as the database backstop
(PE013 `invalid_transition`).

**`people_leave_request_days`** is the per-day breakdown, written with the request and rewritten only
while `PENDING`. It is used for counting, overlap, availability and leave-year splitting.

| Column | Notes |
|---|---|
| `request_id`, `date` | PK `(request_id, date, slot)` |
| `slot` | `AM` or `PM`. A full day writes **both** rows. An HOURS day writes both rows (D-P3-27) |
| `amount` | Chargeable amount for that slot (0 on non-working days and holidays, which are kept for display) |
| `employee_id`, `active` | `active` is true while the request is `PENDING` or `APPROVED`. A trigger keeps it in step with the request status |

**Overlap backstop (D-P3-19), without `btree_gist`:** a partial unique index on
`(business_id, employee_id, date, slot) WHERE active AND amount > 0`. Two live requests can never occupy the
same half-day, whatever the leave type. A morning and an afternoon request on the same day coexist, as
D-P3-19 requires. This follows the established one-open-row pattern and needs no privileged SQL.

**`people_leave_request_transitions`** is append-only, with no UPDATE grant (PE004).

| Column | Notes |
|---|---|
| `request_id`, `seq` | PK. `seq` = request version after the transition |
| `from_status`, `to_status` | `from_status` is null on submission |
| `actor_user_id`, `actor_basis` | Same vocabulary as `decision_basis`, plus `EMPLOYEE` and `ON_BEHALF` |
| `quantity` | Quantity at this transition |
| `ledger_entry_id` | Deduction (approve) or reversal (cancel), if any |
| `idempotency_key` | Unique `(business_id, request_id, idempotency_key)` where not null: replay protection for transitions |
| `has_reason` | Reason text, if any, is in the notes table |
| `at` | Database time |

**`people_leave_request_notes`** holds the employee's note and the decision and cancellation reasons. It is
a separate table, as `people_employee_personal_details` is, so list queries cannot select it by accident.
Its columns are `request_id`, `kind` (`REQUEST`, `DECISION` or `CANCELLATION`), `seq`, `body` (≤ 1,000
chars) and `author_user_id`. Rows are append-only. Read access is §8.

## 4. Request state machine

### 4.1 States

```
            submit (requires_approval)          approve (re-quote, deduct)
  ∅ ───────────────────────────────▶ PENDING ─────────────────────────────▶ APPROVED
  │                                   │  │                                      │
  │ submit (no approval: POLICY_AUTO) │  └─ reject ─▶ REJECTED                  └─ cancel (reverse) ─▶ CANCELLED
  └──────────────────────────────────────────────────────────────────────────▶ APPROVED
                                      └─ withdraw ─▶ WITHDRAWN
```

`REJECTED`, `WITHDRAWN` and `CANCELLED` are terminal. Requests are never deleted (D-P3-10: they cascade
only with a business purge).

### 4.2 Transition matrix

| From → To | Who (server-checked) | Preconditions (all under the §7.2 locks) | Ledger |
|---|---|---|---|
| ∅ → PENDING | The employee (self, D-P3-12), or a `people:leave_manage` holder on behalf | §6 checks pass; policy `requires_approval`; employee not TERMINATED; an active assignment covers every requested day | None |
| ∅ → APPROVED | Same | As above; policy has `requires_approval = false`; balance check passes under lock | Deduct (basis `POLICY_AUTO`) |
| PENDING → APPROVED | Resolved approver (§5.2), or a `people:leave_manage` holder (override), or the sole owner (§5.3) | Version matches; actor ≠ requester; re-quote matches the approver's `expectedQuantity` (§7.2); balance check passes | Deduct |
| PENDING → REJECTED | Same as approve | Version matches; actor ≠ requester (except the sole owner, who may also reject) | None |
| PENDING → WITHDRAWN | The employee, or the on-behalf submitter, or a `people:leave_manage` holder | Version matches | None |
| APPROVED → CANCELLED | The employee **before the first leave day** (D-P3-28); the resolved approver or a `people:leave_manage` holder at any time | Version matches | Reverse the deduction (idempotent) |

Any other pair is `409 invalid_transition` (service) and PE013 (trigger). Every transition writes:

- one transition row;
- one audit event (§8.4);
- `version + 1`.

All of it happens in one transaction with the ledger posting.

### 4.3 Stale versions and replays

- Every transition request names the `version` it was based on. A mismatch is `409 stale`, with nothing
  written and no audit entry. This matches P1, P3-A and the P2 client behaviour.
- `POST /leave-requests` **requires** `Idempotency-Key`:
  - the same key with the same body gives `200` and the original request;
  - the same key with a different body gives `409 idempotency_conflict`.
- Transition endpoints **accept** `Idempotency-Key` (recommended for clients). A replay of a committed
  transition with the same key gives `200` with the current request and no second ledger posting. Without
  a key, a replay fails on `version`.
- Ledger postings have their own idempotency key (§7.1), so even a service bug that ran a transition twice
  cannot post twice.

## 5. Identity and approval authority

### 5.1 Who "the employee" is (D-P3-12)

A request is self-service only when the signed-in user is linked through
`people_employees.user_id = actor.userId`. Their membership must also be `ACTIVE`: A2-B's per-request
actor re-check already refuses suspended members. The employee must not be `TERMINATED`.

**"Verified" link: a disagreement to note.** Today the link is asserted by an OWNER or ADMIN
(`people:manage`). The user never confirms it. If an admin links the wrong member, that member could see
and request the employee's leave, including sensitive history. The brief asks for "verified" links. The
current mechanism is admin-verified, not user-confirmed.

- **Recommended (D-P3-29):** accept admin-asserted links for B2, because the admin can already see all of
  this data.
- The `GET /people/me/leave` response names the linked employee, so the user can spot a wrong link.
- Link and unlink are already audited.
- A user-confirmation step would be a People P1 change, and would need its own decision.

### 5.2 Who approves (D-P3-13, amended timing)

The approver is resolved **at decision time** by the server, never taken from the client or stored as
authority:

1. Find the employee's open manager assignment (P1 reporting line) on the business date of the decision.
2. The manager employee must not be `TERMINATED`. They must be linked to a user with an `ACTIVE`
   membership whose permissions include `people:leave_approve`. If so, that user is **the resolved
   approver**.
3. Otherwise the request is in **fallback**: any `people:leave_manage` holder may decide it, recorded as
   basis `FALLBACK`.
4. A `people:leave_manage` holder may always decide (basis `OVERRIDE` when a resolved approver exists).
5. Holding `people:leave_approve` grants nothing on its own beyond the reports for whom the user is the
   resolved approver. It is a record-scoped rule that *narrows* `authorize()`. It never widens another key.

The inbox lists requests where the caller is currently the resolved approver, or which are in fallback (for
`people:leave_manage` holders). Because resolution is live, a manager change moves pending requests to the
new manager. No stored routing needs repair. D-P3-13 did not say when resolution happens; resolving
live is the amendment.

### 5.3 Self-approval and the sole-owner exception (D-P3-14)

- **Hard rule:** `actor.userId` must differ from the user linked to the request's employee, for approve
  and reject. This is checked in the service and by a guard that compares
  `decided_by_user_id` to the employee's `user_id` at write time (PE014 `self_decision`).
- **Sole-owner exception, separately authorised:**
  - Allowed only when **all** of these hold:
    - the actor holds `people:leave_manage`;
    - no *other* `ACTIVE` member holds `people:leave_manage`;
    - the request has no resolved approver other than the actor;
    - the body carries an explicit `"selfDecision": true` acknowledgement.
  - The request is recorded with basis `SOLE_OWNER`. The audit event carries `selfDecision: true`.
  - The guard allows the self-decision only when the transaction has set
    `app.leave_self_decision = 'sole_owner'` (`SET LOCAL`). The service sets it only after the check
    above.
  - D-P3-30 asks Regan whether to enable it at all. Recommended: enabled, because a one-person business
    otherwise cannot record its own leave.
- **Policy auto-approval** (`requires_approval = false`) is **not** self-approval. The approval is the
  policy's, recorded as basis `POLICY_AUTO` with the submitter as actor. It still goes through the
  ledger lock and balance check. This removes the apparent conflict between D-P3-14 and D-P3-16.

### 5.4 Delegation

None in P3-B (D-P3-15). Absence is covered by fallback to `people:leave_manage` holders.

## 6. Policy engine: dates, duration and rule checks

The engine is a pure module (`modules/people/server/leave-engine.ts`, no database access) fed by a
loader that reads, in one snapshot:

- the assignment or assignments covering the dates;
- the rules in force (D-P3-25 rule 2);
- the work pattern;
- holidays for the employee's current location;
- the employee's start date and status;
- the business's `businessToday`.

The same engine serves `POST /leave-requests/quote`, submission and the re-quote at approval.

### 6.1 Duration (D-P3-17, D-P3-18)

- Dates are business-local calendar dates. There are no instants. The business time zone decides only
  "today".
- For each date from start to end:
  - it is **chargeable** if the work pattern in force on that date includes the weekday and it is not an
    active holiday for the employee's current location (or a business-wide holiday);
  - otherwise it is shown with amount 0.
- **DAYS:**
  - a full chargeable day = 1;
  - `AM`/`PM` portions = 0.5, allowed only when policy granularity is `HALF_DAY`;
  - `FULL_DAY` granularity refuses portions (`invalid_portion`).
- **HOURS:**
  - the body gives `hoursByDay` for each chargeable date, as a multiple of the policy granularity
    (hour, half or quarter hour);
  - each day is ≤ the pattern's `hours_per_day`;
  - a missing day defaults to `hours_per_day`.
- A request whose total chargeable quantity is 0 is refused (`no_chargeable_days`).
- A request may span at most 366 days (CHECK and contract).

### 6.2 Rule checks (all P3-A rule fields; nothing invented)

| Rule (P3-A column) | Check | Error |
|---|---|---|
| Assignment | Every requested date is covered by an assignment of this leave type. If the dates span two assignments, the request is refused (D-P3-31: split the request) | `no_policy` / `policy_changes_within_request` |
| `minimum_notice_days` | `start_date − today ≥ notice`. A `people:leave_manage` holder on behalf may override, recorded in the transition | `insufficient_notice` |
| `allow_backdated` | If false, `start_date ≥ today` | `backdating_not_allowed` |
| `waiting_period_days` | `start_date ≥ employee.start_date + waiting` | `waiting_period` |
| Employee status | Not `TERMINATED`. `PENDING` employees may request only dates on or after their start date | `terminated` / `before_start` |
| Overlap (D-P3-19) | No active slot clash (§3.2 index) | `overlap` (with the clashing request id only if the caller may see it) |
| Leave year (D-P3-32) | If the request crosses a leave-year boundary of its policy, it is either split or refused | `crosses_leave_year` |
| Balance | Not at submission (informational "projected" value only). Enforced at approval under the ledger lock (D-P3-20) | `insufficient_balance` (approval) |

Quotes return each day, the total, the policy and version, and a list of `warnings`, for example
"balance after this request would be negative within the policy limit".

## 7. Ledger integration and the approval transaction

### 7.1 What P3-B needs from P3-C (interface, not implementation)

P3-B calls the People module's ledger service in-process, inside the same transaction. It never writes
ledger tables directly.

```ts
// Called inside withTenant, inside the caller's transaction, after the caller holds the §7.2 locks.
postLeaveDeduction(db, {
  employeeId, leaveTypeId, policyId, policyVersion,   // rules in force on the approval date (§4.7 rule 6)
  amount,                                             // > 0, numeric(9,4) in the policy unit
  leaveYear,                                          // the leave year(s) the leave dates fall in (D-P3-32)
  source: { kind: 'LEAVE_REQUEST', id: requestId },   // idempotency: unique (business, source.kind, source.id, entry kind)
  actorUserId,
}): Promise<{ entryId, balanceAfter }>               // throws InsufficientBalance (negative limit under FOR UPDATE)

postLeaveReversal(db, { deductionEntryId, source, actorUserId }): Promise<{ entryId }>
                                                      // idempotent; never edits the deduction (append-only)
```

The balance row lock (`FOR UPDATE`, one row per employee and leave type, D-P3-20) and "accrue up to date"
(D-P3-21) run **inside** `postLeaveDeduction`, before the negative-limit check. Accrual posts nothing new
when it is already up to date.

### 7.2 Approval sequence (single transaction, ordered locks)

This lock order extends P3-A §4.5 and must also be the order P3-C uses. The order is:
policy, then employee, then request, then balance row.

```
 1. Read the request without a lock to get employee, type and policy ids; 404 if not visible.
 2. SELECT policy           FOR SHARE                      (archive takes FOR UPDATE)
 3. SELECT employee         FOR SHARE                      (termination takes FOR UPDATE)
 4. SELECT request          FOR UPDATE; check version → 409 stale; check status = PENDING
 5. Authority (§5.2 / §5.3) against the live reporting line and memberships → 403 forbidden / self_decision
 6. Re-quote with the rules in force today (§6); if quantity ≠ body.expectedQuantity → 409 quote_changed
    (returns the new quote; nothing written).
 7. postLeaveDeduction → balance FOR UPDATE → accrue → limit check → insert entry
                                                      → 409 insufficient_balance (whole tx rolls back)
 8. UPDATE request (status, quantity, decision columns, deduction_entry_id, version+1)  [guard re-checks matrix and self-decision]
 9. INSERT transition row (+ note row if a reason was given)
10. recordAudit(...)  — references only (§8.4)
11. COMMIT. Any error from 2–10 rolls back everything: no partial state, no ledger entry without a request change.
```

**Concurrency outcomes (each covered by a deterministic race test, §15):**

- **Two approvals of the same request:** the second blocks at step 4, then gets `stale`.
- **Two approvals of different requests that would together overspend:** the second blocks at step 7 on the
  balance row, then sees the first deduction and gets `insufficient_balance`.
- **Approve vs withdraw:** whoever locks the request first wins, and the other gets `stale`.
- **Approve vs termination:** termination holds the employee `FOR UPDATE`, so approval waits at step 3. It
  then fails the `TERMINATED` check with `409 terminated`.
- **Approve vs policy archive:** archive holds the policy `FOR UPDATE`. The approval waits and then
  re-reads the policy. An archived policy still governs existing assignments (P3-A), so the approval
  proceeds.
- **Submit vs submit (overlapping requests):** the partial unique index decides. The loser gets `overlap`.
- **Approve vs manager change:** the manager change does not lock the request. The authority check reads
  the reporting line after step 3. A manager change committed before that point is honoured. One that
  commits after the approval is not retroactive, and that is acceptable.

Cancellation takes the same locks 2–4. It then calls `postLeaveReversal`, which takes the balance row
`FOR UPDATE` and posts an append-only reversal. It never edits the deduction.

**Transaction failure recovery.** There is no external effect inside the transaction: no email, no
Scheduling write and no HTTP call. A failure therefore leaves no residue, and the client retries with the
same `Idempotency-Key`. Locks are transaction-scoped only, so this is safe behind PgBouncer in
transaction mode (the existing pooler CI re-run).

## 8. Privacy and field-level visibility

### 8.1 Classification

A request is **sensitive** if its leave type has `sensitive = true` (D-P3-7) **at read time**. Changing
the flag later re-classifies all of that type's requests. That is the conservative choice, and a test
pins it.

### 8.2 Who sees what (D-P3-22, made precise)

| Field | Employee (self) | Resolved approver (current) | `people:leave_manage` | `people:read_sensitive` | `people:read` only (e.g. MANAGER, not the approver) | Everyone else |
|---|---|---|---|---|---|---|
| Dates, portions, status | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ (no access) |
| Quantity | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Leave type: ordinary | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| Leave type: **sensitive** | ✓ | ✓ | ✓ (needed to decide) | ✓ | **"Away"** (type, category and policy are null) | ✗ |
| Notes and reasons: ordinary | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Notes and reasons: **sensitive** | ✓ | ✓ (while pending, and their own decision) | ✗ unless also `read_sensitive` | ✓ | ✗ | ✗ |
| Transition history | ✓ (actors as names) | ✓ | ✓ | ✓ | ✗ | ✗ |

- "Everyone else" includes MEMBER without a self link and other businesses (they get `404`).
- Team leave visibility (§9.3) for `people:read` holders is **busy-only** for sensitive types.
- A new decision (D-P3-33) asks whether `people:read` holders should see team leave at all, or only
  the employee's own approver chain. Recommended: `people:read` holders see team leave (they already see
  the directory), with sensitive requests shown as "Away".

### 8.3 Enforcement layers

- **Service projection:** one `projectLeaveRequest(viewer, request)` function. Every route and list goes
  through it, and a unit test checks every field against the table above.
- **Notes:** these are only in the separate table, loaded only by the detail endpoint after the §8.2 check.
  List endpoints never join it.
- **Database: optional, recommended (D-P3-34).** A restrictive RLS policy on
  `people_leave_request_notes` for sensitive rows, keyed on `app.user_id` and the employee link. This
  mirrors ADR 0006's restrictive `private_details` idea. It is defence in depth against a service bug.
  It does not protect against a compromised API process (same boundary as ADR 0006 §7).

### 8.4 Audit

| Action | Target | Metadata (never names, notes, reasons or amounts) |
|---|---|---|
| `people.leave_request.submitted` | request | `employeeId`, `leaveTypeId` **omitted when sensitive**, `sensitive`, `startDate`, `endDate`, `onBehalf`, `basis` |
| `.approved` / `.rejected` | request | `employeeId`, `sensitive`, `basis` (`MANAGER`, `FALLBACK`, `OVERRIDE`, `SOLE_OWNER`, `POLICY_AUTO`), `selfDecision`, `ledgerEntryId` (approve) |
| `.withdrawn` / `.cancelled` | request | `employeeId`, `sensitive`, `byEmployee`, `ledgerEntryId` (reversal) |
| `.notice_overridden` | request | `employeeId` |

Audit readers (`audit:read`: OWNER and ADMIN) could resolve a `leaveTypeId` to a sensitive type name, so
the id is omitted for sensitive requests. P3-A's existing test pattern ("no names, descriptions or
amounts") is extended to leave requests.

## 9. API contracts and permission matrix

### 9.1 New permission keys (D-P3-12, static in `permissions.ts`; no migration)

| Key | OWNER | ADMIN | MANAGER | MEMBER | Covers |
|---|:-:|:-:|:-:|:-:|---|
| `people:leave_self` | ✓ | ✓ | ✓ | ✓ | Own leave only, through the user link: quote, submit, withdraw, cancel before start, own history and balances |
| `people:leave_approve` | ✓ | ✓ | ✓ | | Decide requests for which the caller is the **resolved approver** (§5.2). Grants nothing else |
| `people:leave_manage` | ✓ | ✓ | | | Any employee: submit on behalf, decide (override or fallback), cancel any approved request, override notice. Balance adjustments are P3-C's |

Existing keys are unchanged. MEMBER gains `people:leave_self` only, not the directory. Navigation and
shell gating are D-P3-24 (§12.3).

### 9.2 Endpoints (all under `/api/v1/b/:slug/people`; contracts in `packages/contracts/src/people-leave.ts`, additive)

| Method and path | Auth (route) + record rule (service) | Body / query → response |
|---|---|---|
| `GET /me/leave` | `people:leave_self` + linked employee | → `{ employee: {id, displayName}, assignments[], balances[] (P3-C), pendingCount }`. `404 not_linked` without a link |
| `POST /leave-requests/quote` | `leave_self` (own) or `leave_manage` (any `employeeId`) | `{ employeeId?, leaveTypeId, startDate, startPortion?, endDate, endPortion?, hoursByDay? }` → `{ days[], quantity, unit, policyId, policyVersion, warnings[], projectedBalance? }`. Read-only |
| `POST /leave-requests` | Same. **`Idempotency-Key` required** | Quote body + `note?` → `201 LeaveRequest` (or `200` on replay) |
| `GET /leave-requests` | `leave_self`, `leave_approve`, `leave_manage` or `people:read`. The result set is narrowed by `scope` | `?scope=mine\|approvals\|all&status&employeeId&leaveTypeId&from&to&cursor&limit` → keyset page of projected requests. `approvals` = resolved-approver plus fallback (for `leave_manage`). `all` needs `leave_manage` or `people:read` (projected per §8.2) |
| `GET /leave-requests/:id` | Any viewer allowed by §8.2, else `404` | → projected request + notes the viewer may see |
| `GET /leave-requests/:id/history` | Same | → transitions (projected) |
| `POST /leave-requests/:id/withdraw` | Employee, on-behalf submitter or `leave_manage` | `{ version }` |
| `POST /leave-requests/:id/approve` | §5.2 / §5.3 | `{ version, expectedQuantity, reason?, selfDecision? }` |
| `POST /leave-requests/:id/reject` | §5.2 / §5.3 | `{ version, reason?, selfDecision? }` |
| `POST /leave-requests/:id/cancel` | Employee before the first day, resolved approver, or `leave_manage` | `{ version, reason? }` |
| `GET /leave-calendar` | `people:read`, or `leave_approve` (own reports only) | `?from&to(≤ 92 days)&departmentId&locationId&cursor` → per-employee busy blocks (`APPROVED` and optionally `PENDING`), type per §8.2 |
| `GET /leave-work-week`, `PUT /leave-work-week` | `people:read` / `people:configure` | `{ days, hoursPerDay, version }` |
| `GET\|POST /employees/:id/work-patterns`, `POST /employees/:id/work-patterns/end` | `people:read` / `people:manage` | Effective-dated, as P3-A assignments (if D-P3-26 is accepted) |
| `GET\|POST /leave-holidays`, `PATCH /leave-holidays/:id`, `POST /leave-holidays/:id/archive\|restore` | `people:read` / `people:configure` | `{ date, name, locationId? }` |

All transition endpoints accept an optional `Idempotency-Key` (§4.3). There is no DELETE endpoint.

**Errors** (each added to the route error maps; unknown body fields are rejected):

- **400:** `invalid_input`, `invalid_query`, `invalid_cursor`, `invalid_portion`, `invalid_hours`,
  `no_chargeable_days`, `range_too_long`, `backdating_not_allowed`, `insufficient_notice`,
  `waiting_period`, `before_start`, `no_policy`, `policy_changes_within_request`, `crosses_leave_year`.
- **403:** `forbidden`, `self_decision`.
- **404:** `not_found` (including another business's ids and requests the viewer may not see),
  `not_linked`.
- **409:** `stale`, `invalid_transition`, `overlap`, `insufficient_balance`, `quote_changed`,
  `terminated`, `idempotency_conflict`, `already_started` (employee cancel).

## 10. Scheduling, notifications and search boundaries

### 10.1 Scheduling: one source of truth

- **People's approved leave is the only source of truth for absence.** Scheduling never stores leave as its
  own record type and never decides leave.
- **In P3-B nothing is written to Scheduling, and Scheduling reads nothing from People.** The boundaries test
  is unchanged. Today a manager rostering someone on leave sees no conflict. That is a known, documented gap
  until P3-E.
- **P3-E path (D-P3-23, unchanged):**
  - People adds `employee_id` to PERSON resources (S2 §9);
  - an outbox row is written in the approval or cancellation transaction (no external effect);
  - a projector creates or removes a **busy-only** block (time span only, no type or notes) on that
    resource;
  - Scheduling's existing ordered-lock conflict check (ADR 0008) then treats it like any other occupying
    assignment;
  - conflicts across the two Zones are advisory in Scheduling, never blocking leave approval.
- **Gate:** P3-E must not start until Scheduling's private/busy-only visibility (ADR 0006 §4–§7) is built.
  Otherwise a block's title or presence leaks to every `scheduling:read` holder.
- **P3-B's preparation:** `people_leave_request_days` is the projection source (per date, half-day slots,
  active flag), so P3-E needs no new People table.

### 10.2 Notifications

P3-B emits no notifications. The N1 producer types `people.leave.submitted`, `.decided` and `.withdrawn` are
wired only when N1's runtime exists and is approved. The resolver `people.leave.approver` is the §5.2
function, exported from the People module. Until then, the approval inbox is pull-based (§12).

### 10.3 Global search

Leave requests and notes are **not** indexed by GS1. A search hit would reveal that a request exists, which
may be sensitive. Any later change needs its own privacy decision.

## 11. P3-C prerequisite checklist (gate for B2)

| # | Item P3-B depends on | Verify by | State on `main` 84271b3 |
|---|---|---|---|
| C-1 | D-P3-20, D-P3-21 and D-P3-25 approved by Regan | Decision record in `people-leave-p3.md` | **Not met:** still proposals |
| C-2 | D-P3-32 (leave-year attribution of a deduction) decided **before** P3-C is built, because it shapes the ledger entry | Same | **Not met:** new (§13) |
| C-3 | P3-C migration merged on `main` and **applied to production**, confirmed by a read-only `_prisma_migrations` read | `git log`, production preflight | **Not met:** no P3-C migration exists |
| C-4 | `people_leave_policy_revisions.effective_from` exists, set by trigger, back-filled | Schema + migration test | **Not met** |
| C-5 | One balance row per employee and leave type, locked `FOR UPDATE` by every posting | Integration test + code | **Not met** |
| C-6 | Ledger entries append-only (no UPDATE or DELETE grant, guard), each recording `policy_id` and `policy_version` | Grants inventory test | **Not met** |
| C-7 | `postLeaveDeduction` / `postLeaveReversal` (§7.1) exported from the People module, idempotent on `source` | Unit + integration test | **Not met** |
| C-8 | Negative-limit check under the lock, with deterministic parallel-deduction race tests passing directly and behind the pooler | CI runs | **Not met** |
| C-9 | "Accrue up to date" idempotent and safe to call inside the approval transaction | Tests in §4.7 of the P3 doc | **Not met** |
| C-10 | Lock order: policy → employee → (request) → balance, documented and race-tested in P3-C | Doc + race tests | **Not met** |
| C-11 | Termination behaviour of balances (D-P3-8 deferred item) decided | Decision record | **Not met** |

B1 (§14) does not depend on any of these and can run in parallel with P3-C.

## 12. UI screen and component inventory (B4, client only)

### 12.1 Screens

| Screen | Who | Contents and states |
|---|---|---|
| **My leave** (People › Leave › My leave) | `leave_self` with a link | Balances per type (P3-C), upcoming and pending requests, past requests. Empty state; "not linked" state ("Ask an administrator to link your profile"); loading skeleton; error |
| **Request leave** (sheet or page) | `leave_self`, or `leave_manage` with an employee picker | Type select, date range, AM/PM portions or hours per day, note. **Live quote** (days breakdown, quantity, warnings, projected balance). Field-level errors from the server codes. Values kept on failure. Single submit with an `Idempotency-Key` generated per open form |
| **Request detail** | Anyone allowed by §8.2 | Status badge, dates, quantity, type or "Away", notes allowed by §8.2, history timeline, and the actions the viewer may take (withdraw, cancel, approve or reject with reason). `stale` and `quote_changed` handled with a reload-and-explain dialog, as P2 does |
| **Approvals inbox** | `leave_approve` / `leave_manage` | `scope=approvals` list: filters (status, type, employee, dates), basis chip (Manager or Fallback), bulk actions **not** provided (each decision needs a version and quote) |
| **Team leave** | `people:read`, or `leave_approve` (own reports) | Calendar strip or list by week or month from `/leave-calendar`; department and location filters; sensitive requests shown as "Away" |
| **Leave settings** | `people:configure` (read: `people:read`) | Work week, holidays (per location), next to the existing leave types and policies (P3-D) |
| **Employee profile › Leave tab** | `people:read` + §8.2 | That employee's requests and balances; on-behalf "Request leave" for `leave_manage` |

### 12.2 Components

Build on `@business-os/ui` and the V2 contracts (`docs/ui/pixa-design-system-v2-a.md` §9.2).

- **Exist today:** `Badge`, `Card`, `Dialog`, `Field`, `Table`, `StatusIndicator`, `Alert`.
- **Specified in V2 but not yet in `packages/ui`:** `DataTable`, `FilterBar`, `DateField`, `Sheet`,
  `SegmentedControl`, `StatusBadge`, `EmptyState`/`ErrorState`, `Pagination`.
- B4 uses whatever V2 has shipped when B4 starts, and does not add Zone-local copies.
- **Leave-specific (People-local):**
  - `LeaveStatusBadge`: the status-to-tone map. Pending = warning, Approved = success,
    Rejected/Withdrawn/Cancelled = neutral. Dot plus text, never colour alone;
  - `LeaveQuotePanel`;
  - `LeaveDayBreakdown`;
  - `LeaveHistoryTimeline`;
  - `DecisionDialog`: approve or reject, with a reason, the quantity confirmation and the sole-owner
    acknowledgement;
  - `TeamLeaveStrip`.
- **Themes:** light and dark only through semantic tokens. No raw colours. Each screen is screenshotted in
  both themes at desktop and 900 × 600 widths, using the existing screenshot recipe.

### 12.3 Navigation (D-P3-24)

- Leave appears as tabs inside People.
- **This touches a controlled surface.** The People Zone currently opens only with `people:read`. For MEMBER
  (who only has `people:leave_self`) it must open showing **My leave** alone.
- The change is in the shell registry. It must be coordinated with the UI V2 lane, not done silently in B4.

## 13. Decision register

### 13.1 Previously accepted (Regan, 2026-11-16): preserved

| # | Status in this design |
|---|---|
| D-P3-1 (P3-C before P3-B) | **Preserved.** B2 is gated on §11. B1 is ledger-free and may run in parallel with P3-C |
| D-P3-2 (config keys) | Preserved. Work week and holidays use `people:configure`; work patterns use `people:manage` |
| D-P3-3 (explicit effective-dated assignments) | Preserved. The engine uses the assignment covering each date. No eligibility rules |
| D-P3-4 (rule vocabulary) | Preserved, **no new policy field**. This is why D-P3-28 proposes a business-wide cancellation rule instead of D-P3-16's "if the policy allows" |
| D-P3-5 (revisions; type and unit fixed) | Preserved. Quotes and deductions record `policy_version` |
| D-P3-6 (no seeded types) | Unaffected |
| D-P3-7 (sensitive flag) | Preserved and enforced here (§8) |
| D-P3-8 (termination) | Preserved. P1 lifecycle code is unchanged. Approvals refuse terminated employees. Balance-at-termination is a P3-C item (C-11) |
| D-P3-9 (effective dates never future) | Preserved for configuration rows (work patterns). **Leave dates themselves are future dates by nature.** They are not "effective dates", so no conflict |
| D-P3-10 (purge cascade) | Preserved. All P3-B rows cascade with the business |
| D-P3-11 (P3-A migration) | Unaffected. Applied migrations are never edited |

### 13.2 Existing proposals D-P3-12 to D-P3-25, reconciled

The repository records these as **proposals, not approved** (`people-leave-p3.md` header: the
2026-11-16 approval "does not cover D-P3-12 onward"). Each still needs Regan's decision. I have not treated
any of them as accepted.

| # | Recommendation | Change vs the recorded proposal |
|---|---|---|
| D-P3-12 | **Confirm** the three keys and grants (§9.1) | None |
| D-P3-13 | **Confirm with amendment:** resolve the approver **live at decision time** (§5.2); require an `ACTIVE` membership | Adds timing and the suspension rule |
| D-P3-14 | **Confirm with amendment:** the sole-owner exception needs an explicit `selfDecision` acknowledgement, a database guard and an audit flag. Policy auto-approval is defined as not self-approval | Makes "separately authorised" concrete |
| D-P3-15 | **Confirm:** no delegation | None |
| D-P3-16 | **Amend.** "By the employee before the leave starts, *if the policy allows*" has no supporting policy field (D-P3-4 has none), and adding one would change approved P3-A rules. See D-P3-28 | Conflict, see D-P3-28 |
| D-P3-17 | **Confirm with amendment:** business work week + holiday list (optional per location) in B1; **per-employee work pattern in B1, not "later"** (D-P3-26) | Moves the per-employee override earlier (part-time over-charging risk) |
| D-P3-18 | **Confirm** | None |
| D-P3-19 | **Confirm**, and define HOURS overlap (D-P3-27) | Clarification |
| D-P3-20 | **Confirm**; P3-C owns it. Add the interface in §7.1 | Interface added |
| D-P3-21 | **Confirm**; P3-C owns it | None |
| D-P3-22 | **Confirm with precision:** the §8.2 table; omit `leaveTypeId` from audit for sensitive requests | Precision |
| D-P3-23 | **Confirm:** P3-E only, busy-only, after Scheduling privacy is built | None |
| D-P3-24 | **Confirm**, but flag it as a shell/navigation change needing UI V2 coordination | Ownership note |
| D-P3-25 | **Confirm**, with a caveat for leave in a later leave year (D-P3-32) | See D-P3-32 |

### 13.3 New proposals (need Regan's decision)

| # | Question | Recommendation | Why |
|---|---|---|---|
| D-P3-26 | Per-employee work pattern | Effective-dated per-employee days and hours in B1, defaulting to the business work week | Without it, a part-timer requesting a week is charged for days they never work. Manual fixes would need ledger adjustments for every request |
| D-P3-27 | Overlap for HOURS requests | An HOURS day occupies both half-day slots: at most one leave request per employee per day when any is hourly | Clock times are not modelled (D-P3-18: "hours, not instants"). This is conservative and enforceable by the same index |
| D-P3-28 | Employee cancelling approved leave | Business-wide rule: the employee may cancel their own approved leave **before its first day**. On or after that day, only the approver or `leave_manage` can. No policy field | Resolves the D-P3-16 / D-P3-4 conflict without changing P3-A |
| D-P3-29 | "Verified" user link | Accept admin-asserted links (existing, audited). Show the linked employee to the user. User confirmation would be a separate People change | Brief says "verified"; today the link is admin-verified only (§5.1) |
| D-P3-30 | Sole-owner self-decision | Enable, with the §5.3 conditions | A one-person business otherwise cannot record leave |
| D-P3-31 | Request spanning a policy assignment change | Refuse and ask for two requests | Avoids one request deducting under two policies |
| D-P3-32 | **Leave-year attribution (P3-C input)** | §4.7 rule 6 says "deduct on the approval date with the rules in force on that date". For leave falling in a **later leave year**, deducting from the current year's balance is wrong under GRANT policies without carry-over. Recommendation: the deduction entry records the **leave year of the leave dates**. The balance check uses the balance for that leave year as it will stand at its start: current balance + known grant, minus approved deductions for that year. Requests crossing a leave-year boundary are refused (split them). P3-C must model per-leave-year balances, or at least dated entries | **Conflict with the D-P3-25 proposal as written; must be decided before P3-C is built** |
| D-P3-33 | Team leave visibility | `people:read` holders see team leave (sensitive shown as "Away"); `leave_approve` holders see their reports; MEMBER sees only their own | Brief asks for "filtered team leave visibility" without fixing the audience |
| D-P3-34 | Restrictive RLS for sensitive notes | Yes, as defence in depth (§8.3) | Same reasoning as ADR 0006's `private_details` |
| D-P3-35 | Quote drift at approval | Approval must carry `expectedQuantity`; any mismatch gives `409 quote_changed` and nothing is deducted | Holidays or patterns may change between submit and approval; the approver must see what will be deducted |
| D-P3-36 | Termination with pending or future approved leave | P1 unchanged (no automatic action). Approval is refused once terminated. Future approved leave stays visible to `leave_manage` with a "terminated" marker for manual cancellation | Avoids touching P1 lifecycle code and the P3-A lock order |

## 14. Delivery packages B1–B4 and migration plan

Each package has its own branch, draft PR, tests, ChatGPT audit and verdicts under the protocol.

| Package | Scope | Depends on | Migration | Owned paths (conflict-minimal) |
|---|---|---|---|---|
| **B1 Calendar and engine** | Work week, work patterns (D-P3-26), holidays: tables, guards, config API, contracts. Pure duration engine + `POST /leave-requests/quote` **for DAYS/HOURS counting only** (no balance) | P3-A; decisions D-P3-17/18/26/27 | One additive migration | `modules/people/server/leave-calendar.ts`, `leave-engine.ts`, new routes under `people/leave-work-week`, `leave-holidays`, `employees/[id]/work-patterns`, `contracts/src/people-leave-calendar.ts` (new file, re-exported) |
| **B2 Requests and approvals** | Request tables, transitions, notes, guards, overlap index, keys in `permissions.ts`, approver resolution, all request endpoints, ledger calls, privacy projection, audit | **P3-C merged and applied (§11)**, B1, D-P3-12–16, 19, 22, 28–32, 34–36 | One additive migration | `modules/people/server/leave-requests.ts`, `leave-approvals.ts`, `leave-privacy.ts`, `people/leave-requests/**`, `people/me/leave`, `contracts/src/people-leave-requests.ts` |
| **B3 Team visibility** | `GET /leave-calendar` (busy blocks per §8.2), filters, paging; exported `people.leave.approver` resolver for N1 | B2, D-P3-33 | None | `leave-calendar` route, `leave-team.ts` |
| **B4 Client** | §12 screens and components, navigation change (coordinated with UI V2) | B2, B3 (API), V2 components available | None | `packages/app/src/zones/people/leave/**`, `packages/app/src/api/people-leave.ts`, shell registry line (coordinated) |

**Shared files every API package touches (expect trivial conflicts only):**

- `tenancy.prisma` (relations);
- `people.prisma` (back-relations);
- `_lib/routes.ts` (error maps);
- `contracts/src/index.ts`;
- `api-v1.json`;
- `permissions.ts` (B2 only);
- `people-boundaries.test.ts` (new table names).

**Migration stamps.** Each must sort after every stamp on `main` **and** in open PRs at the time it is
created (currently above `20261207000000`). P3-C's migration comes first, then B1 and B2 in order. No stamp
is reserved by this document.

**Production rollout (each migration).**

1. Read production `_prisma_migrations` read-only.
2. Create and validate the `pre-<change>-migration` recovery branch.
3. Apply under a verified `APPROVED — EXECUTE: MIGRATION` verdict. P3-B touches authorisation (new
   record-scoped rules), so B2 **escalates to Regan** for both migration and merge under the protocol.
4. Verify forced RLS, grants and guards.
5. Merge.
6. Run the smoke checks.

**Rollback.** Revert the code; the tables are then unused. Dropping them is destructive and needs Regan.
A migrated-but-undeployed state exposes nothing.

**Order and parallelism:** P3-C and B1 can run in parallel. B2 waits for both. B3 follows B2. B4 starts
on B2 and B3 contracts once the APIs are merged.

## 15. Test matrix

Integration tests run against real Postgres, plus the PgBouncer re-run, as P3-A does. Race tests are
deterministic using `pg_blocking_pids`.

| Area | Cases |
|---|---|
| **Tenant isolation** | Every new route with another business's ids → 404; raw SQL under RLS for every new table; the isolation suite covers the new tables; composite FKs refuse cross-business employee, type, policy, location and ledger ids |
| **Grants and guards** | No DELETE or TRUNCATE; column UPDATE inventory; transitions table immutable (PE004); version +1 (PE009); invalid transitions via raw SQL (PE013); self-decision via raw SQL without the session flag (PE014); `active` flag follows status |
| **Authority** | Self-service only with a link and an ACTIVE membership (a suspended member is refused); a MEMBER without a link gets `not_linked`; `leave_approve` decides only for direct reports with live resolution; fallback when the manager is unlinked, terminated or lacks the key; override recorded; self-approve and self-reject refused; sole-owner path needs the acknowledgement and no other `leave_manage` member; a second admin joining disables it; on-behalf submission; a manager change moves pending items |
| **State machine** | Every allowed and forbidden pair in §4.2; employee cancel before and on the start day; reasons stored in notes only |
| **Stale and replay** | Stale version on every transition writes nothing; Idempotency-Key replay returns the original with no second ledger entry; key reuse with a different body gives `idempotency_conflict`; transition replay with a key |
| **Concurrency (deterministic)** | Two approvals of one request; two approvals overspending one balance; approve vs withdraw (both orders); approve vs cancel; approve vs termination; approve vs policy archive; two overlapping submissions; cancel vs cancel (single reversal); approval vs accrual on the same balance |
| **Ledger** | Deduction amount equals the stored quantity; reversal is append-only and idempotent; negative limit at the boundary (exactly the limit, limit + 0.0001); `insufficient_balance` rolls back everything; `quote_changed` rolls back everything |
| **Business-day calculations** | Mon–Fri default; custom work week; per-employee pattern change mid-request; holidays business-wide and per location; a holiday added after submit (pending re-quoted, approved unchanged); half days at the start and end; single-day AM and PM; HOURS granularity (hour, half, quarter), above `hours_per_day`, default fill; a zero-chargeable request refused; a 366-day limit; business time zones Perth and New York around midnight for "today"; leap day; leave-year boundary refusal (calendar, anniversary, custom start) |
| **Rule checks** | Notice (and the on-behalf override, audited); backdating on and off; waiting period; employee start date; assignment gap; assignment change within a request; archived or inactive policy still governing its assignments |
| **Overlap** | Same type and different types; AM plus PM allowed; FULL plus AM refused; HOURS blocks the day; withdrawn, rejected and cancelled requests free their slots; zero-amount (weekend) days never clash |
| **Privacy** | §8.2 table field by field for each viewer class, ordinary vs sensitive; notes never in list responses; flipping the type's `sensitive` flag re-classifies; restrictive RLS on notes (if D-P3-34); `overlap` error does not reveal a hidden request |
| **Auditability** | One audit event per transition; metadata contains no names, notes, reasons or amounts, and no `leaveTypeId` when sensitive; failed transitions write no audit; `basis` and `selfDecision` recorded |
| **Contracts** | Strict bodies (unknown fields refused); quote and request shapes; snapshot `api-v1.json` |
| **Client (B4)** | In-memory stand-in mirroring the server rules (P2 pattern): every screen's empty, loading, error, not-linked, stale and quote-changed states; role-aware tabs; both themes |

## 16. Risks and open questions

- **P3-C is the critical path.** B2 cannot be audited meaningfully until §7.1 exists. D-P3-32 must be
  settled before P3-C's schema is drafted, or P3-C will need a second migration.
- **First record-scoped rule in People.** Approver resolution is new authorisation logic. That is why B2
  escalates to Regan under the protocol even if every check passes.
- **Scheduling blind spot until P3-E.** Rostering does not see leave. The UI should show team leave in
  People (B3/B4) so managers have one place to look.
- **Location-based holidays use the employee's *current* location.** There is no location history (PD-4),
  so a location change re-quotes pending requests against the new location's holidays. Approved requests
  are unaffected.
- **No notifications.** Approvers must open the inbox. A count badge in People (B4) mitigates this until
  N1 exists.
- **Production state not re-verified here** (§1). The next migration thread must do the read-only
  preflight itself.
