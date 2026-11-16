#!/bin/bash
# Run from the ordinary authenticated host Terminal.
set -euo pipefail
umask 077
script_root="$(cd "$(dirname "$0")" && pwd)"
runtime_root="$HOME/Library/Application Support/Pixakova/BusinessOSCoordinator"
python3 - "$runtime_root/.coordinator-local/status.json" <<'PY'
import json, sys, time
from pathlib import Path
path=Path(sys.argv[1])
if path.exists() and time.time()-path.stat().st_mtime<45 and json.loads(path.read_text()).get('running'):
    sys.exit('A coordinator job is active. It has been left running; no restart attempted.')
PY
bash "$script_root/start-local.sh" --update-only
python3 "$runtime_root/tooling/coordinator/queue-release-trial.py"
