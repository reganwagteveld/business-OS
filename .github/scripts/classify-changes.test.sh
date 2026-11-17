#!/usr/bin/env bash
# Self-test for classify-changes.sh. Runs in the "Detect changes" job before the classifier is
# used, so a broken rule fails CI instead of silently skipping the desktop matrix.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fail=0

# name, event, expected "desktop/tier", then changed paths (fed NUL-separated, as git prints them).
check() {
  local name="$1" event="$2" expected="$3"; shift 3
  local out actual
  out="$( (if [ "$#" -gt 0 ]; then printf '%s\0' "$@"; fi) | EVENT_NAME="$event" "$here/classify-changes.sh")"
  actual="$(echo "$out" | sed -n 's/^desktop=//p')/$(echo "$out" | sed -n 's/^tier=//p')"
  if [ "$actual" = "$expected" ]; then
    echo "ok   $name ($actual)"
  else
    echo "FAIL $name: expected $expected, got $actual" >&2
    fail=1
  fi
}
PR=pull_request

# 1. Documentation-only changes skip the native matrix, on pull requests and on pushes.
check "markdown edit under docs"        $PR   false/docs docs/architecture.md
check "markdown edit, push to main"     push  false/docs docs/architecture.md
check "root markdown"                   $PR   false/docs README.md CLAUDE.md
check "nested docs and image"           $PR   false/docs docs/ui/guide.md docs/brand/logo.svg docs/evidence/shot.png
check "docs, scheduled run"             schedule true/full docs/architecture.md
check "docs, manual run"                workflow_dispatch true/full docs/architecture.md

# 2. Desktop source, shared code and desktop build configuration trigger the matrix.
check "desktop frontend source"         $PR   true/full apps/desktop/src/main.tsx
check "Rust source"                     $PR   true/full apps/desktop/src-tauri/src/lib.rs
check "Tauri config"                    $PR   true/full apps/desktop/src-tauri/tauri.conf.json
check "Tauri capabilities"              $PR   true/full apps/desktop/src-tauri/capabilities/default.json
check "Cargo lockfile"                  $PR   true/full apps/desktop/src-tauri/Cargo.lock
check "Tauri config generator"          $PR   true/full apps/desktop/scripts/tauri-config.mjs
check "desktop package manifest"        $PR   true/full apps/desktop/package.json
check "desktop vite config"             $PR   true/full apps/desktop/vite.config.ts
check "shared app package"              $PR   true/full packages/app/src/projects/board.tsx
check "shared UI package"               $PR   true/full packages/ui/src/button.tsx
check "shared contracts package"        $PR   true/full packages/contracts/src/index.ts

