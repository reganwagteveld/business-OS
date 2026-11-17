#!/bin/bash
# Local rehearsal of 20261211000000_people_leave_ledger on a production-shaped database: every migration before
# it applied, then many tenants' policy revisions seeded with past recorded_at values in several time zones, then
# this migration applied by `prisma migrate deploy` as the owner role, timed, and checked.
set -euo pipefail
# LOCAL ONLY: drops and recreates the local business_os database (127.0.0.1, CI roles). Never point it elsewhere.
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$(git rev-parse --show-toplevel)/apps/api"
MIG=prisma/migrations/20261211000000_people_leave_ledger
HOLD=$(mktemp -d)
N=${N:-2000}
PSQL="psql -h 127.0.0.1 -U postgres -d business_os -qAtX -v ON_ERROR_STOP=1"

mkdir -p "$HOLD"; mv "$MIG" "$HOLD/"
trap 'mv "$HOLD/20261211000000_people_leave_ledger" prisma/migrations/ 2>/dev/null || true' EXIT
psql -h 127.0.0.1 -U postgres -qc "drop database if exists business_os with (force)" -c "create database business_os"
psql -h 127.0.0.1 -U postgres -d business_os -q -c "GRANT CONNECT ON DATABASE business_os TO bos_owner, bos_app, bos_auth; GRANT USAGE, CREATE ON SCHEMA public TO bos_owner; GRANT USAGE ON SCHEMA public TO bos_app, bos_auth; ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app;"
pnpm exec prisma migrate deploy 2>&1 | tail -1

echo "== seed $N businesses x 3 policies (+1 revision each on a third), recorded over the past 300 days"
$PSQL <<SQL
INSERT INTO businesses (id, name, slug, country_code, time_zone, locale, currency, home_region)
SELECT gen_random_uuid(), 'R ' || g, 'r-' || g, 'AU',
       (ARRAY['Australia/Perth','Australia/Sydney','America/New_York','Pacific/Auckland','Europe/London','Pacific/Honolulu'])[1 + g % 6],
       'en-AU', 'AUD', 'ci' FROM generate_series(1, $N) g;
INSERT INTO people_leave_types (id, business_id, name, category, paid, sensitive)
SELECT gen_random_uuid(), id, 'Annual', 'ANNUAL', true, false FROM businesses;
INSERT INTO people_leave_policies (id, business_id, leave_type_id, name, unit, granularity, entitlement_method, entitlement_amount, accrual_frequency, year_start, carryover, carryover_cap)
SELECT gen_random_uuid(), t.business_id, t.id, 'P' || k, 'HOURS', 'HOUR', 'ACCRUAL', 152, 'MONTHLY', 'CALENDAR', 'CAPPED', 100
  FROM people_leave_types t CROSS JOIN generate_series(1, 3) k;
SQL
# P3-A's own guards write revision 1 per policy; a third of the policies get a second revision the same way.
# Then recorded_at is spread over the past 300 days (guard off for that one statement only).
$PSQL <<'SQL'
UPDATE people_leave_policies SET name = name || ' ', version = version + 1 WHERE random() < 0.33;
ALTER TABLE people_leave_policy_revisions DISABLE TRIGGER USER;
UPDATE people_leave_policy_revisions SET recorded_at = now() - (random() * interval '300 days');
ALTER TABLE people_leave_policy_revisions ENABLE TRIGGER USER;
-- One business whose time zone changed after its first revision (the preflight must list it).
INSERT INTO audit_events (id, business_id, action, target_type, metadata, created_at)
SELECT gen_random_uuid(), b.id, 'business.updated', 'business', '{"fields":["timeZone"],"timeZoneFrom":"Australia/Sydney","timeZoneTo":"Australia/Perth"}', now()
  FROM businesses b ORDER BY b.slug LIMIT 1;
ANALYZE;
SQL
echo "== preflight (read-only)"
$PSQL -f "$HERE/preflight.sql"

echo "== apply"
mv "$HOLD/20261211000000_people_leave_ledger" prisma/migrations/
start=$(date +%s%N)
pnpm exec prisma migrate deploy 2>&1 | tail -1
echo "apply_ms=$(( ($(date +%s%N) - start) / 1000000 ))"

echo "== verify"
$PSQL <<'SQL'
SELECT 'revisions=' || count(*) || ' missing=' || count(*) FILTER (WHERE effective_from IS NULL)
       || ' inferred=' || count(*) FILTER (WHERE effective_from_basis = 'INFERRED') FROM people_leave_policy_revisions;
SELECT 'mismatch_vs_tz=' || count(*) FROM people_leave_policy_revisions r JOIN businesses b ON b.id = r.business_id
 WHERE r.effective_from <> (r.recorded_at AT TIME ZONE b.time_zone)::date;
SELECT 'forced=' || string_agg(relname || ':' || relforcerowsecurity, ',' ORDER BY relname) FROM pg_class
 WHERE relname IN ('businesses', 'people_leave_policy_revisions', 'people_leave_accounts', 'people_leave_buckets',
                   'people_leave_transactions', 'people_leave_entries', 'people_leave_authorisations');
SELECT 'guard=' || tgenabled::text FROM pg_trigger WHERE tgname = 'people_leave_policy_revisions_guard';
SELECT 'not_null=' || is_nullable FROM information_schema.columns WHERE table_name = 'people_leave_policy_revisions' AND column_name = 'effective_from';
SELECT 'ledger_rows=' || ((SELECT count(*) FROM people_leave_accounts) + (SELECT count(*) FROM people_leave_buckets)
       + (SELECT count(*) FROM people_leave_transactions) + (SELECT count(*) FROM people_leave_entries) + (SELECT count(*) FROM people_leave_authorisations));
SELECT 'migration=' || migration_name || ' finished=' || (finished_at IS NOT NULL) || ' ms=' || round(extract(epoch FROM finished_at - started_at) * 1000)
  FROM _prisma_migrations WHERE migration_name LIKE '20261211%';
SQL
