# Sales configuration migration: preflight, rehearsal, apply and recovery

Migration `20261210000000_sales_configuration` (S-CFG-1A, PR #135). Spec: [sales-pipeline-configuration-scfg.md](./sales-pipeline-configuration-scfg.md) §7 and §8.

**Status: NOT APPLIED to production or to any Neon branch.** Nothing in this document authorises applying it. Order (protocol, "Production migrations"):

1. Read-only preflight on production (§3).
2. Rehearsal on a disposable Neon branch, including the lock drill (§4). Required by spec §8.2.
3. Evidence posted to PR #135 (§5), then a ChatGPT `APPROVED — EXECUTE: MIGRATION` verdict naming `20261210000000_sales_configuration`, the exact head SHA and that evidence.
4. Recovery branch `pre-sales-configuration-migration`, verified (§6).
5. Apply and verify (§7, §8).
6. Only then the merge, through the merge queue under a separate `APPROVED — EXECUTE: MERGE` verdict (§9).

Merging first would ship code that reads `config_version` before the column exists, so the order is fixed.

## 1. What the migration does

One explicit transaction with `SET LOCAL lock_timeout = '3s'` and `statement_timeout = '60s'`. Additive only: no existing row changes.

- `sales_pipelines.config_version INTEGER NOT NULL DEFAULT 1` plus CHECK `> 0` (constant default, so no table rewrite).
- Partial unique indexes `sales_stages_active_name_key` and `sales_pipelines_active_name_key` on `lower(btrim(name))` where `archived_at IS NULL`.
- Guard functions `sales_stages_guard()` and `opportunities_stage_guard()` (SECURITY INVOKER, pinned `search_path`, `EXECUTE` revoked from PUBLIC) and three triggers: `sales_stages_guard`, `opportunities_stage_guard_insert`, `opportunities_stage_guard_update`.
- No RLS, grant or policy change.

### Locks (all held until COMMIT)

| Table | Strongest lock | Blocks | Scan |
|---|---|---|---|
| `sales_pipelines` | ACCESS EXCLUSIVE (ADD COLUMN, CHECK) | reads and writes | CHECK scan, unique index build |
| `sales_stages` | SHARE (index build), SHARE ROW EXCLUSIVE (trigger) | writes | unique index build |
| `opportunities` | SHARE ROW EXCLUSIVE (triggers) | writes | none |

So while it runs, pipelines cannot be read and stages and opportunities cannot be written. `lock_timeout` of 3 s makes it fail and roll back rather than queue behind a long transaction. Spec §7.3: if any of the three tables has more than 100,000 rows or 100 MB, stop and re-plan; the preflight enforces this.

**Compatibility.** The old code (still on `main` between apply and merge) never creates a state the triggers reject, and never writes a duplicate active name, so the gap between apply and merge is safe (spec §8.3).

## 2. Local drill (2026-11-17, PostgreSQL 16)

On a database with every migration except this one, 2 businesses, 6 stages, 18 opportunities.

| Run | Result |
|---|---|
| Preflight, clean | **PASS** (A1–A7, B2–B5). |
| Preflight, a duplicate active stage name seeded | **STOP**: duplicate active stage names. |
| Preflight, wrong expected fingerprint | **STOP**: fingerprint differs. |
| `migrate deploy` while another session holds an `UPDATE` on `sales_stages` | **Failed** after 3 s: `canceling statement due to lock timeout` (Postgres log). Prisma itself prints only `current transaction is aborted`, because the migration's explicit transaction is already aborted when Prisma tries to write its log. Nothing was left behind; `_prisma_migrations` kept one unfinished row and further deploys refused (P3009). |
| `prisma migrate resolve --rolled-back 20261210000000_sales_configuration` | Marked the row rolled back. Preflight then **PASS**es and reports the resolved attempt. |
| `migrate deploy` again, with the probe running | **Applied** in 1.4 s wall time. Probe: longest read 52 ms, longest stage write 47 ms. |
| Rehearsal script | **PASS**: objects, guard smoke, archive of 5,000 open opportunities in 277 ms (25 s budget). Every write rolled back (counts unchanged). |
| Rehearsal script with one trigger disabled | **STOP**: 2 of 3 guard triggers enabled. |
| Fixture on an empty, fully migrated database, then rehearsal script and probe | Fixture created, second run a no-op; rehearsal **PASS**; probe ran without errors. Without `SCFG_FIXTURE_TARGET=rehearsal` it refuses. |
| Probe while another session holds ACCESS EXCLUSIVE on `sales_pipelines` for 2 s | Longest read 2,034 ms: the probe sees stalls. |
| Persistent-connection probe (`.mjs`, replaces the first `.sh` probe, which opened a new connection per sample and so timed about 2 s of connection set-up from the Mac to us-east-1) with a 1.5 s ACCESS EXCLUSIVE hold | Read longest minus median 1,455 ms, write 1 ms. Refuses a role that bypasses RLS. |
| Reset script, then preflight, then deploy with the new probe | Reset removed objects and ledger rows; preflight **PASS** (0 resolved attempts); deploy applied; probe longest minus median 4 ms (read) and 3 ms (write); rehearsal **PASS**. Without `SCFG_RESET_TARGET=rehearsal` it refuses. |

Neon adds network round trips from the Mac, which is why §4 measures the real window rather than inheriting these numbers.

## 3. Read-only preflight (spec §8.1)

Every step runs from the Mac Remote Control session; the cloud container cannot reach Neon.

**Target guards, all required, before each of §3, §4, §6 and §7:**

- The checkout is PR #135 at the **exact audited head**, and that head contains every migration production has (25 as of 2026-11-17, latest `20261207000000_workflow_links`). The fingerprint check refuses anything else.
- URLs come from the environment only. Never type or paste them into chat, the PR or a report.
- A **read-only** Neon API request confirms the endpoint host behind the URL in use: the project's **default (production)** branch for §3, §6 and §7; the rehearsal branch, and **not** the default branch, for §4.
- Use the **direct** (non `-pooler`) endpoint for migrations and scripts.

```sh
cd apps/api
node scripts/migration-fingerprint.mjs --exclude 20261210000000_sales_configuration   # files only; expect "migrations: 25"
export SCFG_EXPECTED_FINGERPRINT=<the fingerprint printed above>
export SCFG_PREFLIGHT_APP_URL=<bos_app URL, direct production endpoint>
psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/sales-configuration-preflight.sql
pnpm exec prisma migrate status   # exactly one pending migration: 20261210000000_sales_configuration
```

psql 15 or newer. Both transactions are `READ ONLY` and end in `ROLLBACK`. Output is counts, sizes, booleans and pass/fail lines only. Any failure prints `STOP: …` and psql exits non-zero.

| Check | Pass condition (anything else is a stop) |
|---|---|
| A1 | The admin role is superuser or BYPASSRLS, so counts are not false zeros. |
| A2 | No unfinished or rolled-back row (except a resolved earlier attempt of **this** migration, reported). Fingerprint equals the repository's. This migration absent. Nothing sorts at or after it. |
| A3 | None of the migration's column, CHECK, indexes, functions or triggers exist; no other trigger on the Sales tables. |
| A4 | Exact totals and sizes of `businesses`, `sales_pipelines`, `sales_stages`, `opportunities`, `opportunity_outcomes`. Stop if an altered table is over 100,000 rows or 100 MB. |
| A5 | All 0: duplicate active stage names per pipeline; duplicate active pipeline names per business; OPEN unarchived opportunities in an archived stage or pipeline; stage/pipeline business mismatch; an active pipeline named like the default in a business with no default pipeline. A non-zero count is a data fix, which escalates to Regan. |
| A6 | Reported only: pipelines with no active stage, closed rows in archived stages, largest number of OPEN opportunities in one stage. |
| A7 | No transaction older than 60 s (otherwise retry later); server version. |
| B1–B2 | `bos_app` connects with READ COMMITTED as default, and with no business set sees 0 rows (negative control). |
| B3–B5 | Per business, as `bos_app`: the per-business sums equal A4's exact totals. A difference can mean a write between A and B: stop and re-run in a quiet moment. Empty case stated explicitly. |

Keep the raw output in the private Mac session. Post only the pass/fail summary and counts.

## 4. Neon rehearsal (spec §8.2, required)

1. **Branch budget.** List the project's branches (read-only Neon API). If creating the rehearsal branch now, and the recovery branch later, would take the project over the plan's included branch count, stop and ask Regan: freeing a slot means deleting a branch, and paying for an extra one is spend. Both are his decisions.
2. Create `rehearsal-sales-configuration-<yyyymmdd>` from production, after the §3 preflight passed, in the production region. Temporary test branches need no approval.
3. Target guard: the rehearsal URLs point at that branch, not the default branch.
4. Run §3 against the branch with the rehearsal URLs. It must pass exactly as on production.
5. **Fixture, only if needed.** The smoke, timing and probe need one business with an active member. If the branch has none (production may have no businesses yet), create a marked throwaway one **on the rehearsal branch only**:
   ```sh
   SCFG_FIXTURE_TARGET=rehearsal psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/sales-configuration-rehearsal-fixture.sql
   ```
   It commits 1 business, 1 owner on an `.invalid` address, 1 pipeline, 3 stages and 200 OPEN opportunities, and is a no-op when run twice. Never run it with a production URL.
6. **Lock drill.** In one psql session as the admin role, hold a write: `BEGIN; UPDATE sales_stages SET name = name WHERE id = (SELECT id FROM sales_stages ORDER BY id LIMIT 1);` and leave it open. In another, run `pnpm exec prisma migrate deploy` against the branch. It must fail within a few seconds (Prisma shows `current transaction is aborted`; that is expected, see §2). Then `ROLLBACK` the held session, and confirm that `config_version` does not exist on the branch. Run `pnpm exec prisma migrate resolve --rolled-back 20261210000000_sales_configuration`. Re-run §3 on the branch: it must pass and report 1 resolved attempt.
   If the branch has no Sales rows at all, skip the `UPDATE` and hold `LOCK TABLE sales_stages IN ROW EXCLUSIVE MODE` instead (same conflict).
7. **Timed apply.** Start the probe in a second terminal, wait until it has run about 5 s (its baseline), then deploy. Record the deploy wall time and the probe's two lines:
   ```sh
   export SCFG_PROBE_APP_URL=<bos_app URL, rehearsal branch, direct>
   export SCFG_PROBE_BUSINESS_ID=<any business with a stage, from the rehearsal branch; not posted anywhere>
   node scripts/sales-configuration-probe.mjs    # terminal 2, runs 30 s
   pnpm exec prisma migrate deploy               # terminal 1, against the rehearsal branch
   ```
   The probe keeps two connections open and samples every 100 ms, so connection set-up is never timed. Its median is the network round trip; **longest minus median** is the stall the migration caused.
   **Repeating a measurement** on a branch where the migration is already applied: `SCFG_RESET_TARGET=rehearsal psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/sales-configuration-rehearsal-reset.sql` drops the migration's objects and ledger rows on the **rehearsal branch only**. Re-run §3 on the branch (PASS, 0 resolved attempts), then repeat this step and step 8. No new Neon branch is needed.
8. **Rehearsal checks** on the branch:
   ```sh
   export SCFG_REHEARSAL_APP_URL=<bos_app URL, rehearsal branch, direct>
   psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/sales-configuration-rehearsal.sql
   ```
   A: objects as designed, forced RLS and grants unchanged. B: as `bos_app`, SA001 (insert, restore in an archived pipeline), SA002, SA003, SA004, U1 and U2 `23505`, closed rows unblocked. C: an archive of 5,000 OPEN opportunities timed on the service's own statement sequence, with audit rows (`SCFG_TIMING_ROWS` to change it). B and C always roll back. It uses the first business with an active member (the fixture if step 5 ran).
9. **Pooler note.** The app reaches Neon through the pooler in transaction mode. The service code was tested behind PgBouncer in transaction mode (29 of 29 integration tests). No extra rehearsal step is needed for the pooler; the migration itself always uses the direct endpoint.
10. Leave the rehearsal branch in place. Deleting any Neon branch needs Regan's approval (protocol, "Neon branches"); list it for his housekeeping.

## 5. Evidence and go / no-go

Post to PR #135, as one comment, with no ids, names, hosts or URLs: the head SHA used; the §3 summary and counts on production; the rehearsal §3 result; the lock drill result; deploy wall time; probe numbers; the rehearsal script's lines. Then ChatGPT reviews it.

**Go** if all hold:

- the production preflight passed and the rehearsal preflight passed;
- the lock drill failed cleanly and resolved;
- the rehearsal deploy succeeded and its checks passed;
- the probe's **longest minus median**, for reads and for stage writes, is each at most **2 s** (proposed threshold).

If either is over 2 s, the migration escalates (protocol: locking not accepted under documented thresholds), and Regan must accept the stall himself, for this migration (§10, message 3). A stall accepted for an earlier migration does not carry over.

## 6. Recovery branch

After the `APPROVED — EXECUTE: MIGRATION` verdict passes the provenance check, and immediately before applying:

1. Create `pre-sales-configuration-migration` from production.
2. Verify: it reaches `ready`; it accepts a connection; its `_prisma_migrations` count (25) and fingerprint equal production's (run the fingerprint query, or the §3 preflight's A2, against it).
3. Record its id, LSN and creation time in `ops/neon/recovery-points.json` (and the Neon housekeeping log), in a docs-only follow-up. Point-in-time restore is not a substitute.

