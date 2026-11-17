#!/usr/bin/env bash
# CIQ-A1 docs check, range selection. Runs scan-doc-credentials.sh over the complete change under
# test, and never skips:
#
#   pull_request  The checkout is GitHub's merge commit. Its first parent is the base tip and its
#                 second parent is the PR head, so HEAD^1..HEAD is the whole PR, every commit
#                 included, exactly as it would land. PR_HEAD_SHA must equal HEAD^2.
#   push          Only a single step from the previous tip (HEAD^1 == EVENT_BEFORE), the same rule
#                 changed-files.sh applies before any reduced tier is allowed.
#   anything else (no merge commit, PR head mismatch, multi-commit or force push, new branch,
#                 schedule, workflow_dispatch): every documentation file at HEAD is scanned in
#                 full, as if newly added. Fail closed, never skip.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
event="${EVENT_NAME:-}"
docs=(-- 'docs/' '*.md' '*.mdx' '*.txt')

range_ok=false
reason=""
if [ "$event" = pull_request ] || [ "$event" = push ]; then
  if EVENT_NAME="$event" EVENT_BEFORE="${EVENT_BEFORE:-}" "$here/changed-files.sh" > /dev/null 2> "${TMPDIR:-/tmp}/doc-gate.err.$$"; then
    range_ok=true
    if [ "$event" = pull_request ]; then
      head2="$(git rev-parse --verify --quiet 'HEAD^2' || true)"
      if ! [[ "${PR_HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || [ "$head2" != "$PR_HEAD_SHA" ]; then
        range_ok=false
        reason="merge commit's second parent is not the PR head"
      fi
    fi
  else
    reason="$(head -c 120 "${TMPDIR:-/tmp}/doc-gate.err.$$" | tr '\n' ' ')"
  fi
  rm -f "${TMPDIR:-/tmp}/doc-gate.err.$$"
else
  reason="event ${event:-unknown} has no change range"
fi

if [ "$range_ok" = true ]; then
  echo "scanning documentation lines added between $(git rev-parse --short HEAD^1) and $(git rev-parse --short HEAD) (complete change)"
  git diff --unified=0 --no-renames HEAD^1 HEAD "${docs[@]}" | "$here/scan-doc-credentials.sh"
else
  echo "no verified change range ($reason); scanning every documentation file at HEAD (fail closed)"
  empty_tree="$(git hash-object -t tree /dev/null)"
  git diff --unified=0 --no-renames "$empty_tree" HEAD "${docs[@]}" | "$here/scan-doc-credentials.sh"
fi
