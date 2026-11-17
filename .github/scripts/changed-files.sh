#!/usr/bin/env bash
# Prints the files changed by the event under test, NUL-separated, for classify-changes.sh.
# Renames and copies are reported as a deletion plus an addition (--no-renames), so moving code
# into docs/ lists the code path too. Exits non-zero when the diff cannot be established with
# certainty; the caller then selects the full tier.
#
#   pull_request  HEAD is the merge commit; its first parent is the current base tip.
#   push          HEAD must be a commit whose first parent is the commit the push replaced
#                 (EVENT_BEFORE). Anything else (multi-commit push, force push, new branch) fails.
set -euo pipefail

event="${EVENT_NAME:?EVENT_NAME is required}"
git rev-parse --verify --quiet HEAD >/dev/null || { echo "no HEAD commit" >&2; exit 1; }
parents="$(git rev-list --parents -n 1 HEAD | wc -w)"   # sha + parents

case "$event" in
  pull_request)
    if [ "$parents" -ne 3 ]; then
      echo "Expected a merge commit for the pull request checkout" >&2
      exit 1
    fi
    ;;
  push)
    before="${EVENT_BEFORE:-}"
    if ! [[ "$before" =~ ^[0-9a-f]{40}$ ]] || [ "$before" = "0000000000000000000000000000000000000000" ]; then
      echo "push has no usable 'before' commit" >&2
      exit 1
    fi
    if [ "$parents" -lt 2 ]; then
      echo "pushed commit has no parent" >&2
      exit 1
    fi
    if [ "$(git rev-parse HEAD^1)" != "$before" ]; then
      echo "push is not a single step from the previous tip (fail closed)" >&2
      exit 1
    fi
    ;;
  *)
    echo "event $event is always fully validated" >&2
    exit 1
    ;;
esac

git diff --name-only --no-renames -z HEAD^1 HEAD
