#!/usr/bin/env bash
# Static guard (CI-2C): release-validation.yml must never be able to publish, upload to a release
# channel, deploy, use secrets or write to the repository. This checks the workflow text on every
# CI run, so adding such a step fails CI until the guard and the owner approve the change.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
wf="$here/../workflows/release-validation.yml"
fail=0
[ -f "$wf" ] || { echo "FAIL workflow not found: $wf" >&2; exit 1; }
# Strip comment lines so explanatory text cannot trigger or hide a match.
body="$(grep -vE '^[[:space:]]*#' "$wf")"

forbid() { # name regex
  if echo "$body" | grep -Eiq "$2"; then echo "FAIL forbidden: $1 (/$2/)" >&2; fail=1; else echo "ok   absent: $1"; fi
}
forbid "write permission of any kind"        '^[[:space:]]*[a-z-]+:[[:space:]]*write[[:space:]]*$'
forbid "write-all permission"                'write-all'
forbid "OIDC token"                          'id-token'
forbid "any secret reference"                'secrets\.|secrets:[[:space:]]*inherit'
forbid "GitHub Environment (approval gate for publish)" '^[[:space:]]*environment:'
forbid "release creation or upload actions"  'action-gh-release|softprops|create-release|upload-release|tauri-action|release-action'
forbid "gh release or gh api writes"         'gh[[:space:]]+release|gh[[:space:]]+api[^|]*(-X|--method)[[:space:]]*(POST|PUT|PATCH|DELETE)'
forbid "deploy tools and hosts"              'vercel|netlify|wrangler|neon|prisma[[:space:]]+migrate|kubectl|terraform|docker[[:space:]]+push|npm[[:space:]]+publish|pnpm[[:space:]]+publish|cargo[[:space:]]+publish'
forbid "git push or tag creation"            'git[[:space:]]+push|git[[:space:]]+tag'
forbid "repository_dispatch or workflow triggers" 'repository_dispatch|actions_run_trigger|gh[[:space:]]+workflow[[:space:]]+run'
forbid "pull_request_target"                 'pull_request_target'
forbid "persisted checkout credentials"      'persist-credentials:[[:space:]]*true'

# Positive checks.
echo "$body" | grep -Eq '^permissions:' && echo "ok   top-level permissions block present" || { echo "FAIL no top-level permissions block" >&2; fail=1; }
top="$(echo "$body" | awk '/^permissions:/{f=1;next} f&&/^[^[:space:]]/{exit} f')"
[ "$(echo "$top" | grep -Ec '[a-z-]+:')" = 1 ] && echo "$top" | grep -Eq 'contents:[[:space:]]*read' && echo "ok   workflow permissions are exactly contents: read" || { echo "FAIL workflow permissions must be exactly contents: read" >&2; fail=1; }
exit "$fail"
