#!/usr/bin/env bash
# Self-test for check-migration-order.sh. Runs in the "Detect changes" job before the check is used.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail=0
base=(migration_lock.toml 20261113140000_identity 20261118050000_scheduling 20261119300000_communications)
printf '%s\n' "${base[@]}" > "$tmp/base"

run() { # name, expected exit (0|1); reads $tmp/head
  local name="$1" expected="$2"
  local actual=0
  "$here/check-migration-order.sh" "$tmp/base" "$tmp/head" > /dev/null 2>&1 || actual=$?
  if [ "$actual" = "$expected" ]; then echo "ok   $name"; else echo "FAIL $name: expected exit $expected, got $actual" >&2; fail=1; fi
}
check() { # name, expected exit, added names...: head = every base migration plus the added ones
  local name="$1" expected="$2"; shift 2
  { printf '%s\n' "${base[@]}"; printf '%s\n' "$@"; } > "$tmp/head"
  run "$name" "$expected"
}
without() { # name, expected exit, removed base name, added names...: head = base minus one, plus additions
  local name="$1" expected="$2" gone="$3"; shift 3
  { printf '%s\n' "${base[@]}" | grep -vx "$gone"; printf '%s\n' "$@"; } > "$tmp/head"
  run "$name" "$expected"
}

check "no new migration"                              0
check "new migration after the newest"                0 20261120000000_invoices_due
check "two new migrations after the newest"           0 20261120000000_a 20261120000001_b
check "named by migrate dev today (sorts earlier)"    1 20261115070000_new_table
check "equal to the newest timestamp, earlier name"   1 20261119300000_aaa
check "one good, one early"                           1 20261120000000_ok 20261116000000_early
check "not a Prisma migration name"                   1 add_column
check "uppercase name"                                1 20261120000000_AddColumn
# Deleted or renamed base migrations (STAB-A01).
without "deleted newest base migration"              1 20261119300000_communications
without "deleted older base migration"               1 20261113140000_identity
without "renamed base migration, same timestamp"     1 20261118050000_scheduling 20261118050000_scheduling_core
without "renamed base migration to a later name"     1 20261118050000_scheduling 20261120000000_scheduling
without "deleted one and added a valid new one"      1 20261113140000_identity 20261120000000_ok
without "migration_lock.toml removed is not a migration" 0 migration_lock.toml
exit "$fail"
