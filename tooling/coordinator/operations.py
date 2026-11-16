#!/usr/bin/env python3
"""Host adapters: disposable-database QA/upgrade qualification and authenticated read smoke."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

from coordinator import command, safe_environment
from release import checked, invariants, postgres_environment


def local_env(port):
    base = f'127.0.0.1:{port}'
    url = lambda role, password, db='business_os': f'postgresql://{role}:{password}@{base}/{db}'
    return safe_environment({
        'DATABASE_URL': url('bos_app', 'bos_local_app_password'),
        'AUTH_DATABASE_URL': url('bos_auth', 'bos_local_auth_password'),
        'MIGRATION_DATABASE_URL': url('bos_owner', 'bos_local_owner_password'),
        'SHADOW_DATABASE_URL': url('bos_owner', 'bos_local_owner_password', 'business_os_shadow'),
        'TEST_ADMIN_URL': url('postgres', 'local_coordinator_only'),
        'ADMIN_DATABASE_URL': url('postgres', 'local_coordinator_only'),
        'AUTH_SECRET': 'local-coordinator-test-only-secret-0123456789',
        'REGION': 'local', 'DATABASE_REGION': 'local', 'DEPLOYMENT_REGION': 'local',
        'APP_BASE_URL': 'http://localhost:3000', 'VITE_API_BASE_URL': 'http://localhost:3000',
        'CORS_ALLOWED_ORIGINS': 'http://localhost:5173,http://localhost:1420,tauri://localhost,http://tauri.localhost',
    })


@contextmanager
def database(checkout):
    name = 'bos-coordinator-' + uuid.uuid4().hex[:12]
    env = safe_environment()
    checked(['docker', 'run', '-d', '--rm', '--name', name, '-p', '127.0.0.1:0:5432',
             '-e', 'POSTGRES_PASSWORD=local_coordinator_only', '-e', 'POSTGRES_DB=business_os',
             '-v', str(Path(checkout)/'docker/init') + ':/docker-entrypoint-initdb.d:ro', 'postgres:16.10'], checkout, env)
    try:
        port = int(checked(['docker', 'port', name, '5432/tcp'], checkout, env).split(':')[-1])
        for _ in range(60):
            p = command(['docker', 'exec', name, 'pg_isready', '-U', 'postgres', '-d', 'business_os'], checkout, 15, env)
            if p.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Disposable test database did not start')
        yield local_env(port)
    finally:
        checked(['docker', 'rm', '-f', name], checkout, env)


def run_logged(argv, checkout, env, log):
    result = command(argv, checkout, 3600, env)
    with Path(log).open('a') as out:
        out.write('\nCOMMAND: ' + ' '.join(argv) + '\n' + result.stdout + result.stderr)
    if result.returncode:
        # These commands use synthetic local credentials only; give the fixes agent
        # the actual failure instead of a host-log path it cannot inspect.
        raise RuntimeError('Local check failed: ' + ' '.join(argv) + '; see ' + str(log) +
                           '\n' + (result.stdout + result.stderr)[-10000:])


def setup(checkout, env, log):
    run_logged(['pnpm', 'install', '--frozen-lockfile'], checkout, env, log)
    run_logged(['pnpm', '--filter', '@business-os/api', 'exec', 'prisma', 'migrate', 'deploy'], checkout, env, log)
    run_logged(['pnpm', '--filter', '@business-os/api', 'db:privileged'], checkout, env, log)


def qa(checkout, log):
    with database(checkout) as env:
        setup(checkout, env, log)
        for script in ['contracts:check', 'typecheck', 'lint', 'boundaries', 'test', 'test:integration', 'db:check-migrations', 'build']:
            run_logged(['pnpm', script], checkout, env, log)
    return {'local_qa': True, 'pooler_isolation': 'required in canonical GitHub CI, not asserted here'}


def qualify(checkout, sha, log):
    if checked(['git', 'rev-parse', 'HEAD'], checkout) != sha:
        raise RuntimeError('Qualification checkout does not match reviewed SHA')
    with database(checkout) as env:
        setup(checkout, env, log)
        run_logged(['pnpm', 'test:integration'], checkout, env, log)
        run_logged(['pnpm', 'db:check-migrations'], checkout, env, log)
    # Baseline = main's ancestor used to qualify the PR. Never copy production data.
    base = checked(['git', 'merge-base', 'origin/main', sha], checkout)
    with tempfile.TemporaryDirectory(prefix='bos-qualification-') as tmp:
        baseline = Path(tmp)/'baseline'
        checked(['git', 'worktree', 'add', '--detach', str(baseline), base], checkout)
        try:
            with database(baseline) as env:
                setup(baseline, env, log)
                run_logged(['pnpm', 'test:integration'], baseline, env, log)
                db_env = postgres_environment(env['TEST_ADMIN_URL'], env)
                count_sql = 'SELECT count(*) FROM businesses'
                before = int(checked(['psql', '-XAt', '-c', count_sql], baseline, db_env))
                if before == 0:
                    raise RuntimeError('Baseline tests retained no representative businesses; explicit fixture is needed')
                run_logged(['pnpm', '--filter', '@business-os/api', 'exec', 'prisma', 'migrate', 'deploy'], checkout, env, log)
                run_logged(['pnpm', '--filter', '@business-os/api', 'db:privileged'], checkout, env, log)
                after = int(checked(['psql', '-XAt', '-c', count_sql], checkout, db_env))
                if before != after:
                    raise RuntimeError('Upgrade changed baseline business count')
                run_logged(['pnpm', 'test:integration'], checkout, env, log)
                run_logged(['pnpm', 'db:check-migrations'], checkout, env, log)
        finally:
            checked(['git', 'worktree', 'remove', '--force', str(baseline)], checkout)
    return {'sha': sha, 'fresh': True, 'upgrade': True, 'baseline': base, 'synthetic_businesses_before': before}


def privileged(checkout, sha, log):
    if checked(['git', 'rev-parse', 'HEAD'], checkout) != sha:
        raise RuntimeError('Privileged checkout SHA differs')
    admin = os.environ.get('BOS_ADMIN_DATABASE_URL')
    if not admin:
        raise RuntimeError('Missing host secret BOS_ADMIN_DATABASE_URL')
    from release import prod_env
    env = prod_env()
    migration_target = urllib.parse.urlsplit(env['MIGRATION_DATABASE_URL'])
    admin_target = urllib.parse.urlsplit(admin)
    if (migration_target.hostname, migration_target.path) != (admin_target.hostname, admin_target.path):
        raise RuntimeError('Admin URL does not target the same database as the migration URL')
    env['ADMIN_DATABASE_URL'] = admin
    env['DEPLOYMENT_REGION'] = 'us-east-1'
    # Never save raw production command output, even on error.
    checked(['pnpm', '--filter', '@business-os/api', 'db:privileged'], checkout, env)
    invariants(checkout)
    return {'sha': sha, 'passed': True}


def smoke(sha):
    origin = os.environ.get('BOS_SMOKE_ORIGIN', 'https://app.pixakova.com').rstrip('/')
    cookie = os.environ.get('BOS_SMOKE_COOKIE')
    slug = os.environ.get('BOS_SMOKE_BUSINESS_SLUG')
    if not cookie or not slug:
        raise RuntimeError('Host smoke credentials BOS_SMOKE_COOKIE and BOS_SMOKE_BUSINESS_SLUG are required')
    if urllib.parse.urlsplit(origin).scheme != 'https':
        raise RuntimeError('Production smoke origin must use HTTPS')
    slug = urllib.parse.quote(slug, safe='')
    routes = ['/api/v1/me'] + [f'/api/v1/b/{slug}/' + route for route in
        ['customers', 'projects', 'finance/invoices', 'people/employees', 'scheduling/calendars',
         'communications/connections', 'reporting/metrics']]
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    opener = urllib.request.build_opener(NoRedirect())
    for route in routes:
        request = urllib.request.Request(origin + route, headers={'Cookie': cookie, 'Cache-Control': 'no-cache'})
        with opener.open(request, timeout=30) as response:
            if response.status != 200 or 'application/json' not in response.headers.get('Content-Type', ''):
                raise RuntimeError('Authenticated smoke failed')
            json.load(response)  # Validate JSON without persisting business data.
    return {'sha': sha, 'passed': True, 'checked_routes': len(routes), 'mode': 'authenticated-read-only'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['qa', 'qualify', 'privileged', 'smoke'])
    parser.add_argument('target')
    parser.add_argument('sha', nargs='?')
    parser.add_argument('--log', type=Path)
    args = parser.parse_args()
    log = args.log or Path.cwd()/'operations.log'
    if args.action == 'smoke':
        result = smoke(args.target)
    elif args.action == 'qa':
        result = qa(Path(args.target).resolve(), log)
    elif args.action == 'qualify':
        result = qualify(Path(args.target).resolve(), args.sha, log)
    else:
        result = privileged(Path(args.target).resolve(), args.sha, log)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
