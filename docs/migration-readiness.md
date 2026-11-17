# Migration readiness (STAB-01)

Assessed against `main` at **0a3610b** (Communications C1, PR #39) on 2026-11-15. Companion to
[stabilisation-checkpoint.md](stabilisation-checkpoint.md). Production was **not** written to: no
migration, deployment or configuration change was made. Production state comes from the read-only
readiness report of 06:17–06:21 UTC the same day (summarised in §2), plus anonymous read-only HTTP
checks at the time of this assessment. `main` has not changed since that report.

## 1. Verdict

**GO for controlled migration, with nothing to migrate today.** All 11 migrations on `main` are
already applied to production with matching checksums. The next schema change is GO only when the
deployment sequencing in §6 has been chosen (finding STAB-H1), because today every merge deploys code
to production before anyone can run its migration.

## 2. Inventory, in dependency order

Prisma applies migrations in folder-name order. Each one depends only on migrations above it.

| # | Migration | Creates / changes | Depends on | Destructive steps | Production |
|---|---|---|---|---|---|
| 1 | 20261113140000_identity | users, sessions, accounts, verifications, rate limits | — | none | applied 11-13 |
| 2 | 20261113150000_tenancy | businesses, memberships, invitations, audit; RLS helpers | 1 | replaces one RLS policy on `users` (`DROP POLICY … ; CREATE POLICY`) | applied 11-13 |
| 3 | 20261114050000_customers | customers, contacts, activities | 2 | none | applied 11-14 |
| 4 | 20261114090000_sales | pipelines, stages, opportunities, outcomes | 2, 3 | none | applied 11-14 |
| 5 | 20261114120000_projects | projects, project tasks | 2, 3 | none | applied 11-14 |
| 6 | 20261115000000_finance | settings, number series, tax rates, documents, lines | 2–5 (customers, contacts, opportunities, projects) | none | applied 11-14 |
| 7 | 20261116000000_finance_payments | payments, allocations, credit applications | 6 | none | applied 11-14 |
| 8 | 20261117000000_finance_expenses | expense categories, expenses, expense allocations | 6, 7, 3, 5 | relaxes `finance_payments.customer_id` to NULLable (widening, safe) | applied 11-14 |
| 9 | 20261118000000_people | departments, locations, employees, assignments, history, personal details | 2 | none | applied 11-15 06:16:45 |
| 10 | 20261118050000_scheduling | calendars, events | 2, 3 | none | applied 11-15 06:16:54 |
| 11 | 20261119300000_communications | conversations, messages, participants; **alters `activities`** (4 columns, 2 FKs, 3 CHECKs) | 3 | none (adds only; `visibility` has a constant default) | applied 11-15 06:17:11 |

Notes:

- C1 is the only migration since F3 that changes an existing table. Its new CHECK constraints are
  validated against existing rows; the representative upgrade (§3.2) shows they hold for existing
  rows of synthetic test data.
- Migrations 9–11 carry **future-dated names** (18–19 November). See §4.
- `20261119300000` encodes hour 30, which is not a real time. It is harmless (Prisma only sorts the
  names) and cannot be renamed because production records migrations by name. Recorded as STAB-L7.

## 3. Verification performed

All on disposable local PostgreSQL 16.15 databases (ICU `en-US`, as CI), with the same roles,
grants and privileged SQL as CI and production. PgBouncer 1.22.0 in transaction mode for the pooled
suites, as CI.

### 3.1 Fresh database

`prisma migrate deploy` (11 migrations) → `db:privileged` → integration (now 389 tests including the
new cross-Zone suite), isolation (75), Finance and People suites behind PgBouncer (92 + 22), and
`db:check-migrations` ("No difference detected"). All passed, three times in a row.

### 3.2 Representative pre-migration database

This reproduces production's schema as it stood before 06:16 UTC today (migrations 1–8 only),
populated with synthetic, production-schema-compatible test data, and then upgrades it with the code
on `main`. No production data was copied or used:

1. Checked out c7ce20c (F3, the last commit before People), created `stab_premig`, applied its 8
   migrations and privileged SQL.
2. Populated it with synthetic data by running F3's own integration suite against it (267 tests):
   52 businesses, 75 customers, 188 activities, 417 finance documents, 60 expenses, with every role.
3. On `main`: `prisma migrate status` listed exactly the 3 pending migrations (People, Scheduling,
   C1); `prisma migrate deploy` applied them in 2 s; `migrate status` then reported up to date and
   `prisma migrate diff --from-config-datasource --to-schema prisma/schema` reported no difference.
4. Ran the verification SQL in §5 (results below), then `main`'s full integration suite against the
   upgraded database holding that test data: **389 / 389 passed**.

Results of §5 on the upgraded database: 11 migrations, none rolled back; only `_prisma_migrations`
lacks forced RLS; every table owned by `bos_owner`; every RLS table has at least one policy; every
tenant table has `business_id`; no single-column FK into a tenant table (all composite with
`business_id`); no `bos_*` role with SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB; `bos_app` cannot
CREATE in `public` and holds no TRUNCATE, REFERENCES or TRIGGER grants; only `plpgsql`; the four
SECURITY DEFINER functions are in `app_private` and owned by `bos_definer`; no invalid constraint or
index; all 188 pre-existing activities back-filled to `STANDARD` visibility.

### 3.3 Production (read-only)

From the 06:17–06:21 UTC report (Remote Control session on the Mac, owner role, read-only):
`_prisma_migrations` has 11 rows, none rolled back, checksums match `main`; `prisma migrate status`
from a clean clone: up to date; 41 of 42 tables forced RLS (only `_prisma_migrations` not); role
attributes, ownership, default privileges and `app_private` functions as in §3.2; no
`MIGRATION_DATABASE_URL` in either Vercel project.

At this assessment (cloud sandbox, anonymous HTTPS only): `/api/v1/health` 200 `ok`; `/api/v1/me`,
and a Scheduling route both 401 without a session (deployed and enforcing auth). This sandbox cannot
reach Neon; a fresh production read needs the Mac session (see §6 step 1).

**Drift: none found. Pending migrations: none. Incompatible changes: none.**

### 3.4 Indexes (informational)

Five composite foreign keys have no index that starts with their columns:
`opportunities (business_id, contact_id)`, `finance_documents (business_id, contact_id)`,
`activities (business_id, conversation_id)`, `finance_expenses (business_id, tax_rate_id)`,
`finance_settings (business_id, default_tax_rate_id)`. They matter only when the parent row is
deleted or its key updated; contacts, conversations and tax rates are archived, never deleted, so
there is no current impact. Recorded as STAB-L1 for a future additive migration.

## 4. Migration ordering risk (fixed in CI by this PR)

Because migrations 9–11 are named for 18–19 November, `prisma migrate dev` run before then names a
new migration so that it sorts **before** them. Demonstrated on a disposable database with a probe
migration `20261115070000_probe` that alters `scheduling_events`:

- On the production-like database (all 11 applied) Prisma simply lists it as pending and would
  apply it **last**.
- On a fresh database Prisma applies it **seventh**, before Scheduling exists, and fails (P3018).

A migration that does not depend on the newer tables would pass CI and leave production and every
fresh database (CI, restores, a future region) with different histories for the same files.

Fix (STAB-M1): `.github/scripts/check-migration-order.sh`, run on every pull request in the
"Detect changes" job, fails if:

- any migration folder on the base branch is missing from the pull request (deleted or renamed;
  production records applied migrations by name, so either breaks the history), or
- an added migration's name does not sort strictly after the newest migration on the base branch,
  or is not `<14 digits>_<snake_case>`.

Its self-test (`check-migration-order.test.sh`, 14 cases: 8 for ordering and format, 6 for
deletion and renaming) runs first in the same job.

Rule for authors until the calendar passes 20 November: create with `--create-only` and rename the
folder to sort after `20261119300000_communications`, e.g. `20261120000000_<name>`.

## 5. Post-migration verification SQL

Run as `bos_owner` inside `BEGIN TRANSACTION READ ONLY; … ROLLBACK;`. Expected results in comments.

```sql
select count(*) filter (where rolled_back_at is null and finished_at is not null) ok, count(*) total
  from _prisma_migrations;                                                       -- ok = total = 11 (+ new)
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and (not c.relrowsecurity or not c.relforcerowsecurity);                      -- only _prisma_migrations
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
   and not exists (select 1 from pg_policy p where p.polrelid = c.oid);          -- 0 rows
select rolname from pg_roles where rolname like 'bos_%'
   and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb);               -- 0 rows
select has_schema_privilege('bos_app', 'public', 'CREATE');                      -- f
select extname from pg_extension;                                                -- plpgsql
select conrelid::regclass, conname from pg_constraint
 where not convalidated and connamespace = 'public'::regnamespace;               -- 0 rows
```

Then: `curl https://app.pixakova.com/api/v1/health` (200 `ok`), sign in, and open each Zone once.

## 6. Proposed execution sequence for the next migration

> **Superseded for approvals.** The current procedure and who approves each step are in `docs/agent-task-protocol.md` "Production migrations" and "Approvals", which win over this section. The "Regan's written approval" wording below is historical.

There is no migration to run today. For the next one:

1. **Read-only pre-check** (Mac session, owner URL): `prisma migrate status` from a clean checkout of
   the PR head; expect exactly the new migration(s) pending.
2. **Recovery point**: create Neon branch `pre-<change>-migration` from `production`; note its LSN
   and time. (Inside 6 h, point-in-time restore is a second option.)
3. **Sequencing** (STAB-H1, Regan to choose one, once):
   - **A. Migrate just before merge** (as done for C1): only for additive migrations, only after CI
     and the audit pass, and only with the exact files that will merge. Record it in the PR.
   - **B. Turn off automatic production deploys for `main`** in both Vercel projects, merge, run the
     migration, then promote the deployment. Safer; one manual step per release.
   Recommended: **B**, because A still deploys code before migrations for anything not applied in
   advance, and leaves a window if the merge is delayed.
4. **Apply** under the approval the protocol requires (an `APPROVED — EXECUTE: MIGRATION` verdict, or Regan's approval where it escalates):
   `MIGRATION_DATABASE_URL=<owner direct URL> pnpm --filter @business-os/api exec prisma migrate deploy`.
   Run `db:privileged` only if the migration notes say so (none of 1–11 after tenancy needed it again).
5. **Verify** with §5, the health check and a signed-in pass through each Zone.
6. **Keep** the recovery branch until the next migration has been verified.

## 7. Backup, recovery, rollback and forward-fix

| Situation | Action | Owner |
|---|---|---|
| Migration fails part-way | **Prisma does not roll back a failed migration file.** Verified: a probe migration `CREATE TABLE …; SELECT 1/0;` failed with P3018 and left the table behind, with an unfinished row in `_prisma_migrations` (STAB-M6). So: restore from the recovery branch (cleanest), or remove the partial objects by hand, then `prisma migrate resolve --rolled-back <name>`, fix the SQL in a **new** PR and deploy again. Never edit an applied migration. New migrations should wrap their statements in an explicit `BEGIN; … COMMIT;` unless they use a statement that cannot run in a transaction (for example `CREATE INDEX CONCURRENTLY`). | Developer, Regan approves |
| Migration applied, code faulty, schema fine | **Forward-fix**: revert or fix the code and redeploy. Schema stays. This is the default for additive migrations. | Developer |
| Migration applied, schema wrong, no new data worth keeping | **Rollback**: stop writes, restore `production` from the `pre-<change>-migration` branch in the Neon console (Neon keeps the current state as a backup branch), check `_prisma_migrations`, redeploy the last commit that matches that schema from Vercel's deployment list. | Regan (destructive) |
| Data written after the migration must be kept | Export it before restoring, or prefer a forward-fix migration that corrects the schema. | Regan |
| Need data from more than 6 h ago | Only the named recovery branches exist (Free plan, 6 h history). | Regan |

Writing a down-migration is not part of this project's practice and is not proposed: additive
migrations are fixed forward, and anything that drops or renames needs an expand-then-contract plan
across two releases.

## 8. Risks and owners

| ID | Risk | Disposition | Owner |
|---|---|---|---|
| STAB-H1 | Merges deploy code before migrations run | Open. Next migration blocked until §6 step 3 is chosen. | Regan |
| STAB-H2 | 6 h PITR (Free plan), backup region unverified (ADR 0002), production branch unprotected | Accepted while production holds no business data; must be resolved before a pilot with real data. | Regan |
| STAB-M1 | Future-dated migration names reorder new migrations; a deleted or renamed migration would break history | Fixed: CI check in this PR (order, format, deletion, rename) | Developer |
| STAB-M5 | C1 applied to production ~2 min before its PR merged | Recorded exception (approved at the time; files byte-identical). Option B removes the need. | Regan |
| STAB-M6 | A failed migration leaves a partial schema (no automatic rollback) | Documented procedure (§7); recovery branch before every migration; explicit transactions in new migrations | Developer, Regan |
| STAB-L1 | Five unindexed composite FKs | Deferred; no impact while parents are archived, not deleted | Developer (next additive migration) |
| STAB-L7 | `20261119300000` encodes hour 30 | Accepted; cannot rename applied migration | — |

## 9. Production migration log

Entries before 2026-11-17 record Regan's own approvals under the rules of the time. Later entries link their delegated operation record (protocol, "Delegated operation record").

### F6-3 payment reminders (2026-11-16)

Approved by Regan in the project thread (subject to preflight). Applied from `main` at `52de37f`.

| Step | Result (UTC) |
|---|---|
| Preflight (read-only, `bos_owner` on the production direct endpoint, database `neondb`) | 16 migrations applied, newest `20261126000000_finance_billing`, none failed or rolled back; checksums of all 16 match the files; `20261127000000_finance_reminders` the only pending migration; none of the four reminder tables or `app_private.finance_reminders_due` existed |
| Recovery branch | First attempt failed: Neon Free plan limit of 10 branches. With Regan's approval, `pre-customers-migration` (`br-lingering-violet-bb5t44yw`; not default, no compute, no children, unreferenced) was deleted at 06:24:06. Preflight re-run, unchanged. `pre-f6-3-migration` = `br-shy-wave-bbrssahm`, parent `production` at LSN `0/2869FE0`, created 06:24:28, no compute |
| `prisma migrate deploy` | Applied only `20261127000000_finance_reminders`: started 06:24:50.893, finished 06:24:52.746, 1 step, no rollback |
| `pnpm --filter @business-os/api db:privileged` (Neon owner role, region `us-east-1`) | 06:25:08–06:25:15: re-applied 001 and 002 (idempotent), applied `003_finance_reminders_due.sql` |
| Migration state | 17 applied, 0 failed; `prisma migrate status`: up to date |
| RLS | `finance_reminder_policies`, `finance_reminder_customer_policies`, `finance_reminder_holds`, `finance_reminders`: `relrowsecurity` and `relforcerowsecurity` true, owner `bos_owner`, `tenant_isolation` policy for `bos_app`; `definer_reminders_due_read` (SELECT, `bos_definer`) on policies and reminders |
| Grants | `bos_app`: SELECT, INSERT and column-level UPDATE only; no table-level UPDATE, DELETE or TRUNCATE; no other grantees |
| Triggers and constraints | Four guard triggers present; CHECK constraints 6 / 1 / 6 / 16 (policies / customer policies / holds / reminders); partial unique index `finance_reminder_policies_default_key (business_id) WHERE is_default` |
| Functions | Guard functions and `finance_reminder_stages_valid` not executable by PUBLIC (`stages_valid` executable by `bos_app`, as the migration grants); `app_private.finance_reminders_due(integer)` SECURITY DEFINER, owner `bos_definer`, fixed `search_path`, EXECUTE `bos_app` only; `bos_definer` has no CREATE on `app_private` afterwards; `SELECT count(*) FROM app_private.finance_reminders_due(50)` as `bos_app` returned 0 |
| Health (06:25:58) | `GET /api/v1/health` 200 `ok`; unauthenticated `GET /api/v1/b/x/finance/reminder-policies` 401 `unauthenticated` (not 500). No signed-in smoke test: no production test account exists |

Not done, by instruction: no `CRON_SECRET`, no cron entry, the internal finance-reminders job route
was not called, no email was sent. Keep `pre-f6-3-migration` until the next migration is verified.

### S2 scheduling resources (2026-11-16)

Approved by Regan in the S2 project thread (recovery branch and migration named explicitly). Applied from PR #61's head `1caa429` **before** the merge, so the code never ran without its tables.

| Step | Result (UTC) |
|---|---|
| Neon plan | Upgraded by Regan to Launch, so no recovery branch was deleted |
| Preflight (read-only, `bos_owner`, production direct endpoint) | 17 applied, newest `20261127000000_finance_reminders`, none failed; checksums match; `20261128000000_scheduling_resources` the only pending migration; neither scheduling resource table existed; no new privileged SQL |
| Recovery branch | `pre-s2-migration` = `br-wild-band-bbsipovj`, from production at 07:45:28 (LSN `0/2993118`), no compute |
| `prisma migrate deploy` | Applied only `20261128000000_scheduling_resources`: 07:46:23–07:46:32, 1 step, no rollback. 18 applied, up to date |
| RLS | `scheduling_resources`, `scheduling_event_resources`: `relrowsecurity` and `relforcerowsecurity` true, owner `bos_owner`, `tenant_isolation` policy for `bos_app` |
| Grants | `bos_app`: SELECT, INSERT, UPDATE on resources; SELECT, INSERT and column UPDATE (`removed_at`, `removed_by_id`) on assignments; no DELETE or TRUNCATE outside `bos_owner`; no other grantees |
| Health | `GET /api/v1/health` 200 at 07:46:57 |
| Merge | PR #61 squash-merged as `9dc670d` after CI passed on `1caa429` |

Not done, by instruction: Scheduling navigation not switched on. Keep `pre-s2-migration` until the next migration is verified.

### E1 communications erasure foundation, dormant (2026-11-16)

Approved by Regan in the E1 project thread at 08:53 UTC, naming the recovery branch, the migration, `db:privileged` with `004` and the merge. Applied from PR #64's head `63abd53` **before** the merge. Activation was explicitly excluded; see `docs/communications-e1.md` §13.

| Step | Result (UTC) |
|---|---|
| Preflight (read-only, `bos_owner`, production direct endpoint), 08:51 and again at 08:53 | 19 applied, newest `20261130000000_finance_catalog`, none failed, checksums match; `20261201000000_communications_erasure` the only pending migration; `bos_app`, `bos_jobs`, `bos_definer` and `bos_maint` exist, none BYPASSRLS; none of the six E1 tables existed; no `erased_at` on `messages` |
| Recovery branch | `pre-e1-migration` = `br-damp-band-bbc521r1`, from production at 08:51:15 (LSN `0/2A7E9A0`), no compute |
| `prisma migrate deploy` | Applied only `20261201000000_communications_erasure`: 08:54:11–08:54:13, 1 step, no rollback. 20 applied, up to date |
| `db:privileged` (from `apps/api`, project owner) | 08:54:20–08:54:29: re-applied `001`–`003` (idempotent) and applied `004_communications_erasure.sql` |
| RLS | The six new tables: `relrowsecurity` and `relforcerowsecurity` true, owner `bos_owner`; tenant policies for `bos_maint` (all six), `bos_app` (erasures, items, holds), read-only `bos_definer` (erasures, holds) |
| Grants | `bos_app`: SELECT on erasures, items and holds, INSERT on holds; nothing on keys, erased references or privileged grants; no DELETE or TRUNCATE on any new table; only other grantee `bos_maint`. `bos_app` table grants on `messages`, `message_participants`, `conversations`, `activities` and `mail_retention_settings` identical before and after |
| Columns | `erased_at` on messages, participants, conversations and activities; `retention_category` on messages |
| Functions | 25 `app_private.communications_*`, all SECURITY DEFINER with `search_path = pg_catalog, pg_temp`, none executable by PUBLIC; `erasure_actor` and `erasure_due` owned by `bos_definer`, the rest by `bos_maint`; `bos_app` may execute only the 9 entry points `004` grants plus `erasure_due`; neither owner can create in `app_private` |
| Data | All six new tables empty |
| Merge | Branch updated with main's #67 (Finance PDF fix, no E1 file; Regan approved 08:57), CI green on `984f3e4`, PR #64 squash-merged as `e5d19cd` |
| Health after deploy (09:07) | `GET /api/v1/health` 200; unauthenticated `GET /api/v1/b/x/communications/erasures`, `/legal-holds` and `/retention/eligibility` 401 (not 500); `/api/internal/jobs/communications-retention` 503 (disabled) |

Not done, by instruction: no `CRON_SECRET`, no `COMMUNICATIONS_RETENTION_JOBS_ENABLED`, no cron entry, no mailbox connected, no erasure run, §13 policies unchanged. Keep `pre-e1-migration` until the next migration is verified.

### A2-B membership lifecycle and invitations (2026-11-16)

Approved by Regan in the A2-B project thread at 12:32 UTC (recovery branch, migration, `db:privileged`), and the merge separately at 12:35 UTC. Applied from PR #76's head `38502a4` **before** the merge.

| Step | Result (UTC) |
|---|---|
| Preflight (read-only), 12:20 and again at 12:32 | 22 applied, newest `20261204000000_people_leave_policies`, none failed or rolled back, all checksums match; `20261205000000_membership_lifecycle` the only pending migration (`prisma migrate status`); 0 invitations (so no duplicate open ones), 2 ACTIVE and 0 SUSPENDED memberships; no `suspended_at`/`suspended_by`, `invitations_open_email_key` or `member_emails` yet |
| Recovery branch | `pre-a2b-migration`, from production at 12:32:38, no compute |
| `prisma migrate deploy` | Applied only `20261205000000_membership_lifecycle` (one transaction), finished 12:33:11, 1 step, no rollback. 23 applied, up to date |
| `db:privileged` (from `apps/api`, project owner, region `us-east-1`) | Re-applied `001`–`004` (`001`'s `accept_invitation` now also requires `revoked_at IS NULL` and `expires_at > now()`) and applied `005_member_emails.sql` |
| Schema | `memberships.suspended_at` (timestamptz) and `suspended_by` (uuid), nullable, column UPDATE for `bos_app`; CHECK `memberships_suspension_consistent`; trigger `memberships_stamp_suspension` (BEFORE UPDATE OF status); `memberships_no_self_role_change` now BEFORE UPDATE OR DELETE; `memberships_keep_an_owner` takes `pg_advisory_xact_lock`; index `invitations_open_email_key` |
| Functions and grants | `app_private.member_emails()` SECURITY DEFINER, owner `bos_definer`, `search_path = pg_catalog, pg_temp`, EXECUTE for `bos_app` only (not PUBLIC, `bos_owner`, `bos_auth`, `bos_jobs`); policy `definer_member_emails_read` (SELECT, `bos_definer`); `bos_definer` cannot create in `app_private`; 43 `app_private` functions |
| RLS and data | RLS enabled and forced on `memberships` and `invitations`; still 2 ACTIVE memberships, no suspension fields set |
| Health | `GET /api/v1/health` 200 |

Keep `pre-a2b-migration` until the next migration is verified.

### GS1-A search indexes (2026-11-17)

Approved by Regan in the GS1-A project thread at 07:08 UTC: the recovery branch and the migration, for PR #97 at `db3c092`. Applied **before** the merge. Regan accepted a one-time write stall of about 6 s at today's size; the Neon rehearsal and that decision are recorded in [search-index-migration.md](search-index-migration.md) §3a. The merge was approved separately through a recorded ChatGPT merge verdict. The redacted operator record is the PR #97 comment of 08:38 UTC.

| Step | Result (UTC) |
|---|---|
| Preflight (read-only), 07:09 | 23 applied, migration fingerprint matches the repository, none unfinished or rolled back; `20261206000000_search_indexes` the only pending migration (`prisma migrate status`); no search index or migration row; no long transaction; the 8 indexed tables unchanged from the morning baseline (0–3 rows, 48–240 kB each) |
| Recovery branch | `pre-search-indexes-migration`, from production at 07:09:16, no compute; verified before the apply: `ready`, accepted a connection through a temporary read-only endpoint (since deleted), 23 migrations with the same fingerprint; LSN recorded privately |
| `prisma migrate deploy` | Run as the owner role from the Mac; applied only `20261206000000_search_indexes` (one transaction), 07:11:37–07:11:57, exit 0. 24 applied, all finished |
| Ledger | The new row is finished, not rolled back, and its checksum equals the SHA-256 of the repository `migration.sql` |
| Indexes | All 22 search indexes exist with names matching the migration; `indisvalid` and `indisready` true for each |
| Health and search | `GET /api/v1/health` 200 on app.pixakova.com and the Vercel production URL; POST to `b/[slug]/search` and `b/[slug]/search/resolve` 404 `not_found`; `SEARCH_API_ENABLED = false` |
| Merge | PR #97 synced with main as `0f37d7e` (same patch as `db3c092`), CI gate green, squash-merged as `06405a5` |

Also kept, pending a separate decision: the temporary branches `rehearsal-search-indexes-20261117-prod` and `rehearsal-search-indexes-20261117-seed`, which already have the migration applied. Keep `pre-search-indexes-migration` until the next migration is verified.
