#!/usr/bin/env bash
# Verifies Linux (.deb, .AppImage) and Windows (NSIS .exe installer) release-candidate bundles.
# macOS has its own script (verify-macos-bundle.sh).
# Usage: verify-release-bundle.sh <linux|windows> <bundle-dir> <evidence-dir>. Exits non-zero on any failed check.
set -euo pipefail
platform="${1:?linux or windows}"
bundle="${2:?bundle directory}"
evidence="${3:?evidence directory}"
mkdir -p "$evidence"
conf="$(dirname "$0")/../../apps/desktop/src-tauri/tauri.conf.json"
want_version="$(jq -r .version "$conf")"
want_name="$(jq -r .productName "$conf")"
fail=0
check() { if [ "$2" = ok ]; then echo "ok   $1"; else echo "FAIL $1: $3" >&2; fail=1; fi; }
# Same rule as the CI build job: no server configuration inside a client bundle.
leak_re='DATABASE_URL|postgres(ql)?://|bos_(app|owner|auth|jobs)|MIGRATION_|AUTH_SECRET'

first() { ls $1 2>/dev/null | head -n1 || true; }

case "$platform" in
  linux)
    deb="$(first "$bundle/deb/*.deb")"
    img="$(first "$bundle/appimage/*.AppImage")"
    [ -n "$deb" ] && check ".deb exists" ok || { echo "FAIL .deb missing in $bundle/deb" >&2; exit 1; }
    dpkg-deb --info "$deb" > "$evidence/deb-info.txt"
    dpkg-deb --contents "$deb" > "$evidence/deb-contents.txt"
    ver="$(dpkg-deb --field "$deb" Version)"
    [ "$ver" = "$want_version" ] && check ".deb version" ok || check ".deb version" bad "got $ver, want $want_version"
    arch="$(dpkg-deb --field "$deb" Architecture)"
    echo "deb architecture: $arch" > "$evidence/deb-arch.txt"
    grep -Eq '/usr/bin/[A-Za-z0-9_-]+$' "$evidence/deb-contents.txt" && check ".deb contains an executable in /usr/bin" ok || check ".deb contains an executable in /usr/bin" bad "none listed"
    grep -Eq '\.desktop$' "$evidence/deb-contents.txt" && check ".deb contains a desktop entry" ok || check ".deb contains a desktop entry" bad "none listed"
    unpack="$(mktemp -d)"; dpkg-deb --extract "$deb" "$unpack"
    exe="$(ls "$unpack"/usr/bin/* | head -n1)"
    file "$exe" | tee "$evidence/binary-type.txt" | grep -q 'ELF' && check "executable is ELF" ok || check "executable is ELF" bad "$(cat "$evidence/binary-type.txt")"
    if grep -aEl "$leak_re" "$exe"; then check "no server configuration in the executable" bad "found"; else check "no server configuration in the executable" ok; fi
    rm -rf "$unpack"
    if [ -n "$img" ]; then
      [ -x "$img" ] && check "AppImage is executable" ok || check "AppImage is executable" bad "$img"
      head -c 4 "$img" | grep -q 'ELF' && check "AppImage is ELF" ok || check "AppImage is ELF" bad "bad header"
    else
      check "AppImage exists" bad "no .AppImage in $bundle/appimage"
    fi
    files=("$deb" ${img:+"$img"})
    ;;
  windows)
    exe="$(first "$bundle/nsis/*.exe")"
    [ -n "$exe" ] && check "NSIS installer exists" ok || { echo "FAIL NSIS installer missing in $bundle/nsis" >&2; exit 1; }
    [ "$(stat -c %s "$exe")" -gt 1000000 ] && check "installer size over 1 MB" ok || check "installer size over 1 MB" bad "$(stat -c %s "$exe") bytes"
    [ "$(head -c 2 "$exe")" = MZ ] && check "installer is a PE executable (MZ header)" ok || check "installer is a PE executable (MZ header)" bad "bad header"
    case "$(basename "$exe")" in *"$want_version"*) check "installer name carries version $want_version" ok ;; *) check "installer name carries version $want_version" bad "$(basename "$exe")" ;; esac
    app="$(first "apps/desktop/src-tauri/target/release/business-os-desktop.exe")"
    if [ -n "$app" ]; then
      [ "$(head -c 2 "$app" )" = MZ ] && check "application executable is PE" ok || check "application executable is PE" bad "bad header"
      if grep -aEl "$leak_re" "$app"; then check "no server configuration in the executable" bad "found"; else check "no server configuration in the executable" ok; fi
    else
      check "application executable exists" bad "target/release/business-os-desktop.exe missing"
    fi
    # Authenticode state is recorded, never claimed: the verification build is unsigned.
    echo "signature: not validated (unsigned verification build; signing decisions are open, ADR 0005)" > "$evidence/signature.txt"
    files=("$exe")
    ;;
  *) echo "unknown platform $platform" >&2; exit 2 ;;
esac

echo "product: $want_name $want_version" > "$evidence/product.txt"
( for f in "${files[@]}"; do sha256sum "$f"; done ) | tee "$evidence/SHA256SUMS"
exit "$fail"
