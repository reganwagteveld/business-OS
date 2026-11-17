#!/usr/bin/env bash
# Self-test for ci-gate.sh: no combination of failed, cancelled, skipped or missing mandatory
# results may pass. Runs in the "Detect changes" job.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fail=0

# name, expected exit (pass|fail), CHANGES STATIC UNIT DATABASE BUILD DESKTOP DESKTOP_REQUIRED [DESKTOP_TIER] [GATE_TIER]
# DESKTOP_TIER defaults to "docs" when DESKTOP_REQUIRED is false and "full" otherwise.
# GATE_TIER (CIQ-A1) defaults to "full"; pass "-" to leave it unset.
check() {
  local name="$1" expected="$2"
  local got=pass
  # CIQ-A2: the pooler and completeness jobs follow the shard result unless DBP / DBC override them.
  DATABASE_POOLER="${DBP-$6}" DATABASE_COMPLETE="${DBC-$6}" \
  CHANGES="$3" STATIC="$4" UNIT="$5" DATABASE="$6" BUILD="$7" DESKTOP="$8" DESKTOP_REQUIRED="$9" \
    DESKTOP_TIER="${10-$([ "$9" = false ] && echo docs || echo full)}" DESKTOP_REASON=test \
    GATE_TIER="${11-full}" GATE_REASON=test "$here/ci-gate.sh" > /dev/null 2>&1 || got=fail
  if [ "${11-}" = - ]; then
    got=pass
    env -u GATE_TIER DATABASE_POOLER="${DBP-$6}" DATABASE_COMPLETE="${DBC-$6}" CHANGES="$3" STATIC="$4" UNIT="$5" DATABASE="$6" BUILD="$7" DESKTOP="$8" DESKTOP_REQUIRED="$9" \
      DESKTOP_TIER="${10}" DESKTOP_REASON=test "$here/ci-gate.sh" > /dev/null 2>&1 || got=fail
  fi
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

# CIQ-A1 gate tiers. sk = skipped. Order: CHANGES STATIC UNIT DATABASE BUILD DESKTOP DESKTOP_REQUIRED DESKTOP_TIER GATE_TIER
sk=skipped
# docs: Static, Unit, Database and Build may be skipped (and the desktop matrix by its own CI-2A rule).
check "docs tier, all gated jobs skipped"        pass $S $sk $sk $sk $sk $sk false docs docs
check "docs tier, gated jobs ran and passed"     pass $S $S $S $S $S $sk false docs docs
check "docs tier, some ran, some skipped"        pass $S $sk $S $sk $S $sk false docs docs
check "docs tier, static ran and failed"         fail $S failure $sk $sk $sk $sk false docs docs
check "docs tier, unit ran and failed"           fail $S $sk failure $sk $sk $sk false docs docs
check "docs tier, database ran and failed"       fail $S $sk $sk failure $sk $sk false docs docs
check "docs tier, build ran and failed"          fail $S $sk $sk $sk failure $sk false docs docs
check "docs tier, static cancelled"              fail $S cancelled $sk $sk $sk $sk false docs docs
check "docs tier, database cancelled"            fail $S $sk $sk cancelled $sk $sk false docs docs
check "docs tier, static result missing"         fail $S "" $sk $sk $sk $sk false docs docs
check "docs tier, database result missing"       fail $S $sk $sk "" $sk $sk false docs docs
check "docs tier, classifier failed"             fail failure $sk $sk $sk $sk $sk false docs docs
check "docs tier, classifier cancelled"          fail cancelled $sk $sk $sk $sk $sk false docs docs
check "docs tier, classifier result missing"     fail "" $sk $sk $sk $sk $sk false docs docs
check "docs tier, desktop required but skipped"  fail $S $sk $sk $sk $sk $sk true full docs
check "docs tier, desktop required and passed"   pass $S $sk $sk $sk $sk $S true full docs
# client: only Database may be skipped.
check "client tier, database skipped"            pass $S $S $S $sk $S $S true full client
check "client tier, database skipped, desktop not needed" pass $S $S $S $sk $S $sk false server client
check "client tier, database ran and passed"     pass $S $S $S $S $S $S true full client
check "client tier, database ran and failed"     fail $S $S $S failure $S $S true full client
check "client tier, database cancelled"          fail $S $S $S cancelled $S $S true full client
check "client tier, database result missing"     fail $S $S $S "" $S $S true full client
check "client tier, static skipped"              fail $S $sk $S $sk $S $S true full client
check "client tier, unit skipped"                fail $S $S $sk $sk $S $S true full client
check "client tier, build skipped"               fail $S $S $S $sk $sk $S true full client
check "client tier, unit failed"                 fail $S $S failure $sk $S $S true full client
check "client tier, desktop needed but skipped"  fail $S $S $S $sk $S $sk true full client
check "client tier, classifier failed"           fail failure $S $S $sk $S $S true full client
# full, unknown, missing or garbage gate tier: nothing gated may be skipped.
check "full tier, database skipped"              fail $S $S $S $sk $S $S true full full
check "full tier, static skipped"                fail $S $sk $S $S $S $S true full full
check "unknown gate tier, database skipped"      fail $S $S $S $sk $S $S true full bogus
check "empty gate tier, database skipped"        fail $S $S $S $sk $S $S true full ""
check "unset gate tier, database skipped"        fail $S $S $S $sk $S $S true full -
check "unset gate tier, all passed"              pass $S $S $S $S $S $S true full -
check "upper-case tier is not a tier"            fail $S $sk $sk $sk $sk $sk false docs DOCS
check "tier with whitespace is not a tier"       fail $S $S $S $sk $S $S true full "client "

# CIQ-A2: the RLS/pooler job and the completeness job are required exactly like the shards.
DBP=failure   check "full tier, pooler job failed"            fail $S $S $S $S $S $S true full full
DBP=cancelled check "full tier, pooler job cancelled"         fail $S $S $S $S $S $S true full full
DBP=skipped   check "full tier, pooler job skipped"           fail $S $S $S $S $S $S true full full
DBP=""        check "full tier, pooler result missing"        fail $S $S $S $S $S $S true full full
DBC=failure   check "full tier, completeness failed"          fail $S $S $S $S $S $S true full full
DBC=skipped   check "full tier, completeness skipped"         fail $S $S $S $S $S $S true full full
DBC=""        check "full tier, completeness missing"         fail $S $S $S $S $S $S true full full
DBP=success DBC=success check "full tier, all database jobs passed" pass $S $S $S $S $S $S true full full
check "full tier, a shard failed (matrix result)"              fail $S $S $S failure $S $S true full full
DBC=success check "full tier, shard failed but completeness green" fail $S $S $S failure $S $S true full full
DBP=skipped DBC=skipped check "client tier, all database jobs skipped" pass $S $S $S $sk $S $S true full client
DBP=failure DBC=skipped check "client tier, pooler ran and failed" fail $S $S $S $sk $S $S true full client
DBP=skipped DBC=failure check "docs tier, completeness ran and failed" fail $S $sk $sk $sk $sk $sk false docs docs
DBP=skipped DBC=skipped check "unset tier, all database jobs skipped" fail $S $S $S $sk $S $S true full -

exit "$fail"
