#!/usr/bin/env bash
# Installs a pinned PgBouncer from the signed Ubuntu archive and starts it for the RLS spike.
#
# The .deb files (PgBouncer and any dependency missing from the runner image) are kept in
# $PGBOUNCER_DEB_DIR, which the workflow caches by version + runner image version. A cache hit
# skips `apt-get update` (the slow part); a miss, or a cached set that no longer installs, falls
# back to downloading through apt, which verifies the archive signatures.
set -euo pipefail
: "${PGBOUNCER_VERSION:?}" "${PGBOUNCER_DEB_DIR:?}"

install_from_dir() {
  compgen -G "$PGBOUNCER_DEB_DIR/*.deb" > /dev/null && sudo dpkg -i "$PGBOUNCER_DEB_DIR"/*.deb > /dev/null
}

if install_from_dir; then
  echo "Installed PgBouncer $PGBOUNCER_VERSION from cached packages"
else
  echo "No usable cached packages; downloading PgBouncer $PGBOUNCER_VERSION through apt"
  rm -rf "$PGBOUNCER_DEB_DIR"
  mkdir -p "$PGBOUNCER_DEB_DIR/partial"
  sudo apt-get update -qq
  sudo apt-get install -y -qq --download-only -o Dir::Cache::archives="$PGBOUNCER_DEB_DIR" "pgbouncer=$PGBOUNCER_VERSION"
  sudo rm -rf "$PGBOUNCER_DEB_DIR/partial" "$PGBOUNCER_DEB_DIR/lock"
  sudo chown -R "$(id -u):$(id -g)" "$PGBOUNCER_DEB_DIR"
  install_from_dir
fi

# The package starts a system instance on 6432; the spike runs its own on 6433.
sudo systemctl stop pgbouncer || true
installed="$(dpkg-query -W -f='${Version}' pgbouncer)"
if [ "$installed" != "$PGBOUNCER_VERSION" ]; then
  echo "Expected PgBouncer $PGBOUNCER_VERSION, found $installed" >&2
  exit 1
fi
pgbouncer --version
