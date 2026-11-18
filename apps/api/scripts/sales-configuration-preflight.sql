-- Read-only production preflight for migration 20261210000000_sales_configuration (S-CFG-1A, PR #135).
-- Procedure: docs/sales-configuration-migration.md §3. Spec: docs/sales-pipeline-configuration-scfg.md §8.1.
--
-- Fail closed. Every check that does not pass raises "STOP: ..." and psql exits non-zero (ON_ERROR_STOP).
-- Both transactions are READ ONLY and end in ROLLBACK, so the script cannot change anything.
--
-- Two connections, because the forced RLS policies apply TO bos_app only:
--   A. The ADMIN role (the Neon owner role used for privileged SQL). It must be proven to bypass RLS
--      (rolbypassrls or rolsuper in pg_roles); otherwise every count would be a false zero. It takes the exact
--      control totals, the invalid-state counts, migration history, object absence, sizes and activity.
--   B. bos_app, the role the policies apply to. For every business it sets app.business_id and counts what
--      that tenant can see. The per-business sums must equal A's exact totals, and with no business set
--      bos_app must see nothing.
--
-- Output hygiene: no SQL text, no ids, no names, no hosts, no raw checksums. Only counts, sizes, booleans and
-- pass/fail lines. Business ids pass from A to B through a psql variable (\gset), never printed. Keep the raw
-- output in the private Mac session; post only the pass/fail summary and counts in the PR.
--
-- Usage (psql 15 or newer, from apps/api; URLs come from the environment, never from the command line):
--   export SCFG_EXPECTED_FINGERPRINT=<from: node scripts/migration-fingerprint.mjs --exclude 20261210000000_sales_configuration>
--   export SCFG_PREFLIGHT_APP_URL=<bos_app, DIRECT (non-pooler) endpoint of the target branch>
--   psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/sales-configuration-preflight.sql
\set ON_ERROR_STOP on
\set QUIET on
\pset footer off

\getenv expected_fingerprint SCFG_EXPECTED_FINGERPRINT
\getenv app_url SCFG_PREFLIGHT_APP_URL
\if :{?expected_fingerprint}
\else
  DO $$ BEGIN RAISE EXCEPTION 'STOP: SCFG_EXPECTED_FINGERPRINT is not set'; END $$;
\endif
\if :{?app_url}
\else
  DO $$ BEGIN RAISE EXCEPTION 'STOP: SCFG_PREFLIGHT_APP_URL is not set'; END $$;
\endif

-- ======================================== A. ADMIN connection ========================================
-- One snapshot for every count in A.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT set_config('scfg.expected_fingerprint', :'expected_fingerprint', true) \gset scfg_ignore_

DO $$
DECLARE
  me record;
  n bigint;
  fp text;
  latest text;
  t text;
  sz bigint;
  bad bigint := 0;
  dup_stages bigint; dup_pipelines bigint; open_archived bigint; stage_business bigint; default_name bigint;
BEGIN
  -- A1. The counting role must see every row (forced RLS also binds the table owner).
  SELECT rolname, rolsuper, rolbypassrls INTO me FROM pg_roles WHERE rolname = current_user;
  IF NOT (me.rolsuper OR me.rolbypassrls) THEN
    RAISE EXCEPTION 'STOP: the admin role does not bypass RLS, so its counts would be false zeros';
  END IF;
  RAISE NOTICE 'A1 admin role bypasses RLS: yes (superuser: %, bypassrls: %)', me.rolsuper, me.rolbypassrls;

  -- A2. Migration history: nothing unfinished or rolled back; fingerprint equals the repository's (every
  --     migration except this one); this migration not present. The one exception: a failed attempt of THIS
  --     migration that was resolved with `prisma migrate resolve --rolled-back` (procedure §7) is the clean
  --     retry state, so it is allowed and reported. An unresolved (unfinished, not rolled back) row still stops.
  SELECT count(*) INTO n FROM _prisma_migrations
   WHERE (finished_at IS NULL AND rolled_back_at IS NULL)
      OR (rolled_back_at IS NOT NULL AND migration_name <> '20261210000000_sales_configuration');
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: % unfinished or rolled-back migration row(s)', n; END IF;
  SELECT count(*) INTO n FROM _prisma_migrations
   WHERE migration_name = '20261210000000_sales_configuration' AND rolled_back_at IS NOT NULL AND finished_at IS NULL;
  RAISE NOTICE 'A2 resolved (rolled-back) earlier attempts of this migration: %', n;
  SELECT md5(string_agg(migration_name || ':' || checksum, ',' ORDER BY migration_name)), max(migration_name), count(*)
    INTO fp, latest, n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF fp IS DISTINCT FROM current_setting('scfg.expected_fingerprint') THEN
    RAISE EXCEPTION 'STOP: applied migration fingerprint differs from the repository (compare privately)';
  END IF;
  RAISE NOTICE 'A2 migrations applied: %, latest: %, fingerprint matches: yes', n, latest;
  SELECT count(*) INTO n FROM _prisma_migrations WHERE migration_name = '20261210000000_sales_configuration' AND rolled_back_at IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: 20261210000000_sales_configuration already has % live row(s)', n; END IF;
  IF latest >= '20261210000000' THEN RAISE EXCEPTION 'STOP: production already has a migration that sorts at or after this one'; END IF;

  -- A3. Nothing this migration creates exists yet.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'sales_pipelines' AND column_name = 'config_version';
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: sales_pipelines.config_version already exists'; END IF;
  SELECT count(*) INTO n FROM pg_class WHERE relkind = 'i' AND relname IN ('sales_stages_active_name_key', 'sales_pipelines_active_name_key');
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: % index name(s) already exist', n; END IF;
  IF to_regprocedure('public.sales_stages_guard()') IS NOT NULL OR to_regprocedure('public.opportunities_stage_guard()') IS NOT NULL THEN
    RAISE EXCEPTION 'STOP: a guard function of this migration already exists';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger WHERE NOT tgisinternal
     AND tgrelid IN ('public.sales_stages'::regclass, 'public.sales_pipelines'::regclass, 'public.opportunities'::regclass);
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: % trigger(s) already exist on the Sales tables (none expected)', n; END IF;
  SELECT count(*) INTO n FROM pg_constraint WHERE conname = 'sales_pipelines_config_version_positive';
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: constraint sales_pipelines_config_version_positive already exists'; END IF;
  RAISE NOTICE 'A3 no object of this migration exists: yes';

  -- A4. Exact totals (the control for B), and the lock-size assessment for the three altered tables
  --     (spec §7.3: over 100,000 rows or 100 MB is a stop and a re-plan).
  FOREACH t IN ARRAY ARRAY['businesses', 'sales_pipelines', 'sales_stages', 'opportunities', 'opportunity_outcomes'] LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    sz := pg_total_relation_size(format('public.%I', t)::regclass);
    PERFORM set_config('scfg.total_' || t, n::text, true);
    RAISE NOTICE 'A4 % exact rows: %, total size: %', t, n, pg_size_pretty(sz);
    IF t IN ('sales_pipelines', 'sales_stages', 'opportunities') AND (n > 100000 OR sz > 100 * 1024 * 1024) THEN
      RAISE EXCEPTION 'STOP: % exceeds the §7.3 lock-size threshold (100,000 rows or 100 MB); re-plan', t;
    END IF;
  END LOOP;

  -- A5. Invalid states (spec §8.1 step 7). Every one must be 0; a non-zero count is a data issue whose fix is a
  --     data change that escalates to Regan. The migration never attempts it.
  SELECT count(*) INTO dup_stages FROM (SELECT 1 FROM sales_stages WHERE archived_at IS NULL
    GROUP BY business_id, pipeline_id, lower(btrim(name)) HAVING count(*) > 1) d;
  SELECT count(*) INTO dup_pipelines FROM (SELECT 1 FROM sales_pipelines WHERE archived_at IS NULL
    GROUP BY business_id, lower(btrim(name)) HAVING count(*) > 1) d;
  SELECT count(*) INTO open_archived FROM opportunities o
    JOIN sales_stages s ON s.business_id = o.business_id AND s.id = o.stage_id
    JOIN sales_pipelines p ON p.business_id = o.business_id AND p.id = o.pipeline_id
   WHERE o.status = 'OPEN' AND o.archived_at IS NULL AND (s.archived_at IS NOT NULL OR p.archived_at IS NOT NULL);
  SELECT count(*) INTO stage_business FROM sales_stages s JOIN sales_pipelines p ON p.id = s.pipeline_id
   WHERE p.business_id <> s.business_id;
  SELECT count(*) INTO default_name FROM sales_pipelines p
   WHERE p.archived_at IS NULL AND lower(btrim(p.name)) = 'sales pipeline'
     AND NOT EXISTS (SELECT 1 FROM sales_pipelines d WHERE d.business_id = p.business_id AND d.default_slot = 'default');
  RAISE NOTICE 'A5 must be 0: duplicate active stage names %, duplicate active pipeline names %, open opportunities in archived stage or pipeline %, stage/pipeline business mismatch %, default-name clash without default %',
    dup_stages, dup_pipelines, open_archived, stage_business, default_name;
  bad := dup_stages + dup_pipelines + open_archived + stage_business + default_name;

  -- A6. Reported, not a stop.
  SELECT count(*) INTO n FROM sales_pipelines p WHERE NOT EXISTS
    (SELECT 1 FROM sales_stages s WHERE s.business_id = p.business_id AND s.pipeline_id = p.id AND s.archived_at IS NULL);
  RAISE NOTICE 'A6 (report only) pipelines with no active stage: %', n;
  SELECT count(*) INTO n FROM opportunities o JOIN sales_stages s ON s.business_id = o.business_id AND s.id = o.stage_id
   WHERE s.archived_at IS NOT NULL AND (o.status <> 'OPEN' OR o.archived_at IS NOT NULL);
  RAISE NOTICE 'A6 (report only) won, lost or archived opportunities in archived stages: %', n;
  SELECT coalesce(max(c), 0) INTO n FROM (SELECT count(*) AS c FROM opportunities WHERE status = 'OPEN' AND archived_at IS NULL
    GROUP BY business_id, stage_id) x;
  RAISE NOTICE 'A6 (report only) largest number of open opportunities in one stage (bulk-move size): %', n;

  -- A7. No long-running transaction (spec §8.1 step 9), plus the server version.
  SELECT count(*), coalesce(max(date_trunc('second', now() - xact_start))::text, 'none') INTO n, t FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL;
  RAISE NOTICE 'A7 other open transactions: %, oldest: %', n, t;
  SELECT count(*) INTO n FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start < now() - interval '60 seconds';
  SELECT setting INTO t FROM pg_settings WHERE name = 'server_version';
  RAISE NOTICE 'A7 server version: %', t;
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: % transaction(s) open for more than 60 s; retry later', n; END IF;

  IF bad <> 0 THEN
    RAISE EXCEPTION 'STOP: % invalid-state row group(s); the migration would fail or leave a broken state. Do not apply; report privately', bad;
  END IF;
