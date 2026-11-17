# Search index migration: rehearsal, preflight, apply and recovery

Migration `20261206000000_search_indexes` (22 read-only lookup indexes for global search, GS1-A). It was split out of PR #93 on 2026-11-17 by Regan's decision, so this migration has its own PR and its own approval.

**Status: NOT APPLIED to production or any Neon branch.** Nothing in this document authorises applying it. Applying it to production needs Regan's explicit approval, given in the thread that carries it out, after §4.1–§4.3 are done and recorded in the PR.

Search stays disabled (`SEARCH_API_ENABLED = false`) whether or not these indexes exist. No code reads them until a separate, approved enablement PR.

## 1. What the migration does

- One explicit transaction (`BEGIN … COMMIT`) with `SET LOCAL lock_timeout = '3s'` and `SET LOCAL statement_timeout = '60s'`.
- 22 plain `CREATE INDEX` statements on 8 tables: `customers` (3 indexes), `contacts` (3), `opportunities` (2), `projects` (2), `project_tasks` (2), `finance_documents` (1), `finance_catalog_items` (3) and `people_employees` (6).
- It is additive only. It has no table, column, policy, grant, extension or function change, and no privileged step. A unit test checks that every statement matches the declaration in its owning module, verbatim.

**Locks add up until COMMIT.** Each build takes a SHARE lock on its table. Inside one transaction, every lock is held until the last build finishes. So writes to `customers`, the first table, wait for the whole migration, not just for its own build. Reads are never blocked.

## 2. Rehearsal tool

`apps/api/scripts/search-index-rehearsal.mjs` rehearses the whole file through the real runner, `prisma migrate deploy`, while writes run against every indexed table at the same time.

| Step | What it does |
|---|---|
| Guard (runs first) | `scripts/lib/rehearsal-guard.mjs` must **prove** the target is disposable before any connection, seed, write or migration. It fails closed on any doubt, missing input or API error (see "Target guard" below). It also refuses a database where the migration or any search index already exists. |
| `--seed` | Seeds the design-point tenant (§11.1 of `global-search-gs1.md`) plus a noisy tenant five times larger. That is about 1.2 M rows in total, all synthetic. It then runs `ANALYZE`. |
| Writers | At least one writer per indexed table, connecting as the **app role** with `app.business_id` set per transaction, as `withTenant` does, so forced RLS applies. They update rows (with the version bump the guard triggers require) and insert customers. |
| Baseline | 10 s of writes before any index exists. |
| `--drill` | A write transaction holds a row lock on `customers`, so the migration hits `lock_timeout` and fails. The tool records what Prisma leaves behind, then runs the documented recovery, `prisma migrate resolve --rolled-back`. |
| Real run | Writers warm up, then `prisma migrate deploy` runs. Lock waits are sampled every 100 ms. The report gives per-table write latency inside the migration window. |
| After | Checks that all 22 indexes exist and are valid, that `_prisma_migrations` shows the migration finished, and runs 10 s of writes with the indexes in place (write overhead). |

The output is a JSON report. It contains no connection strings, and the host is redacted.

**Target guard.** The guard accepts only two kinds of target. It never trusts an operator-typed "disposable" flag or a host typed in again:

- **Local:** every URL is a loopback host or a local socket.
- **Neon branch:** the Neon control plane confirms all of the following, using `NEON_API_KEY` held by the operator on the Mac, with `NEON_PROJECT_ID` and `REHEARSAL_NEON_BRANCH_ID`:
  - the branch is **not** the project's default branch;
  - it is **not** protected;
  - it is named `rehearsal-search-indexes-…`;
  - it is less than 72 hours old;
  - every URL's host (direct or `-pooler`) is one of **that branch's** endpoints;
  - independently, no URL's host is an endpoint of the **default (production) branch**.

The guard also refuses a host that matches any production URL present in the shell. It refuses URLs that disagree on host or database, an app URL that uses the owner or admin role, and a mix of local and remote URLs. Unit tests (`tests/unit/search-index-rehearsal-guard.test.ts`) cover each refusal, including a production-like URL with no production environment set, a wrong branch, the default branch, a protected or old branch, and Neon API failures.

The tool needs three URLs for the same disposable database:

- `REHEARSAL_DATABASE_URL`: the owner/migration role, which runs the migration as production does.
- `REHEARSAL_APP_DATABASE_URL`: the app role, used by the writers.
- `REHEARSAL_ADMIN_DATABASE_URL`: the admin role, used for seeding and for reading `pg_stat_activity`.

