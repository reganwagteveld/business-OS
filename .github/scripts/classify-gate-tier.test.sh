#!/usr/bin/env bash
# Self-test for classify-gate-tier.sh (CIQ-A1). Runs in the "Detect changes" job before the classifier
# is used, so a broken rule fails CI instead of silently skipping a gated job.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fail=0

# name, event, ref, expected tier, then changed paths (fed NUL-separated, as git prints them).
check() {
  local name="$1" event="$2" ref="$3" expected="$4"; shift 4
  local out actual
  out="$( (if [ "$#" -gt 0 ]; then printf '%s\0' "$@"; fi) | EVENT_NAME="$event" GATE_REF="$ref" "$here/classify-gate-tier.sh")"
  actual="$(echo "$out" | sed -n 's/^gate_tier=//p')"
  if [ "$actual" = "$expected" ] && echo "$out" | grep -q '^gate_reason=.'; then
    echo "ok   $name ($actual)"
  else
    echo "FAIL $name: expected $expected, got '${actual}'" >&2
    fail=1
  fi
}
PR=pull_request
M=refs/heads/main
PRREF=refs/pull/1/merge

# 1. Ordinary documentation: docs tier on pull requests and on pushes to main.
check "spec markdown"                     $PR  $PRREF docs docs/architecture.md
check "spec markdown, push to main"       push $M     docs docs/finance-banking-f8.md
check "nested docs and images"            $PR  $PRREF docs docs/ui/guide.md docs/brand/logo.svg docs/evidence/shot.png docs/ui/a/b.webp
check "two specs"                         $PR  $PRREF docs docs/people-leave-p3.md docs/sales-data-model.md
check "feature spec named pipeline"       $PR  $PRREF docs docs/sales-pipeline-configuration-scfg.md
check "screenshot folder README"          $PR  $PRREF docs docs/ui/screenshots/finance-f3/README.md

# 2. Governance, policy, CI, migration, deployment and operational documents are never docs tier.
check "repository CLAUDE.md"              $PR  $PRREF full CLAUDE.md
check "root README"                       $PR  $PRREF full README.md
check "any root markdown"                 $PR  $PRREF full NOTES.md
check "nested AGENTS.md"                  $PR  $PRREF full apps/api/AGENTS.md
check "AGENTS.md under docs"              $PR  $PRREF full docs/AGENTS.md
check "CLAUDE.md under docs, odd case"    $PR  $PRREF full docs/sub/Claude.MD
check "agent task protocol"               $PR  $PRREF full docs/agent-task-protocol.md
check "agent context"                     $PR  $PRREF full docs/agent-context.md
check "merge queue"                       $PR  $PRREF full docs/merge-queue.md
check "active workstreams"                $PR  $PRREF full docs/active-workstreams.md
check "CI doc"                            $PR  $PRREF full docs/ci.md
check "CI proposal"                       $PR  $PRREF full docs/ci-merge-pipeline-proposal.md
check "CIQ report"                        $PR  $PRREF full docs/ciq-1-merge-queue-throughput.md
check "CI-2 runner doc"                   $PR  $PRREF full docs/ci-2-runner-efficiency.md
check "migration readiness"               $PR  $PRREF full docs/migration-readiness.md
check "migration record"                  $PR  $PRREF full docs/workflow-links-migration.md
check "search index migration"            $PR  $PRREF full docs/search-index-migration.md
check "deployment"                        $PR  $PRREF full docs/deployment.md
check "vercel builds"                     $PR  $PRREF full docs/vercel-builds.md
check "private beta lockdown"             $PR  $PRREF full docs/private-beta-lockdown.md
check "security review"                   $PR  $PRREF full docs/web-security-review.md
check "operations runbook"                $PR  $PRREF full docs/operations/neon-branch-housekeeping.md
check "ADR"                               $PR  $PRREF full docs/adr/0009-something.md
check "governance, upper case"            $PR  $PRREF full docs/MERGE-QUEUE.md
check "governance, mixed case"            $PR  $PRREF full docs/Agent-Task-Protocol.md
check "release doc"                       $PR  $PRREF full docs/release-checklist.md
check "neon doc"                          $PR  $PRREF full docs/neon-recovery.md
check "ordinary + governance"             $PR  $PRREF full docs/architecture.md docs/merge-queue.md

