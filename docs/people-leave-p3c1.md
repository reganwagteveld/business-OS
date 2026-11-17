# People P3-C1: leave ledger core

Status: **draft PR, disabled by default, not applied anywhere but CI and local rehearsal.** Spec:
[people-leave-p3c-ledger-architecture.md](people-leave-p3c-ledger-architecture.md) v1.4 §C, §C.6a, §I.2a, §J.1,
§J.2, §J.4, §K and §L (row P3-C1). Authorisation: the owner decision record on PR #134 (comment 6950789737)
allows P3-C1 implementation and tests in a new, isolated draft PR under **D-P3C-32 option A**. It gives **no**
permission to apply a production migration, run privileged SQL, merge, deploy, connect payroll, activate the
feature or start C2–C6.

## 1. What this package adds

| Piece | Where |
|---|---|
| Five tables: accounts, buckets (leave years), transactions, entries, authorisations (empty, write-refused) | `apps/api/prisma/schema/people-leave-ledger.prisma`, migration `20261211000000_people_leave_ledger` |
| Revision `effective_from` + `effective_from_basis` (D-P3-25 r.1, D-P3C-27, J.2 back-fill) | same migration; `people-leave.prisma` |
| Guards, stage gate, deferred commit invariants, partial unique indexes, grants, forced RLS + restrictive read policies | hand-written section of the migration |
| Posting primitive for derived kinds with explicit hours, totals, seals, verifier V-01..V-07 | `apps/api/src/modules/people/server/leave-ledger.ts` (not exported, no route, no job) |
| Tests T-C01..T-C09e, T-C10 (system keys), T-C40, T-C41, T-C42c/d/e, T-C47, T-C62, T-C63, T-C64 | `apps/api/tests/integration/people-leave-ledger.test.ts` (also run behind PgBouncer in CI) |

Nothing calls the primitive outside tests. There is no engine (C2), no request integration (C3), no read API
(C4), no corrections or grants (C5) and no payroll surface (C6).

### 1.1 Stage gate (what C1 accepts)

Only the derived transaction kinds `ACCRUAL`, `YEAR_OPEN`, `CONSUME`, `FREEZE` and `CARRY_PROPAGATION` are
accepted (trigger `people_leave_transactions_stage_gate`, PE015). Refused until their package adds its backstop:
request kinds (`RESERVE`, `RELEASE`, `REVERSE_CONSUMPTION`, C3/B2), manual kinds (`ADJUSTMENT`, `CORRECTION`,
`EXPIRY`, `PAYOUT`, `OPENING_BALANCE`, `IMPORT`, C5), `WRITE_OFF` (D-P3C-11), `POLICY_EXPIRY` (D-P3C-15), any
posting under a `DAYS` policy revision or with `hours_per_day` (revised D-P3C-23), and every write to
`people_leave_authorisations` (C5).

### 1.2 SQLSTATEs (class PE)

PE013 immutable ledger rows · PE014 account lock not held · PE015 not enabled in this stage · PE016 ledger rule ·
PE017 invariant at commit · PE018 `leave_reference_not_visible` (D-P3C-37 (a)) · PE019 writer may not post here.
PE009 (stale) is reused for a version that does not advance by exactly one. P3-B numbers its codes after PE019.

## 2. Choices the audit should check

These go beyond, or narrow, the spec. Each is fail-closed.

1. **Lock proof by account version.** Every transaction stores `account_version` (unique per account) and the
   account guard requires each bump to be used by exactly one transaction at commit (deferred). V-06 is therefore
   enforced at write time, not only detected. The lock proof compares the account row's `xmin` with the current
   top-level xid, so a bump inside a savepoint is refused (tested).
2. **A writer must be able to read the whole account** (DETAIL level, sensitive included) to bump it (PE019).
   This is stricter than §C.6a and guarantees that no guard sum is computed over a partial, RLS-filtered view.
   In C1 the database therefore accepts a bump from OWNER/ADMIN, and from the linked employee on their own
   account only. Which actor may post which derived kind is the application's decision under D-P3C-32 option A
   (C1 has no route or job that posts at all); an inflated `ACCRUAL`/`GRANT` amount by a `bos_app` holder is
   detected by V-08 in C2, not stopped here, exactly as option A states.
