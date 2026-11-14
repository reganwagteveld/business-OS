#!/usr/bin/env bash
# Decides which conditional CI jobs a pull request needs, from its changed file list on stdin
# (one path per line). Prints GitHub Actions outputs: `desktop=true|false` and `desktop_reason=...`.
#
# Only the native desktop matrix (Tauri/Rust on Linux, macOS, Windows) is conditional. Static
# checks, unit tests, database tests and build verification run on every pull request.
#
# Fail closed: an empty list (e.g. the diff could not be computed) selects the desktop matrix.
set -euo pipefail

desktop=false
reason=""

# Paths whose change can affect the native desktop build. Anything matching runs the full
# cross-platform matrix. Keep in sync with docs/ci.md and the self-test.
desktop_paths() {
  case "$1" in
    apps/desktop/src-tauri/*) return 0 ;;          # Rust, Cargo.toml/lock, build.rs, tauri.conf*.json, capabilities, icons
    apps/desktop/scripts/*) return 0 ;;            # tauri-config.mjs generates the build config (CSP, API origin)
    apps/desktop/package.json) return 0 ;;         # @tauri-apps/cli and api versions, tauri:build script
    apps/desktop/vite.config.*) return 0 ;;        # frontend build that Tauri embeds
    apps/desktop/index.html) return 0 ;;           # entry document; Tauri injects CSP hashes into it
    pnpm-lock.yaml|pnpm-workspace.yaml) return 0 ;; # shared dependency changes (incl. @tauri-apps/*, vite)
    package.json|.nvmrc) return 0 ;;               # root toolchain (pnpm, Node)
    rust-toolchain|rust-toolchain.toml) return 0 ;;
    .github/*) return 0 ;;                         # CI infrastructure itself: prove the full path still works
  esac
  return 1
}

count=0
while IFS= read -r path; do
  [ -z "$path" ] && continue
  count=$((count + 1))
  if desktop_paths "$path"; then
    desktop=true
    reason="${reason:+$reason, }$path"
  fi
done

if [ "$count" -eq 0 ]; then
  desktop=true
  reason="no changed files could be listed (fail closed)"
fi

# Keep the reason short for the job summary.
if [ "${#reason}" -gt 300 ]; then reason="${reason:0:297}..."; fi

echo "desktop=$desktop"
echo "desktop_reason=${reason:-no desktop-affecting paths changed}"
