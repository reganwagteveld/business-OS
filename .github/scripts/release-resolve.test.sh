#!/usr/bin/env bash
# Self-test for release-resolve.sh using a throwaway repository.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp" && git init -q -b main . && git config user.email t@example.invalid && git config user.name t
git commit -q --allow-empty -m one; one="$(git rev-parse HEAD)"
git commit -q --allow-empty -m two; two="$(git rev-parse HEAD)"
git update-ref refs/remotes/origin/main "$two"
git checkout -q -b side "$one"; git commit -q --allow-empty -m side; side="$(git rev-parse HEAD)"
bad=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef

check() { # name expected(pass|fail) env...
  local name="$1" want="$2"; shift 2
  local got=pass
  env -i PATH="$PATH" HOME="$HOME" "$@" "$here/release-resolve.sh" > /dev/null 2>&1 || got=fail
  if [ "$got" = "$want" ]; then echo "ok   $name ($got)"; else echo "FAIL $name: expected $want, got $got" >&2; fail=1; fi
}
check "tag on main tip"              pass EVENT_NAME=push GITHUB_SHA="$two"
check "tag on older main commit"     pass EVENT_NAME=push GITHUB_SHA="$one"
check "tag on unmerged commit"       fail EVENT_NAME=push GITHUB_SHA="$side"
check "manual, matching expected"    pass EVENT_NAME=workflow_dispatch GITHUB_SHA="$two" EXPECTED_SHA="$two"
check "manual, expected mismatch"    fail EVENT_NAME=workflow_dispatch GITHUB_SHA="$two" EXPECTED_SHA="$one"
check "manual, expected missing"     fail EVENT_NAME=workflow_dispatch GITHUB_SHA="$two"
check "manual, expected short"       fail EVENT_NAME=workflow_dispatch GITHUB_SHA="$two" EXPECTED_SHA="${two:0:7}"
check "manual, expected upper case"  fail EVENT_NAME=workflow_dispatch GITHUB_SHA="$two" EXPECTED_SHA="$(echo "$two" | tr a-f A-F)"
check "manual, unmerged commit"      fail EVENT_NAME=workflow_dispatch GITHUB_SHA="$side" EXPECTED_SHA="$side"
check "unknown commit"               fail EVENT_NAME=push GITHUB_SHA="$bad"
check "malformed commit"             fail EVENT_NAME=push GITHUB_SHA="main"
check "missing commit"               fail EVENT_NAME=push
check "main ref unreadable"          fail EVENT_NAME=push GITHUB_SHA="$two" MAIN_REF=origin/nope
check "pull request head"            pass EVENT_NAME=pull_request PR_HEAD_SHA="$side"
check "pull request head missing"    fail EVENT_NAME=pull_request
check "schedule event"               fail EVENT_NAME=schedule GITHUB_SHA="$two"
check "event missing"                fail GITHUB_SHA="$two"
exit "$fail"
