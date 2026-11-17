#!/usr/bin/env bash
# Resolves and validates the release candidate commit. Run inside a full-history checkout.
# Inputs: EVENT_NAME, GITHUB_SHA (commit the workflow run was started for), PR_HEAD_SHA (pull_request only),
#   EXPECTED_SHA (manual runs: the 40-character SHA the operator expects), MAIN_REF (default origin/main).
# Output: prints `sha=<candidate>` and exits 0, or exits non-zero with an error. Fail closed.
#  - tag pushes and manual runs: the candidate is the commit the run started on; it must be an ancestor
#    of (or equal to) main, so a release can only be cut from reviewed, merged code.
#  - manual runs also require EXPECTED_SHA to equal that commit, so a stale or mistyped SHA cannot validate
#    a different commit than the operator meant.
#  - pull_request runs (workflow self-validation only) use the PR head and are not release evidence.
set -uo pipefail
main_ref="${MAIN_REF:-origin/main}"
sha_re='^[0-9a-f]{40}$'
die() { echo "::error title=Release candidate::$1" >&2; exit 1; }

case "${EVENT_NAME:-}" in
  pull_request)
    [[ "${PR_HEAD_SHA:-}" =~ $sha_re ]] || die "pull request head SHA is missing or malformed"
    echo "sha=$PR_HEAD_SHA"
    exit 0
    ;;
  push|workflow_dispatch) ;;
  *) die "event '${EVENT_NAME:-}' is not a release validation trigger" ;;
esac

[[ "${GITHUB_SHA:-}" =~ $sha_re ]] || die "run commit is missing or malformed"
if [ "$EVENT_NAME" = workflow_dispatch ]; then
  [[ "${EXPECTED_SHA:-}" =~ $sha_re ]] || die "manual runs need the full 40-character expected SHA (lower case)"
  [ "$EXPECTED_SHA" = "$GITHUB_SHA" ] || die "expected SHA $EXPECTED_SHA does not match the commit this run started on ($GITHUB_SHA). Run the workflow from the ref that points at the candidate."
fi
git cat-file -e "$GITHUB_SHA^{commit}" 2>/dev/null || die "commit $GITHUB_SHA is not in the checkout"
git rev-parse --verify -q "$main_ref" > /dev/null || die "cannot read $main_ref"
git merge-base --is-ancestor "$GITHUB_SHA" "$main_ref" || die "commit $GITHUB_SHA is not on main (not an ancestor of $main_ref); release candidates must come from merged code"
echo "sha=$GITHUB_SHA"
