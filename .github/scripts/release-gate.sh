#!/usr/bin/env bash
# Verdict of the "Release gate" job in release-validation.yml. Fails closed: it exits 0 only when
# every required result is exactly "success". Missing, empty, skipped, cancelled, failed or unknown
# values all fail. Inputs (job results from the `needs` context, plus two computed facts):
#   RESOLVE FULL_SUITE LINUX MACOS WINDOWS   job results
#   NIGHTLY                                  "clear" only when no unresolved nightly failure was found
#   EVENT_NAME                               github.event_name (only tag pushes and manual runs are
#                                            release evidence; pull_request runs validate the workflow itself)
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

require "Resolve candidate commit" "${RESOLVE:-}"
# The full suite is skipped only on pull_request runs, where the normal CI workflow covers the PR.
if [ "${EVENT_NAME:-}" = pull_request ] && [ "${FULL_SUITE:-}" = skipped ]; then
  echo "skip Full CI suite (pull_request validation of this workflow; normal CI runs separately)"
else
  require "Full CI suite" "${FULL_SUITE:-}"
fi
require "Linux package and verify" "${LINUX:-}"
require "macOS package and verify" "${MACOS:-}"
require "Windows package and verify" "${WINDOWS:-}"

if [ "${NIGHTLY:-}" != clear ]; then
  echo "::error title=Nightly validation::nightly status is '${NIGHTLY:-unknown}'; an unresolved nightly failure (or an unreadable status) blocks the release gate."
  fail=1
else
  echo "ok   Nightly validation has no unresolved failure"
fi

case "${EVENT_NAME:-}" in
  push|workflow_dispatch) echo "release evidence: yes (${EVENT_NAME})" ;;
  pull_request) echo "release evidence: NO (pull_request run validates the workflow itself)" ;;
  *) echo "::error title=Unexpected event::event '${EVENT_NAME:-unknown}' is not a release validation trigger."; fail=1 ;;
esac

exit "$fail"
