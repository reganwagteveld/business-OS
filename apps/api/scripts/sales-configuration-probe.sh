#!/usr/bin/env bash
# Concurrency probe for the S-CFG-1A rehearsal (docs/sales-configuration-migration.md §4, step 7).
# REHEARSAL BRANCH ONLY. Run it in a second terminal while `prisma migrate deploy` runs on the rehearsal branch.
#
# As bos_app with one business set, it repeats, for SCFG_PROBE_SECONDS (default 20):
#   - a read of sales_pipelines, sales_stages and opportunities (the ADD COLUMN holds ACCESS EXCLUSIVE on
#     sales_pipelines until COMMIT, so this read waits for the whole migration);
#   - a no-op write on one sales_stages row, rolled back (the index build holds SHARE on sales_stages, so writes
#     wait).
# It prints only the number of rounds, errors and the longest wait of each kind, in ms. No ids, names or hosts.
#
# Environment (never on the command line):
#   SCFG_PROBE_APP_URL       bos_app URL of the REHEARSAL branch (direct endpoint)
#   SCFG_PROBE_BUSINESS_ID   a business that has at least one stage (the rehearsal script picks one; any works)
#   SCFG_PROBE_SECONDS       optional, default 20
set -euo pipefail
: "${SCFG_PROBE_APP_URL:?STOP: SCFG_PROBE_APP_URL is not set}"
: "${SCFG_PROBE_BUSINESS_ID:?STOP: SCFG_PROBE_BUSINESS_ID is not set}"
secs="${SCFG_PROBE_SECONDS:-20}"
[[ "$SCFG_PROBE_BUSINESS_ID" =~ ^[0-9a-f-]{36}$ ]] || { echo "STOP: SCFG_PROBE_BUSINESS_ID is not a uuid" >&2; exit 2; }

now_ms() { echo $(( $(date +%s%N) / 1000000 )); }
end=$(( $(date +%s) + secs )); rounds=0; errors=0; max_read=0; max_write=0
read_sql="BEGIN; SELECT set_config('app.business_id', '$SCFG_PROBE_BUSINESS_ID', true);
SELECT count(*) FROM sales_pipelines; SELECT count(*) FROM sales_stages; SELECT count(*) FROM opportunities; COMMIT;"
write_sql="BEGIN; SELECT set_config('app.business_id', '$SCFG_PROBE_BUSINESS_ID', true);
UPDATE sales_stages SET name = name WHERE id = (SELECT id FROM sales_stages ORDER BY id LIMIT 1); ROLLBACK;"

while [ "$(date +%s)" -lt "$end" ]; do
  s=$(now_ms)
  psql "$SCFG_PROBE_APP_URL" -X -q -tA -v ON_ERROR_STOP=1 -c "$read_sql" >/dev/null 2>&1 || errors=$((errors + 1))
  d=$(( $(now_ms) - s )); [ "$d" -gt "$max_read" ] && max_read=$d
  s=$(now_ms)
  psql "$SCFG_PROBE_APP_URL" -X -q -tA -v ON_ERROR_STOP=1 -c "$write_sql" >/dev/null 2>&1 || errors=$((errors + 1))
  d=$(( $(now_ms) - s )); [ "$d" -gt "$max_write" ] && max_write=$d
  rounds=$((rounds + 1))
done
echo "probe rounds: $rounds, errors: $errors, longest read: ${max_read} ms, longest stage write: ${max_write} ms"
[ "$errors" -eq 0 ] || { echo "STOP: probe statements failed; check the URL and business id" >&2; exit 1; }
