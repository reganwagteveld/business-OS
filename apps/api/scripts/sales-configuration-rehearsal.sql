-- Rehearsal checks for migration 20261210000000_sales_configuration (S-CFG-1A, PR #135), run on a DISPOSABLE
-- Neon branch AFTER `prisma migrate deploy` there. Never run it against production: part C writes rows (inside
-- transactions that always roll back, but it still takes row locks on live tables). Procedure:
-- docs/sales-configuration-migration.md §4. Spec: docs/sales-pipeline-configuration-scfg.md §8.2.
--
--   A. ADMIN: the migration's objects exist as designed (column, CHECK, indexes valid, SECURITY INVOKER guard
--      functions with a pinned search_path, three enabled triggers), forced RLS and bos_app grants unchanged.
--   B. bos_app, one business, ONE transaction that ends in ROLLBACK: G1/G2/U1/U2 smoke (SA001..SA004, 23505).
--   C. bos_app, same business, ONE transaction that ends in ROLLBACK: a populated-stage archive timed on the
--      service's own statement sequence (§5.3 steps 4-9), with SCFG_TIMING_ROWS open opportunities (default 5000).
--
-- Fail closed: anything unexpected raises "STOP: ..." and psql exits non-zero. Output: counts, timings,
-- booleans and pass lines only; no ids, names or hosts.
--
-- Production verification after apply (procedure §8): SCFG_VERIFY_ONLY=1 runs section A only (read-only) and
-- needs no bos_app URL:  SCFG_VERIFY_ONLY=1 psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f <this file>
--
-- Usage (psql 15 or newer, from apps/api; URLs from the environment, both pointing at the REHEARSAL branch):
--   export SCFG_REHEARSAL_APP_URL=<bos_app, DIRECT endpoint of the rehearsal branch>
--   export SCFG_TIMING_ROWS=5000          # optional
--   psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/sales-configuration-rehearsal.sql
\set ON_ERROR_STOP on
\set QUIET on
\pset footer off

\getenv app_url SCFG_REHEARSAL_APP_URL
\getenv timing_rows SCFG_TIMING_ROWS
\getenv verify_only SCFG_VERIFY_ONLY
\if :{?verify_only}
\elif :{?app_url}
\else
  DO $$ BEGIN RAISE EXCEPTION 'STOP: SCFG_REHEARSAL_APP_URL is not set'; END $$;
\endif
\if :{?timing_rows}
\else
  \set timing_rows 5000
\endif

-- ======================================== A. ADMIN: objects ==========================================
BEGIN TRANSACTION READ ONLY;
DO $$
DECLARE
  n bigint;
  r record;
