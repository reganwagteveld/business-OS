#!/usr/bin/env bash
# Self-test for check-migration-order.sh. Runs in the "Detect changes" job before the check is used.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail=0
base=(migration_lock.toml 20261113140000_identity 20261118050000_scheduling 20261119300000_communications)
printf '%s\n' "${base[@]}" > "$tmp/base"

check() { # name, expected exit (0|1), added names...
  local name="$1" expected="$2"; shift 2
  { printf '%s\n' "${base[@]}"; printf '%s\n' "$@"; } > "$tmp/head"
  local actual=0
  "$here/check-migration-order.sh" "$tmp/base" "$tmp/head" > /dev/null 2>&1 || actual=$?
  if [ "$actual" = "$expected" ]; then echo "ok   $name"; else echo "FAIL $name: expected exit $expected, got $actual" >&2; fail=1; fi
}

check "no new migration"                              0
check "new migration after the newest"                0 20261120000000_invoices_due
check "two new migrations after the newest"           0 20261120000000_a 20261120000001_b
check "named by migrate dev today (sorts earlier)"    1 20261115070000_new_table
check "equal to the newest timestamp, earlier name"   1 20261119300000_aaa
check "one good, one early"                           1 20261120000000_ok 20261116000000_early
check "not a Prisma migration name"                   1 add_column
check "uppercase name"                                1 20261120000000_AddColumn
exit "$fail"