3. **FREEZE** uses `source_kind = EMPLOYMENT` and is the one kind allowed with no entries (state changes only).
4. **No day↔hours basis in C1.** `hours_per_day` is kept on entries and the policy version is recorded on every
   entry, but `DAYS` postings and any `hours_per_day` are refused (PE015). Regan's D-P3C-23a/b (weekly ordinary
   hours ÷ 5 by default, average scheduled working-day hours as the alternative, chosen per policy by
   effective-dated revision; consumption always deducts actual scheduled ordinary hours) land in C2 with
   T-C24a..d. C1 hard-codes no conversion, so nothing here changes for those decisions.
5. **Derived keys are bound to facts**: `ac:{account}:{service period}:{period start}` must match the accrual
   entry; `yo:{bucket}` names the year it opens and the grant goes into that year; `cs:`, `fz:` and
   `cp:{related}:{uuid}` have fixed shapes.
6. **Carry and lapse**: positive carry ≤ the revision's cap; carry-out, carry-in and lapse in one closing cite
   one policy revision; CAPPED lapses to the cap, NONE lapses to zero, UNLIMITED never lapses; a CARRY_CAP lapse
   is reversed only by a propagation. A YEAR_OPEN may post its carry-out and lapse into the year it closed in the
   same database transaction (checked by `closed_at = now()` and the row's `xmin`).
7. **Bucket transitions are tied to the transaction kind** in the current xid: FUTURE→OPEN and OPEN→CLOSED need a
   YEAR_OPEN, →FROZEN needs a FREEZE; CLOSED and FROZEN are final.
8. **Authorisations table**: read-only in C1; its FK to `memberships (business_id, user_id)` would block a
   membership delete once rows exist. C5 must decide that (flagged, not solved here).
9. **Sensitivity** is computed: the statement's value OR the type's flag OR any cited row's flag, so it only ever
   grows (T-C42d/e). A cited row the writer cannot read is refused with PE018 (D-P3C-37 (a)).

## 3. The revision back-fill (J.2): preflight, rehearsal and lock limits

The migration is additive DDL **plus** an existing-data transformation of `people_leave_policy_revisions`. It is
not routine: the apply verdict needs the evidence below. The back-fill block runs last, between the markers
`-- >>> backfill-effective-from` and `-- <<< backfill-effective-from`, under `lock_timeout = 3s` and
`statement_timeout = 30s`. It takes ACCESS EXCLUSIVE on `businesses` and `people_leave_policy_revisions` until
COMMIT, asserts that every row was updated and none is NULL, and restores FORCE RLS and the guard (asserted).

### 3.1 Read-only preflight (production, before the apply verdict)

Run as the admin role in a `READ ONLY` transaction, after the protocol's `_prisma_migrations` read (pending set =
exactly this migration, checksums match):

```sql
BEGIN READ ONLY;
SELECT count(*) AS revision_rows, count(DISTINCT business_id) AS businesses FROM people_leave_policy_revisions;
-- Businesses whose time zone changed after their earliest revision (their INFERRED dates may be one day off).
SELECT b.id, count(*) AS changes
  FROM businesses b
  JOIN audit_events a ON a.business_id = b.id AND a.action = 'business.updated' AND a.metadata ? 'timeZoneTo'
 WHERE a.created_at > (SELECT min(r.recorded_at) FROM people_leave_policy_revisions r WHERE r.business_id = b.id)
 GROUP BY b.id ORDER BY b.id;
SELECT count(*) AS ledger_tables_present FROM pg_class
 WHERE relname IN ('people_leave_accounts', 'people_leave_buckets', 'people_leave_transactions',
                   'people_leave_entries', 'people_leave_authorisations');
ROLLBACK;
```

