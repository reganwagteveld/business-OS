#!/bin/sh
# Runs the visual suite inside the pinned Playwright image, the same image the `Visual regression`
# workflow uses, so goldens made here match CI pixel for pixel. Needs Docker and an installed workspace
# (`pnpm install` on a Linux x64 host, or the container's own install; see README).
# Usage: sh scripts/docker.sh [playwright test arguments, e.g. --update-snapshots]
set -eu
IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
exec docker run --rm --ipc=host --init \
  -v "$ROOT:$ROOT" -w "$ROOT/tooling/visual" \
  -e CI="${CI:-}" \
  "$IMAGE" node node_modules/@playwright/test/cli.js test "$@"