END $$;

-- Carry the control totals and the business list to B without printing them.
SELECT current_setting('scfg.total_businesses') AS t_businesses, current_setting('scfg.total_sales_pipelines') AS t_pipelines,
       current_setting('scfg.total_sales_stages') AS t_stages, current_setting('scfg.total_opportunities') AS t_opps,
       current_setting('scfg.total_opportunity_outcomes') AS t_outcomes,
       (SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '') FROM businesses) AS business_ids
\gset
ROLLBACK;

-- ======================================== B. bos_app connection =======================================
\connect :app_url
BEGIN TRANSACTION READ ONLY;
SELECT set_config('scfg.business_ids', :'business_ids', true), set_config('scfg.t_businesses', :'t_businesses', true),
       set_config('scfg.t_pipelines', :'t_pipelines', true), set_config('scfg.t_stages', :'t_stages', true),
       set_config('scfg.t_opps', :'t_opps', true), set_config('scfg.t_outcomes', :'t_outcomes', true)
\gset scfg_ignore_

DO $$
DECLARE
  me record;
  ids uuid[] := CASE WHEN current_setting('scfg.business_ids') = '' THEN ARRAY[]::uuid[]
                     ELSE string_to_array(current_setting('scfg.business_ids'), ',')::uuid[] END;
  b uuid;
  n bigint;
  seen_b bigint := 0; seen_p bigint := 0; seen_s bigint := 0; seen_o bigint := 0; seen_x bigint := 0;
  with_rows bigint := 0; v bigint;