# 3. Non-prose files under docs/ and anything else are full.
check "docs patch file"                   $PR  $PRREF full docs/scheduling-s1-integration.patch
check "docs text file"                    $PR  $PRREF full docs/ui/harness/main.tsx.txt
check "docs script"                       $PR  $PRREF full docs/run.sh
check "docs pdf"                          $PR  $PRREF full docs/report.pdf
check "docs html"                         $PR  $PRREF full docs/ui/v2-a/reference/reference.html
check "SECURITY.md under docs"            $PR  $PRREF full docs/SECURITY.md
check "docs package.json"                 $PR  $PRREF full docs/package.json
check "docs hidden file"                  $PR  $PRREF full docs/.hidden.md
check "uppercase docs directory"          $PR  $PRREF full Docs/a.md
check "uppercase extension"               $PR  $PRREF full docs/a.MD
check "workflow"                          $PR  $PRREF full .github/workflows/ci.yml
check "CI script"                         $PR  $PRREF full .github/scripts/ci-gate.sh
check "PR template"                       $PR  $PRREF full .github/pull_request_template.md
check "ops data"                          $PR  $PRREF full ops/neon/recovery-points.json
check "docs + ops data"                   $PR  $PRREF full docs/a.md ops/neon/audit-log.jsonl

# 4. Client UI source and client tests: client tier.
check "app zone component"                $PR  $PRREF client packages/app/src/zones/customers/panel.tsx
check "app shell + test"                  $PR  $PRREF client packages/app/src/shell/app-shell.tsx packages/app/tests/shell.test.tsx
check "app test support fake"             $PR  $PRREF client packages/app/tests/support/fake-api.ts
check "typed API wrapper"                 $PR  $PRREF client packages/app/src/api/customers.ts packages/app/tests/customer-zone.test.tsx
check "UI component"                      $PR  $PRREF client packages/ui/src/components/button.tsx
check "UI stylesheet"                     $PR  $PRREF client packages/ui/src/styles.css
check "web entry"                         $PR  $PRREF client apps/web/src/main.tsx apps/web/src/index.css
check "client + ordinary docs + images"   $PR  $PRREF client packages/app/src/shell/app-shell.tsx docs/ui/rail/open.png docs/ui-notes.md
check "client on push to main"            push $M     client packages/app/src/zones/sales/board.tsx

# 5. Client paths that touch transport, auth, session, permissions, tenancy or tool setup are full.
check "HTTP transport"                    $PR  $PRREF full packages/app/src/api/http.ts
check "API client root"                   $PR  $PRREF full packages/app/src/api/client.ts
check "auth API wrapper"                  $PR  $PRREF full packages/app/src/api/auth.ts
check "tenancy API wrapper"               $PR  $PRREF full packages/app/src/api/tenancy.ts
check "client config"                     $PR  $PRREF full packages/app/src/config.ts
check "auth screens"                      $PR  $PRREF full packages/app/src/auth/auth-screens.tsx
check "desktop transport"                 $PR  $PRREF full packages/app/src/auth/desktop-transport.ts
check "session helper"                    $PR  $PRREF full packages/app/src/workspace/session-store.ts
check "permission view"                   $PR  $PRREF full packages/app/src/zones/settings/permissions.tsx
check "role picker"                       $PR  $PRREF full packages/app/src/zones/settings/role-select.tsx
check "admission"                         $PR  $PRREF full packages/app/src/shell/admission-banner.tsx
check "token store"                       $PR  $PRREF full packages/app/src/workspace/token-store.ts
check "auth test"                         $PR  $PRREF full packages/app/tests/auth.test.tsx
check "tenancy test"                      $PR  $PRREF full packages/app/tests/tenancy.test.ts
check "test setup file"                   $PR  $PRREF full packages/app/tests/setup.ts
check "client + auth"                     $PR  $PRREF full packages/app/src/shell/x.tsx packages/app/src/auth/y.ts

