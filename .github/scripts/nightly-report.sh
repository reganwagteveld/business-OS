#!/usr/bin/env bash
# Nightly report: runner-minutes per OS, verdict, and (scheduled runs only) a failure issue.
# Inputs: GH_TOKEN REPO RUN_ID EVENT_NAME FULL_SUITE MACOS_NATIVE SERVER_URL.
set -uo pipefail
jobs="$(gh api "repos/$REPO/actions/runs/$RUN_ID/jobs?per_page=100" --paginate --jq '.jobs[]' | jq -s '.' 2>/dev/null || echo '[]')"

mins() { # label substring -> "N jobs, X.Y min wall, Z billed min (each job rounded up)"
  echo "$jobs" | jq -r --arg l "$1" '
    [.[] | select((.labels // []) | map(ascii_downcase) | any(contains($l))) | select(.completed_at != null and .started_at != null)
     | ((.completed_at | fromdate) - (.started_at | fromdate))] as $d
    | "\($d | length) jobs, \((($d | add // 0) / 60 * 10 | round) / 10) min, \([$d[] | (. / 60 | ceil)] | add // 0) billed min"'
}
queue() { # label substring -> longest queue wait in seconds
  echo "$jobs" | jq -r --arg l "$1" '
    [.[] | select((.labels // []) | map(ascii_downcase) | any(contains($l))) | select(.started_at != null)
     | ((.started_at | fromdate) - (.created_at | fromdate))] | max // 0'
}

verdict=success
# Skipped is fine only for the full suite on pull requests (the normal CI covers it there).
case "$EVENT_NAME:$FULL_SUITE" in pull_request:skipped) ;; *:success) ;; *) verdict=failure ;; esac
[ "$MACOS_NATIVE" = success ] || verdict=failure

{
  echo "## Nightly report"
  echo
  echo "Verdict: **$verdict** (full suite: $FULL_SUITE, macOS native: $MACOS_NATIVE, event: $EVENT_NAME)"
  echo
  echo "| Runner | Usage | Longest queue wait |"
  echo "|---|---|---|"
  echo "| macOS | $(mins macos) | $(queue macos) s |"
  echo "| Windows | $(mins windows) | $(queue windows) s |"
  echo "| Linux | $(mins ubuntu) | $(queue ubuntu) s |"
} >> "$GITHUB_STEP_SUMMARY"

if [ "$verdict" != success ] && [ "$EVENT_NAME" = schedule ]; then
  title="Nightly validation failed"
  url="$SERVER_URL/$REPO/actions/runs/$RUN_ID"
  body="Run $url failed (full suite: $FULL_SUITE, macOS native: $MACOS_NATIVE). Open the run summary for the failing job. An unresolved failure blocks release approval."
  existing="$(gh issue list --repo "$REPO" --state open --search "\"$title\" in:title" --json number --jq '.[0].number // empty')"
  if [ -n "$existing" ]; then
    gh issue comment "$existing" --repo "$REPO" --body "$body"
  else
    gh issue create --repo "$REPO" --title "$title" --body "$body"
  fi
fi

[ "$verdict" = success ]
