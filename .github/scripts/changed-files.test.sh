#!/usr/bin/env bash
# Self-test for changed-files.sh and its pairing with classify-changes.sh, using throwaway git
# repositories. Covers renames, deletions, mixed changes and every case where the diff cannot be
# trusted (those must end in the full tier, never in a skipped native matrix).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0
ZERO=0000000000000000000000000000000000000000

new_repo() {
  rm -rf "$tmp/r" && mkdir "$tmp/r" && cd "$tmp/r" || exit 1
  git init -q . && git config user.email t@example.invalid && git config user.name t
  mkdir -p docs apps/desktop/src-tauri/src packages/app
  echo a > docs/a.md; echo fn > apps/desktop/src-tauri/src/lib.rs; echo x > packages/app/x.ts
  git add -A && git commit -qm base
}

# run name, event, expected desktop/tier ("fail" when the diff itself must be refused)
verdict() {
  local name="$1" event="$2" expected="$3" before="${4:-}"
  local out actual files="$tmp/files"
  if EVENT_NAME="$event" EVENT_BEFORE="$before" "$here/changed-files.sh" > "$files" 2>/dev/null; then
    out="$(EVENT_NAME="$event" "$here/classify-changes.sh" < "$files")"
    actual="$(echo "$out" | sed -n 's/^desktop=//p')/$(echo "$out" | sed -n 's/^tier=//p')"
  else
    actual=fail
  fi
  if [ "$actual" = "$expected" ]; then echo "ok   $name ($actual)"; else echo "FAIL $name: expected $expected, got $actual" >&2; fail=1; fi
}

# A pull request checkout is a merge commit: first parent = base tip.
as_pr() { # commit the working tree on a side branch, then merge it into base with a merge commit
  local base; base="$(git rev-parse HEAD)"
  git checkout -q -b side && git add -A && git commit -qm change
  git checkout -q "$base" && git merge -q --no-ff side -m merge
}
as_push() { git add -A && git commit -qm change; }

new_repo; echo b >> docs/a.md; as_pr
verdict "PR: markdown edit"                      pull_request false/docs
new_repo; echo b >> apps/desktop/src-tauri/src/lib.rs; as_pr
verdict "PR: desktop source"                     pull_request true/full
new_repo; echo b >> packages/app/x.ts; as_pr
verdict "PR: shared code"                        pull_request true/full
new_repo; echo b >> docs/a.md; echo b >> packages/app/x.ts; as_pr
verdict "PR: mixed docs and source"              pull_request true/full
new_repo; git mv apps/desktop/src-tauri/src/lib.rs docs/lib.md; as_pr
verdict "PR: code renamed into docs"             pull_request true/full
new_repo; git rm -q apps/desktop/src-tauri/src/lib.rs; as_pr
verdict "PR: native source deleted"              pull_request true/full
new_repo; git rm -q docs/a.md; as_pr
verdict "PR: docs deleted"                       pull_request false/docs
new_repo; git mv docs/a.md docs/b.md; as_pr
verdict "PR: docs renamed within docs"           pull_request false/docs
new_repo; git mv docs/a.md apps/desktop/src-tauri/src/a.md; as_pr
verdict "PR: docs moved into native tree"        pull_request true/full
new_repo; git checkout -q -b empty; git commit -q --allow-empty -m e; git checkout -q -; git merge -q --no-ff empty -m merge
verdict "PR: empty diff"                         pull_request true/full
new_repo; echo b >> docs/a.md; git add -A; git commit -qm c
verdict "PR: checkout is not a merge commit"     pull_request fail

new_repo; before="$(git rev-parse HEAD)"; echo b >> docs/a.md; as_push
verdict "push: docs-only commit"                 push false/docs "$before"
new_repo; before="$(git rev-parse HEAD)"; echo b >> packages/app/x.ts; as_push
verdict "push: shared code"                      push true/full "$before"
new_repo; before="$(git rev-parse HEAD)"; echo b >> docs/a.md; as_push; echo c >> packages/app/x.ts; as_push
verdict "push: two commits, last is docs-only"   push fail "$before"
new_repo; echo b >> docs/a.md; as_push
verdict "push: new branch (before is zeros)"     push fail "$ZERO"
verdict "push: before missing"                   push fail ""
verdict "push: before is garbage"                push fail "not-a-sha"
new_repo; echo b >> docs/a.md; as_push
verdict "push: before is a different commit"     push fail "$(printf 'a%.0s' $(seq 40))"
verdict "scheduled run"                          schedule fail ""
verdict "manual run"                             workflow_dispatch fail ""

# CIQ-A4: the macOS leg, through real git diffs (renames are a deletion plus an addition). Expected
# "desktop/macos"; "fail" means the diff is refused and the workflow keeps all three platforms.
macv() {
  local name="$1" event="$2" expected="$3" before="${4:-}"
  local out actual files="$tmp/files"
  if EVENT_NAME="$event" EVENT_BEFORE="$before" "$here/changed-files.sh" > "$files" 2>/dev/null; then
    out="$(EVENT_NAME="$event" "$here/classify-changes.sh" < "$files")"
    actual="$(echo "$out" | sed -n 's/^desktop=//p')/$(echo "$out" | sed -n 's/^macos=//p')"
  else
    actual=fail
  fi
  if [ "$actual" = "$expected" ]; then echo "ok   macOS: $name ($actual)"; else echo "FAIL macOS: $name: expected $expected, got $actual" >&2; fail=1; fi
}
new_repo; echo b >> packages/app/x.ts; as_pr
macv "PR: shared client source"                  pull_request true/false
new_repo; echo b >> packages/app/x.ts; echo b >> docs/a.md; echo n > packages/app/new.ts; as_pr
macv "PR: client edit, new client file and docs" pull_request true/false
new_repo; git rm -q packages/app/x.ts; as_pr
macv "PR: client source deleted"                 pull_request true/false
new_repo; git rm -q apps/desktop/src-tauri/src/lib.rs; as_pr
macv "PR: native source deleted"                 pull_request true/true
new_repo; mkdir -p apps/desktop/src; git mv packages/app/x.ts apps/desktop/src/x.ts; as_pr
macv "PR: client file renamed into desktop app"  pull_request true/true
new_repo; git mv apps/desktop/src-tauri/src/lib.rs packages/app/lib.ts; as_pr
macv "PR: Rust file renamed into a package"      pull_request true/true
new_repo; echo b >> packages/app/x.ts; echo '{}' > pnpm-lock.yaml; as_pr
macv "PR: client source plus lockfile"           pull_request true/true
new_repo; echo b >> packages/app/x.ts; mkdir -p .github/workflows; echo x > .github/workflows/ci.yml; as_pr
macv "PR: client source plus CI config"          pull_request true/true
new_repo; echo b >> packages/app/x.ts; mkdir -p release; echo x > release/notes.sh; as_pr
macv "PR: client source plus unfamiliar path"    pull_request true/true
new_repo; echo b >> packages/app/x.ts; echo x > packages/app/build.mjs; as_pr
macv "PR: client source plus package script"     pull_request true/true
new_repo; echo b >> packages/app/x.ts; git add -A; git commit -qm c
macv "PR: checkout is not a merge commit"        pull_request fail
new_repo; before="$(git rev-parse HEAD)"; echo b >> packages/app/x.ts; as_push
macv "push: shared client source"                push true/true "$before"

exit "$fail"
