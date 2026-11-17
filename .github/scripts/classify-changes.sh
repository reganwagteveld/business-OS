#!/usr/bin/env bash
# Decides whether the native desktop matrix (Tauri/Rust on Linux, macOS, Windows) is needed, from
# the changed paths on stdin (NUL-separated, as `git diff --name-only --no-renames -z` prints).
# Prints GitHub Actions outputs: `desktop=true|false`, `tier=docs|server|full` and `desktop_reason=...`.
#
# CI-2A policy (docs/ci.md): the matrix is skipped only when EVERY changed path is on an explicit
# allow-list. Anything else, including unknown paths, an empty list, odd path names and any
# dependency, config, CI or shared-code file, selects the matrix (fail closed). Static checks, unit
# tests, database tests and build verification are not conditional and always run.
#
#   docs    every path is documentation (docs/** text and images, root *.md). Skips the matrix on
#           pull requests and on pushes.
#   server  every path is documentation or API/web application source that is outside the desktop
#           dependency closure. Skips the matrix on pull requests only (the push to main still runs it).
#   full    anything else. Runs the matrix.
#
# EVENT_NAME is the GitHub event (default: pull_request). Only pull_request and push can skip.
set -euo pipefail

event="${EVENT_NAME:-pull_request}"

# Documentation: markdown and images under docs/, and markdown files in the repository root.
is_docs() {
  case "$1" in
    docs/*.md|docs/*.png|docs/*.jpg|docs/*.jpeg|docs/*.gif|docs/*.svg|docs/*.webp|docs/*.pdf) return 0 ;;
    */*) return 1 ;;                      # any other nested path is not root documentation
    *.md) return 0 ;;                     # README.md, CLAUDE.md, ...
  esac
  return 1
}

# Server-side or web-only source that the native build never installs or imports (the desktop job
# installs only @business-os/desktop and its dependencies). This is a positive allow-list at every
# depth: the file must sit under a known source directory AND have a known source extension. Hidden
# files, tool configuration (*.config.*, tsconfig*), manifests, lockfiles, scripts, YAML/TOML/JSON and
# every unknown extension are not listed, so they are full.
is_server_only() {
  case "$1" in
    apps/api/src/*|apps/api/tests/*|apps/api/prisma/*|apps/web/src/*) ;;
    *) return 1 ;;
  esac
  local base="${1##*/}"
  case "$base" in
    .*|*.config.*|tsconfig*|package.json|*-lock.*|*.lock) return 1 ;;
  esac
  case "$base" in
    *.ts|*.tsx|*.sql|*.prisma|*.css) return 0 ;;
  esac
  return 1
}

safe_path() { # reject anything that is not a plain repository-relative path
  case "$1" in
    ''|/*|./*|../*|*/../*|*/..|*//*|*$'\n'*) return 1 ;;
  esac
  return 0
}

count=0
all_docs=true
all_server=true
reason=""
while IFS= read -r -d '' path; do
  count=$((count + 1))
  if ! safe_path "$path"; then
    all_docs=false; all_server=false
    reason="${reason:+$reason, }unrecognised path name (fail closed)"
    continue
  fi
  if is_docs "$path"; then
    continue
  fi
  all_docs=false
  if is_server_only "$path"; then
    continue
  fi
  all_server=false
  reason="${reason:+$reason, }$path"
done

desktop=true
tier=full
if [ "$count" -eq 0 ]; then
  reason="no changed files could be listed (fail closed)"
elif [ "$event" != pull_request ] && [ "$event" != push ]; then
  reason="full validation for $event"
elif [ "$all_docs" = true ]; then
  desktop=false; tier=docs
  reason="documentation only"
elif [ "$all_server" = true ] && [ "$event" = pull_request ]; then
  desktop=false; tier=server
  reason="documentation and API/web source only (pull request)"
elif [ "$all_server" = true ]; then
  reason="API/web source on $event (native build still runs)"
fi

if [ "${#reason}" -gt 300 ]; then reason="${reason:0:297}..."; fi

echo "desktop=$desktop"
echo "tier=$tier"
echo "desktop_reason=${reason:-native-affecting change}"