# 3. Dependencies, lockfiles and toolchain cannot bypass, wherever they live.
check "root lockfile"                   $PR   true/full pnpm-lock.yaml
check "root manifest"                   $PR   true/full package.json
check "workspace file"                  $PR   true/full pnpm-workspace.yaml
check "nested package manifest"         $PR   true/full packages/ui/package.json
check "API manifest"                    $PR   true/full apps/api/package.json
check "web manifest"                    $PR   true/full apps/web/package.json
check "Node version"                    $PR   true/full .nvmrc
check "Rust toolchain"                  $PR   true/full rust-toolchain.toml
check "tsconfig base"                   $PR   true/full tsconfig.base.json
check "package.json hidden in docs"     $PR   true/full docs/package.json
check "lockfile hidden in docs"         $PR   true/full docs/pnpm-lock.yaml
check "API tool config"                 $PR   true/full apps/api/vitest.config.ts
check "API json config"                 $PR   true/full apps/api/tsconfig.json
check "nested hidden tool config"       $PR   true/full apps/api/src/feature/.toolrc
check "nested Cargo lockfile"           $PR   true/full apps/web/src/feature/Cargo.lock
check "nested Cargo manifest"           $PR   true/full apps/web/src/Cargo.toml
check "nested YAML"                     $PR   true/full apps/api/src/config/settings.yaml
check "nested yml"                      $PR   true/full apps/web/src/ci.yml
check "nested package.json"             $PR   true/full apps/api/src/feature/package.json
check "nested pnpm lockfile"            $PR   true/full apps/web/src/pnpm-lock.yaml
check "nested json"                     $PR   true/full apps/api/tests/fixtures/data.json
check "nested config.ts"                $PR   true/full apps/api/src/vitest.config.ts
check "nested tsconfig"                 $PR   true/full apps/web/src/tsconfig.json
check "nested tsconfig variant"         $PR   true/full apps/api/tests/tsconfig.test.json
check "nested env file"                 $PR   true/full apps/api/src/.env
check "API unknown extension"           $PR   true/full apps/api/src/feature/data.bin
check "API shell script"                $PR   true/full apps/api/src/run.sh
check "API script directory"            $PR   true/full apps/api/scripts/apply-privileged.mjs
check "web index.html"                  $PR   true/full apps/web/index.html
check "web public js"                   $PR   true/full apps/web/public/theme-boot.js
check "web vercel config"               $PR   true/full apps/web/vercel.json
check "Prisma migration lock"           $PR   true/full apps/api/prisma/migrations/migration_lock.toml
check "name containing lock is still source"   $PR   false/server apps/api/src/lib/clock.ts apps/api/src/lib/deadlock.ts
check "lockfile named like source"      $PR   true/full apps/api/src/pnpm-lock.ts
check "web css"                         $PR   false/server apps/web/src/styles/app.css

# 4. CI workflow and CI scripts cannot bypass.
check "CI workflow"                     $PR   true/full .github/workflows/ci.yml
check "CI script"                       $PR   true/full .github/scripts/ci-gate.sh
check "CI action"                       $PR   true/full .github/actions/setup-workspace/action.yml
check "PR template"                     $PR   true/full .github/pull_request_template.md

# 5. Mixed changes keep the checks.
check "docs + desktop source"           $PR   true/full docs/a.md apps/desktop/src/main.tsx
check "docs + shared package"           $PR   true/full docs/a.md packages/app/src/x.ts
check "docs + workflow"                 $PR   true/full docs/a.md .github/workflows/ci.yml
check "docs + lockfile"                 $PR   true/full README.md pnpm-lock.yaml
check "docs + unknown"                  $PR   true/full docs/a.md mystery/file.txt

# 6. API, database, auth and web source: full static/unit/database/build checks always run (they are
#    not conditional); only the native matrix is skipped, and only on pull requests.
check "API change"                      $PR   false/server apps/api/src/app/api/v1/health/route.ts
check "database migration"              $PR   false/server apps/api/prisma/migrations/20261115000000_x/migration.sql apps/api/prisma/schema.prisma
check "auth code"                       $PR   false/server apps/api/src/lib/auth.ts
check "web app source"                  $PR   false/server apps/web/src/routes/projects.tsx
check "API + docs"                      $PR   false/server apps/api/src/x.ts docs/a.md
check "API change on push to main"      push  true/full   apps/api/src/x.ts
check "API + shared package"            $PR   true/full apps/api/src/x.ts packages/contracts/src/index.ts

# 7. Unknown, ambiguous and malformed input fails closed.
check "unknown top-level path"          $PR   true/full mystery/file.txt
check "unknown root file"               $PR   true/full Makefile
check "docs-looking script"             $PR   true/full docs/run.sh
check "docs patch file"                 $PR   true/full docs/scheduling-s1-integration.patch
check "markdown inside an app"          $PR   true/full apps/desktop/src-tauri/NOTES.md
check "markdown inside a package"       $PR   true/full packages/ui/README.md
check "uppercase docs directory"        $PR   true/full Docs/a.md
check "path traversal"                  $PR   true/full docs/../apps/desktop/src/main.tsx
check "absolute path"                   $PR   true/full /etc/passwd.md
check "double slash"                    $PR   true/full docs//a.md
check "empty list fails closed"         $PR   true/full
check "empty path fails closed"         $PR   true/full ""

exit "$fail"