If the branch fails any check: stop and report.

## 7. Apply

1. Re-run §3 on production. It must still pass, with the same `_prisma_migrations` state as in the posted evidence. If anything changed, stop.
2. Target guard: the URL is the production default branch, direct endpoint.
3. From `apps/api`: `pnpm exec prisma migrate deploy`.
4. On failure: see §11. Never retry without re-running §3.

## 8. Verify

As the admin role, read-only:

- `_prisma_migrations`: `20261210000000_sales_configuration` finished with the repository's checksum, nothing pending (`prisma migrate status`).
- Section A of the rehearsal script, in its read-only verify mode (sections B and C write, rolled back, and are for the rehearsal branch only):
  ```sh
  SCFG_VERIFY_ONLY=1 psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/sales-configuration-rehearsal.sql   # VERIFY PASS
  ```
  It checks the column, CHECK, two valid partial indexes, two SECURITY INVOKER functions with a pinned `search_path`, three enabled triggers, forced RLS on the four Sales tables and no `bos_app` DELETE grant. Also run `docs/migration-readiness.md` §5.
- Every `sales_pipelines` row has `config_version = 1`.
- `GET https://app.pixakova.com/api/v1/health` returns `status: ok`. A signed-in pass of Sales (open the board, move an opportunity) works with the old code.
- Record the run in `docs/migration-readiness.md` §9 and post the delegated operation record (protocol) on PR #135.