## 3. Local rehearsal result (2026-11-17)

This ran on PostgreSQL 16 in the cloud dev container. It is **not** Neon, so absolute times will differ. The run was seeded at design point plus a noisy tenant, with 8 concurrent writers and `--drill`.

| Table | Rows | Size |
|---|---:|---:|
| project_tasks | 600,000 | 214 MB |
| finance_documents | 300,000 | 170 MB |
| contacts | 120,000 | 62 MB |
| customers | 60,000 | 23 MB |
| opportunities | 60,000 | 21 MB |
| projects | 30,000 | 12 MB |
| finance_catalog_items | 12,000 | 6 MB |
| people_employees | 3,000 | 2 MB |

**Real run:** `prisma migrate deploy` succeeded in **7.4 s**. All 22 indexes were valid, the migration was recorded as finished, and no write failed. Up to 8 sessions waited on locks at once, and the longest wait was 5.4 s.

Longest single write during the migration, by table, in migration order:

| Table | Longest write | p99 |
|---|---:|---:|
| customers | 5.43 s | 5.3 ms |
| contacts | 4.87 s | 5.5 ms |
| opportunities | 4.18 s | 5.2 ms |
| projects | 3.91 s | 6.2 ms |
| project_tasks | 3.76 s | 6.2 ms |
| finance_documents | 0.54 s | 5.4 ms |
| finance_catalog_items | 0.15 s | 4.9 ms |
| people_employees | 0.06 s | 5.0 ms |

The pattern confirms the audit concern: a table indexed early waits for every build after it. At this size, a user saving a customer could wait about 5 s once. Nothing timed out or failed.

**Write overhead after the indexes:** p95 rose by 0.1–0.3 ms per write. For example, customers went from 2.3 ms to 2.4 ms and finance_documents from 2.6 ms to 2.7 ms.

**Failure drill:**

- The held write made the migration fail after 4.7 s, which is past the 3 s `lock_timeout`. Prisma reports the follow-on error "current transaction is aborted" rather than the lock timeout itself.
- **No index was left behind**, because the explicit transaction rolled everything back.
- `_prisma_migrations` kept a row with `finished_at` empty, which blocks further `migrate deploy` runs.
- `prisma migrate resolve --rolled-back 20261206000000_search_indexes` marked that row rolled back.
- The next `migrate deploy` then applied the migration cleanly. The report shows both rows: the rolled-back attempt, then the finished one.

**What this means for production:** at the design point this result is a **NO-GO**. A 5.4 s longest write is far over the proposed 2 s threshold (§4.3). The stall grows with data. Production may be much smaller, but that has to be **measured, not assumed**. Production approval needs either of these:

- a rehearsal at production size (§4.2) showing a longest write of at most 2 s;
- a separately approved alternative from §5.

## 4. Production procedure

Every step below runs from the Mac Remote Control session, because the cloud container cannot reach Neon. Steps 4.1 and 4.2 are allowed under the standing infrastructure policy (read-only checks, temporary test branches). Steps 4.4 onward need Regan's explicit approval in the thread that carries them out.

### 4.1 Read-only production preflight

```sh
cd apps/api
node scripts/migration-fingerprint.mjs          # expected fingerprint (files only, no database)
psql "$MIGRATION_DATABASE_URL_WITHOUT_SCHEMA_PARAM" -f scripts/search-index-preflight.sql
pnpm exec prisma migrate status                 # must list exactly one pending migration: this one
```

The SQL runs inside `BEGIN READ ONLY … ROLLBACK`. It selects no SQL text, ids, names, client addresses or raw checksums. **Keep the raw output in the private Mac session.** Post only this pass/fail summary in the PR:

1. `applied_fingerprint` equals the repository fingerprint, with 0 unfinished and 0 rolled back. **Stop** on any mismatch and compare privately.
2. `prisma migrate status` shows `20261206000000_search_indexes` as the **only** pending migration, so `migrate deploy` would apply nothing else. **Stop** otherwise.
3. `search_migration_rows = 0` and `existing_search_indexes = 0`. **Stop** otherwise.
4. Rows and size of the 8 tables. These are counts only.
5. No long-running transaction. Retry later if there is one.
6. `maintenance_work_mem`, the parallel maintenance worker count and the server version.