If the second query lists any business, D-P3C-35 goes to Regan before any apply verdict. As of 2026-11-17
production has no businesses (project memory; to be confirmed by this preflight), so the expected result is zero
revision rows and an empty list.

### 3.2 Rehearsal

**Local (done, this PR):** see §3.3. **Neon (to do before the apply verdict, Mac session):** a disposable branch
from production, the preflight above, `prisma migrate deploy`, then the checks in §3.3 and the measured
`_prisma_migrations` duration. A long transaction on `businesses` must make the apply fail on `lock_timeout`
and leave nothing behind (tested locally in T-C64).

### 3.3 Local rehearsal results

Script: [evidence/people-p3c1/local-rehearsal.sh](evidence/people-p3c1/local-rehearsal.sh) (local PostgreSQL 16,
local only), preflight [evidence/people-p3c1/preflight.sql](evidence/people-p3c1/preflight.sql). Run 2026-11-17:
every migration up to `20261207000000_workflow_links` applied, then 2,000 businesses in six time zones, 6,000
policies and 8,018 revisions written through P3-A's own guards, `recorded_at` spread over the past 300 days, and
one audited time-zone change after a revision.

| Check | Result |
|---|---|
| Preflight: pending set | 25 applied, newest `20261207000000_workflow_links`; ledger tables absent |
| Preflight: rows to transform | 8,018 revisions in 2,000 businesses |
| Preflight: time-zone change after a revision | 1 business listed (the seeded one), as designed |
| `prisma migrate deploy` | succeeded; `_prisma_migrations` duration 235 ms (2.0 s wall clock including Prisma start-up) |
| After: `effective_from` NULL / `INFERRED` | 0 / 8,018 of 8,018 |
| After: dates equal `recorded_at` in the business's zone | 8,018 of 8,018 (0 mismatches) |
| After: FORCE RLS | on for `businesses`, revisions and all five ledger tables |
| After: revision guard / `effective_from` NOT NULL | enabled (`O`) / NOT NULL |
| After: ledger rows | 0 |
| Behind a long reader on `businesses` (T-C64 test) | fails with 55P03 within the lock timeout; nothing changed |

Not yet run: the Neon rehearsal on a branch from production (§3.2), which is what the apply verdict relies on.

## 4. Decisions still open for this package

Need ChatGPT technical acceptance or an owner record during the audit (the code follows the recommendation):

| Decision | What C1 does |
|---|---|
| D-P3-25 r.1 | Revisions get `effective_from` (business today, `RECORDED`; back-filled rows `INFERRED`). |
| D-P3C-09 | One serialisation point per account: the account row (version bump). |
| D-P3C-10 | No stored totals; balances are sums of entries. |
| D-P3C-27 | Back-fill in the migration (rehearsed). |
| D-P3C-29 | `numeric(12,4)` hours; the primitive refuses more than 4 decimal places. |
| D-P3C-33 | `recorded_at` informational; seals are stored `pg_snapshot` values compared with `recorded_xid`. |
| D-P3C-34 | Fail-closed restrictive read policies in C1 (OWNER/ADMIN and the linked employee only). |
| D-P3C-35 | Only if the preflight finds a time-zone change after a revision (owner). |
| D-P3C-37 | (a) refuse the write (PE018); no privileged lookup. |

## 5. Production path (not authorised by this PR)

Per protocol "Production migrations" and spec §J.7: preflight (§3.1) → recovery branch created and validated →
Neon rehearsal (§3.2) with evidence posted → `APPROVED — EXECUTE: MIGRATION` naming this file and the reviewed
head (or Regan where the audit escalates) → `prisma migrate deploy` → verify forced RLS, grants, triggers, zero
ledger rows and the back-filled `effective_from` → merge through the queue under a separate merge verdict →
smoke (`/api/v1/health`; no leave balance route exists). Rollback before any ledger row exists: the tables are
empty and nothing reads them; a forward migration drops them if needed. The back-filled columns are additive.
