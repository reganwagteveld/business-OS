-- Read-only production preflight for migration 20261207000000_workflow_links (WF-1B-1, PR #110).
-- Procedure: docs/workflow-links-migration.md §4.1. Spec: docs/cross-zone-workflows-wf1.md §10.2 (gate G-3).
--
-- Fail closed. Every check that does not pass raises "STOP: ..." and psql exits non-zero (ON_ERROR_STOP).
-- Both transactions are READ ONLY and end in ROLLBACK, so the script cannot change anything.
--
-- Two connections, because forced RLS policies here apply TO bos_app only:
--   A. The ADMIN role (the Neon owner role used for privileged SQL). It must be proven to bypass RLS
--      (rolbypassrls or rolsuper in pg_roles); otherwise every count would be a false zero. It takes the exact
--      control totals, the global I1 counts, migration history, object absence, sizes and activity.
--   B. bos_app, the role the policies apply to. For every business it sets app.business_id and counts what
--      that tenant can see. The per-business sums must equal A's exact totals, and with no business set
--      bos_app must see nothing. This proves the RLS path, the count and the business list agree.
--
-- Output hygiene: no SQL text, no ids, no names, no hosts, no raw checksums. Only counts, sizes, booleans
-- and one fingerprint. Business ids pass from A to B through a psql variable (\gset), never printed.
-- Keep the raw output in the private Mac session; post only the pass/fail summary in the PR.
--
-- Usage (psql 15 or newer, from apps/api; URLs come from the environment, never from the command line):
--   export WF_EXPECTED_FINGERPRINT=<from: node scripts/migration-fingerprint.mjs --exclude 20261207000000_workflow_links>
--   export WF_PREFLIGHT_APP_URL=<bos_app, DIRECT (non-pooler) production endpoint>
--   psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/workflow-links-preflight.sql
\set ON_ERROR_STOP on
\set QUIET on
\pset footer off

\getenv expected_fingerprint WF_EXPECTED_FINGERPRINT
\getenv app_url WF_PREFLIGHT_APP_URL
\if :{?expected_fingerprint}
\else
  DO $$ BEGIN RAISE EXCEPTION 'STOP: WF_EXPECTED_FINGERPRINT is not set'; END $$;
\endif
\if :{?app_url}
\else
  DO $$ BEGIN RAISE EXCEPTION 'STOP: WF_PREFLIGHT_APP_URL is not set'; END $$;
\endif

-- ======================================== A. ADMIN connection ========================================
-- One snapshot for every count in A.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT set_config('wf.expected_fingerprint', :'expected_fingerprint', true) \gset wf_ignore_

DO $$
DECLARE
  me record;
  n bigint;
  fp text;
  latest text;
  i1_docs bigint; i1_exp bigint; i1_tpl bigint;
  t text;
BEGIN
  -- A1. The counting role must see every row (forced RLS also binds the table owner).
  SELECT rolname, rolsuper, rolbypassrls INTO me FROM pg_roles WHERE rolname = current_user;
  IF NOT (me.rolsuper OR me.rolbypassrls) THEN
    RAISE EXCEPTION 'STOP: the admin role does not bypass RLS, so its counts would be false zeros';
  END IF;
  RAISE NOTICE 'A1 admin role bypasses RLS: yes (superuser: %, bypassrls: %)', me.rolsuper, me.rolbypassrls;

  -- A2. Migration history: nothing unfinished or rolled back; fingerprint equals the repository's (every
  --     migration except this one); this migration not present.
  SELECT count(*) INTO n FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: % unfinished or rolled-back migration row(s)', n; END IF;
  SELECT md5(string_agg(migration_name || ':' || checksum, ',' ORDER BY migration_name)), max(migration_name), count(*)
    INTO fp, latest, n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF fp IS DISTINCT FROM current_setting('wf.expected_fingerprint') THEN
    RAISE EXCEPTION 'STOP: applied migration fingerprint differs from the repository (compare privately)';
  END IF;
  RAISE NOTICE 'A2 migrations applied: %, latest: %, fingerprint matches: yes', n, latest;
  SELECT count(*) INTO n FROM _prisma_migrations WHERE migration_name = '20261207000000_workflow_links';
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: 20261207000000_workflow_links already has % row(s)', n; END IF;

  -- A3. Nothing this migration creates exists yet.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'projects'
     AND column_name IN ('source_opportunity_id', 'source_quote_id', 'source_quote_kind');
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: % new projects column(s) already exist', n; END IF;
  IF to_regclass('public.workflow_requests') IS NOT NULL THEN RAISE EXCEPTION 'STOP: workflow_requests already exists'; END IF;
  IF to_regprocedure('public.projects_guard_links()') IS NOT NULL THEN RAISE EXCEPTION 'STOP: projects_guard_links() already exists'; END IF;
  SELECT count(*) INTO n FROM pg_constraint WHERE conname IN (
    'projects_source_opportunity_fkey', 'projects_source_quote_fkey', 'projects_source_quote_kind', 'projects_source_quote_customer',
    'finance_documents_project_customer_fkey', 'finance_expenses_project_customer_fkey', 'finance_recurring_templates_project_customer_fkey');
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: % constraint name(s) already exist', n; END IF;
  SELECT count(*) INTO n FROM pg_class WHERE relkind = 'i' AND relname IN (
    'finance_documents_kind_customer_key', 'projects_customer_key', 'projects_source_quote_key', 'projects_business_id_source_opportunity_id_idx');
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: % index name(s) already exist', n; END IF;
  RAISE NOTICE 'A3 no object of this migration exists: yes';

  -- A4. Exact totals (the control for B) and on-disk size of every table the migration locks.
  FOREACH t IN ARRAY ARRAY['businesses', 'projects', 'opportunities', 'finance_documents', 'finance_expenses', 'finance_recurring_templates'] LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    PERFORM set_config('wf.total_' || t, n::text, true);
    RAISE NOTICE 'A4 % exact rows: %, total size: %', t, n, pg_size_pretty(pg_total_relation_size(format('public.%I', t)::regclass));
  END LOOP;

  -- A5. I1 over every business (spec §10.2 queries, unchanged). All must be 0.
  SELECT count(*) INTO i1_docs FROM finance_documents d JOIN projects p ON p.business_id = d.business_id AND p.id = d.project_id
   WHERE p.customer_id IS DISTINCT FROM d.customer_id;
  SELECT count(*) INTO i1_exp FROM finance_expenses e JOIN projects p ON p.business_id = e.business_id AND p.id = e.project_id
   WHERE e.customer_id IS NOT NULL AND p.customer_id IS DISTINCT FROM e.customer_id;
  SELECT count(*) INTO i1_tpl FROM finance_recurring_templates r JOIN projects p ON p.business_id = r.business_id AND p.id = r.project_id
   WHERE p.customer_id IS DISTINCT FROM r.customer_id;
  PERFORM set_config('wf.i1_total', (i1_docs + i1_exp + i1_tpl)::text, true);
  RAISE NOTICE 'A5 I1 violations: documents %, expenses %, recurring templates %', i1_docs, i1_exp, i1_tpl;

  -- A6. Recorded, not a stop condition: customerless expenses linked to a project stay valid (MATCH SIMPLE).
  SELECT count(*) INTO n FROM finance_expenses WHERE customer_id IS NULL AND project_id IS NOT NULL;
  RAISE NOTICE 'A6 customerless expenses linked to a project (re-check after apply): %', n;

  -- A7. Activity now, as metadata only: open transactions and the oldest one.
  SELECT count(*), coalesce(max(date_trunc('second', now() - xact_start))::text, 'none') INTO n, t FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL;
  RAISE NOTICE 'A7 other open transactions: %, oldest: %', n, t;
  SELECT setting INTO t FROM pg_settings WHERE name = 'server_version';
  RAISE NOTICE 'A7 server version: %', t;

  IF i1_docs + i1_exp + i1_tpl <> 0 THEN
    RAISE EXCEPTION 'STOP: % I1 violation(s); the migration would fail on VALIDATE. Do not apply; report privately', i1_docs + i1_exp + i1_tpl;
  END IF;
