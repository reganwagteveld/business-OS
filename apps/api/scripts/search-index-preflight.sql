-- Read-only production preflight for migration 20261206000000_search_indexes (docs/search-index-migration.md §4.1).
-- Run as the owner (migration) role. Everything runs inside a READ ONLY transaction that is rolled back,
-- so it cannot change anything.
--
-- Output hygiene (ChatGPT audit of PR #97, MEDIUM): no query selects SQL text, ids, names of people or
-- businesses, connection details or raw checksums. Migration history is reduced to counts, the latest
-- name and one fingerprint that is compared with `node scripts/migration-fingerprint.mjs` from the repo.
-- Even so, keep the raw output in the private Mac session; post only the pass/fail summary in the PR.
BEGIN READ ONLY;

-- 1. Migration history, summarised: totals, anything unfinished or rolled back, the latest applied name.
SELECT count(*) AS applied,
       count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back,
       max(migration_name) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS latest_applied
FROM _prisma_migrations;

-- 2. One fingerprint over every applied (name, checksum) pair. It must equal the fingerprint the repo script
--    prints for the migrations on main BEFORE the search migration. A mismatch means a checksum or set
--    difference: stop, and compare privately.
SELECT md5(string_agg(migration_name || ':' || checksum, ',' ORDER BY migration_name)) AS applied_fingerprint
FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;

-- 3. The search migration must not be present yet.
SELECT count(*) AS search_migration_rows FROM _prisma_migrations WHERE migration_name = '20261206000000_search_indexes';

-- 4. Size of every table the migration indexes (decides the build time and how long writes wait).
SELECT relname AS table_name, n_live_tup AS live_rows, pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
WHERE relname IN ('customers', 'contacts', 'opportunities', 'projects', 'project_tasks', 'finance_documents', 'finance_catalog_items', 'people_employees')
ORDER BY pg_total_relation_size(relid) DESC;

-- 5. No index name the migration creates may exist already.
SELECT count(*) AS existing_search_indexes FROM pg_indexes WHERE indexname LIKE '%\_search\_%' ESCAPE '\';

-- 6. Open transactions and lock waits right now, as metadata only (no SQL text, no client address).
SELECT backend_type, state, wait_event_type, wait_event, date_trunc('second', now() - xact_start) AS xact_age
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL
ORDER BY xact_start;

-- 7. Server settings that bound the build.
SELECT name, setting FROM pg_settings WHERE name IN ('maintenance_work_mem', 'max_parallel_maintenance_workers', 'lock_timeout', 'statement_timeout', 'server_version');

ROLLBACK;
