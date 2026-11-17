#!/usr/bin/env bash
# Self-test for db-shard-completeness.sh: a missing, empty, unreadable, failing, skipped, duplicated,
# partial or foreign report must fail; only a complete, clean set passes. Runs in "Detect changes".
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail=0
P=/home/runner/work/business-OS/business-OS/apps/api/tests/integration

printf '%s\n' apps/api/tests/integration/a.test.ts apps/api/tests/integration/b.test.ts \
  apps/api/tests/integration/sub/c.test.ts > "$work/expected"

file() { # name [status] [assertion status] [assertion count]
  local n=$(( ${4:-1} )) a="" i
  for i in $(seq 1 "$n"); do a="${a:+$a,}{\"status\":\"${3:-passed}\"}"; done
  echo "{\"name\":\"$P/$1\",\"status\":\"${2:-passed}\",\"assertionResults\":[${a}]}"
}
report() { # out, success, failed, pending, total, files...
  local out="$1" success="$2" failed="$3" pending="$4" total="$5"; shift 5
  local files; files="$(IFS=,; echo "$*")"
  echo "{\"success\":$success,\"numTotalTests\":$total,\"numFailedTests\":$failed,\"numPendingTests\":$pending,\"numTodoTests\":0,\"testResults\":[${files}]}" > "$out"
}
good() { # dir
  mkdir -p "$1"
  report "$1/shard-1.json" true 0 0 2 "$(file a.test.ts passed passed 2)"
  report "$1/shard-2.json" true 0 0 1 "$(file b.test.ts)"
  report "$1/shard-3.json" true 0 0 3 "$(file sub/c.test.ts passed passed 3)"
}
check() { # name expected dir [count]
  local got=pass
  "$here/db-shard-completeness.sh" "$work/expected" "${4:-3}" "$3" > /dev/null 2>&1 || got=fail
  if [ "$got" = "$2" ]; then echo "ok   $1 ($got)"; else echo "FAIL $1: expected $2, got $got" >&2; fail=1; fi
}
case_dir() { local d="$work/$1"; good "$d"; echo "$d"; }

d=$(case_dir clean);            check "complete clean set" pass "$d"
d=$(case_dir missing);          rm "$d/shard-2.json"; check "a shard report is missing" fail "$d"
d=$(case_dir empty);            : > "$d/shard-3.json"; check "a shard report is empty" fail "$d"
d=$(case_dir garbage);          echo 'not json' > "$d/shard-1.json"; check "a shard report is unreadable" fail "$d"
d=$(case_dir truncated);        head -c 40 "$d/shard-1.json" > "$d/t" && mv "$d/t" "$d/shard-1.json"; check "a shard report is truncated" fail "$d"
d=$(case_dir failed);           report "$d/shard-2.json" false 1 0 1 "$(file b.test.ts failed failed)"; check "a test failed" fail "$d"
d=$(case_dir failflag);         report "$d/shard-2.json" false 0 0 1 "$(file b.test.ts)"; check "success flag false" fail "$d"
d=$(case_dir skipped);          report "$d/shard-2.json" true 0 1 1 "$(file b.test.ts passed skipped)"; check "a test was skipped" fail "$d"
d=$(case_dir skippedonly);      report "$d/shard-2.json" true 0 0 1 "$(file b.test.ts passed skipped)"; check "a skipped assertion with clean counters" fail "$d"
d=$(case_dir notests);          report "$d/shard-2.json" true 0 0 0 "$(file b.test.ts passed passed 0)"; check "a file ran no tests" fail "$d"
d=$(case_dir emptyshard);       report "$d/shard-2.json" true 0 0 0; check "an empty shard (and a file nobody ran)" fail "$d"
d=$(case_dir dup);              report "$d/shard-2.json" true 0 0 3 "$(file b.test.ts)" "$(file a.test.ts passed passed 2)"; check "a file ran in two shards" fail "$d"
d=$(case_dir extra);            report "$d/shard-2.json" true 0 0 2 "$(file b.test.ts)" "$(file d.test.ts)"; check "an unlisted file ran" fail "$d"
d=$(case_dir foreign);          report "$d/shard-2.json" true 0 0 2 "$(file b.test.ts)" '{"name":"/x/apps/api/tests/unit/u.test.ts","status":"passed","assertionResults":[{"status":"passed"}]}'; check "a file outside integration" fail "$d"
d=$(case_dir fewer);            check "fewer shards than expected" fail "$d" 4
d=$(case_dir badcount);         check "invalid shard count" fail "$d" x
: > "$work/empty-expected"
if "$here/db-shard-completeness.sh" "$work/empty-expected" 3 "$work/clean" > /dev/null 2>&1; then
  echo "FAIL an empty expected list must fail" >&2; fail=1
else echo "ok   empty expected list (fail)"; fi
exit "$fail"
