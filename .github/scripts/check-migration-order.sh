#!/usr/bin/env bash
# Fails when a pull request adds a Prisma migration whose name sorts at or before the newest
# migration already on the base branch (STAB-01, docs/migration-readiness.md §4).
#
# Prisma applies pending migrations in name order. Three migrations on main carry future-dated
# names (20261118…, 20261119…), so `prisma migrate dev` run before those dates names a new
# migration so that it sorts BEFORE them. Production would apply it last (it is merely pending),
# while a fresh database (CI, a restore, a new region) would apply it earlier: two different
# histories for one set of files. This check makes CI refuse such a name; rename the folder so it
# sorts after the newest base migration.
#
# Usage: check-migration-order.sh <base-names-file> <head-names-file>
# Each file lists migration folder names, one per line (migration_lock.toml and blanks ignored).
set -euo pipefail
base_file="$1" head_file="$2"

clean() { grep -Ev '^(migration_lock\.toml)?$' "$1" | sort -u || true; }

newest_base="$(clean "$base_file" | tail -n 1)"
added="$(comm -13 <(clean "$base_file") <(clean "$head_file"))"

if [ -z "$added" ]; then
  echo "No new migrations."
  exit 0
fi

fail=0
while IFS= read -r name; do
  if ! [[ "$name" =~ ^[0-9]{14}_[a-z0-9_]+$ ]]; then
    echo "FAIL $name: expected <14-digit timestamp>_<snake_case_name>" >&2
    fail=1
  elif [ -n "$newest_base" ] && [[ ! "$name" > "$newest_base" ]]; then
    echo "FAIL $name sorts at or before $newest_base, the newest migration on the base branch." >&2
    echo "     Rename the folder so it sorts after $newest_base (keep the timestamp format)." >&2
    fail=1
  else
    echo "ok   $name (after ${newest_base:-nothing})"
  fi
done <<< "$added"
exit "$fail"