BEGIN
  -- B1. This connection is the policy role, without any bypass, at READ COMMITTED by default (spec §5.1).
  SELECT rolname, rolsuper, rolbypassrls INTO me FROM pg_roles WHERE rolname = current_user;
  IF me.rolname <> 'bos_app' OR me.rolsuper OR me.rolbypassrls THEN
    RAISE EXCEPTION 'STOP: connection B must be bos_app without superuser or BYPASSRLS';
  END IF;
  IF current_setting('default_transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'STOP: bos_app default isolation is not READ COMMITTED';
  END IF;

  -- B2. Negative control: with no business set, bos_app sees nothing.
  PERFORM set_config('app.business_id', '', true);
  SELECT (SELECT count(*) FROM businesses) + (SELECT count(*) FROM sales_pipelines) + (SELECT count(*) FROM sales_stages)
       + (SELECT count(*) FROM opportunities) + (SELECT count(*) FROM opportunity_outcomes) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: bos_app sees % row(s) with no business set; RLS is not in force', n; END IF;
  RAISE NOTICE 'B2 negative control (no business set sees 0 rows): yes%',
    CASE WHEN current_setting('scfg.t_pipelines')::bigint = 0 THEN ' (could not discriminate: no Sales rows exist)' ELSE '' END;

  -- B3. Per business, as that tenant.
  FOREACH b IN ARRAY ids LOOP
    PERFORM set_config('app.business_id', b::text, true);
    EXECUTE 'SELECT count(*) FROM businesses' INTO n;
    IF n <> 1 THEN RAISE EXCEPTION 'STOP: a business does not see exactly its own businesses row (sees %)', n; END IF;
    seen_b := seen_b + n;
    EXECUTE 'SELECT count(*) FROM sales_pipelines' INTO n; seen_p := seen_p + n; v := n;
    EXECUTE 'SELECT count(*) FROM sales_stages' INTO n; seen_s := seen_s + n; v := v + n;
    EXECUTE 'SELECT count(*) FROM opportunities' INTO n; seen_o := seen_o + n; v := v + n;
    EXECUTE 'SELECT count(*) FROM opportunity_outcomes' INTO n; seen_x := seen_x + n; v := v + n;
    IF v > 0 THEN with_rows := with_rows + 1; END IF;
  END LOOP;

  RAISE NOTICE 'B3 businesses checked: %, with Sales rows: %', cardinality(ids), with_rows;
  RAISE NOTICE 'B3 per-business sums vs exact totals: businesses %/%, pipelines %/%, stages %/%, opportunities %/%, outcomes %/%',
    seen_b, current_setting('scfg.t_businesses'), seen_p, current_setting('scfg.t_pipelines'), seen_s, current_setting('scfg.t_stages'),
    seen_o, current_setting('scfg.t_opps'), seen_x, current_setting('scfg.t_outcomes');

  -- B4. The sums must equal the admin's exact totals. A difference means rows outside every listed business,
  --     a hidden row, or a write between A and B: stop and re-run in a quiet moment.
  IF seen_b <> current_setting('scfg.t_businesses')::bigint OR seen_p <> current_setting('scfg.t_pipelines')::bigint
     OR seen_s <> current_setting('scfg.t_stages')::bigint OR seen_o <> current_setting('scfg.t_opps')::bigint
     OR seen_x <> current_setting('scfg.t_outcomes')::bigint THEN
    RAISE EXCEPTION 'STOP: per-business sums differ from the exact totals';
  END IF;
  IF cardinality(ids) = 0 OR with_rows = 0 THEN
    RAISE NOTICE 'B5 empty case: % businesses with Sales rows; totals by exact count under the BYPASSRLS admin role', with_rows;
  END IF;
  RAISE NOTICE 'PREFLIGHT PASS';
END $$;
ROLLBACK;
