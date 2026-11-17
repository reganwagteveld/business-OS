#!/usr/bin/env bash
# Vercel "Ignored Build Step" for the browser app (business-os-web), wired in apps/web/vercel.json.
# INFRA-VC-1, docs/vercel-builds.md. Vercel's contract: exit 0 = SKIP this deployment, exit 1 = BUILD.
#
# Policy (fail open to BUILD):
#   - Anything other than a preview deployment builds (production on main always builds).
#   - A preview is skipped only when EVERY path that changed since the comparison commit is on the
#     allow-list below: documentation (same rule as .github/scripts/classify-changes.sh is_docs) or
#     API-only (apps/api/**, which the browser app never imports; tests/vercel-ignore-build.test.ts
#     proves that from the workspace manifests).
#   - Comparison commit: the branch's last successful deployment (VERCEL_GIT_PREVIOUS_SHA); without
#     one, the current main tip. Shared packages, contracts, lockfiles, manifests, config, CI, scripts,
#     tooling, unknown paths, an empty diff and every error (missing variable, missing git, shallow
#     history, fetch failure, timeout, odd path) build.
#
# The decision is made in a subshell; this script exits 0 only when that subshell prints exactly
# "skip" and succeeds. Every other outcome, including a crash, exits 1.
set -uo pipefail

is_docs() { # keep identical to is_docs in .github/scripts/classify-changes.sh (parity is tested)
  case "$1" in
    docs/*.md|docs/*.png|docs/*.jpg|docs/*.jpeg|docs/*.gif|docs/*.svg|docs/*.webp|docs/*.pdf) return 0 ;;
    */*) return 1 ;;
    *.md) return 0 ;;
  esac
  return 1
}

is_api_only() { # the API project's own tree; nothing under it is in the browser app's build closure
  case "$1" in
    apps/api/*) return 0 ;;
  esac
  return 1
}

safe_path() {
  case "$1" in
    ''|/*|./*|../*|*/../*|*/..|*//*|*$'\n'*) return 1 ;;
  esac
  return 0
}

# Prints "skip" or "build: <reason>". Any failure ends the subshell non-zero, which builds.
decide() {
  set -euo pipefail
  local env="${VERCEL_ENV:-}"
  if [ "$env" != preview ]; then echo "build: VERCEL_ENV=${env:-unset} (only previews can skip)"; return 0; fi

  command -v git >/dev/null || { echo "build: git unavailable"; return 0; }
  local root; root="$(git rev-parse --show-toplevel)"
  cd "$root"
  local head; head="$(git rev-parse --verify 'HEAD^{commit}')"
  local remote="${VERCEL_IGNORE_BUILD_REMOTE:-}"
  if [ -z "$remote" ]; then
    if [ -n "${VERCEL_GIT_REPO_OWNER:-}" ] && [ -n "${VERCEL_GIT_REPO_SLUG:-}" ]; then
      remote="https://github.com/${VERCEL_GIT_REPO_OWNER}/${VERCEL_GIT_REPO_SLUG}.git"
    fi
  fi
  fetch() { [ -n "$remote" ] && timeout 60 git fetch --quiet --no-tags --depth=1 "$remote" "$1" >/dev/null 2>&1; }

  local base="" basis=""
  local prev="${VERCEL_GIT_PREVIOUS_SHA:-}"
  if [ -n "$prev" ]; then
    case "$prev" in *[!0-9a-f]*) echo "build: malformed previous SHA"; return 0 ;; esac
    if git cat-file -e "${prev}^{commit}" 2>/dev/null || { fetch "$prev" && git cat-file -e "${prev}^{commit}" 2>/dev/null; }; then
      base="$prev"; basis="last successful deployment ${prev:0:12}"
    fi
  fi
  if [ -z "$base" ]; then
    if fetch main && base="$(git rev-parse --verify 'FETCH_HEAD^{commit}' 2>/dev/null)"; then
      basis="main tip ${base:0:12}"
    else
      echo "build: no comparison commit (no previous deployment and main could not be fetched)"; return 0
    fi
  fi

  local list; list="$(mktemp)"
  git diff --name-only --no-renames -z "$base" "$head" > "$list"
  local count=0 path
  while IFS= read -r -d '' path; do
    count=$((count + 1))
    if ! safe_path "$path"; then echo "build: unrecognised path name"; rm -f "$list"; return 0; fi
    if is_docs "$path" || is_api_only "$path"; then continue; fi
    echo "build: $path changed since $basis"; rm -f "$list"; return 0
  done < "$list"
  rm -f "$list"
  if [ "$count" -eq 0 ]; then echo "build: no changed files since $basis"; return 0; fi
  echo "skip"
  echo "skip: $count changed path(s) since $basis are documentation or API-only" >&2
}

verdict="$(decide)" && status=0 || status=$?
if [ "$status" -eq 0 ] && [ "$verdict" = skip ]; then
  exit 0
fi
echo "${verdict:-build: decision failed (exit $status), building}"
exit 1
