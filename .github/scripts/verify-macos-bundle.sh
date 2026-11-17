#!/usr/bin/env bash
# Verifies the macOS bundle produced by `tauri build --bundles app,dmg`.
# Usage: verify-macos-bundle.sh <bundle-dir> <evidence-dir>. Exits non-zero on any failed check.
set -euo pipefail
bundle="${1:?bundle directory}"
evidence="${2:?evidence directory}"
mkdir -p "$evidence"
conf="$(dirname "$0")/../../apps/desktop/src-tauri/tauri.conf.json"
want_id="$(jq -r .identifier "$conf")"
want_version="$(jq -r .version "$conf")"
fail=0
check() { if [ "$2" = ok ]; then echo "ok   $1"; else echo "FAIL $1: $3" >&2; fail=1; fi; }

app="$(ls -d "$bundle"/macos/*.app 2>/dev/null | head -n1 || true)"
[ -n "$app" ] && check "app bundle exists" ok || { echo "FAIL app bundle missing in $bundle/macos" >&2; exit 1; }
plist="$app/Contents/Info.plist"
id="$(plutil -extract CFBundleIdentifier raw "$plist")"
ver="$(plutil -extract CFBundleShortVersionString raw "$plist")"
[ "$id" = "$want_id" ] && check "bundle identifier" ok || check "bundle identifier" bad "got $id, want $want_id"
[ "$ver" = "$want_version" ] && check "bundle version" ok || check "bundle version" bad "got $ver, want $want_version"

bin="$app/Contents/MacOS/$(ls "$app/Contents/MacOS" | head -n1)"
file "$bin" | tee "$evidence/binary-type.txt" | grep -q 'Mach-O' && check "executable is Mach-O" ok || check "executable is Mach-O" bad "$(cat "$evidence/binary-type.txt")"
lipo -archs "$bin" | tee "$evidence/archs.txt" >/dev/null
# Unsigned verification build: record the signature state, never claim it is signed.
codesign -dv "$app" > "$evidence/codesign.txt" 2>&1 || true
echo "signature state: $(grep -E 'Signature=|code object is not signed' "$evidence/codesign.txt" | head -n1)"

# Same rule as the CI build job: no server configuration inside a client bundle.
if grep -aEl 'DATABASE_URL|postgres(ql)?://|bos_(app|owner|auth|jobs)|MIGRATION_|AUTH_SECRET' "$bin"; then
  check "no server configuration in the executable" bad "found"
else
  check "no server configuration in the executable" ok
fi

dmg="$(ls "$bundle"/dmg/*.dmg 2>/dev/null | head -n1 || true)"
[ -z "$dmg" ] || dmg="$(cd "$(dirname "$dmg")" && pwd)/$(basename "$dmg")"
if [ -n "$dmg" ] && hdiutil verify "$dmg" > "$evidence/hdiutil-verify.txt" 2>&1; then check "disk image verifies" ok; else check "disk image verifies" bad "${dmg:-no dmg}"; fi

tar -C "$(dirname "$app")" -czf "$evidence/app.tar.gz" "$(basename "$app")"
( cd "$evidence" && shasum -a 256 app.tar.gz > SHA256SUMS && [ -z "$dmg" ] || shasum -a 256 "$dmg" >> SHA256SUMS )
cat "$evidence/SHA256SUMS"
exit "$fail"