### 4.2 Neon branch rehearsal

1. Create a temporary Neon branch from production in the production region. Follow the standing Neon policy and the recovery-branch registry. If the branch would exceed the limit, add cost or need a deletion the policy does not cover, stop and ask.
2. Name the branch `rehearsal-search-indexes-<yyyymmdd>`. Run the rehearsal with `--seed --drill`, using the branch's owner, app (`bos_app`) and admin roles, plus `NEON_API_KEY`, `NEON_PROJECT_ID` and `REHEARSAL_NEON_BRANCH_ID` so the guard can verify the branch. The seed must be **at least** the production size from §4.1. The design point is the default; use `--scale` below 1 only to match a smaller measured production size, and say so in the PR.
3. If production is larger than the design point, run again with `--scale` above 1.
4. Attach the JSON report to the PR. Delete the temporary branch per policy and log it.

### 4.3 Go / no-go

These thresholds are proposed; Regan decides.

- **Go** if the rehearsal at production size shows all of the following:
  - the migration succeeded;
  - all 22 indexes are valid;
  - the drill left nothing behind;
  - the **maximum** (not p99) write during the migration is at most 2 s.

  This matches the D-GS1-16 planning threshold, applied to the end-to-end write stall rather than to build time.
- The local design-point run (5.4 s) is **NO-GO at that size**.
- **No-go** otherwise. Use one of the §5 options, which is Regan's choice.

### 4.4 Recovery branch (approval required)

Create `pre-search-indexes-migration` from production immediately before applying, then verify it:

- It reaches `ready`.
- It accepts a connection.
- Its `_prisma_migrations` count equals production's.
- Record its LSN and creation time in the registry.

Standing policy: keep production plus at least 2 recent verified recovery branches. Point-in-time recovery is not a substitute.

### 4.5 Apply (approval required)

1. Choose a quiet period. Production has no real users yet, but confirm there is no active write traffic by re-running §4.1 step 5.
2. Run `pnpm exec prisma migrate deploy` from `apps/api`, with `MIGRATION_DATABASE_URL` pointing at production.
3. Verify:
   - `_prisma_migrations` shows the migration finished, with the repository's checksum.
   - All 22 indexes are valid. The preflight index query should list exactly the 22 names, and `pg_index.indisvalid` should be true.
   - Application smoke test: production responds 200, and both search routes still return `404 not_found`.

### 4.6 Merge order

Merging to `main` deploys production. So this PR merges only **after** step 4.5 has succeeded, through the merge-queue thread, with Regan's merge approval. PR #93 (the disabled code) merges before it. This PR is stacked on #93 and is retargeted to `main` once #93 lands.

## 5. If the rehearsal is not acceptable (options for Regan)

1. **Smaller migrations:** one migration per Zone, or per table. Each holds only its own tables' locks. The largest tables (`project_tasks`, `finance_documents`) go in their own migrations.
2. **`CREATE INDEX CONCURRENTLY`:** writes are not blocked. It cannot run inside a transaction or a Prisma migration, so it needs a separately approved non-transactional step, like the privileged scripts. A failed concurrent build leaves an INVALID index that must be dropped and rebuilt, so the procedure needs its own recovery steps.
3. **Apply while production is small.** This is likely the cheapest option today; §4.1 decides.

## 6. Rollback and forward recovery

| Situation | What happens | Action |
|---|---|---|
| Lock or statement timeout, or any error during apply | The transaction rolls back and no index is created (rehearsed). `_prisma_migrations` keeps an unfinished row, and `migrate deploy` refuses to continue. | Run `pnpm exec prisma migrate resolve --rolled-back 20261206000000_search_indexes` (rehearsed), check §4.1 again, then retry in a quieter moment or choose a §5 option. Do not edit the migration file. |
| Applied, but write overhead or disk use is unacceptable | The indexes exist. Search is disabled, so no code depends on them. | Forward fix: a new, separately approved step that runs `DROP INDEX CONCURRENTLY` per index (non-transactional, like §5 option 2). Never edit or delete an applied migration. |
| Applied, then a later search migration needs different indexes | | A new migration. The index declarations in the providers and their unit test move with it. |
| Data damage of any kind (not expected from an additive, index-only change) | | Stop and ask Regan. Restoring from `pre-search-indexes-migration` is a last resort, needs Regan's approval and loses every write made after the branch point. Never improvise production repairs. |
