#!/usr/bin/env bash
# Verdict of the "CI gate" job, the single required status check. Inputs are job results
# (success, failure, cancelled, skipped, or empty if unknown) from the `needs` context:
#   CHANGES STATIC UNIT DATABASE BUILD DESKTOP, plus DESKTOP_REQUIRED (classifier output)
#   plus DESKTOP_TIER (docs, server or full) and DESKTOP_REASON (CI-2A desktop decision),
#   plus GATE_TIER (docs, client or full) and GATE_REASON (CIQ-A1 gated-job decision).
# Exits 0 only when every applicable check succeeded.
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

# A gated job may be absent only when the classifier job succeeded AND its explicit tier permits
# skipping that job (classify-gate-tier.sh). A job that was allowed to skip but ran anyway must still
# succeed. Any other combination, including a missing, unknown or unpermitted tier, requires success.
#   docs    may skip Static checks, Unit tests, Build verification and Database tests
#   client  may skip Database tests only
#   full    may skip nothing
gate_tier=full
if [ "${CHANGES:-}" = success ]; then
  case "${GATE_TIER:-}" in
    docs|client) gate_tier="$GATE_TIER" ;;
  esac
fi

may_skip() { # job key -> 0 if the gate tier permits skipping it
  case "$gate_tier:$1" in
    docs:static|docs:unit|docs:build|docs:database|client:database) return 0 ;;
  esac
  return 1
}

gated() { # display name, job key, result
  if ! may_skip "$2"; then
    require "$1" "$3"
  elif [ "$3" = skipped ]; then
    echo "skip $1 (not needed, tier $gate_tier: ${GATE_REASON:-})"
  elif [ "$3" = success ]; then
    echo "ok   $1"
  else
    echo "::error title=$1 did not pass::$1 ran and finished as '${3:-unknown}'."
    fail=1
  fi
}

require "Detect changes" "${CHANGES:-}"
gated "Static checks" static "${STATIC:-}"
gated "Unit tests" unit "${UNIT:-}"
gated "Database tests" database "${DATABASE:-}"
gated "Build verification" build "${BUILD:-}"

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
