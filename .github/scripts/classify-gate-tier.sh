#!/usr/bin/env bash
# CIQ-A1 (docs/ciq-1-merge-queue-throughput.md §4.A.1, §4.A.2; decisions D-CI-2 and D-CIQ-1):
# decides which gated jobs a change needs, from the changed paths on stdin (NUL-separated, as
# `git diff --name-only --no-renames -z` prints them). Prints GitHub Actions outputs:
#   gate_tier=docs|client|full
#   gate_reason=...
#
#   docs    every path is ordinary documentation (docs/** prose and images that are NOT governance,
#           policy, CI, migration, deployment or operational documents). Static checks, unit tests,
#           build verification and database tests are skipped; Detect changes (self-tests, migration
#           order, credential scan) still runs and must pass.
#   client  every path is client UI source or client test (.ts/.tsx/.css) under packages/app/src/,
#           packages/app/tests/, packages/ui/src/, packages/ui/tests/ or apps/web/src/, outside the HTTP
#           transport, client config, auth, session, admission, permission, role and tenant code, plus
#           (optionally) ordinary documentation as defined for `docs`. Only the Database job is skipped:
#           static, unit, contract, architecture, build and bundle-leak checks still run, and so does
#           the desktop matrix when classify-changes.sh says so.
#   full    anything else. Every job runs.
#
# This is separate from classify-changes.sh on purpose: the CI-2A desktop decision is unchanged, and
# its broader `docs` rule (every root *.md, every docs/** file) is never reused to skip the gated jobs.
#
# Fail closed: an empty list, an unsafe path name, any path not on an allow-list, a mixed change, an
# event other than pull_request or a push to main, or any error selects `full`. The gate (ci-gate.sh)
# accepts a skipped job only when this classifier succeeded and named a tier that permits that skip.
#
# EVENT_NAME is the GitHub event (default: pull_request); GATE_REF is github.ref.
set -euo pipefail

event="${EVENT_NAME:-pull_request}"
ref="${GATE_REF:-}"

safe_path() { # reject anything that is not a plain repository-relative path
  case "$1" in
    ''|/*|./*|../*|*/../*|*/./*|*/..|*/.|*//*|*$'\n'*|*$'\r'*|*$'\t'*|*'\'*) return 1 ;;
  esac
  return 0
}

# Governance, policy, CI, migration, deployment, security and operational documents. These are never
# `docs` tier, whatever their extension. Matched case-insensitively so a case variant cannot slip past.
is_governance_doc() {
  local p="${1,,}"
  case "$p" in
    docs/agent-*|docs/agents/*|docs/merge-queue*|docs/active-workstreams*) return 0 ;;
    docs/ci*|docs/*-ci-*|docs/*release*) return 0 ;;
    docs/*migration*|docs/deployment*|docs/vercel*|docs/*neon*|docs/operations/*|docs/ops/*) return 0 ;;
    docs/private-beta*|docs/*security*|docs/*lockdown*|docs/*admission*) return 0 ;;
    docs/adr/*) return 0 ;;
  esac
  case "${p##*/}" in
    claude.md|agents.md|security.md|codeowners) return 0 ;;
  esac
  return 1
}

# Ordinary documentation: prose and images under docs/ only (root and nested *.md elsewhere are full).
is_ordinary_doc() {
  case "$1" in
    docs/*.md|docs/*.png|docs/*.jpg|docs/*.jpeg|docs/*.gif|docs/*.svg|docs/*.webp) ;;
    *) return 1 ;;
  esac
  case "${1##*/}" in
    .*) return 1 ;;
  esac
  is_governance_doc "$1" && return 1
  return 0
}

# Client UI source. Positive allow-list of directories and extensions; then exclusions for anything
# that talks to the API, carries authentication, session, admission, permission or tenant logic, or
# configures a tool. Clients reach data only through /api/v1 (pnpm boundaries and tests/architecture
# enforce that on every non-docs run), which is why the Database job cannot be affected by these files.
is_client_source() {
  case "$1" in
    packages/app/src/*|packages/app/tests/*|packages/ui/src/*|packages/ui/tests/*|apps/web/src/*) ;;
    *) return 1 ;;
  esac
  local lower="${1,,}" base="${1##*/}"
  case "$base" in
    .*|*.config.*|tsconfig*|package.json|*-lock.*|*.lock) return 1 ;;
  esac
  case "$base" in
    *.ts|*.tsx|*.css) ;;
    *) return 1 ;;
  esac
  case "$lower" in
    # The HTTP transport (credentials, CSRF, base URL), client configuration and the auth screens.
    # Other packages/app/src/api/* modules are typed wrappers over /api/v1 and stay client source.
    packages/app/src/api/http.ts|packages/app/src/api/client.ts|packages/app/src/config.ts) return 1 ;;
    packages/app/src/auth/*|*/setup.ts|*/setup.tsx) return 1 ;;
    *auth*|*session*|*admission*|*permission*|*tenant*|*tenanc*|*rbac*|*role*|*csrf*|*token*|*secret*|*credential*) return 1 ;;
  esac
  return 0
}

count=0
all_docs=true
all_client=true
saw_client=false
reason=""
add_reason() { reason="${reason:+$reason, }$1"; }

while IFS= read -r -d '' path; do
  count=$((count + 1))
  if ! safe_path "$path"; then
    all_docs=false; all_client=false
    add_reason "unrecognised path name (fail closed)"
    continue
  fi
  if is_ordinary_doc "$path"; then
    continue                              # ordinary docs may accompany client source
  fi
  all_docs=false
  if is_client_source "$path"; then
    saw_client=true
    continue
  fi
  all_client=false
  add_reason "$path"
done

tier=full
if [ "$count" -eq 0 ]; then
  reason="no changed files could be listed (fail closed)"
elif [ "$event" != pull_request ] && ! { [ "$event" = push ] && [ "$ref" = refs/heads/main ]; }; then
  reason="full validation for $event${ref:+ on $ref}"
elif [ "$all_docs" = true ]; then
  tier=docs
  reason="ordinary documentation only"
elif [ "$all_client" = true ] && [ "$saw_client" = true ]; then
  tier=client
  reason="client UI source only (no API, auth, contracts, config or dependencies)"
fi

reason="${reason:-full validation}"
if [ "${#reason}" -gt 300 ]; then reason="${reason:0:297}..."; fi

echo "gate_tier=$tier"
echo "gate_reason=$reason"
