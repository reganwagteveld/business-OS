# Workflow links migration: preflight, rehearsal, apply and recovery

Migration `20261207000000_workflow_links` (WF-1B-1, PR #110). Spec: [cross-zone-workflows-wf1.md](./cross-zone-workflows-wf1.md) §5 and §10.

**Status: NOT APPLIED to production or to any Neon branch.** Nothing in this document authorises applying it. The procedure follows the protocol's production migration order:

1. A ChatGPT migration audit with an `APPROVED — EXECUTE` verdict that names this migration file and the exact head SHA. Regan's direct approval may stand in where the protocol escalates.
2. The read-only preflight (§4.1).
3. A verified recovery branch (§4.4).
4. Regan's explicit apply approval, written by Regan himself in the Mac session thread (§5).

Merging deploys code that needs the new columns, so the PR merges only **after** the apply has been verified (§4.7).

## 1. What the migration does

It runs in one explicit transaction with `SET LOCAL lock_timeout = '3s'` and `statement_timeout = '60s'`. It is additive only. No existing row changes, and no issued Finance document is touched.

- **Indexes:** two unique indexes that the primary keys already imply, so they cannot fail. `finance_documents (business_id, id, kind, customer_id)` and `projects (business_id, id, customer_id)`.
- **Columns:** three new `projects` columns, `source_opportunity_id`, `source_quote_id` and `source_quote_kind` (constant default, so no table rewrite). Two CHECKs, one index, and one unique key per source quote.
- **Foreign keys:**
  - two from `projects`: to opportunities, and to the source quote;
  - three I1 keys (`finance_documents`, `finance_expenses` and `finance_recurring_templates` → `projects`), added `NOT VALID` and then validated.
- **Validation:** done inside the `validate-i1` block, which lifts and restores FORCE (see §2).
- **Trigger:** `projects_guard_links()` (SECURITY INVOKER) and its trigger.
- **Table:** `workflow_requests`, with forced RLS, a tenant policy, a restrictive insert policy, and `SELECT, INSERT` for `bos_app` only.

### Locks (all held until COMMIT)

| Table | Strongest lock | Blocks | Scan |
|---|---|---|---|
| `projects` | ACCESS EXCLUSIVE (ADD COLUMN, CHECK, NO FORCE) | reads and writes | index builds, CHECK scan (new columns are NULL) |
| `finance_documents` | ACCESS EXCLUSIVE (NO FORCE) | reads and writes | unique index build, VALIDATE |
| `finance_expenses` | ACCESS EXCLUSIVE (NO FORCE) | reads and writes | VALIDATE |
| `finance_recurring_templates` | ACCESS EXCLUSIVE (NO FORCE) | reads and writes | VALIDATE |
| `opportunities` | SHARE ROW EXCLUSIVE (FK added) | writes | none |
| `workflow_requests` | new table | nothing | none |

So for the length of the transaction, Projects and Finance documents, expenses and schedules cannot be read or written, and opportunities cannot be written. With `lock_timeout` at 3 s, the migration fails and rolls back rather than queueing behind a long transaction, so it can never hold the app behind it for more than 3 s plus its own run time.

**Local timing** (PostgreSQL 16, 1,252 businesses, 280 projects, 1,225 documents, 246 expenses, 132 schedules): the statements took **33 ms** in total, and the slowest took 5 ms. `prisma migrate deploy` took 1.9 s wall time end to end, which is mostly Prisma start-up. On Neon, round trips from the Mac add to the time locks are held. The #97 rehearsal saw about 6 s on near-empty tables, and the cause was not verified. That is why §4.2 measures it here and does not inherit #97's numbers or its accepted stall.

## 2. Finding fixed before any apply: VALIDATE under forced RLS

`VALIDATE CONSTRAINT` checks existing rows **as the table owner**. Here the owner is `bos_owner`, the migration role. `FORCE ROW LEVEL SECURITY` binds the owner to the tenant policies, which are written `TO bos_app` and grant the owner no rows. So under FORCE, the check sees nothing and **passes even when rows violate I1**. This was verified locally: a seeded violation validated cleanly as `bos_owner` and failed as superuser.

The migration therefore lifts FORCE for the owner on the four tables the check reads (`projects`, `finance_documents`, `finance_expenses`, `finance_recurring_templates`). It validates, restores FORCE, and asserts that all four tables are forced again before the block ends, all in the same transaction.

- No other session can see the gap, because each `ALTER TABLE` holds ACCESS EXCLUSIVE until COMMIT.
- A failure rolls the change back.
- `bos_app` is not the owner, so its policies apply throughout either way.

T-53 runs the block **verbatim as `bos_owner`**. It shows that under FORCE the check passes vacuously, that the block refuses a violation with `23503`, and that on clean data the block passes and leaves FORCE on all four tables.

The same blind spot applies to any earlier migration that added a validated foreign key to a forced-RLS table holding data. That is outside this PR. It is listed for the auditor, not changed here.

## 3. Local drill (2026-11-17, PostgreSQL 16)

These ran on a copy of the integration database with this migration removed.

| Run | Result |
|---|---|
| Preflight, clean | **PASS**: A1–A7 and B2–B4. 1,252 businesses checked. Per-business sums equal the exact totals for every table, and with no business set `bos_app` sees 0 rows. |
| Preflight, wrong history (migration already present) | **STOP**: fingerprint differs. |
| Preflight, seeded I1 violation (one project's customer changed) | **STOP**: 4 I1 violations (3 documents, 1 expense). |
| `migrate deploy` with that violation | **Failed.** No column, constraint or table was left behind, and FORCE stayed on all four tables. `_prisma_migrations` kept an unfinished row. |
| `prisma migrate resolve --rolled-back 20261207000000_workflow_links` | Marked the row rolled back. |
| Violation removed, `migrate deploy` again | **Applied.** Three I1 keys validated, FORCE on all four tables, and the history shows the rolled-back attempt followed by the finished one. |

## 4. Production procedure

Every step runs from the Mac Remote Control session, because the cloud container cannot reach Neon. Steps 4.1 and 4.2 are allowed under the standing infrastructure policy (read-only checks and temporary test branches). Steps 4.4 to 4.6 need the approvals at the top of this document.

**Target guards, all required:**

- Use the repository checkout at the **exact audited head** of PR #110.
- That head must contain every migration production already has. If `20261206000000_search_indexes` is applied in production, this branch must include it, which means merging `main` once #97 has merged, at the front of the queue. The fingerprint check refuses anything else.
- Read the URLs from the environment only. Never type or paste them into chat, the PR or a report.
- Before 4.4 and before 4.5, a **read-only** Neon API request must confirm that the endpoint host behind `MIGRATION_DATABASE_URL` is an endpoint of the project's **default (production)** branch. Before 4.2, it must confirm the host belongs to the rehearsal branch and **not** the default branch.

### 4.1 Read-only preflight

```sh
cd apps/api
node scripts/migration-fingerprint.mjs --exclude 20261207000000_workflow_links   # files only, no database
export WF_EXPECTED_FINGERPRINT=<the fingerprint printed above>
export WF_PREFLIGHT_APP_URL=<bos_app URL for the DIRECT (non -pooler) production endpoint>
psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/workflow-links-preflight.sql
pnpm exec prisma migrate status   # exactly one pending migration: 20261207000000_workflow_links
```

`scripts/workflow-links-preflight.sql` needs psql 15 or newer. Both of its transactions are `READ ONLY` and end in `ROLLBACK`. It prints only counts, sizes, booleans and pass/fail lines: no SQL text, ids, names or hosts. Any failed check prints `STOP: …` and psql exits non-zero.

| Check | Pass condition (anything else is a stop) |
|---|---|
| A1 | The admin role is superuser or BYPASSRLS. Otherwise every count would be a false zero. |
| A2 | No unfinished or rolled-back migration. Applied fingerprint equals the repository's. This migration is absent. |
| A3 | None of this migration's columns, table, function, constraints or indexes exist. |
| A4 | Exact row counts and sizes of the six affected tables. Recorded; these are the control totals. |
| A5 | I1 violations across all businesses: documents 0, expenses 0, recurring templates 0. |
| A6 | Customerless expenses linked to a project. Recorded only, and re-checked after apply. |
| A7 | No long-running transaction (otherwise retry later), plus the server version. |
| B2 | As `bos_app` with no business set, 0 rows are visible: RLS is in force. |
| B3–B4 | For every business, as `bos_app` with that business set: it sees exactly its own business row. The per-business sums equal A4's exact totals for every table, and no business has an I1 violation. A difference can mean rows outside every business, a hidden row, or a write between A and B. Stop, and re-run in a quiet moment. |
| B5 | Empty case stated explicitly. |

Keep the raw output in the private Mac session. Post only the pass/fail summary and the counts in the PR.

### 4.2 Neon rehearsal (recommended, to measure the lock window)

1. Create a temporary branch `rehearsal-workflow-links-<yyyymmdd>` from production, in the production region, under the standing Neon policy and the branch limit. If it would exceed the limit, add cost or need a deletion the policy does not cover, stop and ask.
2. Confirm with the Neon API that the branch is not the default branch and that the URLs point at its endpoints (target guards above).
3. Run §4.1 against the branch. It must pass exactly as it would on production.
4. Run `prisma migrate deploy` against the branch from the Mac. While it runs, have a second session repeat a trivial `bos_app` read of `projects` and record the longest wait. Record the deploy wall time.
5. Verify as in §4.6. Delete the branch per policy and log the deletion.

### 4.3 Go / no-go (proposed thresholds; Regan decides)

- **Go** if the rehearsal (or, without one, the preflight) shows all of the following:
  - the preflight passed;
  - the deploy succeeded;
  - FORCE is on all four tables;
  - the three keys are validated;
  - the longest blocked read or write is at most **2 s**.
- If the longest wait is over 2 s, it is Regan's decision. Today production has no real users, but this acceptance must be made **for this migration**; the stall accepted for #97 does not carry over.

### 4.4 Recovery branch (approval required)

Create `pre-workflow-links-migration` from production immediately before applying. Verify it:

- it reaches `ready`;
- it accepts a connection;
- its `_prisma_migrations` count and fingerprint equal production's.

Record its id, LSN and creation time in `ops/neon/recovery-points.json`. Standing policy: keep production plus at least 2 recent verified recovery branches. Point-in-time restore is not a substitute.

### 4.5 Apply (approval required)

1. Re-run §4.1, which must still pass. Re-run A7 for no active write traffic.
2. Confirm the target is the production branch (target guards).
3. From `apps/api`, with `MIGRATION_DATABASE_URL` pointing at the production direct endpoint: `pnpm exec prisma migrate deploy`.

### 4.6 Verify

Run each as the admin role, read-only:

- `_prisma_migrations` has `20261207000000_workflow_links` finished, with the repository's checksum, and nothing pending.
- `pg_constraint`: the seven new constraints exist, and the three `*_project_customer_fkey` keys have `convalidated = true`.
- `pg_class`: `relrowsecurity` and `relforcerowsecurity` are true for `projects`, `finance_documents`, `finance_expenses`, `finance_recurring_templates` and `workflow_requests`.
- The trigger `projects_guard_links` exists on `projects`. `workflow_requests` grants are `SELECT, INSERT` to `bos_app` only.
- A6 count is unchanged.
- Smoke: production health returns 200. The new code is not deployed yet, so nothing reads the new columns.

### 4.7 Merge order

PR #110 merges only after §4.6 succeeds. It goes through the merge-queue thread, with a fresh `APPROVED — EXECUTE` merge verdict on the final head, followed by the production smoke checks.

## 5. What Regan writes in the Mac session thread

Each is a fresh, unedited message from Regan, sent at the time of the step. A relayed message or a card tap does not count.

1. To allow the read-only checks and a rehearsal (already within standing policy, so this is optional): *"Run the read-only preflight for 20261207000000_workflow_links from PR #110 at `<head SHA>`, and a Neon rehearsal on a temporary branch."*
2. After the migration audit verdict and a passing preflight: *"Approved: create and verify recovery branch pre-workflow-links-migration, then apply migration 20261207000000_workflow_links from PR #110 at `<head SHA>` to production and verify it. Stop on any deviation."*
3. If the measured wait exceeds 2 s: *"I accept a write/read stall of up to `<N>` s for 20261207000000_workflow_links at today's production size."*

## 6. Rollback and forward recovery

| Situation | What happens | Action |
|---|---|---|
| Lock or statement timeout, an I1 violation, or any error during apply | The transaction rolls back and nothing is left behind, FORCE included (rehearsed locally). `_prisma_migrations` keeps an unfinished row, and `migrate deploy` refuses to continue. | `pnpm exec prisma migrate resolve --rolled-back 20261207000000_workflow_links` (rehearsed). Re-run §4.1. If I1 failed, stop and report privately; never edit data to make it pass without Regan. Retry in a quieter moment. Never edit the migration file. |
| Applied, before the code merges | The schema is additive. The running code ignores the new columns, and FKs on existing rows already validated. | Nothing to do. Merge per §4.7. |
| Applied, and something is wrong with the new objects | | Forward fix in a new, separately approved migration. Never edit or delete an applied migration. |
| Data damage of any kind (not expected from an additive change) | | Stop and ask Regan. Restoring from `pre-workflow-links-migration` is a last resort, needs Regan's approval, and loses every write after the branch point. Never improvise production repairs. |
