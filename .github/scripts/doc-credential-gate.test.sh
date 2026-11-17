#!/usr/bin/env bash
# Self-test for doc-credential-gate.sh with throwaway git repositories shaped like the checkouts
# GitHub Actions produces (pull_request merge commit, single-step push, and every case without a
# trustworthy range). Fake credentials are assembled at run time so this file never matches.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0
cred="ghp_abcdefghijklmnopqrstuvwxyz0123456789"

new_repo() {
  rm -rf "$tmp/r" && mkdir "$tmp/r" && cd "$tmp/r" || exit 1
  git init -q -b main . && git config user.email t@example.invalid && git config user.name t
  mkdir -p docs packages/app
  echo "intro" > docs/a.md; echo x > packages/app/x.ts
  git add -A && git commit -qm base
}
commit() { git add -A && git commit -qm "$1"; }
# GitHub's pull_request checkout: a merge commit of the PR head into the base tip.
pr_merge() {
  git checkout -q main && git merge -q --no-ff --no-edit pr
}

# name, expected (pass|fail), then env assignments for the gate
expect() {
  local name="$1" want="$2" got=pass; shift 2
  env "$@" "$here/doc-credential-gate.sh" > "$tmp/out" 2>&1 || got=fail
  if [ "$got" = "$want" ]; then echo "ok   $name ($got)"; else echo "FAIL $name: expected $want, got $got" >&2; cat "$tmp/out" >&2; fail=1; fi
}
# The gate tier must be full whenever the range is not verified (no reduced tier without the scan's range).
expect_full_tier() {
  local name="$1" t; shift
  if env "$@" "$here/changed-files.sh" > "$tmp/files" 2>/dev/null; then
    t="$(env "$@" GATE_REF=refs/heads/main "$here/classify-gate-tier.sh" < "$tmp/files" | sed -n 's/^gate_tier=//p')"
  else t=full; fi
  if [ "$t" = full ]; then echo "ok   $name (gate tier full)"; else echo "FAIL $name: gate tier $t" >&2; fail=1; fi
}

# 1. Multi-commit PR: an early commit adds a credential, a later commit touches another file only.
new_repo
git checkout -q -b pr
echo "token $cred" >> docs/b.md; commit "add doc"
echo y >> packages/app/x.ts; commit "later client change"
head="$(git rev-parse HEAD)"
# The last commit alone is clean; this is the range the audit was worried about.
if git diff -U0 --no-renames HEAD^1 HEAD | "$here/scan-doc-credentials.sh" > /dev/null 2>&1; then
  echo "ok   last commit alone is clean (control)"; else echo "FAIL control" >&2; fail=1; fi
pr_merge
expect "multi-commit PR, credential in an earlier commit" fail EVENT_NAME=pull_request PR_HEAD_SHA="$head"

# 2. Same, docs-only PR (would be the docs tier).
new_repo
git checkout -q -b pr
echo "token $cred" >> docs/b.md; commit "add doc"
echo "more" >> docs/a.md; commit "later doc change"
head="$(git rev-parse HEAD)"; pr_merge
expect "docs-only multi-commit PR, credential in an earlier commit" fail EVENT_NAME=pull_request PR_HEAD_SHA="$head"

# 3. Credential added then removed in a later commit: not in the proposed change, no false positive.
new_repo
git checkout -q -b pr
echo "token $cred" >> docs/b.md; commit "add doc"
echo "clean" > docs/b.md; commit "remove it"
head="$(git rev-parse HEAD)"; pr_merge
expect "credential added then removed within the PR" pass EVENT_NAME=pull_request PR_HEAD_SHA="$head"

# 4. Clean multi-commit PR.
new_repo
git checkout -q -b pr
echo "notes" >> docs/b.md; commit one; echo y >> packages/app/x.ts; commit two
head="$(git rev-parse HEAD)"; pr_merge
expect "clean multi-commit PR" pass EVENT_NAME=pull_request PR_HEAD_SHA="$head"

# 5. PR head mismatch or missing: falls back to scanning every doc at HEAD (clean repo passes,
#    a credential anywhere in docs fails).
expect "PR head mismatch, clean tree" pass EVENT_NAME=pull_request PR_HEAD_SHA=0123456789012345678901234567890123456789
expect "PR head missing, clean tree" pass EVENT_NAME=pull_request PR_HEAD_SHA=
new_repo
git checkout -q -b pr
echo "token $cred" >> docs/b.md; commit "add doc"
pr_merge
expect "PR head mismatch, credential in tree" fail EVENT_NAME=pull_request PR_HEAD_SHA=0123456789012345678901234567890123456789

# 6. pull_request checkout that is not a merge commit: whole-tree scan, gate tier full.
new_repo
echo "token $cred" >> docs/b.md; commit "direct"
expect "PR checkout without merge commit, credential in tree" fail EVENT_NAME=pull_request PR_HEAD_SHA="$(git rev-parse HEAD)"
expect_full_tier "PR checkout without merge commit" EVENT_NAME=pull_request

# 7. Push to main, single step (a merged PR): the merge's own diff.
new_repo
before="$(git rev-parse HEAD)"
echo "token $cred" >> docs/b.md; commit "squash merge"
expect "single-step push adding a credential" fail EVENT_NAME=push EVENT_BEFORE="$before"
new_repo
before="$(git rev-parse HEAD)"
echo "notes" >> docs/b.md; commit "squash merge"
expect "single-step push, clean" pass EVENT_NAME=push EVENT_BEFORE="$before"

# 8. Multi-commit push: the credential is in the earlier commit; whole-tree scan catches it,
#    and the gate tier is full.
new_repo
before="$(git rev-parse HEAD)"
echo "token $cred" >> docs/b.md; commit one
echo y >> packages/app/x.ts; commit two
expect "multi-commit push, credential in an earlier commit" fail EVENT_NAME=push EVENT_BEFORE="$before"
expect_full_tier "multi-commit push" EVENT_NAME=push EVENT_BEFORE="$before"

# 9. Push without a usable before (new branch, zero sha) and other events: whole-tree scan.
expect "push with zero before, credential in tree" fail EVENT_NAME=push EVENT_BEFORE=0000000000000000000000000000000000000000
expect_full_tier "push with zero before" EVENT_NAME=push EVENT_BEFORE=0000000000000000000000000000000000000000
expect "workflow_dispatch, credential in tree" fail EVENT_NAME=workflow_dispatch
expect "schedule, credential in tree" fail EVENT_NAME=schedule
new_repo
expect "workflow_dispatch, clean tree" pass EVENT_NAME=workflow_dispatch

# 10. Code files are out of scope in both modes (secret scanning covers them).
new_repo
echo "const k = '$cred'" > packages/app/k.ts; commit code
expect "credential-shaped string in code, whole-tree mode" pass EVENT_NAME=schedule

exit "$fail"