END $$;

-- Carry the control totals and the business list to B without printing them.
SELECT current_setting('wf.total_businesses') AS t_businesses, current_setting('wf.total_projects') AS t_projects,
       current_setting('wf.total_finance_documents') AS t_docs, current_setting('wf.total_finance_expenses') AS t_expenses,
       current_setting('wf.total_finance_recurring_templates') AS t_templates,
       (SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '') FROM businesses) AS business_ids
\gset
ROLLBACK;

-- ======================================== B. bos_app connection =======================================
\connect :app_url
BEGIN TRANSACTION READ ONLY;
SELECT set_config('wf.business_ids', :'business_ids', true), set_config('wf.t_businesses', :'t_businesses', true),
       set_config('wf.t_projects', :'t_projects', true), set_config('wf.t_docs', :'t_docs', true),
       set_config('wf.t_expenses', :'t_expenses', true), set_config('wf.t_templates', :'t_templates', true)
\gset wf_ignore_

DO $$
DECLARE
  me record;
  ids uuid[] := CASE WHEN current_setting('wf.business_ids') = '' THEN ARRAY[]::uuid[]
                     ELSE string_to_array(current_setting('wf.business_ids'), ',')::uuid[] END;
  b uuid;
  n bigint;
  seen_b bigint := 0; seen_p bigint := 0; seen_d bigint := 0; seen_e bigint := 0; seen_t bigint := 0;
  with_rows bigint := 0; bad_businesses bigint := 0; v bigint;
