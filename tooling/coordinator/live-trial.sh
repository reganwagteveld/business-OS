#!/bin/bash
# Run in an ordinary authenticated host terminal, with its normal permissions.
set -euo pipefail
umask 077
coordinator_root="$(cd "$(dirname "$0")/../.." && pwd)"
trial_dir="$coordinator_root/.coordinator-local"
mkdir -p "$trial_dir"
for executable in python3 git claude codex; do
  command -v "$executable" >/dev/null || { echo "Missing command: $executable"; exit 1; }
done
claude auth status > "$trial_dir/claude-auth-status.json"
python3 - "$trial_dir/claude-auth-status.json" <<'PY'
import json, sys
if not json.load(open(sys.argv[1])).get('loggedIn'):
    sys.exit('Claude login is unavailable in this terminal. Run claude auth login here.')
PY
codex login status
python3 - "$trial_dir" <<'PY'
import json, sys
from pathlib import Path
p=Path(sys.argv[1])
check="from pathlib import Path; p=Path('coordinator-trial.txt'); assert p.read_text() == 'Coordinator live handoff verified.\\n', 'Trial content incorrect'"
config={'state_directory':str(p/'jobs'), 'codex_model':'gpt-6.1-sol',
        'claude_model':'sonnet', 'turn_timeout_seconds':900,
        'max_audit_cycles':3,'max_turns':10,
        'qa_commands':[['python3','-c',check]]}
(p/'trial-config.json').write_text(json.dumps(config,indent=2))
(p/'trial-brief.md').write_text('''Transport smoke test only. Create exactly one new file, coordinator-trial.txt,
containing exactly this line followed by a newline:
Coordinator live handoff verified.
Do not change or commit any other file. Codex plans then Claude writes then Codex inspects
actual content; return changes if incorrect and Claude will correct it. No production,
network, database, dependencies or shell commands are needed for this task. Use file tools.
The host runs the independent content check. State honestly that you did not run QA yourself.
The final release-unconfigured state is the expected successful stopping point for this trial,
not proof that production release works. Do not read unrelated product documentation.
''')
PY
trial_id="handoff-$(date +%Y%m%d-%H%M%S)"
echo "Starting live handoff trial: $trial_id"
echo "Claude model: sonnet alias. Codex model: gpt-6.1-sol."
echo "This is a transport test. Production release is not connected."
python3 "$coordinator_root/tooling/coordinator/coordinator.py" --config "$trial_dir/trial-config.json" add "$trial_id" "$trial_dir/trial-brief.md"
python3 "$coordinator_root/tooling/coordinator/coordinator.py" --config "$trial_dir/trial-config.json" run "$trial_id"
echo "Trial stopped at the release boundary. Logs: $trial_dir/jobs/$trial_id"
