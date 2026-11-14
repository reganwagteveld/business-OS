#!/usr/bin/env bash
# Self-test for classify-changes.sh. Runs in the "Detect changes" job before the classifier is
# used, so a broken rule fails CI instead of silently skipping the desktop matrix.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fail=0

check() { # name, expected desktop value, files...
  local name="$1" expected="$2"; shift 2
  local actual
  actual="$(printf '%s\n' "$@" | "$here/classify-changes.sh" | sed -n 's/^desktop=//p')"
  if [ "$actual" = "$expected" ]; then
    echo "ok   $name (desktop=$actual)"
  else
    echo "FAIL $name: expected desktop=$expected, got $actual" >&2
    fail=1
  fi
}

check "application UI change"         false apps/web/src/routes/projects.tsx packages/app/src/projects/board.tsx
check "API change"                    false apps/api/src/app/api/v1/health/route.ts packages/contracts/src/index.ts
check "database migration"            false apps/api/prisma/migrations/20261115000000_x/migration.sql apps/api/prisma/schema.prisma
check "docs only"                     false docs/architecture.md README.md
check "desktop frontend source"       false apps/desktop/src/main.tsx
check "Rust source"                   true  apps/desktop/src-tauri/src/lib.rs
check "Tauri config"                  true  apps/desktop/src-tauri/tauri.conf.json
check "Tauri capabilities"            true  apps/desktop/src-tauri/capabilities/default.json
check "Cargo lockfile"                true  apps/desktop/src-tauri/Cargo.lock
check "Tauri config generator"        true  apps/desktop/scripts/tauri-config.mjs
check "desktop package manifest"      true  apps/desktop/package.json
check "desktop vite config"           true  apps/desktop/vite.config.ts
check "shared dependency (lockfile)"  true  packages/ui/package.json pnpm-lock.yaml
check "Node version"                  true  .nvmrc
check "CI workflow"                   true  .github/workflows/ci.yml
check "empty list fails closed"       true  ""

exit "$fail"
