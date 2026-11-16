#!/usr/bin/env python3
"""Queue the coordinator's own bounded live release qualification on the host."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from coordinator import git, save
from release import checked, invariants, ledger, migration_files, validate_ledger, validate_configuration
from worker import refresh_runtime

APPROVED_PATHS = ['tooling/coordinator/*', 'docs/roadmap.md', 'docs/evidence/coordinator/*',
                  '.github/workflows/ci.yml', '.gitignore']
PATCH_PATHS = ['tooling/coordinator', 'docs/roadmap.md', 'docs/evidence/coordinator',
               '.github/workflows/ci.yml', '.gitignore']
BRIEF = '''Qualify and deliver the Business OS Claude/Codex coordinator implementation.
The host imported only coordinator tooling, its roadmap/evidence, CI test registration and
ignore rules into a clean checkout of current GitHub main. The developer's separate F6-2
checkout must stay untouched. Audit the diff from origin/main, source instructions and tests.
Identify and fix concrete engineering defects within the approved paths only. Do not add
product features, modify app code, change schema/privileged SQL, weaken existing QA or remove
release gates. The candidate coordinator code is the subject of review and may be corrected;
the installed host broker, credentials, private configuration and this task's scope may not.
Check durable handoffs, pause/retry semantics, independent QA, publication, CI gates, database
target/checksum checks, uncertain-write reconciliation, deployment promotion and signed-in
smoke verification. Correct inaccurate readiness claims in docs. No production schema change
is part of this job. Set release_strategy to none. Independent host QA and canonical CI run
after audit; the host broker handles the authorized merge and read-only release checks.
Completion means the exact reviewed changes merged under CI protection, main CI succeeded,
both production targets point to the merged SHA, and signed-in cross-Zone smoke reads pass.
'''


def ensure_database_engine(root):
    if not shutil.which('docker'):
        raise RuntimeError('Docker CLI is missing; the full database QA cannot run')
    def ready():
        return subprocess.run(['docker', 'info', '--format', '{{.ServerVersion}}'], cwd=root,
                              capture_output=True, timeout=10).returncode == 0
    if ready():
        return
    if sys.platform != 'darwin' or not Path('/Applications/Docker.app').is_dir():
        raise RuntimeError('Docker engine is stopped; start the configured engine before qualification')
    print('Starting the installed Docker Desktop for disposable database QA...', flush=True)
    subprocess.run(['open', '-a', 'Docker'], check=True, capture_output=True, timeout=15)
    for _ in range(60):
        if ready():
            return
        time.sleep(2)
    raise RuntimeError('Docker Desktop did not become ready; no job or production write started')


def import_candidate(root, checkout, branch, repository='https://github.com/reganwagteveld/business-OS.git'):
    git(root, 'clone', '--no-hardlinks', repository, str(checkout))
    git(checkout, 'switch', 'main')
    baseline = git(checkout, 'rev-parse', 'HEAD')
    git(checkout, 'switch', '-c', branch)
    git(checkout, 'fetch', str(root), 'HEAD')
    candidate = git(checkout, 'rev-parse', 'FETCH_HEAD')
    common = git(checkout, 'merge-base', baseline, candidate)
    patch = subprocess.run(['git', 'diff', '--binary', common, candidate, '--', *PATCH_PATHS],
                           cwd=checkout, capture_output=True, check=True).stdout
    if not patch:
        raise RuntimeError('There is no coordinator candidate change to qualify')
    result = subprocess.run(['git', 'apply', '--3way'], cwd=checkout, input=patch, capture_output=True)
    conflicts = git(checkout, 'diff', '--name-only', '--diff-filter=U').splitlines()
    if result.returncode and not conflicts:
        raise RuntimeError('Candidate patch could not be imported; no job started')
    return baseline, candidate, conflicts


def queue(root):
    local = root / '.coordinator-local'
    config_path = local / 'config.local.json'
    config = refresh_runtime(config_path)
    status_path = local / 'status.json'
    if not status_path.exists() or time.time() - status_path.stat().st_mtime > 45:
        raise RuntimeError('No fresh worker heartbeat; no job queued')
    status = json.loads(status_path.read_text())
    if status.get('running'):
        raise RuntimeError('A worker job is already active; leave it running')
    jobs = Path(config['state_directory'])
    for state_path in jobs.glob('release-qualification-*/state.json'):
        state = json.loads(state_path.read_text())
        if state.get('stage') == 'verified':
            print('Qualification already verified: ' + state['id'])
        else:
            print('Existing qualification retained: ' + state['id'] + ' — ' + state['stage'])
        print('Inspect its saved state rather than creating a duplicate release.')
        return
    config['release']['enabled'] = True  # This job only; ordinary release stays disabled.
    config['release']['approved_paths'] = APPROVED_PATHS
    validate_configuration(config['release'])
    for executable in ['git', 'gh', 'codex', 'claude', 'pnpm', 'psql', 'neonctl']:
        if not shutil.which(executable):
            raise RuntimeError('Missing required executable: ' + executable)
    print('Checking existing GitHub and agent logins...', flush=True)
    checked(['gh', 'api', 'repos/reganwagteveld/business-OS', '--jq', '.id'], root, timeout=30)
    checked(['codex', 'login', 'status'], root, timeout=20)
    auth = json.loads(checked(['claude', 'auth', 'status'], root, timeout=20))
    if auth.get('loggedIn') is not True:
        raise RuntimeError('Claude is not logged in')
    ensure_database_engine(root)
    job_id = 'release-qualification-' + time.strftime('%Y%m%d-%H%M%S')
    job = jobs / job_id
    job.mkdir(mode=0o700)
    checkout = job / 'checkout'
    # No state.json exists until preparation passes, so the worker cannot race setup.
    baseline, candidate, conflicts = import_candidate(root, checkout, 'agent/' + job_id)
    print('Checking production baseline using read-only database and signed-in requests...', flush=True)
    # Qualification must not silently ship an earlier, unmigrated product baseline.
    validate_ledger(migration_files(checkout), ledger(checkout), False)
    invariants(checkout)
    from operations import smoke
    if smoke('qualification-baseline').get('passed') is not True:
        raise RuntimeError('Baseline signed-in smoke failed')
    protection = json.loads(checked(['gh', 'api', 'repos/reganwagteveld/business-OS/branches/main/protection'], root))
    required = protection.get('required_status_checks') or {}
    contexts = set(required.get('contexts', [])) | {c['context'] for c in required.get('checks', [])}
    if required.get('strict') is not True or 'CI gate' not in contexts or not protection.get('enforce_admins', {}).get('enabled'):
        raise RuntimeError('Existing strict CI/admin branch protection did not pass')
    # Refresh API access now, without relying on the historical access setup report.
    from release import vercel_deployments, Waiting
    try:
        vercel_deployments(config['release'], baseline)
    except Waiting:
        # A newer main push may be deploying. The actual release checks the exact merged SHA.
        print('Current main deployment is still settling; exact release verification remains mandatory.', flush=True)
    python = sys.executable
    config['qa_commands'] = [
        [python, '-m', 'unittest', 'discover', '-s', 'tooling/coordinator', '-p', 'test_*.py', '-v'],
        [python, str(root / 'tooling/coordinator/operations.py'), 'qa', '{checkout}',
         '--log', '{job_dir}/operations.log']]
    config['max_audit_cycles'] = 6
    config['max_turns'] = 16
    # Audit the operational code with the configured strong models; no API billing override.
    config['claude_model'] = 'opus'
    qualification_config = local / 'release-qualification-config.json'
    save(qualification_config, config)
    os.chmod(qualification_config, 0o600)
    save(job / 'state.json', {
        'id': job_id, 'brief': BRIEF, 'checkout': str(checkout), 'base_sha': baseline,
        'candidate_sha': candidate, 'config_path': str(qualification_config),
        'title': 'Add the Business OS Claude and Codex delivery coordinator',
        'stage': 'fix' if conflicts else 'audit', 'cycles': 0, 'turn': 0,
        'implementation': {'summary': 'Host imported bounded coordinator candidate onto current main', 'findings': []},
        'audit': {'summary': 'Resolve import conflicts, then independent audit' if conflicts else 'Independent audit required',
                  'findings': conflicts}})
    print('QUEUED: ' + job_id, flush=True)
    print('Worker will audit → fix as needed → QA → PR → CI → guarded merge → deployment/smoke verification.')
    print('Ordinary release remains disabled. This one job has bounded release authority.')
    print('Status: ' + str(local / 'status.md'))


def main():
    argparse.ArgumentParser(description=__doc__).parse_args()
    root = Path.home() / 'Library/Application Support/Pixakova/BusinessOSCoordinator'
    try:
        queue(root)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        # Do not print raw provider responses or credentials.
        reason = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        save(root / '.coordinator-local/qualification-preflight.json', {'queued': False, 'reason': reason})
        print('Qualification not queued: ' + reason, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
