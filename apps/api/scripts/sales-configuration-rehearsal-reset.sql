-- Return a REHEARSAL branch to its pre-migration state, so the timed apply (docs/sales-configuration-migration.md
-- §4 step 7) can be repeated without creating another Neon branch. REHEARSAL BRANCH ONLY, never production: it
-- drops the objects of 20261210000000_sales_configuration and deletes that migration's _prisma_migrations rows.
-- Refuses unless SCFG_RESET_TARGET=rehearsal and the role bypasses RLS. The Neon API target guard (the URL is the
-- rehearsal branch, not the default branch) is the real protection.
--
-- Usage (psql 15 or newer, from apps/api, admin URL of the REHEARSAL branch):
--   SCFG_RESET_TARGET=rehearsal psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/sales-configuration-rehearsal-reset.sql
-- Then re-run the §3 preflight on the branch: it must PASS with 0 resolved attempts.
\set ON_ERROR_STOP on
\set QUIET on

\getenv reset_target SCFG_RESET_TARGET
\if :{?reset_target}
\else
  \set reset_target none
\endif
SELECT :'reset_target' = 'rehearsal' AS reset_ok \gset
\if :reset_ok
\else
  DO $$ BEGIN RAISE EXCEPTION 'STOP: set SCFG_RESET_TARGET=rehearsal (rehearsal branch only)'; END $$;
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'STOP: run as the admin role (it must bypass RLS)';
  END IF;
END $$;
DROP TRIGGER IF EXISTS opportunities_stage_guard_update ON opportunities;
DROP TRIGGER IF EXISTS opportunities_stage_guard_insert ON opportunities;
DROP TRIGGER IF EXISTS sales_stages_guard ON sales_stages;
DROP FUNCTION IF EXISTS opportunities_stage_guard();
DROP FUNCTION IF EXISTS sales_stages_guard();
DROP INDEX IF EXISTS sales_stages_active_name_key;
DROP INDEX IF EXISTS sales_pipelines_active_name_key;
ALTER TABLE sales_pipelines DROP CONSTRAINT IF EXISTS sales_pipelines_config_version_positive;
ALTER TABLE sales_pipelines DROP COLUMN IF EXISTS config_version;
DELETE FROM _prisma_migrations WHERE migration_name = '20261210000000_sales_configuration';
DO $$ BEGIN RAISE NOTICE 'RESET done: migration objects and ledger rows removed on this branch'; END $$;
COMMIT;