BEGIN
  -- B1. This connection is the policy role, without any bypass.
  SELECT rolname, rolsuper, rolbypassrls INTO me FROM pg_roles WHERE rolname = current_user;
  IF me.rolname <> 'bos_app' OR me.rolsuper OR me.rolbypassrls THEN
    RAISE EXCEPTION 'STOP: connection B must be bos_app without superuser or BYPASSRLS';
  END IF;

  -- B2. Negative control: with no business set, bos_app sees nothing (RLS is active on every table).
  PERFORM set_config('app.business_id', '', true);
  SELECT (SELECT count(*) FROM businesses) + (SELECT count(*) FROM projects) + (SELECT count(*) FROM finance_documents)
       + (SELECT count(*) FROM finance_expenses) + (SELECT count(*) FROM finance_recurring_templates) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'STOP: bos_app sees % row(s) with no business set; RLS is not in force', n; END IF;
  RAISE NOTICE 'B2 negative control (no business set sees 0 rows): yes';

  -- B3. Per business, as that tenant: what it sees, and its I1 violations.
  FOREACH b IN ARRAY ids LOOP
    PERFORM set_config('app.business_id', b::text, true);
    EXECUTE 'SELECT count(*) FROM businesses' INTO n;
    IF n <> 1 THEN RAISE EXCEPTION 'STOP: a business does not see exactly its own businesses row (sees %)', n; END IF;
    seen_b := seen_b + n;
    EXECUTE 'SELECT count(*) FROM projects' INTO n; seen_p := seen_p + n; v := n;
    EXECUTE 'SELECT count(*) FROM finance_documents' INTO n; seen_d := seen_d + n; v := v + n;
    EXECUTE 'SELECT count(*) FROM finance_expenses' INTO n; seen_e := seen_e + n; v := v + n;
    EXECUTE 'SELECT count(*) FROM finance_recurring_templates' INTO n; seen_t := seen_t + n; v := v + n;
    IF v > 0 THEN with_rows := with_rows + 1; END IF;
    EXECUTE $q$SELECT
        (SELECT count(*) FROM finance_documents d JOIN projects p ON p.business_id = d.business_id AND p.id = d.project_id
          WHERE p.customer_id IS DISTINCT FROM d.customer_id)
      + (SELECT count(*) FROM finance_expenses e JOIN projects p ON p.business_id = e.business_id AND p.id = e.project_id
          WHERE e.customer_id IS NOT NULL AND p.customer_id IS DISTINCT FROM e.customer_id)
      + (SELECT count(*) FROM finance_recurring_templates r JOIN projects p ON p.business_id = r.business_id AND p.id = r.project_id
          WHERE p.customer_id IS DISTINCT FROM r.customer_id)$q$ INTO n;
    IF n > 0 THEN bad_businesses := bad_businesses + 1; END IF;
  END LOOP;

  RAISE NOTICE 'B3 businesses checked: %, with rows in these tables: %, with I1 violations: %', cardinality(ids), with_rows, bad_businesses;
  RAISE NOTICE 'B3 per-business sums vs exact totals: businesses %/%, projects %/%, documents %/%, expenses %/%, templates %/%',
    seen_b, current_setting('wf.t_businesses'), seen_p, current_setting('wf.t_projects'), seen_d, current_setting('wf.t_docs'),
    seen_e, current_setting('wf.t_expenses'), seen_t, current_setting('wf.t_templates');

  -- B4. The sums must equal the admin's exact totals. A difference means rows outside every listed business,
  --     a hidden row, or a write between A and B: stop and re-run in a quiet moment.
  IF seen_b <> current_setting('wf.t_businesses')::bigint OR seen_p <> current_setting('wf.t_projects')::bigint
     OR seen_d <> current_setting('wf.t_docs')::bigint OR seen_e <> current_setting('wf.t_expenses')::bigint
     OR seen_t <> current_setting('wf.t_templates')::bigint THEN
    RAISE EXCEPTION 'STOP: per-business sums differ from the exact totals';
  END IF;
  IF bad_businesses <> 0 THEN RAISE EXCEPTION 'STOP: % business(es) have I1 violations', bad_businesses; END IF;
  IF cardinality(ids) = 0 OR with_rows = 0 THEN
    RAISE NOTICE 'B5 empty case: % businesses with rows; totals 0 by exact count under the BYPASSRLS admin role', with_rows;
  END IF;
  RAISE NOTICE 'PREFLIGHT PASS';
END $$;
ROLLBACK;
