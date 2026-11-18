#!/usr/bin/env bash
# Self-test for release-nightly-status.sh with a fake `gh`. Proves pagination: a blocking issue on page 3 of
# 250 open issues must still block, and any API failure must not read as clear.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
cat > "$tmp/bin/gh" <<'FAKE'
#!/usr/bin/env bash
# FAKE_ISSUES: none | far | pr | exact_only_in_other_title | apifail ; FAKE_RUN: success | failure | none | fail
case "$1" in
  api)
    [ "$FAKE_ISSUES" = apifail ] && exit 1
    for page in 1 2 3; do
      printf '['
      for i in $(seq 1 100); do
        [ "$i" -gt 1 ] && printf ','
        t="Unrelated issue $page-$i"; pr=''
        if [ "$page" = 3 ] && [ "$i" = 77 ]; then
          case "$FAKE_ISSUES" in
            far) t="Nightly validation failed" ;;
            pr) t="Nightly validation failed"; pr=',"pull_request":{"url":"x"}' ;;
            exact_only_in_other_title) t="Nightly validation failed (old note)" ;;
          esac
        fi
        printf '{"number":%d,"title":"%s"%s}' "$((page * 1000 + i))" "$t" "$pr"
      done
      printf ']\n'
    done ;;
  run)
    [ "$FAKE_RUN" = fail ] && exit 1
    echo "$FAKE_RUN" ;;
esac
FAKE
chmod +x "$tmp/bin/gh"
check() { # name want issues run
  local got
  got="$(PATH="$tmp/bin:$PATH" REPO=o/r FAKE_ISSUES="$3" FAKE_RUN="$4" "$here/release-nightly-status.sh" 2> /dev/null | tail -n1)"
  if [ "$got" = "status=$2" ]; then echo "ok   $1 ($got)"; else echo "FAIL $1: expected status=$2, got $got" >&2; fail=1; fi
}
check "no blocking issue, last nightly success"        clear   none success
check "blocking issue on page 3 of 300 open issues"    blocked far  success
check "pull request with the same title is not an issue" clear  pr   success
check "similar but not exact title is not blocking"     clear   exact_only_in_other_title success
check "latest nightly failed"                           blocked none failure
check "no completed nightly run yet"                    unknown none none
check "issue API failure"                               unknown apifail success
check "run list failure"                                unknown none fail
exit "$fail"
