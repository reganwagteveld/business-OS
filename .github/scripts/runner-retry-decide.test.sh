#!/usr/bin/env bash
# Self-test for runner-retry-decide.sh. Fixtures follow the shape of real GitHub responses (job
# fields and the annotation GitHub adds when a hosted macOS runner is never allocated).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail=0
NOT_ACQUIRED='[{"annotation_level":"failure","message":"The job was not acquired by Runner of type hosted even after multiple attempts"},{"annotation_level":"notice","message":"Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."}]'
CAPACITY_ONLY='[{"annotation_level":"notice","message":"Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times."}]'

ok_job()    { echo "{\"id\":$1,\"name\":\"$2\",\"status\":\"completed\",\"conclusion\":\"success\",\"runner_id\":7,\"runner_name\":\"GitHub Actions 7\",\"steps\":[{},{}]}"; }
alloc_job() { echo "{\"id\":$1,\"name\":\"$2\",\"status\":\"completed\",\"conclusion\":\"cancelled\",\"runner_id\":0,\"runner_name\":\"\",\"steps\":[]}"; }
job()       { echo "{\"id\":$1,\"name\":\"$2\",\"status\":\"completed\",\"conclusion\":\"$3\",\"runner_id\":$4,\"runner_name\":\"$5\",\"steps\":$6}"; }
gate_fail='{"id":9,"name":"CI gate","status":"completed","conclusion":"failure","runner_id":8,"runner_name":"GitHub Actions 8","steps":[{}]}'

# name, expected decision, attempt, jobs JSON (array), then "id=annotations" pairs
check() {
  local name="$1" want="$2" attempt="$3" jobs="$4"; shift 4
  rm -rf "$tmp/ann"; mkdir -p "$tmp/ann"
  echo "{\"total_count\":0,\"jobs\":$jobs}" > "$tmp/jobs.json"
  local pair; for pair in "$@"; do printf '%s' "${pair#*=}" > "$tmp/ann/${pair%%=*}.json"; done
  local got; got="$("$here/runner-retry-decide.sh" "$tmp/jobs.json" "$tmp/ann" "$attempt" | sed -n 's/^decision=//p')"
  if [ "$got" = "$want" ]; then echo "ok   $name ($got)"; else echo "FAIL $name: expected $want, got $got" >&2; fail=1; fi
}
base="$(ok_job 1 'Detect changes'),$(ok_job 2 'Unit, contract and architecture tests'),$(ok_job 3 'Desktop shell (Windows)')"

check "macOS never allocated, attempt 1"         retry          1 "[$base,$(alloc_job 4 'Desktop shell (macOS)'),$gate_fail]" "4=$NOT_ACQUIRED"
check "macOS never allocated, attempt 2"         infra-failure  2 "[$base,$(alloc_job 4 'Desktop shell (macOS)'),$gate_fail]" "4=$NOT_ACQUIRED"
check "macOS never allocated, attempt 3"         infra-failure  3 "[$base,$(alloc_job 4 'Desktop shell (macOS)'),$gate_fail]" "4=$NOT_ACQUIRED"
check "two legs never allocated, attempt 1"      retry          1 "[$base,$(alloc_job 4 'Desktop shell (macOS)'),$(alloc_job 5 'Desktop shell (Windows)'),$gate_fail]" "4=$NOT_ACQUIRED" "5=$NOT_ACQUIRED"
check "test failure is never retried"            skip           1 "[$base,$(job 6 'Unit tests' failure 7 'GitHub Actions 7' '[{}]'),$gate_fail]"
check "test failure plus allocation failure"     skip           1 "[$base,$(job 6 'Unit tests' failure 7 'GitHub Actions 7' '[{}]'),$(alloc_job 4 'Desktop shell (macOS)'),$gate_fail]" "4=$NOT_ACQUIRED"
check "macOS ran and failed"                     skip           1 "[$base,$(job 4 'Desktop shell (macOS)' failure 7 'GitHub Actions 7' '[{},{}]'),$gate_fail]"
check "macOS timed out after starting"           skip           1 "[$base,$(job 4 'Desktop shell (macOS)' timed_out 7 'GitHub Actions 7' '[{},{}]'),$gate_fail]"
check "cancelled after a runner was assigned"    skip           1 "[$base,$(job 4 'Desktop shell (macOS)' cancelled 7 'GitHub Actions 7' '[]'),$gate_fail]" "4=$NOT_ACQUIRED"
check "cancelled with steps (superseded run)"    skip           1 "[$base,$(job 4 'Desktop shell (macOS)' cancelled 0 '' '[{}]'),$gate_fail]" "4=$NOT_ACQUIRED"
check "cancelled, no runner, no annotation"      skip           1 "[$base,$(alloc_job 4 'Desktop shell (macOS)'),$gate_fail]"
check "cancelled, capacity notice only"          skip           1 "[$base,$(alloc_job 4 'Desktop shell (macOS)'),$gate_fail]" "4=$CAPACITY_ONLY"
check "annotation file unreadable"               skip           1 "[$base,$(alloc_job 4 'Desktop shell (macOS)'),$gate_fail]" "4=not json"
check "allocation message as a notice only"      skip           1 "[$base,$(alloc_job 4 'Desktop shell (macOS)'),$gate_fail]" '4=[{"annotation_level":"notice","message":"The job was not acquired by Runner of type hosted"}]'
check "only the gate failed"                     skip           1 "[$base,$gate_fail]"
check "nothing failed"                           skip           1 "[$base]"
check "invalid attempt"                          skip           x "[$base,$(alloc_job 4 'Desktop shell (macOS)'),$gate_fail]" "4=$NOT_ACQUIRED"
check "startup failure is not allocation"        skip           1 "[$base,$(job 4 'Desktop shell (macOS)' startup_failure 0 '' '[]'),$gate_fail]" "4=$NOT_ACQUIRED"
# unreadable jobs list
echo 'not json' > "$tmp/bad.json"; mkdir -p "$tmp/ann"
got="$("$here/runner-retry-decide.sh" "$tmp/bad.json" "$tmp/ann" 1 | sed -n 's/^decision=//p')"
if [ "$got" = skip ]; then echo "ok   unreadable jobs list (skip)"; else echo "FAIL unreadable jobs list: $got" >&2; fail=1; fi
exit "$fail"
