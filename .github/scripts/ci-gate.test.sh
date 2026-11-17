#!/usr/bin/env bash
# Self-test for ci-gate.sh: no combination of failed, cancelled, skipped or missing mandatory
# results may pass. Runs in the "Detect changes" job.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fail=0

# name, expected exit (pass|fail), CHANGES STATIC UNIT DATABASE BUILD DESKTOP DESKTOP_REQUIRED [DESKTOP_TIER]
# DESKTOP_TIER defaults to "docs" when DESKTOP_REQUIRED is false and "full" otherwise.
check() {
  local name="$1" expected="$2"
  local got=pass
  CHANGES="$3" STATIC="$4" UNIT="$5" DATABASE="$6" BUILD="$7" DESKTOP="$8" DESKTOP_REQUIRED="$9" \
    DESKTOP_TIER="${10-$([ "$9" = false ] && echo docs || echo full)}" DESKTOP_REASON=test "$here/ci-gate.sh" > /dev/null 2>&1 || got=fail
  if [ "$got" = "$expected" ]; then
    echo "ok   $name ($got)"
  else
    echo "FAIL $name: expected $expected, got $got" >&2
    fail=1
  fi
}

S=success
check "all pass, desktop ran"                    pass $S $S $S $S $S $S        true
check "all pass, desktop not needed and skipped" pass $S $S $S $S $S skipped  false
check "desktop not needed but ran and passed"    pass $S $S $S $S $S $S        false
check "unit tests failed"                        fail $S $S failure $S $S $S   true
check "database tests failed"                    fail $S $S $S failure $S skipped false
check "database tests cancelled"                 fail $S $S $S cancelled $S skipped false
check "database tests skipped"                   fail $S $S $S skipped $S skipped false
check "static checks missing result"             fail $S "" $S $S $S skipped   false
check "build skipped"                            fail $S $S $S $S skipped $S   true
check "desktop needed but skipped"               fail $S $S $S $S $S skipped  true
check "desktop needed but cancelled"             fail $S $S $S $S $S cancelled true
check "desktop not needed but ran and failed"    fail $S $S $S $S $S failure  false
check "classifier failed, desktop skipped"       fail failure $S $S $S $S skipped ""
check "classifier cancelled, output says false"  fail cancelled $S $S $S $S skipped false
check "classifier output missing"                fail $S $S $S $S $S skipped  ""
check "classifier output garbage"                fail $S $S $S $S $S skipped  maybe

check "server tier may skip desktop"             pass $S $S $S $S $S skipped  false server
check "full tier cannot skip desktop"            fail $S $S $S $S $S skipped  false full
check "unknown tier cannot skip desktop"         fail $S $S $S $S $S skipped  false bogus
check "missing tier cannot skip desktop"         fail $S $S $S $S $S skipped  false ""
check "docs tier, build job failed"              fail $S $S $S $S failure skipped false docs
check "docs tier, static (typecheck/lint) failed" fail $S failure $S $S $S skipped false docs
check "docs tier, classifier job failed"         fail failure $S $S $S $S skipped false docs
check "cancelled required job fails the gate"    fail $S cancelled $S $S $S skipped false docs

exit "$fail"
