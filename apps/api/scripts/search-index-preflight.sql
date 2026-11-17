-- Read-only production preflight for migration 20261206000000_search_indexes (docs/search-index-migration.md §4.1).
-- Run as the owner (migration) role. Everything runs inside a READ ONLY transaction that is rolled back,
-- so it cannot change anything. It reads the migration history, table sizes, name collisions, and what is
-- holding or waiting on locks right now. Paste the output into the PR (no connection strings, no ids).
BEGIN READ ONLY;

-- 1. Migration history: every applied migration with its checksum, and anything unfinished or rolled back.
SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
FROM _prisma_migrations ORDER BY started_at;

-- 2. The search migration must not be present yet.
SELECT count(*) AS search_migration_rows FROM _prisma_migrations WHERE migration_name = '20261206000000_search_indexes';

-- 3. Size of every table the migration indexes (decides the build time and how long writes wait).
SELECT relname AS table_name, n_live_tup AS live_rows, pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
WHERE relname IN ('customers', 'contacts', 'opportunities', 'projects', 'project_tasks', 'finance_documents', 'finance_catalog_items', 'people_employees')
ORDER BY pg_total_relation_size(relid) DESC;

-- 4. No index name the migration creates may exist already.
SELECT indexname FROM pg_indexes WHERE indexname LIKE '%\_search\_%' ESCAPE '\';

-- 5. Long-running transactions and lock waits right now (anything here delays the build or trips lock_timeout).
SELECT state, wait_event_type, now() - xact_start AS xact_age, left(query, 60) AS query_head
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL
ORDER BY xact_start;

-- 6. Server settings that bound the build.
SELECT name, setting FROM pg_settings WHERE name IN ('maintenance_work_mem', 'max_parallel_maintenance_workers', 'lock_timeout', 'statement_timeout', 'server_version');

ROLLBACK;
