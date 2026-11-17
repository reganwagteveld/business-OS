#!/usr/bin/env bash
# Self-test for release-gate.sh: any non-success platform result, a missing result, or a nightly
# status other than "clear" must fail the gate.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
S=success

# name expected RESOLVE FULL_SUITE LINUX MACOS WINDOWS NIGHTLY EVENT
check() {
  local got=pass
  RESOLVE="$3" FULL_SUITE="$4" LINUX="$5" MACOS="$6" WINDOWS="$7" NIGHTLY="$8" EVENT_NAME="$9" "$here/release-gate.sh" > /dev/null 2>&1 || got=fail
  if [ "$got" = "$2" ]; then echo "ok   $1 ($got)"; else echo "FAIL $1: expected $2, got $got" >&2; fail=1; fi
}

check "all success, tag push"            pass $S $S $S $S $S clear push
check "all success, manual"              pass $S $S $S $S $S clear workflow_dispatch
check "all success, pull_request"        pass $S $S $S $S $S clear pull_request
check "macOS failed"                     fail $S $S $S failure $S clear push
check "windows failed"                   fail $S $S $S $S failure clear push
check "linux failed"                     fail $S $S failure $S $S clear push
check "macOS cancelled"                  fail $S $S $S cancelled $S clear push
check "windows cancelled"                fail $S $S $S $S cancelled clear push
check "macOS skipped"                    fail $S $S $S skipped $S clear push
check "windows skipped"                  fail $S $S $S $S skipped clear push
check "linux skipped"                    fail $S $S skipped $S $S clear push
check "macOS result missing"             fail $S $S $S "" $S clear push
check "windows result missing"           fail $S $S $S $S "" clear push
check "full suite failed"                fail $S failure $S $S $S clear push
check "full suite skipped (tag push)"    fail $S skipped $S $S $S clear push
check "full suite skipped (manual)"      fail $S skipped $S $S $S clear workflow_dispatch
check "full suite skipped (pull_request)" pass $S skipped $S $S $S clear pull_request
check "full suite failed (pull_request)" fail $S failure $S $S $S clear pull_request
check "full suite cancelled"             fail $S cancelled $S $S $S clear push
check "resolve failed"                   fail failure $S $S $S $S clear push
check "resolve skipped"                  fail skipped $S $S $S $S clear push
check "nightly blocked"                  fail $S $S $S $S $S blocked push
check "nightly unknown"                  fail $S $S $S $S $S unknown push
check "nightly missing"                  fail $S $S $S $S $S "" push
check "nightly garbage"                  fail $S $S $S $S $S "Clear" push
check "unexpected event (schedule)"      fail $S $S $S $S $S clear schedule
check "event missing"                    fail $S $S $S $S $S clear ""
check "everything missing"               fail "" "" "" "" "" "" ""

exit "$fail"
