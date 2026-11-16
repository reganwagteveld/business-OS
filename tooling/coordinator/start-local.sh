#!/bin/bash
# Install a per-user launchd worker from the user's ordinary authenticated terminal.
set -euo pipefail
umask 077
source_root="$(cd "$(dirname "$0")/../.." && pwd)"
coordinator_root="$HOME/Library/Application Support/Pixakova/BusinessOSCoordinator"
if [ "$source_root" != "$coordinator_root" ]; then
  mkdir -p "$(dirname "$coordinator_root")"
  if [ ! -d "$coordinator_root/.git" ]; then
    git clone --no-hardlinks "$source_root" "$coordinator_root"
  else
    if ! git -C "$coordinator_root" diff --quiet || ! git -C "$coordinator_root" diff --cached --quiet; then
      echo "Managed runtime has local tracked changes; refusing to overwrite them."
      exit 1
    fi
    git -C "$coordinator_root" fetch "$source_root" HEAD
    git -C "$coordinator_root" merge --ff-only FETCH_HEAD
  fi
fi
local_dir="$coordinator_root/.coordinator-local"
if [ "${1:-}" = "--update-only" ]; then
  python3 - "$local_dir/status.json" <<'PY'
import json, sys, time
from pathlib import Path
p=Path(sys.argv[1])
if not p.exists() or time.time()-p.stat().st_mtime>45:
    sys.exit('Runtime updated, but no fresh worker heartbeat exists. Start the service before queueing.')
print('Runtime updated; existing worker retained without restart.')
PY
  exit 0
fi
mkdir -p "$local_dir/jobs"
if [ -f "$local_dir/host.env" ]; then
  set -a
  source "$local_dir/host.env"
  set +a
fi
python3 - "$coordinator_root" "$local_dir" <<'PY'
import json, os, plistlib, shutil, sys
from pathlib import Path
root, local = map(Path, sys.argv[1:])
config = local/'config.local.json'
if not config.exists():
    data = json.loads((root/'tooling/coordinator/config.example.json').read_text())
    data['state_directory'] = str(local/'jobs')
    data['source_repository'] = 'https://github.com/reganwagteveld/business-OS.git'
    operations = str(root/'tooling/coordinator/operations.py')
    python = shutil.which('python3')
    data['turn_timeout_seconds'] = 3600
    data['notifications'] = True
    data['qa_commands'] = [[python, operations, 'qa', '{checkout}', '--log', '{job_dir}/operations.log']]
    data['release'] = {
        'enabled': False, 'repository': 'reganwagteveld/business-OS',
        'required_checks': ['CI gate'],
        'health_url': 'https://app.pixakova.com/api/v1/health',
        'vercel_project_ids': [], 'vercel_team_id': '',
        'neon_project_id': '', 'neon_production_branch_id': '',
        'migration_qualification_command': [python, operations, 'qualify'],
        'privileged_apply_command': [python, operations, 'privileged'],
        'authenticated_smoke_command': [python, operations, 'smoke']
    }
    config.write_text(json.dumps(data,indent=2)+'\n')
# launchd runs a shell wrapper so host credentials stay in an untracked host file, not its plist.
wrapper = local/'launch-worker.sh'
import shlex
q=shlex.quote
wrapper.write_text('#!/bin/bash\nset -euo pipefail\numask 077\nexport PATH='+q(os.environ['PATH'])+'\n'+
    'if [ -f '+q(str(local/'host.env'))+' ]; then set -a; source '+q(str(local/'host.env'))+'; set +a; fi\n'+
    'exec /usr/bin/caffeinate -i '+q(shutil.which('python3'))+' '+q(str(root/'tooling/coordinator/worker.py'))+
    ' --config '+q(str(config))+'\n')
wrapper.chmod(0o700)
plist = {'Label':'com.pixakova.business-os.coordinator', 'ProgramArguments':['/bin/bash',str(wrapper)],
         'WorkingDirectory':str(root), 'RunAtLoad':True, 'KeepAlive':True, 'ThrottleInterval':30,
         'StandardOutPath':str(local/'supervisor.log'), 'StandardErrorPath':str(local/'supervisor-error.log')}
(local/'coordinator.plist').write_bytes(plistlib.dumps(plist))
print('Host worker configuration: '+str(config))
PY
python3 "$coordinator_root/tooling/coordinator/doctor.py" --config "$local_dir/config.local.json" > "$local_dir/readiness.json"
previous_worker_pid="$(python3 - "$local_dir/status.json" <<'PY'
import json, sys, time
from pathlib import Path
p=Path(sys.argv[1])
s=json.loads(p.read_text()) if p.exists() else {}
if p.exists() and time.time()-p.stat().st_mtime<45 and s.get('running'):
    sys.exit('A coordinator job is active; installation will not interrupt it.')
print(s.get('supervisor_pid', 0))
PY
)"
launchctl bootout "gui/$(id -u)/com.pixakova.business-os.coordinator" 2>/dev/null || true
if [ "${1:-}" != "--restart-only" ]; then
  python3 "$coordinator_root/tooling/coordinator/queue-fix-trial.py"
fi
launchctl bootstrap "gui/$(id -u)" "$local_dir/coordinator.plist"
launchctl print "gui/$(id -u)/com.pixakova.business-os.coordinator"
python3 - "$local_dir/status.json" "$previous_worker_pid" <<'PYTHON'
import json, os, sys, time
from pathlib import Path
p=Path(sys.argv[1])
for _ in range(30):
    if p.exists() and time.time()-p.stat().st_mtime<15:
        state=json.loads(p.read_text())
        pid=state.get('supervisor_pid', 0)
        if pid and pid!=int(sys.argv[2]):
            try:
                os.kill(pid, 0)
            except OSError:
                pass
            else:
                print('Worker heartbeat verified; active job: '+str(state.get('running')))
                break
    time.sleep(1)
else:
    sys.exit('Worker has no fresh heartbeat. Inspect supervisor-error.log; installation is not verified.')
PYTHON
echo "Worker installed. Readiness: $local_dir/readiness.json"
echo "Status: $local_dir/status.md"
echo "Existing paused/completed trials remain stopped. Only saved eligible jobs run."
echo "Production release remains disabled until its configuration and checks pass."