BEGIN
  SELECT count(*) INTO n FROM _prisma_migrations
   WHERE migration_name = '20261210000000_sales_configuration' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'STOP: the migration is not recorded as finished on this branch'; END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'sales_pipelines' AND column_name = 'config_version'
     AND is_nullable = 'NO' AND column_default = '1';
  IF n <> 1 THEN RAISE EXCEPTION 'STOP: sales_pipelines.config_version missing or not NOT NULL DEFAULT 1'; END IF;
  SELECT count(*) INTO n FROM pg_constraint WHERE conname = 'sales_pipelines_config_version_positive' AND convalidated;
  IF n <> 1 THEN RAISE EXCEPTION 'STOP: CHECK sales_pipelines_config_version_positive missing'; END IF;
  SELECT count(*) INTO n FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('sales_stages_active_name_key', 'sales_pipelines_active_name_key') AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL;
  IF n <> 2 THEN RAISE EXCEPTION 'STOP: % of 2 partial unique indexes valid', n; END IF;
  FOR r IN SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p
            WHERE p.proname IN ('sales_stages_guard', 'opportunities_stage_guard') AND p.pronamespace = 'public'::regnamespace LOOP
    IF r.prosecdef THEN RAISE EXCEPTION 'STOP: % is SECURITY DEFINER', r.proname; END IF;
    IF NOT coalesce(r.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog, public'] THEN
      RAISE EXCEPTION 'STOP: % has no pinned search_path', r.proname;
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgname IN
    ('sales_stages_guard', 'opportunities_stage_guard_insert', 'opportunities_stage_guard_update');
  IF n <> 3 THEN RAISE EXCEPTION 'STOP: % of 3 guard triggers enabled', n; END IF;
  SELECT count(*) INTO n FROM pg_class WHERE oid IN ('public.sales_pipelines'::regclass, 'public.sales_stages'::regclass,
    'public.opportunities'::regclass, 'public.opportunity_outcomes'::regclass) AND relrowsecurity AND relforcerowsecurity;
  IF n <> 4 THEN RAISE EXCEPTION 'STOP: forced RLS not on all four Sales tables'; END IF;
  SELECT count(*) INTO n FROM information_schema.role_table_grants
   WHERE grantee = 'bos_app' AND table_name IN ('sales_pipelines', 'sales_stages', 'opportunities') AND privilege_type = 'DELETE';
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: bos_app has DELETE on a Sales table'; END IF;
  RAISE NOTICE 'A objects as designed: column, CHECK, 2 valid partial unique indexes, 2 SECURITY INVOKER functions, 3 enabled triggers, forced RLS, no DELETE grant';
END $$;
-- One business that has an active member (its audit rows need a real actor), passed to B and C unprinted.
SELECT m.business_id AS business_id, m.user_id AS user_id FROM memberships m WHERE m.status = 'ACTIVE' ORDER BY m.business_id LIMIT 1
\gset scfg_
ROLLBACK;
-- SCFG_VERIFY_ONLY=1: production post-apply verification (procedure §8). Section A only, read-only; stop here.
\if :{?verify_only}
  \echo 'VERIFY PASS (section A only, read-only)'
  \q
\endif
\if :{?scfg_business_id}
\else
  DO $$ BEGIN RAISE EXCEPTION 'STOP: no business with an active member on this branch; stop and report (procedure §4 step 5)'; END $$;
\endif

-- ======================================== B. bos_app: guard smoke =====================================
\connect :app_url
BEGIN;
SELECT set_config('app.business_id', :'scfg_business_id', true), set_config('app.user_id', :'scfg_user_id', true) \gset scfg_ignore_
DO $$
DECLARE
  biz uuid := current_setting('app.business_id')::uuid;
  p uuid := gen_random_uuid();
  dflt uuid;
  r1 uuid := gen_random_uuid(); r2 uuid := gen_random_uuid(); r3 uuid := gen_random_uuid();
  o1 uuid := gen_random_uuid(); o2 uuid := gen_random_uuid();
  pname text := 'S-CFG rehearsal ' || substr(md5(random()::text), 1, 8);
  state text;
BEGIN
  IF (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN RAISE EXCEPTION 'STOP: B must run as bos_app'; END IF;
  INSERT INTO sales_pipelines (id, business_id, name, position) VALUES (p, biz, pname, 999999);
  IF (SELECT config_version FROM sales_pipelines WHERE id = p) <> 1 THEN RAISE EXCEPTION 'STOP: config_version does not start at 1'; END IF;
  INSERT INTO sales_stages (id, business_id, pipeline_id, name, position) VALUES
    (r1, biz, p, 'R1', 1000), (r2, biz, p, 'R2', 2000), (r3, biz, p, 'R3', 3000);
  INSERT INTO opportunities (id, business_id, title, pipeline_id, stage_id, currency_code) VALUES (o1, biz, 'Smoke', p, r1, 'AUD');

  -- SA002: archive a stage holding an OPEN opportunity.
  BEGIN UPDATE sales_stages SET archived_at = now() WHERE id = r1; state := 'none';
  EXCEPTION WHEN OTHERS THEN state := SQLSTATE; END;
  IF state <> 'SA002' THEN RAISE EXCEPTION 'STOP: archive with open work gave %, expected SA002', state; END IF;
  -- An empty stage archives; an OPEN insert into it is SA001.
  UPDATE sales_stages SET archived_at = now() WHERE id = r3;
  BEGIN INSERT INTO opportunities (id, business_id, title, pipeline_id, stage_id, currency_code) VALUES (gen_random_uuid(), biz, 'X', p, r3, 'AUD'); state := 'none';
  EXCEPTION WHEN OTHERS THEN state := SQLSTATE; END;
  IF state <> 'SA001' THEN RAISE EXCEPTION 'STOP: OPEN insert into archived stage gave %, expected SA001', state; END IF;
  -- SA004: a stage never changes pipeline.
  SELECT id INTO dflt FROM sales_pipelines WHERE default_slot = 'default';
  IF dflt IS NOT NULL THEN
    BEGIN UPDATE sales_stages SET pipeline_id = dflt WHERE id = r2; state := 'none';
    EXCEPTION WHEN OTHERS THEN state := SQLSTATE; END;
    IF state NOT IN ('SA004', '23503') THEN RAISE EXCEPTION 'STOP: pipeline change gave %, expected SA004', state; END IF;
  END IF;
  -- U1: active stage names unique, case- and whitespace-insensitive.
  BEGIN INSERT INTO sales_stages (id, business_id, pipeline_id, name, position) VALUES (gen_random_uuid(), biz, p, ' r2 ', 4000); state := 'none';
  EXCEPTION WHEN OTHERS THEN state := SQLSTATE; END;
  IF state <> '23505' THEN RAISE EXCEPTION 'STOP: duplicate stage name gave %, expected 23505', state; END IF;
  -- U2: active pipeline names unique per business.
  BEGIN INSERT INTO sales_pipelines (id, business_id, name, position) VALUES (gen_random_uuid(), biz, upper(pname), 999998); state := 'none';
  EXCEPTION WHEN OTHERS THEN state := SQLSTATE; END;
  IF state <> '23505' THEN RAISE EXCEPTION 'STOP: duplicate pipeline name gave %, expected 23505', state; END IF;
  -- SA003: the last active stage. Close the opportunity in R1, archive R2, then R1 is the last.
  UPDATE opportunities SET status = 'LOST', closed_at = now() WHERE id = o1;
  UPDATE sales_stages SET archived_at = now() WHERE id = r2;
  BEGIN UPDATE sales_stages SET archived_at = now() WHERE id = r1; state := 'none';
  EXCEPTION WHEN OTHERS THEN state := SQLSTATE; END;
  IF state <> 'SA003' THEN RAISE EXCEPTION 'STOP: archiving the last active stage gave %, expected SA003', state; END IF;
  -- Closed history is never blocked: the LOST row in an archived stage may change other columns.
  UPDATE sales_stages SET archived_at = NULL WHERE id = r2;
  UPDATE opportunities SET stage_id = r2 WHERE id = o1;   -- a LOST row moves freely
  UPDATE sales_stages SET archived_at = now() WHERE id = r2;
  UPDATE opportunities SET title = 'Still lost' WHERE id = o1;
  -- SA001 on restore in an archived pipeline: an archived OPEN opportunity, then the pipeline is archived.
  INSERT INTO opportunities (id, business_id, title, pipeline_id, stage_id, currency_code) VALUES (o2, biz, 'Parked', p, r1, 'AUD');
  UPDATE opportunities SET archived_at = now() WHERE id = o2;
  UPDATE sales_pipelines SET archived_at = now() WHERE id = p;
  BEGIN UPDATE opportunities SET archived_at = NULL WHERE id = o2; state := 'none';
  EXCEPTION WHEN OTHERS THEN state := SQLSTATE; END;
  IF state <> 'SA001' THEN RAISE EXCEPTION 'STOP: restore in an archived pipeline gave %, expected SA001', state; END IF;
  RAISE NOTICE 'B guard smoke as bos_app: SA001 (insert, restore in archived pipeline), SA002, SA003, SA004, U1 and U2 23505, closed rows unblocked: pass';
END $$;
ROLLBACK;

-- ======================================== C. bos_app: populated-stage archive timing ==================
BEGIN;
SELECT set_config('app.business_id', :'scfg_business_id', true), set_config('app.user_id', :'scfg_user_id', true),
       set_config('scfg.rows', :'timing_rows', true) \gset scfg_ignore_
DO $$
DECLARE
  biz uuid := current_setting('app.business_id')::uuid;
  actor uuid := current_setting('app.user_id')::uuid;
  rows int := current_setting('scfg.rows')::int;
  p uuid := gen_random_uuid(); s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
  ids uuid[];
  moved int;
  t0 timestamptz; t1 timestamptz; t2 timestamptz; t3 timestamptz; t4 timestamptz;
BEGIN
  INSERT INTO sales_pipelines (id, business_id, name, position) VALUES (p, biz, 'S-CFG timing ' || substr(md5(random()::text), 1, 8), 999997);
  INSERT INTO sales_stages (id, business_id, pipeline_id, name, position) VALUES (s1, biz, p, 'Full', 1000), (s2, biz, p, 'Target', 2000);
  INSERT INTO opportunities (id, business_id, title, pipeline_id, stage_id, currency_code)
    SELECT gen_random_uuid(), biz, 'Load', p, s1, 'AUD' FROM generate_series(1, rows);
  -- The service's settings and statement sequence (§5.3), timed.
  PERFORM set_config('lock_timeout', '5s', true), set_config('statement_timeout', '30000ms', true);
  t0 := clock_timestamp();
  PERFORM pg_advisory_xact_lock(hashtextextended('sales.pipeline_config:' || p::text, 0));
  PERFORM 1 FROM sales_stages WHERE pipeline_id = p AND id IN (s1, s2) ORDER BY id FOR UPDATE;
  SELECT array_agg(id ORDER BY id) INTO ids FROM (SELECT id FROM opportunities
    WHERE stage_id = s1 AND pipeline_id = p AND status = 'OPEN' AND archived_at IS NULL ORDER BY id FOR NO KEY UPDATE) l;
  t1 := clock_timestamp();
  UPDATE opportunities SET stage_id = s2, version = version + 1, updated_by_id = actor, updated_at = now()
   WHERE id = ANY(ids) AND stage_id = s1 AND status = 'OPEN' AND archived_at IS NULL;
  GET DIAGNOSTICS moved = ROW_COUNT;
  t2 := clock_timestamp();
  UPDATE sales_stages SET archived_at = now() WHERE id = s1;
  UPDATE sales_pipelines SET config_version = config_version + 1, updated_at = now(), updated_by_id = actor WHERE id = p;
  t3 := clock_timestamp();
  INSERT INTO audit_events (id, business_id, actor_user_id, action, target_type, target_id, metadata)
    SELECT gen_random_uuid(), biz, actor, 'sales.opportunity.stage_changed', 'opportunity', x,
           jsonb_build_object('fromStageId', s1, 'toStageId', s2, 'cause', 'stage_archived')
      FROM unnest(ids) x;
  t4 := clock_timestamp();
  IF moved <> rows THEN RAISE EXCEPTION 'STOP: moved % of % rows', moved, rows; END IF;
  RAISE NOTICE 'C archive timing for % open opportunities: lock+select % ms, move % ms, archive+bump % ms, audit % ms, total % ms (deadline 25000 ms)',
    rows, round(extract(epoch FROM t1 - t0) * 1000), round(extract(epoch FROM t2 - t1) * 1000), round(extract(epoch FROM t3 - t2) * 1000),
    round(extract(epoch FROM t4 - t3) * 1000), round(extract(epoch FROM t4 - t0) * 1000);
  IF t4 - t0 > interval '20 seconds' THEN RAISE EXCEPTION 'STOP: archive of % rows took over 20 s; the batched-move fallback (§11) is needed', rows; END IF;
END $$;
ROLLBACK;
\echo 'REHEARSAL CHECKS PASS (all writes rolled back)'
