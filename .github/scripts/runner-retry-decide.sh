#!/usr/bin/env bash
# CIQ-A4: decides whether a failed CI run may be re-run automatically. Read-only; prints
#   decision=retry|skip|infra-failure   and   reason=...
#
#   jobs.json        the run attempt's jobs (GET .../runs/<id>/attempts/<n>/jobs), object or array
#   annotations-dir  <job-id>.json per cancelled job (GET .../check-runs/<job-id>/annotations)
#   attempt          the run attempt that finished (1, 2, ...)
#
# A job is a CONFIRMED runner-allocation failure only if ALL hold: it completed as cancelled, no
# runner was ever assigned (runner_id 0 or missing, empty runner_name), no step ran, and GitHub
# annotated it "...was not acquired by Runner...". Retry only when every failed job except the
# "CI gate" job is such a failure, and only after attempt 1: one retry per run (that is, per SHA and
# event). A test failure, a timeout or any other cancellation is never retried. A second allocation
# failure is reported as an infrastructure failure and CI stays red.
set -euo pipefail
jobs_file="${1:?jobs.json}"; ann_dir="${2:?annotations dir}"; attempt="${3:?attempt}"
[[ "$attempt" =~ ^[0-9]+$ ]] || { echo "decision=skip"; echo "reason=invalid attempt '$attempt'"; exit 0; }

jobs="$(jq -c 'if type == "object" then .jobs else . end | map({id, name, status, conclusion,
  runner_id: (.runner_id // 0), runner_name: (.runner_name // ""), steps: ((.steps // []) | length)})' "$jobs_file")" \
  || { echo "decision=skip"; echo "reason=jobs list unreadable (fail closed: no retry)"; exit 0; }

failed="$(jq -c '[.[] | select(.name != "CI gate") | select(.conclusion != "success" and .conclusion != "skipped")]' <<< "$jobs")"
if [ "$(jq length <<< "$failed")" -eq 0 ]; then
  echo "decision=skip"; echo "reason=no failed job other than the gate"; exit 0
fi

alloc_names=()
while IFS= read -r job; do
  id="$(jq -r .id <<< "$job")"; name="$(jq -r .name <<< "$job")"
  structural="$(jq -r '.status == "completed" and .conclusion == "cancelled" and .runner_id == 0 and .runner_name == "" and .steps == 0' <<< "$job")"
  annotated=false
  if [[ "$id" =~ ^[0-9]+$ ]] && [ -f "$ann_dir/$id.json" ] \
     && jq -e 'any(.[]?; (.annotation_level == "failure") and ((.message // "") | test("was not acquired by Runner")))' "$ann_dir/$id.json" > /dev/null 2>&1; then
    annotated=true
  fi
  if [ "$structural" != true ] || [ "$annotated" != true ]; then
    echo "decision=skip"
    echo "reason=$name finished as $(jq -r .conclusion <<< "$job") and is not a confirmed runner-allocation failure; never retried"
    exit 0
  fi
  alloc_names+=("$name")
done < <(jq -c '.[]' <<< "$failed")

list="$(IFS=,; echo "${alloc_names[*]}")"
if [ "$attempt" -eq 1 ]; then
  echo "decision=retry"; echo "reason=runner never allocated: $list"
else
  echo "decision=infra-failure"; echo "reason=runner never allocated again on attempt $attempt: $list"
fi
