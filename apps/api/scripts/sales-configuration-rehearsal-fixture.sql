-- Throwaway fixture for the S-CFG-1A rehearsal: REHEARSAL BRANCH ONLY, never production.
-- Procedure: docs/sales-configuration-migration.md §4 step 5. Use it only when the rehearsal branch (a copy of
-- production) has no business with an active member, which the rehearsal script needs for its bos_app smoke and
-- timing sections and the probe needs for its reads.
--
-- It COMMITS one marked business ("S-CFG rehearsal fixture", slug scfg-rehearsal-fixture), one user on the
-- reserved .invalid domain, an OWNER membership, one pipeline with three stages and 200 OPEN opportunities.
-- It refuses to run unless SCFG_FIXTURE_TARGET=rehearsal, and does nothing if the fixture already exists. The
-- target guard (Neon API: the URL is the rehearsal branch, not the default branch) is the real protection; this
-- variable only makes the intent explicit. The branch is thrown away with everything on it.
--
-- Usage (psql 15 or newer, from apps/api, admin URL of the REHEARSAL branch):
--   SCFG_FIXTURE_TARGET=rehearsal psql "$ADMIN_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f scripts/sales-configuration-rehearsal-fixture.sql
\set ON_ERROR_STOP on
\set QUIET on

\getenv fixture_target SCFG_FIXTURE_TARGET
\if :{?fixture_target}
\else
  \set fixture_target none
\endif
SELECT :'fixture_target' = 'rehearsal' AS fixture_ok \gset
\if :fixture_ok
\else
  DO $$ BEGIN RAISE EXCEPTION 'STOP: set SCFG_FIXTURE_TARGET=rehearsal (rehearsal branch only)'; END $$;
\endif

BEGIN;
DO $$
DECLARE
  biz uuid := gen_random_uuid();
  usr uuid := gen_random_uuid();
  p uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid();
BEGIN
  IF NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'STOP: run as the admin role (it must bypass RLS)';
  END IF;
  IF EXISTS (SELECT 1 FROM businesses WHERE slug = 'scfg-rehearsal-fixture') THEN
    RAISE NOTICE 'FIXTURE already present: nothing to do';
    RETURN;
  END IF;
  INSERT INTO users (id, email, name, updated_at) VALUES (usr, 'scfg-rehearsal-' || substr(md5(random()::text), 1, 8) || '@example.invalid', 'S-CFG rehearsal', now());
  INSERT INTO businesses (id, name, slug, country_code, time_zone, locale, currency, home_region)
  VALUES (biz, 'S-CFG rehearsal fixture', 'scfg-rehearsal-fixture', 'AU', 'Australia/Perth', 'en-AU', 'AUD', 'aws-us-east-1');
  INSERT INTO memberships (id, business_id, user_id, role) VALUES (gen_random_uuid(), biz, usr, 'OWNER');
  INSERT INTO sales_pipelines (id, business_id, name, position) VALUES (p, biz, 'Sales pipeline', 1000);
  INSERT INTO sales_stages (id, business_id, pipeline_id, name, position) VALUES
    (s1, biz, p, 'Lead', 1000), (gen_random_uuid(), biz, p, 'Proposal', 2000), (gen_random_uuid(), biz, p, 'Negotiation', 3000);
  INSERT INTO opportunities (id, business_id, title, pipeline_id, stage_id, currency_code)
  SELECT gen_random_uuid(), biz, 'Fixture ' || g, p, s1, 'AUD' FROM generate_series(1, 200) g;
  RAISE NOTICE 'FIXTURE created: 1 business, 1 owner, 1 pipeline, 3 stages, 200 open opportunities';
END $$;
COMMIT;
