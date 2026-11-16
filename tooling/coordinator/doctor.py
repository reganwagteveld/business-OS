#!/usr/bin/env python3
"""Check readiness without printing any credentials or performing production writes."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    checks = []
    def check(name, passed):
        checks.append({'check': name, 'passed': bool(passed)})
    for executable in ['git', 'python3', 'claude', 'codex', 'gh', 'pnpm']:
        check('installed:' + executable, shutil.which(executable))
    try:
        p = subprocess.run(['claude', 'auth', 'status'], text=True, capture_output=True, timeout=15)
        check('Claude authenticated', json.loads(p.stdout).get('loggedIn'))
    except (ValueError, OSError, subprocess.TimeoutExpired):
        check('Claude authenticated', False)
    for command, label in [(['codex', 'login', 'status'], 'Codex authenticated'),
                            (['gh', 'api', 'user', '--jq', '.login'], 'GitHub authenticated/network')]:
        try:
            check(label, subprocess.run(command, capture_output=True, timeout=20).returncode == 0)
        except (OSError, subprocess.TimeoutExpired):
            check(label, False)
    release = config.get('release', {})
    check('release adapters enabled', release.get('enabled'))
    if release.get('enabled'):
        for key in ['repository', 'required_checks', 'vercel_project_ids', 'health_url',
                    'neon_project_id', 'neon_production_branch_id', 'migration_qualification_command',
                    'authenticated_smoke_command', 'privileged_apply_command']:
            check('configured:' + key, release.get(key))
        for key in ['BOS_MIGRATION_DATABASE_URL', 'BOS_VERCEL_TOKEN']:
            check('host secret available:' + key, bool(os.environ.get(key)))
    print(json.dumps({'ready': all(x['passed'] for x in checks), 'checks': checks}, indent=2))


if __name__ == '__main__':
    main()