## 9. Merge

After §8, PR #135 joins the merge queue. The queue syncs it with `main`, regenerates the contract if needed, confirms the patch is unchanged, runs `CI gate` on the final head, and merges only under a fresh `APPROVED — EXECUTE: MERGE` verdict on that head. Then the production smoke checks. The migration verdict does not authorise the merge, and the merge verdict does not authorise the migration.

## 10. What Regan writes in the Mac session thread

Each is a fresh, unedited message from Regan, sent at the time of the step. A relayed message or a card tap does not count.

1. To start (read-only checks and a temporary branch are within standing policy; this makes the request explicit): *"Run the read-only preflight for 20261210000000_sales_configuration from PR #135 at `<head SHA>` on production, then the Neon rehearsal on a temporary branch per docs/sales-configuration-migration.md §4. Post the evidence to the PR. Do not apply anything to production."*
2. After the `APPROVED — EXECUTE: MIGRATION` verdict is posted: *"Approved: create and verify recovery branch pre-sales-configuration-migration, then apply migration 20261210000000_sales_configuration from PR #135 at `<head SHA>` to production and verify it, per docs/sales-configuration-migration.md §6–8. Stop on any deviation."*
3. Only if a probe number was over 2 s: *"I accept a Sales stall of up to `<N>` s for 20261210000000_sales_configuration at today's production size."*

