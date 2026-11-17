#!/usr/bin/env bash
# CIQ-A1 docs check: fails when a line ADDED to a documentation file (docs/**, any *.md, *.mdx or
# *.txt) looks like a live credential. Reads `git diff --unified=0 --no-renames` output on stdin.
# Runs for every tier in "Detect changes", so documentation-only runs still have a content check
# after the docs tier skips the other jobs. The repository is public: never paste the match into the log.
#
# Patterns are deliberately high-confidence (provider-specific prefixes and formats) so ordinary
# prose never trips them. Code and test fixtures are out of scope; secret scanning covers them.
set -euo pipefail

patterns=(
  'AKIA[0-9A-Z]{16}'                                             # AWS access key id
  'gh[pousr]_[A-Za-z0-9]{36,}'                                   # GitHub token
  'github_pat_[A-Za-z0-9_]{22,}'                                 # GitHub fine-grained token
  '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'                        # private key
  'xox[abprs]-[A-Za-z0-9-]{10,}'                                 # Slack token
  '(sk|rk)_live_[A-Za-z0-9]{16,}'                                # Stripe live key
  'npm_[A-Za-z0-9]{36}'                                          # npm token
  're_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}'                          # Resend API key
  'postgres(ql)?://[^[:space:]:@/]+:[^[:space:]@/]+@[^[:space:]/]*neon\.tech'  # Neon URL with password
)
regex="$(IFS='|'; echo "${patterns[*]}")"

is_doc() {
  case "$1" in
    docs/*|*.md|*.mdx|*.txt) return 0 ;;
  esac
  return 1
}

file=""
hits=0
while IFS= read -r line; do
  case "$line" in
    '+++ b/'*) file="${line#+++ b/}"; continue ;;
    '+++ '*) file=""; continue ;;
    '+'*)
      if [ -n "$file" ] && is_doc "$file" && printf '%s\n' "${line:1}" | grep -qE -- "$regex"; then
        echo "::error file=$file,title=Possible credential in documentation::An added line in $file matches a credential pattern. Remove it (and rotate the credential if it is real)."
        hits=$((hits + 1))
      fi
      ;;
  esac
done

if [ "$hits" -gt 0 ]; then
  echo "$hits added documentation line(s) look like credentials" >&2
  exit 1
fi
echo "no credential patterns in added documentation lines"
