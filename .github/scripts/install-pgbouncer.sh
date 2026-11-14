#!/usr/bin/env bash
# Provides a pinned PgBouncer for the RLS spike without installing a system service.
#
# The .deb files (PgBouncer plus any dependency missing from the runner image) come from the
# signed Ubuntu archive through apt, which verifies them, and are kept in $PGBOUNCER_DEB_DIR. The
# workflow caches that directory by PgBouncer version and runner image version, so a cache hit
# skips `apt-get update`. The packages are unpacked (not installed) into $PGBOUNCER_DEB_DIR/root:
# no postinst scripts, no systemd unit, no instance on port 6432 to stop.
#
# Prints the path of a wrapper script that runs the unpacked binary.
set -euo pipefail
: "${PGBOUNCER_VERSION:?}" "${PGBOUNCER_DEB_DIR:?}"

expected_deb="pgbouncer_${PGBOUNCER_VERSION}_amd64.deb"

if [ -f "$PGBOUNCER_DEB_DIR/$expected_deb" ]; then
  echo "Using cached PgBouncer $PGBOUNCER_VERSION packages" >&2
else
  echo "Downloading PgBouncer $PGBOUNCER_VERSION through apt" >&2
  rm -rf "$PGBOUNCER_DEB_DIR"
  mkdir -p "$PGBOUNCER_DEB_DIR/partial"
  sudo apt-get update -qq
  sudo apt-get install -y -qq --download-only -o Dir::Cache::archives="$PGBOUNCER_DEB_DIR" "pgbouncer=$PGBOUNCER_VERSION" >&2
  sudo rm -rf "$PGBOUNCER_DEB_DIR/partial" "$PGBOUNCER_DEB_DIR/lock"
  sudo chown -R "$(id -u):$(id -g)" "$PGBOUNCER_DEB_DIR"
  # apt names files with an epoch-encoded version; normalise to the expected name.
  test -f "$PGBOUNCER_DEB_DIR/$expected_deb" || mv "$PGBOUNCER_DEB_DIR"/pgbouncer_*.deb "$PGBOUNCER_DEB_DIR/$expected_deb"
fi

version="$(dpkg-deb -f "$PGBOUNCER_DEB_DIR/$expected_deb" Version)"
if [ "$version" != "$PGBOUNCER_VERSION" ]; then
  echo "Expected PgBouncer $PGBOUNCER_VERSION, found $version" >&2
  exit 1
fi

root="$PGBOUNCER_DEB_DIR/root"
rm -rf "$root" && mkdir -p "$root"
for deb in "$PGBOUNCER_DEB_DIR"/*.deb; do dpkg-deb -x "$deb" "$root"; done

wrapper="$PGBOUNCER_DEB_DIR/pgbouncer"
cat > "$wrapper" <<EOF
#!/usr/bin/env bash
export LD_LIBRARY_PATH="$root/usr/lib/x86_64-linux-gnu\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
exec "$root/usr/sbin/pgbouncer" "\$@"
EOF
chmod +x "$wrapper"
"$wrapper" --version >&2
echo "$wrapper"
