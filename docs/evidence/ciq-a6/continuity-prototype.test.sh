#!/usr/bin/env bash
# CIQ-A6 evidence: synthetic scenarios for continuity-prototype.py, in a throwaway repository.
# Usage: docs/evidence/ciq-a6/continuity-prototype.test.sh   (needs git >= 2.40 and python3)
set -euo pipefail
PROTO="$(cd "$(dirname "$0")" && pwd)/continuity-prototype.py"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cd "$T"; git init -q -b main; git config user.email t@example.invalid; git config user.name t
w() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" > "$1"; }
commit() { git add -A; git commit -qm "$1"; git rev-parse HEAD; }

# Base: an app shell with a zone list, a permission file and a notes file.
w app.tsx 'export function App({ customers: c, finance: f, dashboard: d }) {'$'\n''  return render(c, f, d);'$'\n''}'
w registry.ts "export type ZoneId = 'customers' | 'finance' | 'settings';"
w permissions.ts 'export const canEdit = (role) => role === "owner" || role === "admin";'
w notes.md 'one'
BASE=$(commit base)

pass=0; fail=0
expect() { # name expected approved candidate [approved_base]
  local name=$1 want=$2; shift 2
  local got; got=$(MAIN=main python3 -I "$PROTO" "$@" | head -1 | awk '{print $4}')
  if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "ok   $name: $got"; else fail=$((fail+1)); echo "FAIL $name: want $want got $got"; MAIN=main python3 -I "$PROTO" "$@" | sed 's/^/     /'; fi
}
branch() { git checkout -q -B "$1" "$2"; }
sync() { git merge -q --no-edit main >/dev/null 2>&1 || true; }

# PR: adds Settings to the signature (audited head A).
branch pr "$BASE"
w app.tsx 'export function App({ customers: c, finance: f, settings: s, dashboard: d }) {'$'\n''  return render(c, f, s, d);'$'\n''}'
A=$(commit "pr: settings")

# 1. main changes an unrelated file; clean sync.
git checkout -q main; w notes.md 'two'; commit "main: notes" >/dev/null
branch c1 "$A"; sync; C1=$(git rev-parse HEAD)
expect "1 clean sync keeps approval" APPROVAL_CONTINUES "$A" "$C1"
expect "2 unchanged PR, new head, same verdict reused" APPROVAL_CONTINUES "$A" "$C1"

# 3. main adds Scheduling to the same signature; the resolution keeps both (composition).
git checkout -q main
w app.tsx 'export function App({ customers: c, finance: f, scheduling: sc, dashboard: d }) {'$'\n''  return render(c, f, sc, d);'$'\n''}'
commit "main: scheduling" >/dev/null
branch c3 "$A"; git merge -q --no-edit main >/dev/null 2>&1 || true
w app.tsx 'export function App({ customers: c, finance: f, scheduling: sc, settings: s, dashboard: d }) {'$'\n''  return render(c, f, sc, s, d);'$'\n''}'
C3=$(commit "resolve: keep both")
expect "3 Settings/Scheduling composition retained" INTEGRATION_VALIDATION_REQUIRED "$A" "$C3"

# 4. Same conflict, but the resolution drops Scheduling (substantive).
branch c4 "$A"; git merge -q --no-edit main >/dev/null 2>&1 || true
w app.tsx 'export function App({ customers: c, finance: f, settings: s, dashboard: d }) {'$'\n''  return render(c, f, s, d);'$'\n''}'
C4=$(commit "resolve: drop scheduling")
expect "4 substantive resolution -> focused re-audit" FOCUSED_REAUDIT_REQUIRED "$A" "$C4"

# 5. A sync commit that also edits the permission rule.
branch c5 "$C3"; w permissions.ts 'export const canEdit = (role) => true;'
C5=$(commit "sneak permission change")
expect "5 changed permission cannot inherit" FOCUSED_REAUDIT_REQUIRED "$A" "$C5"

# 6. A sync commit that adds a migration.
branch c6 "$C3"; w apps/api/prisma/migrations/20990101000000_x/migration.sql 'DROP TABLE customers;'
C6=$(commit "add migration")
expect "6 unapproved migration cannot inherit" FOCUSED_REAUDIT_REQUIRED "$A" "$C6"

# 8. Stale candidate: main moved after the sync.
git checkout -q main; w notes.md 'three'; commit "main: later" >/dev/null
expect "8 stale candidate is blocked" BLOCKED "$A" "$C3"

# 12. Main and PR both rewrite the same permission tokens; candidate takes the PR side.
git checkout -q main; w permissions.ts 'export const canEdit = (role) => role === "owner";'; commit "main: tighten" >/dev/null
branch pr2 "$BASE"; w permissions.ts 'export const canEdit = (role) => role === "owner" || role === "manager";'
A2=$(commit "pr2: manager")
branch c12 "$A2"; git merge -q --no-edit main >/dev/null 2>&1 || true
w permissions.ts 'export const canEdit = (role) => role === "owner" || role === "manager";'; C12=$(commit "resolve: ours")
expect "12 overlapping security edit -> focused re-audit" FOCUSED_REAUDIT_REQUIRED "$A2" "$C12"

# Stacked PR: audited delta taken against its parent PR's head; parent squash-merged later.
branch child "$A"; w team.tsx 'export const Team = () => null;'; AC=$(commit "child")
git checkout -q main; git merge -q --squash c3 >/dev/null 2>&1 || true; git commit -qm "squash parent" >/dev/null 2>&1 || true
branch c13 "$AC"; git merge -q --no-edit main >/dev/null 2>&1 || true
git checkout -q main -- app.tsx; git add -A; git commit -qm "resolve child: take main's app.tsx" >/dev/null 2>&1 || true; C13=$(git rev-parse HEAD)
expect "13 stacked delta after parent squash" APPROVAL_CONTINUES "$AC" "$C13" "$A"

# 13b. Same stacked child, but the resolution also drops a line main added (substantive).
branch c13b "$C13"; w notes.md 'one'; C13B=$(commit "drop main's notes change")
expect "13b stacked child dropping main content -> focused re-audit" FOCUSED_REAUDIT_REQUIRED "$AC" "$C13B" "$A"

echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
