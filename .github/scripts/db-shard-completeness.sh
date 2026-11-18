#!/usr/bin/env bash
# CIQ-A2 (docs/ciq-1-merge-queue-throughput.md §4.A.3, decision D-CI-3): proves that the sharded
# integration run executed exactly the integration test files in the repository, each once, and that
# every one of them passed with at least one test. Fails closed on anything missing or unreadable.
#
# Usage: db-shard-completeness.sh <expected-file-list> <shard-count> <report-dir>
#   expected-file-list  newline-separated repository paths of every integration test file
#                       (git ls-files, not vitest's own list, so a narrowed include is caught)
#   report-dir          contains shard-<i>.json (vitest json reporter output) for i in 1..count
set -euo pipefail

expected="${1:?expected file list}"
count="${2:?shard count}"
dir="${3:?report directory}"
fail=0
err() { echo "::error title=Integration shard completeness::$1"; fail=1; }

[[ "$count" =~ ^[1-9][0-9]?$ ]] || { err "invalid shard count '$count'"; exit 1; }
[ -s "$expected" ] || { err "the expected integration file list is empty or missing"; exit 1; }

seen="$(mktemp)"
total=0
for i in $(seq 1 "$count"); do
  report="$dir/shard-$i.json"
  if [ ! -s "$report" ]; then err "shard $i/$count produced no report"; continue; fi
  if ! jq -e 'type == "object" and (.testResults | type == "array")' "$report" > /dev/null 2>&1; then
    err "shard $i/$count report is not a readable vitest json report"; continue
  fi
  # Shard-level verdict: vitest's own success flag and counters.
  if ! jq -e '.success == true and .numFailedTests == 0 and .numPendingTests == 0 and .numTodoTests == 0
              and (.numTotalTests | type == "number") and .numTotalTests > 0' "$report" > /dev/null; then
    err "shard $i/$count did not pass cleanly ($(jq -c '{success,numTotalTests,numFailedTests,numPendingTests,numTodoTests}' "$report"))"
  fi
  # File-level: every file passed, ran at least one test, and every test in it passed.
  bad="$(jq -r '.testResults[] | select(.status != "passed" or (.assertionResults | length) == 0
                  or any(.assertionResults[]; .status != "passed")) | .name' "$report")"
  [ -z "$bad" ] || err "shard $i/$count has files that failed, were skipped or ran no tests: $(echo "$bad" | sed 's#.*/apps/api/#apps/api/#' | tr '\n' ' ')"
  # Normalise absolute paths to repository paths.
  jq -r '.testResults[].name' "$report" | sed -n 's#^.*/\(apps/api/tests/integration/.*\)$#\1#p' >> "$seen"
  if [ "$(jq '.testResults | length' "$report")" -ne "$(jq -r '.testResults[].name' "$report" | grep -c '/apps/api/tests/integration/' || true)" ]; then
    err "shard $i/$count reported a file outside apps/api/tests/integration/"
  fi
  n="$(jq '.numTotalTests // 0' "$report")"
  echo "shard $i/$count: $(jq '.testResults | length' "$report") files, $n tests"
  total=$((total + n))
done

dupes="$(sort "$seen" | uniq -d)"
[ -z "$dupes" ] || err "files ran in more than one shard: $(echo "$dupes" | tr '\n' ' ')"
missing="$(comm -23 <(sort -u "$expected") <(sort -u "$seen"))"
[ -z "$missing" ] || err "integration files that no shard ran: $(echo "$missing" | tr '\n' ' ')"
extra="$(comm -13 <(sort -u "$expected") <(sort -u "$seen"))"
[ -z "$extra" ] || err "shards ran files that are not in the repository list: $(echo "$extra" | tr '\n' ' ')"

echo "expected $(sort -u "$expected" | wc -l) files; executed $(sort -u "$seen" | wc -l) files and $total tests across $count shards"
rm -f "$seen"
exit "$fail"
