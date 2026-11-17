#!/usr/bin/env bash
# Nightly status for the release gate. Prints `status=clear|blocked|unknown`; always exits 0 so the gate
# decides. Fail closed: only an explicitly proven clear state prints `clear`.
#  - blocked: any open issue titled exactly "Nightly validation failed" (ALL pages are read, no limit), or the
#    latest completed nightly run on main did not succeed.
#  - unknown: any API or parsing failure, or no completed nightly run exists yet (a first release needs a
#    proven successful nightly).
# Inputs: GH_TOKEN, REPO. Needs gh and jq.
set -uo pipefail
status=unknown
title="Nightly validation failed"
if pages="$(gh api --paginate "repos/$REPO/issues?state=open&per_page=100" 2> /dev/null)" \
   && open="$(echo "$pages" | jq -s --arg t "$title" '[.[][] | select(.pull_request == null) | select(.title == $t)] | length' 2> /dev/null)" \
   && [[ "$open" =~ ^[0-9]+$ ]] \
   && last="$(gh run list --repo "$REPO" --workflow nightly.yml --branch main --status completed --limit 1 --json conclusion --jq '.[0].conclusion // "none"' 2> /dev/null)" \
   && [ -n "$last" ]; then
  if [ "$open" != 0 ]; then status=blocked
  elif [ "$last" = success ]; then status=clear
  elif [ "$last" = none ]; then status=unknown
  else status=blocked
  fi
  echo "open nightly-failure issues: $open; latest nightly run on main: $last" >&2
fi
echo "status=$status"