# 6. Client paths that are not source, or tool configuration and dependencies, are full.
check "markdown in client src"            $PR  $PRREF full packages/app/src/zones/README.md
check "json in client src"                $PR  $PRREF full packages/app/src/zones/data.json
check "font file"                         $PR  $PRREF full packages/ui/src/fonts/inter.woff2
check "client package manifest"           $PR  $PRREF full packages/app/package.json
check "UI package manifest"               $PR  $PRREF full packages/ui/package.json
check "UI components.json"                $PR  $PRREF full packages/ui/components.json
check "UI vitest config"                  $PR  $PRREF full packages/ui/vitest.config.ts
check "config file inside src"            $PR  $PRREF full packages/app/src/vite.config.ts
check "tsconfig inside src"               $PR  $PRREF full packages/app/src/tsconfig.json
check "hidden file inside src"            $PR  $PRREF full packages/app/src/.eslintrc.ts
check "lockfile"                          $PR  $PRREF full pnpm-lock.yaml
check "web index.html"                    $PR  $PRREF full apps/web/index.html
check "web vercel config"                 $PR  $PRREF full apps/web/vercel.json
check "web vite config"                   $PR  $PRREF full apps/web/vite.config.ts
check "UI showcase"                       $PR  $PRREF full packages/ui/showcase/main.tsx
check "UI scripts"                        $PR  $PRREF full packages/ui/scripts/build.ts

# 7. API, contracts, database, desktop and mixes with them are full.
check "API source"                        $PR  $PRREF full apps/api/src/app/api/v1/health/route.ts
check "API test"                          $PR  $PRREF full apps/api/tests/integration/people.test.ts
check "migration"                         $PR  $PRREF full apps/api/prisma/migrations/20261212000000_x/migration.sql
check "contracts"                         $PR  $PRREF full packages/contracts/src/index.ts
check "desktop source"                    $PR  $PRREF full apps/desktop/src/main.tsx
check "Rust source"                       $PR  $PRREF full apps/desktop/src-tauri/src/lib.rs
check "client + API"                      $PR  $PRREF full packages/app/src/x.tsx apps/api/src/x.ts
check "client + contracts"                $PR  $PRREF full packages/app/src/x.tsx packages/contracts/src/x.ts
check "client + workflow"                 $PR  $PRREF full packages/app/src/x.tsx .github/workflows/ci.yml
check "root architecture tests"           $PR  $PRREF full tests/architecture/clients.test.ts
check "docs + API"                        $PR  $PRREF full docs/a.md apps/api/src/x.ts

# 8. Events and refs: only pull requests and pushes to main may use a reduced tier.
check "docs, push to release branch"      push refs/heads/release/1.0 full docs/architecture.md
check "docs, tag push"                    push refs/tags/v1.0.0 full docs/architecture.md
check "docs, push without ref"            push ""    full docs/architecture.md
check "client, push to other branch"      push refs/heads/feature full packages/app/src/x.tsx
check "docs, scheduled run"               schedule $M full docs/architecture.md
check "docs, manual run"                  workflow_dispatch $M full docs/architecture.md
check "docs, workflow_call"               workflow_call $M full docs/architecture.md
check "client, manual run"                workflow_dispatch $M full packages/app/src/x.tsx

# 9. Unknown, ambiguous and malformed input fails closed.
check "empty list"                        $PR  $PRREF full
check "empty path"                        $PR  $PRREF full ""
check "path traversal"                    $PR  $PRREF full docs/../apps/api/src/x.ts
check "path traversal into client"        $PR  $PRREF full packages/app/src/../../../apps/api/src/x.ts
check "dot segment"                       $PR  $PRREF full docs/./a.md
check "absolute path"                     $PR  $PRREF full /docs/a.md
check "double slash"                      $PR  $PRREF full docs//a.md
check "newline in name"                   $PR  $PRREF full $'docs/a.md\nREADME.md'
check "backslash in name"                 $PR  $PRREF full 'docs\a.md'
check "unknown top-level path"            $PR  $PRREF full mystery/file.txt
check "ordinary docs only, docs not client" $PR $PRREF docs docs/ui/a.png

exit "$fail"
