#!/usr/bin/env bash
# Verdict of the "CI gate" job, the single required status check. Inputs are job results
# (success, failure, cancelled, skipped, or empty if unknown) from the `needs` context:
#   CHANGES STATIC UNIT DATABASE BUILD DESKTOP, plus DESKTOP_REQUIRED (classifier output)
#   plus DESKTOP_TIER (docs, server or full) and DESKTOP_REASON. Exits 0 only when every applicable
#   check succeeded.
set -uo pipefail
fail=0

require() {
  if [ "$2" != success ]; then
    echo "::error title=$1 did not pass::$1 finished as '${2:-unknown}'; it must succeed."
    fail=1
  else
    echo "ok   $1"
  fi
}

require "Detect changes" "${CHANGES:-}"
require "Static checks" "${STATIC:-}"
require "Unit tests" "${UNIT:-}"
require "Database tests" "${DATABASE:-}"
require "Build verification" "${BUILD:-}"

# Fail closed: the desktop matrix may be absent only when the classifier succeeded, said so explicitly
# (desktop=false) AND named a tier that is allowed to skip it. Any other combination requires success.
desktop_may_skip=false
if [ "${CHANGES:-}" = success ] && [ "${DESKTOP_REQUIRED:-}" = false ]; then
  case "${DESKTOP_TIER:-}" in
    docs|server) desktop_may_skip=true ;;
  esac
fi

if [ "$desktop_may_skip" != true ]; then
  require "Desktop shell" "${DESKTOP:-}"
elif [ "${DESKTOP:-}" != skipped ] && [ "${DESKTOP:-}" != success ]; then
  echo "::error title=Desktop shell did not pass::Desktop shell ran and finished as '${DESKTOP:-unknown}'."
  fail=1
else
  echo "skip Desktop shell (not needed, tier ${DESKTOP_TIER}: ${DESKTOP_REASON:-})"
fi

exit "$fail"
