#!/usr/bin/env bash
# CIQ-A3: read-only eligibility report for the merge-queue thread (docs/merge-queue.md §3 and §5).
# For each PR it finds the newest ChatGPT merge verdict that passes the provenance check in
# docs/agent-task-protocol.md "Approvals", and says whether it still covers the PR's current content.
# It never merges, labels, comments or marks anything ready. It is an aid, not approval: the queue
# thread still re-reads the verdict and CI from GitHub before every merge, and anything this script
# cannot establish is reported as NOT COVERED (fail closed).
#
# Usage:  scripts/merge-queue/verdict-status.sh <pr-number>...      (needs gh api and a git checkout)
#         scripts/merge-queue/verdict-status.sh --parse < comments.json   (offline: verdict parsing only)
#
# A comment is a valid merge verdict only if ALL hold:
#   - performed_via_github_app.slug == chatgpt-codex-connector
#   - updated_at == created_at (never edited)
#   - its first non-empty line, ignoring leading heading and emphasis markers (#, *, _, spaces; a quoted ">" line never counts), is exactly
#     "APPROVED — EXECUTE: MERGE" (em dash) and nothing else
#   - it labels exactly one distinct SHA as the head: a full 40-hex SHA directly after the word "head"
#     (optionally "head SHA"/"head commit", then only spaces, ":", "*", "`" or "="). Other full SHAs
#     in the body (an earlier reviewed head, a base) are ignored; two different labelled heads fail
#   - it names this PR ("#<n>" or "PR <n>"); a verdict naming no PR is not covered (--parse without
#     a PR number skips only this check, for offline listing)
# ready=true (the verdict authorises marking a draft ready) only if BOTH hold:
#   - some unquoted line, after leading heading/list/emphasis markers, STARTS with "Ready and merge"
#     (case-insensitive) and contains no negating or conditional word (not, never, no, don't,
#     cannot, unless, if, until, once, when, whenever, provided, pending, subject to)
#   - no other unquoted line mentions "ready and merge" with such a word (contradiction = not ready)
# Quoted (">") lines never count either way. Anything else is ready=false: the queue reads the
# verdict itself or asks for a dedicated "Ready and merge ..." line; it never infers readiness.
set -euo pipefail

REPO="${REPO:-reganwagteveld/business-OS}"
APP=chatgpt-codex-connector

# stdin: JSON array of issue comments; $1: PR number (optional).
# stdout: one JSON object per valid verdict: {id,url,created_at,sha,ready}
parse_verdicts() {
  jq -c --arg app "$APP" --arg pr "${1:-}" '
    .[]
    | select((.performed_via_github_app.slug // "") == $app)
    | select(.updated_at == .created_at)
    | . as $c
    | ($c.body | split("\n") | map(gsub("\r"; "")) ) as $lines
    | ($lines | map(select(test("\\S"))) | .[0] // "" | gsub("^[\\s#*_]+|[\\s*_]+$"; "")) as $first
    | select($first == "APPROVED — EXECUTE: MERGE")
    | ([ $c.body | scan("\\bhead\\b(?:[ \\t]*(?:sha|commit))?[\\s:*`=]*\\b([0-9a-f]{40})\\b"; "i") | .[0] | ascii_downcase ] | unique) as $shas
    | select($shas | length == 1)
    | ([ $c.body | scan("(?:\\bPR\\s*#?|#)([0-9]{1,5})\\b"; "i") | .[0] ] | unique) as $prs
    | select($pr == "" or ($prs | index($pr)) != null)
    | "\\b(not|never|no|don.?t|cannot|can.?t|unless|if|until|once|when|whenever|provided|pending|subject\\s+to)\\b" as $hedge
    | [ $lines[] | select(test("^\\s*>") | not) | gsub("^[\\s#*_-]+"; "") ] as $plain
    | ([ $plain[] | select(test("^ready and merge\\b"; "i")) | select(test($hedge; "i") | not) ] | length > 0) as $affirm
    | ([ $plain[] | select(test("ready and merge"; "i")) | select(test($hedge; "i")) ] | length > 0) as $hedged
    | {id: $c.id, url: $c.html_url, created_at: $c.created_at, sha: $shas[0],
       ready: ($affirm and ($hedged | not))}'
}

if [ "${1:-}" = --parse ]; then
  parse_verdicts "${2:-}"
  exit 0
fi

[ "$#" -gt 0 ] || { echo "usage: $0 <pr-number>... | --parse [pr] < comments.json" >&2; exit 2; }
git fetch -q origin main

patch_id() { git diff "origin/main...$1" | git patch-id --stable | cut -d' ' -f1; }

printf '%-6s %-6s %-9s %-9s %-14s %-8s %-6s %s\n' PR draft head verdict covers ready CI behind
for pr in "$@"; do
  info="$(gh api "repos/$REPO/pulls/$pr")"
  head="$(jq -r .head.sha <<< "$info")"; draft="$(jq -r .draft <<< "$info")"; ref="$(jq -r .head.ref <<< "$info")"
  verdict="$(gh api --paginate "repos/$REPO/issues/$pr/comments?per_page=100" | jq -s 'add' | parse_verdicts "$pr" | tail -n 1)"
  covers="NOT COVERED"; vsha="-"; ready="-"
  if [ -n "$verdict" ]; then
    vsha="$(jq -r .sha <<< "$verdict")"; ready="$(jq -r .ready <<< "$verdict")"
    if [ "$vsha" = "$head" ]; then
      covers="exact head"
    elif git fetch -q origin "$ref" "$vsha" 2>/dev/null \
         && git merge-base --is-ancestor "$vsha" "$head" \
         && [ -n "$(patch_id "$vsha")" ] && [ "$(patch_id "$vsha")" = "$(patch_id "$head")" ]; then
      covers="same patch-id"   # later commits must still be conflict-free syncs from main: check by hand
    fi
    # A draft is covered only by an affirmative, dedicated "Ready and merge" line (fail closed).
    if [ "$draft" = true ] && [ "$ready" != true ] && [ "$covers" != "NOT COVERED" ]; then
      covers="NOT COVERED (draft, no Ready and merge line)"
    fi
  fi
  ci="$(gh api "repos/$REPO/commits/$head/check-runs?check_name=CI%20gate" --jq '[.check_runs[] | select(.app.slug == "github-actions")] | max_by(.started_at) | if . == null then "none" else (.conclusion // .status) end')"
  behind="$(gh api "repos/$REPO/compare/main...$head" --jq .behind_by 2>/dev/null || echo '?')"
  printf '%-6s %-6s %-9s %-9s %-14s %-8s %-6s %s\n' "#$pr" "$draft" "${head:0:7}" "${vsha:0:7}" "$covers" "$ready" "$ci" "$behind"
  [ -z "$verdict" ] || echo "       verdict: $(jq -r .url <<< "$verdict")"
done