Under the delegation, a verified migration verdict is enough to apply this additive migration. Message 2 is Regan's own go for the Mac session, which acts on production only on his typed word.

## 11. Rollback and forward recovery

| Situation | What happens | Action |
|---|---|---|
| Lock or statement timeout, or any error during apply | The transaction rolls back and nothing is left behind (drilled, §2). `_prisma_migrations` keeps an unfinished row; `migrate deploy` refuses (P3009). | Confirm `config_version` does not exist. `pnpm exec prisma migrate resolve --rolled-back 20261210000000_sales_configuration`. Re-run §3 (it passes with 1 resolved attempt). Report on the PR; retry in a quieter moment under the same verdict only if the evidence is otherwise unchanged. Never edit the migration file. |
| A unique index fails with `23505` | Duplicate active names appeared after the preflight. Rolled back as above. | Resolve as above and stop. Renaming is a data change and escalates to Regan. |
| Applied, before the code merges | Schema is additive; the running code ignores it. | Nothing to do. Merge per §9. |
| Applied, and an object is wrong | | Forward fix in a new, separately approved migration that drops or replaces the triggers, functions or indexes. Dropping `config_version` drops a column and escalates to Regan; the default plan leaves it (harmless to old code). |
| Data damage of any kind (not expected) | | Stop and ask Regan. Restoring from `pre-sales-configuration-migration` needs his approval and loses every later write. Never improvise production repairs. |
