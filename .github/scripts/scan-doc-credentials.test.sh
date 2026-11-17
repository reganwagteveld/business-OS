#!/usr/bin/env bash
# Self-test for scan-doc-credentials.sh. Fake credentials are assembled at run time so this file
# itself never contains a matching string.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fail=0

# name, expected (pass|fail), file, added line
check() {
  local got=pass
  printf 'diff --git a/%s b/%s\n--- a/%s\n+++ b/%s\n@@ -0,0 +1 @@\n+%s\n' "$3" "$3" "$3" "$3" "$4" \
    | "$here/scan-doc-credentials.sh" > /dev/null 2>&1 || got=fail
  if [ "$got" = "$2" ]; then echo "ok   $1 ($got)"; else echo "FAIL $1: expected $2, got $got" >&2; fail=1; fi
}
x16=ABCDEFGHIJKLMNOP; a36=abcdefghijklmnopqrstuvwxyz0123456789
check "plain prose"                    pass docs/a.md "The API key lives in the provider dashboard."
check "local CI connection string"     pass docs/a.md "postgresql://bos_app:bos_local_app_password@localhost:5432/business_os"
check "placeholder Neon URL, no password" pass docs/a.md "postgresql://USER@ep-x.us-east-1.aws.neon.tech/db"
check "AWS key id"                     fail docs/a.md "key AKIA$x16"
check "GitHub token"                   fail docs/a.md "ghp_$a36"
check "RSA private key header"         fail docs/a.md "-----BEGIN RSA PRIVATE KEY-----"
check "private key header (generic)"   fail README.md "-----BEGIN PRIVATE KEY-----"
check "Slack token"                    fail docs/a.md "xoxb-1234567890-abcdef"
check "Stripe live key"                fail docs/a.md "sk_live_$x16"
check "Neon URL with password"         fail docs/a.md "postgresql://neondb_owner:s3cret@ep-x-123.us-east-1.aws.neon.tech/neondb"
check "root markdown"                  fail CLAUDE.md "ghp_$a36"
check "nested markdown"                fail apps/api/AGENTS.md "ghp_$a36"
check "docs text file"                 fail docs/ui/harness/main.tsx.txt "ghp_$a36"
check "test fixture is out of scope"   pass apps/api/tests/unit/x.test.ts "AKIA$x16"
check "removed line is not scanned"    pass docs/a.md " context line"
# a removed credential line is not an addition
got=pass
printf 'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +0,0 @@\n-%s\n' "ghp_$a36" \
  | "$here/scan-doc-credentials.sh" > /dev/null 2>&1 || got=fail
if [ "$got" = pass ]; then echo "ok   deleting a credential passes"; else echo "FAIL deleting a credential" >&2; fail=1; fi
exit "$fail"
