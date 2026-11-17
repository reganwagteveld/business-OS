#!/usr/bin/env bash
# Self-test for the offline verdict parser in verdict-status.sh. No network.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
H=0123456789abcdef0123456789abcdef01234567
H2=fedcba9876543210fedcba9876543210fedcba98
T=2026-11-17T12:00:00Z

# name, expected count of valid verdicts, pr, slug, created, updated, body
check() {
  local json got
  json="$(jq -n --arg slug "$4" --arg c "$5" --arg u "$6" --arg b "$7" \
    '[{id:1, html_url:"u", created_at:$c, updated_at:$u, body:$b, performed_via_github_app:(if $slug == "" then null else {slug:$slug} end)}]')"
  got="$(echo "$json" | "$here/verdict-status.sh" --parse "$3" | grep -c . || true)"
  if [ "$got" = "$2" ]; then echo "ok   $1 ($got)"; else echo "FAIL $1: expected $2, got $got" >&2; fail=1; fi
}
C=chatgpt-codex-connector
check "plain verdict"                 1 119 $C $T $T "APPROVED — EXECUTE: MERGE
PR #119
Exact reviewed head SHA: \`$H\`"
check "heading verdict"               1 141 $C $T $T "## APPROVED — EXECUTE: MERGE
PR #141
**Exact approved/reviewed head:** \`$H\`"
check "bold verdict"                  1 1 $C $T $T "**APPROVED — EXECUTE: MERGE**
PR #1

**Exact reviewed head:** \`$H\`."
check "leading blank lines"           1 1 $C $T $T "

APPROVED — EXECUTE: MERGE
PR #1 head $H"
check "claude app"                    0 1 claude $T $T "APPROVED — EXECUTE: MERGE
head $H"
check "posted by hand (no app)"       0 1 "" $T $T "APPROVED — EXECUTE: MERGE
head $H"
check "edited"                        0 1 $C $T 2026-11-17T12:05:00Z "APPROVED — EXECUTE: MERGE
head $H"
check "conditional pass"              0 1 $C $T $T "CONDITIONAL PASS
head $H"
check "audit pass"                    0 1 $C $T $T "AUDIT PASS — PR #1
head $H"
check "negated verdict"               0 1 $C $T $T "Disposition: HOLD, not \`APPROVED — EXECUTE: MERGE\`
head $H"
check "verdict not on first line"     0 1 $C $T $T "## ChatGPT final re-audit
**APPROVED — EXECUTE: MERGE** through the queue
head $H"
check "verdict with trailing words"   0 1 $C $T $T "APPROVED — EXECUTE: MERGE (pending CI)
head $H"
check "hyphen instead of em dash"     0 1 $C $T $T "APPROVED - EXECUTE: MERGE
head $H"
check "migration verdict"             0 1 $C $T $T "APPROVED — EXECUTE: MIGRATION
head $H"
check "quoted verdict"                0 1 $C $T $T "> APPROVED — EXECUTE: MERGE
head $H"
check "no head SHA"                   0 1 $C $T $T "APPROVED — EXECUTE: MERGE
PR #1"
check "short SHA only"                0 1 $C $T $T "APPROVED — EXECUTE: MERGE
head ${H:0:7}"
check "two different head SHAs"       0 1 $C $T $T "APPROVED — EXECUTE: MERGE
head $H
previous head $H2"
check "base SHA on a non-head line"   1 1 $C $T $T "APPROVED — EXECUTE: MERGE
PR #1
Exact reviewed head SHA: $H
Reviewed base SHA: $H2"
check "names another PR"              0 120 $C $T $T "APPROVED — EXECUTE: MERGE
PR #119
head $H"
check "workflow run number is not a PR" 1 123 $C $T $T "APPROVED — EXECUTE: MERGE
PR #123, audited head $H, CI run #44110822911 succeeded"
check "names this PR"                 1 120 $C $T $T "APPROVED — EXECUTE: MERGE
**PR #120 mailbox UI; exact reviewed head \`$H\`.**"
check "names no PR"                    0 1 $C $T $T "APPROVED — EXECUTE: MERGE
Exact reviewed head SHA: $H"
check "names no PR, offline listing"  1 "" $C $T $T "APPROVED — EXECUTE: MERGE
Exact reviewed head SHA: $H"

# ready: name, expected (true|false|none), body after the verdict and head lines
ready() {
  local r
  r="$(jq -n --arg b "APPROVED — EXECUTE: MERGE
PR #1, exact reviewed head $H
$3" '[{id:1,html_url:"u",created_at:"t",updated_at:"t",body:$b,performed_via_github_app:{slug:"chatgpt-codex-connector"}}]' \
    | "$here/verdict-status.sh" --parse 1 | jq -r .ready)"
  [ -n "$r" ] || r=none
  if [ "$r" = "$2" ]; then echo "ok   ready: $1 ($r)"; else echo "FAIL ready: $1: expected $2, got $r" >&2; fail=1; fi
}
ready "dedicated line"                       true  "Ready and merge this draft PR through the serialized merge queue, within the scope below."
ready "dedicated line, bold label"           true  "**Ready and merge** this draft PR through the merge queue."
ready "dedicated list item"                  true  "- Ready and merge this draft PR."
ready "absent"                               false ""
ready "negated: do NOT ready and merge"      false "Do NOT ready and merge this PR."
ready "negated on the dedicated line"        false "Ready and merge is not authorised yet."
ready "never"                                false "Never ready and merge before main CI."
ready "conditional: if"                      false "Ready and merge if Regan agrees."
ready "conditional: once"                    false "Ready and merge once #140 lands."
ready "conditional: until"                   false "Ready and merge, but not until CI is green."
ready "conditional: subject to"              false "Ready and merge subject to owner approval."
ready "conditional: pending"                 false "Ready and merge pending the macOS job."
ready "contradiction elsewhere"              false "Ready and merge this draft PR.
Do not ready and merge before the owner replies."
ready "quoted historical phrase"             false "> Ready and merge this draft PR."
ready "quoted negation does not veto"        true  "Ready and merge this draft PR.
> earlier: do not ready and merge"
ready "mid-sentence phrase is not a directive" false "The serialized merge queue may ready and merge only this patch."
ready "inline code mention"                  false "This is an explicit \`ready and merge\` approval."
ready "different phrase"                     false "Mark ready; merge later."
exit "$fail"
