#!/usr/bin/env python3
"""Queue a real audit/fix/re-audit trial for the persistent worker; no production writes."""
import json
from pathlib import Path
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[2]
local = root/'.coordinator-local'
local.mkdir(exist_ok=True, mode=0o700)
config_path = local/'fix-trial-config.json'
check = "from pathlib import Path; assert Path('coordinator-trial.txt').read_bytes()==b'Coordinator live handoff verified.\\n'"
config = {'state_directory': str(local/'jobs'), 'codex_model': 'gpt-6.1-sol',
          'claude_model': 'claude-sonnet-5-5', 'turn_timeout_seconds': 900, 'max_audit_cycles': 3,
          'max_turns': 8, 'qa_commands': [[sys.executable, '-c', check]], 'release': {'enabled': False}}
config_path.write_text(json.dumps(config,indent=2)+'\n')
brief = local/'fix-trial-brief.md'
brief.write_text('''Controlled transport regression test. The host deliberately seeded an incorrect
coordinator-trial.txt. Its required bytes are exactly: Coordinator live handoff verified. followed by
one newline. Codex must inspect the actual file and report a concrete finding if incorrect.
Claude then fixes only that file and Codex audits it again. Do not commit, use shell commands,
change any other file or access production. Host QA verifies the bytes independently. Read only
this brief and the trial file; product documentation is unrelated. Set release_strategy to none.
''')
job_id = 'fix-loop-' + time.strftime('%Y%m%d-%H%M%S')
subprocess.run([sys.executable, str(root/'tooling/coordinator/coordinator.py'), '--config', str(config_path),
                'add', job_id, str(brief)], check=True)
from coordinator import save
job = local/'jobs'/job_id
state = json.loads((job/'state.json').read_text())
(Path(state['checkout'])/'coordinator-trial.txt').write_text('Deliberately incorrect smoke-test fixture.\n')
state['stage'] = 'audit'
state['implementation'] = {'summary': 'Host seeded a deliberate defect to exercise real audit/fix handoffs', 'findings': []}
save(job/'state.json', state)
print('Queued real fixes-loop trial: '+job_id)
