"""Host-owned release broker. Agents never execute this module or receive its secrets."""
import hashlib
import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.parse
import urllib.request


class Waiting(Exception):
    """External CI/deployment has not finished; poll later without replaying writes."""


def checked(argv, cwd, env=None, timeout=900):
    if argv[0] == 'neonctl' and os.environ.get('NEON_PROFILE') and '--profile' not in argv:
        argv = list(argv) + ['--profile', os.environ['NEON_PROFILE']]
    p = subprocess.run(argv, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        if argv[0] == 'psql':
            raise RuntimeError('PostgreSQL check failed: ' + database_error(p.stderr))
        # Production command output can contain credentials; never put it into job state.
        raise RuntimeError(f'Release command failed ({p.returncode}): {argv[0]}; reconcile before retry')
    return p.stdout.strip()


def database_error(stderr):
    """Classify libpq failures without echoing URLs, hosts, users or passwords."""
    value = stderr.lower()
    for marker, description in [
        ('password authentication failed', 'the configured database password was rejected'),
        ('not permitted to log in', 'the configured database role is not permitted to log in'),
        ('no password supplied', 'the database connection has no usable password'),
        ('could not translate host name', 'the database hostname could not be resolved'),
        ('name or service not known', 'the database hostname could not be resolved'),
        ('nodename nor servname', 'the database hostname could not be resolved'),
        ('timeout expired', 'the database connection timed out'),
        ('connection timed out', 'the database connection timed out'),
        ('connection refused', 'the database endpoint refused the connection'),
        ('invalid uri query parameter', 'the PostgreSQL client rejected a connection URL option'),
        ('invalid connection option', 'the PostgreSQL client rejected a connection option'),
        ('no pg_hba.conf entry', 'the database rejected this client or TLS configuration'),
        ('ssl error', 'TLS negotiation with the database failed'),
        ('certificate verify failed', 'database TLS certificate verification failed'),
        ('permission denied', 'the database role lacks a required read permission'),
        ('does not exist', 'a required database, role or schema object does not exist'),
        ('too many connections', 'the database connection limit was reached'),
        ('endpoint is disabled', 'the Neon endpoint is disabled'),
    ]:
        if marker in value:
            return description
    return 'the database client failed; provider details were withheld to protect credentials'


def gh(config, cwd, *args):
    return json.loads(checked(['gh', *args], cwd))


def migration_files(checkout):
    directory = Path(checkout) / 'apps/api/prisma/migrations'
    return {p.parent.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(directory.glob('*/migration.sql'))}


def validate_ledger(expected, rows, allow_pending):
    seen = set()
    for row in rows:
        name = row['migration_name']
        if name in seen or not row.get('finished_at') or row.get('rolled_back_at'):
            raise RuntimeError('Incomplete/duplicate/rolled-back production migration; reconciliation required')
        if expected.get(name) != row['checksum']:
            raise RuntimeError('Production migration checksum/history differs from reviewed commit')
        seen.add(name)
    pending = sorted(set(expected) - seen)
    if pending and not allow_pending:
        raise RuntimeError('Production migrations are still pending')
    return pending


def verify_ci(pr, sha, base, required):
    if pr['headRefOid'] != sha or pr['baseRefOid'] != base:
        raise RuntimeError('PR head/base changed; audit and CI must be refreshed')
    if pr['state'] != 'OPEN' or pr['isDraft']:
        raise RuntimeError('PR is not open and ready')
    checks = pr.get('statusCheckRollup') or []
    for name in required:
        matching = [c for c in checks if c.get('name', c.get('context')) == name]
        if not matching:
            raise Waiting('Required CI has not appeared')
        # Fail closed on duplicate statuses, including a stale failure plus a success.
        for check in matching:
            if check.get('status') not in [None, 'COMPLETED']:
                raise Waiting('CI is running')
            if check.get('conclusion', check.get('state')) not in ['SUCCESS', 'success']:
                raise RuntimeError('Required CI check did not succeed')
    if pr.get('mergeStateStatus') not in ['CLEAN', 'HAS_HOOKS']:
        raise Waiting('GitHub has not established a clean merge state')


def prod_env():
    url = os.environ.get('BOS_MIGRATION_DATABASE_URL')
    if not url:
        raise RuntimeError('Missing host secret: BOS_MIGRATION_DATABASE_URL')
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ['postgresql', 'postgres'] or not parsed.hostname or '-pooler' in parsed.hostname:
        raise RuntimeError('Production migration URL must be a direct PostgreSQL URL')
    if urllib.parse.parse_qs(parsed.query).get('sslmode', [''])[0] not in ['require', 'verify-ca', 'verify-full']:
        raise RuntimeError('Production migration URL must require TLS')
    if urllib.parse.unquote(parsed.username or '') != 'bos_owner':
        raise RuntimeError('Production migration connection must use bos_owner')
    # Never inherit API/runtime credentials or developer .env into a production tool.
    env = {k: os.environ[k] for k in ['PATH', 'HOME', 'TMPDIR', 'LANG'] if k in os.environ}
    env.update({'MIGRATION_DATABASE_URL': url, 'PGCONNECT_TIMEOUT': '30',
                'PGOPTIONS': '-c statement_timeout=60000 -c lock_timeout=10000',
                'DOTENV_CONFIG_PATH': '/dev/null'})
    return postgres_environment(url, env)


def postgres_environment(url, env):
    # PGDATABASE's environment default is a database name, not an expanded
    # conninfo URI. Setting it to a URL leaves libpq's host/user defaults active.
    # Explicit PG* fields also keep the password out of process arguments.
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ['postgres', 'postgresql'] or not parsed.hostname or not parsed.username or not parsed.path.lstrip('/'):
        raise RuntimeError('PostgreSQL URL must identify a host, role and database')
    result = dict(env)
    result.update({'PGHOST': parsed.hostname, 'PGPORT': str(parsed.port or 5432),
                   'PGUSER': urllib.parse.unquote(parsed.username),
                   'PGDATABASE': urllib.parse.unquote(parsed.path.lstrip('/')),
                   'PGPASSWORD': urllib.parse.unquote(parsed.password or '')})
    fields = {'sslmode': 'PGSSLMODE', 'channel_binding': 'PGCHANNELBINDING',
              'sslrootcert': 'PGSSLROOTCERT', 'sslcert': 'PGSSLCERT', 'sslkey': 'PGSSLKEY',
              'application_name': 'PGAPPNAME', 'connect_timeout': 'PGCONNECT_TIMEOUT'}
    for key, values in urllib.parse.parse_qs(parsed.query).items():
        if key == 'schema':  # Prisma-specific; libpq uses its existing search_path.
            continue
        if key not in fields or len(values) != 1:
            raise RuntimeError('Unsupported or duplicate PostgreSQL URL connection option')
        result[fields[key]] = values[0]
    return result


def ledger(checkout):
    sql = "SELECT coalesce(json_agg(t),'[]'::json) FROM (SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name) t"
    return json.loads(checked(['psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], checkout, prod_env()))


def invariants(checkout):
    sql = """SELECT json_build_object(
    'unprotected', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'_prisma_migrations'
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)),
    'unsafe_roles', (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'bos_%'
      AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)),
    'invalid_constraints', (SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated),
    'app_create', has_schema_privilege('bos_app','public','CREATE'));"""
    env = prod_env()
    env['PGOPTIONS'] += ' -c default_transaction_read_only=on'
    # One SQL command: psql -c only prints the last result of a command string.
    # A trailing ROLLBACK used to discard the SELECT's JSON result.
    result = checked(['psql', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-c', sql], checkout, env)
    try:
        data = json.loads(result)
    except ValueError:
        raise RuntimeError('Database invariant check returned no valid JSON; release remains blocked') from None
    if data != {'unprotected': 0, 'unsafe_roles': 0, 'invalid_constraints': 0, 'app_create': False}:
        raise RuntimeError('Production database invariants failed')
    return data


def once(state, name, operation, persist):
    journal = state.setdefault('release_journal', {})
    entry = journal.get(name)
    if entry:
        if entry['status'] != 'done':
            raise RuntimeError(f'Interrupted/uncertain release operation {name}; reconcile instead of replaying')
        return entry['result']
    journal[name] = {'status': 'started'}
    persist()
    value = operation()
    journal[name] = {'status': 'done', 'result': value}
    persist()
    return value


def view(config, cwd, number):
    return gh(config, cwd, 'pr', 'view', str(number), '--repo', config['repository'], '--json',
              'number,url,headRefOid,baseRefOid,baseRefName,state,isDraft,statusCheckRollup,mergeStateStatus,mergeCommit')


def vercel_deployments(config, merge_sha):
    token = os.environ.get('BOS_VERCEL_TOKEN')
    if not token:
        raise RuntimeError('Missing host secret: BOS_VERCEL_TOKEN')
    verified = []
    for project in config['vercel_project_ids']:
        params = {'projectId': project, 'target': 'production', 'limit': '20', 'meta-githubCommitSha': merge_sha}
        if config.get('vercel_team_id'):
            team = config['vercel_team_id']
            params['teamId' if team.startswith('team_') else 'slug'] = team
        request = urllib.request.Request('https://api.vercel.com/v6/deployments?' + urllib.parse.urlencode(params),
                                         headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=30) as response:
            deployments = json.load(response).get('deployments', [])
        matching = [d for d in deployments if d.get('meta', {}).get('githubCommitSha') == merge_sha
                    and d.get('target') == 'production']
        if not matching:
            raise Waiting('Waiting for production deployment of merged SHA')
        deployment = max(matching, key=lambda d: d.get('created', d.get('createdAt', 0)))
        if deployment.get('state', deployment.get('readyState')) in ['ERROR', 'CANCELED']:
            raise RuntimeError('Production deployment failed')
        if deployment.get('state', deployment.get('readyState')) != 'READY':
            raise Waiting('Production deployment is building')
        if deployment.get('readySubstate') == 'STAGED':
            raise Waiting('Deployment is staged and has not been promoted')
        # Vercel returns either a boolean or an assignment timestamp.
        assigned = deployment.get('aliasAssigned')
        if not (assigned is True or (type(assigned) in [int, float] and assigned > 0)):
            raise Waiting('Production aliases have not been assigned')
        scope = {k: v for k, v in params.items() if k in ['teamId', 'slug']}
        request = urllib.request.Request('https://api.vercel.com/v9/projects/' +
                    urllib.parse.quote(project, safe='') + '?' + urllib.parse.urlencode(scope),
                    headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=30) as response:
            current = json.load(response).get('targets', {}).get('production') or {}
        if current.get('id', current.get('uid')) != deployment['uid']:
            raise Waiting('Reviewed deployment is not the current production target')
        verified.append({'project': project, 'deployment': deployment['uid'], 'sha': merge_sha})
    return verified


def main_ci(config, cwd, sha):
    runs = gh(config, cwd, 'run', 'list', '--repo', config['repository'], '--workflow', 'ci.yml',
              '--event', 'push', '--commit', sha, '--limit', '20',
              '--json', 'headSha,status,conclusion,url,createdAt')
    matching = [r for r in runs if r.get('headSha') == sha]
    if not matching:
        raise Waiting('Waiting for main CI on the merged SHA')
    run = max(matching, key=lambda r: r.get('createdAt', ''))
    if run.get('status') != 'completed':
        raise Waiting('Main CI is running, including native desktop builds')
    if run.get('conclusion') != 'success':
        raise RuntimeError('Main CI failed after merge; release needs reconciliation')
    return {'sha': sha, 'url': run['url'], 'conclusion': 'success'}


def validate_scope(cwd, base, patterns):
    if patterns:
        changed = checked(['git', 'diff', '--name-only', base], cwd).splitlines()
        changed += checked(['git', 'ls-files', '--others', '--exclude-standard'], cwd).splitlines()
        if any(not any(fnmatch.fnmatchcase(name, pattern) for pattern in patterns) for name in changed):
            raise RuntimeError('Change exceeds this job\'s approved file scope')



def validate_configuration(config):
    for key in ['repository', 'required_checks', 'health_url', 'neon_project_id',
                'neon_production_branch_id', 'migration_qualification_command',
                'authenticated_smoke_command', 'privileged_apply_command']:
        if not config.get(key):
            raise RuntimeError('Missing host release configuration: ' + key)
    if len(config.get('vercel_project_ids', [])) != 2:
        raise RuntimeError('Configure both API and web Vercel project IDs')
    for key in ['BOS_MIGRATION_DATABASE_URL', 'BOS_VERCEL_TOKEN', 'BOS_SMOKE_COOKIE', 'BOS_SMOKE_BUSINESS_SLUG']:
        if not os.environ.get(key):
            raise RuntimeError('Missing host secret/configuration: ' + key)
    for key in ['migration_qualification_command', 'authenticated_smoke_command', 'privileged_apply_command']:
        argv = config[key]
        if not isinstance(argv, list) or not argv or not Path(argv[0]).is_absolute() or not Path(argv[0]).is_file():
            raise RuntimeError('Release hooks must be explicit host-owned executable argument arrays')
    health = urllib.parse.urlsplit(config['health_url'])
    smoke = urllib.parse.urlsplit(os.environ.get('BOS_SMOKE_ORIGIN', 'https://app.pixakova.com'))
    if health.scheme != 'https' or health.netloc != smoke.netloc:
        raise RuntimeError('Smoke origin must match the production health origin')


def step(job_dir, state, config, persist):
    """One nonblocking release stage; every mutation is journaled before execution."""
    from coordinator import git, snapshot
    release = config.get('release')
    if not release or not release.get('enabled'):
        state['stage'] = 'release-unconfigured'
        return
    cwd = Path(state['checkout'])
    stage = state['stage']
    repository = release['repository']
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', repository):
        raise RuntimeError('Invalid release repository')
    if stage == 'publish':
        validate_configuration(release)
        validate_scope(cwd, state['base_sha'], release.get('approved_paths'))
        committed = state.get('release_journal', {}).get('commit', {})
        allowed_head = committed.get('result') if committed.get('status') == 'done' else state.get('audit_head')
        if git(cwd, 'rev-parse', 'HEAD') != allowed_head:
            raise RuntimeError('Checkout commit changed since audit')
        if snapshot(cwd) != state['qa_snapshot']:
            raise RuntimeError('Files changed after independent QA')
        if state.get('audit_snapshot') != state['qa_snapshot']:
            raise RuntimeError('QA files do not match audited files')
        changed = git(cwd, 'status', '--porcelain')
        names = checked(['git', 'ls-files', '--others', '--exclude-standard'], cwd).splitlines()
        if any(Path(n).name.startswith('.env') or n.endswith(('.pem', '.key')) for n in names):
            raise RuntimeError('Untracked credential-shaped file cannot be published')
        if not changed and git(cwd, 'rev-parse', 'HEAD') == state['base_sha']:
            raise RuntimeError('No change to publish')
        def commit():
            if changed:
                git(cwd, 'add', '--all')
                git(cwd, 'commit', '-m', state.get('title', state['id']))
            return git(cwd, 'rev-parse', 'HEAD')
        state['release_sha'] = once(state, 'commit', commit, persist)
        state['release_plan'] = {'strategy': state['audit'].get('release_strategy', 'manual-decision'),
                                 'reviewed_sha': state['release_sha']}
        branch = git(cwd, 'branch', '--show-current')
        git(cwd, 'remote', 'set-url', 'origin', 'https://github.com/' + repository + '.git')
        # Push is reconciled by the remote ref before any retry.
        def push():
            git(cwd, 'push', '--set-upstream', 'origin', branch)
            return state['release_sha']
        once(state, 'push', push, persist)
        body = job_dir / 'pr-body.md'
        body.write_text(state['brief'] + '\n\nIndependent Codex audit: ' + state['audit']['summary']
                        + '\n\nLocal QA passed. Required GitHub CI must pass before release.\n')
        def create_pr():
            existing = gh(release, cwd, 'pr', 'list', '--repo', repository, '--head', branch,
                          '--state', 'open', '--json', 'number,url')
            if existing:
                return existing[0]
            url = checked(['gh', 'pr', 'create', '--repo', repository, '--base', 'main', '--head', branch,
                           '--title', state.get('title', state['id']), '--body-file', str(body)], cwd)
            return {'url': url, 'number': int(url.rstrip('/').split('/')[-1])}
        state['pr'] = once(state, 'pr', create_pr, persist)
        state['stage'] = 'ci'
    elif stage == 'ci':
        pr = view(release, cwd, state['pr']['number'])
        if pr['baseRefName'] != 'main':
            raise RuntimeError('Unexpected PR base')
        if pr['baseRefOid'] != state['base_sha']:
            git(cwd, 'fetch', 'origin', 'main')
            base = git(cwd, 'rev-parse', 'origin/main')
            merged = subprocess.run(['git', 'merge', '--no-edit', 'origin/main'], cwd=cwd,
                                    capture_output=True, text=True)
            state['base_sha'] = base
            if state.get('release_journal'):
                state.setdefault('previous_release_journals', []).append(state['release_journal'])
            for key in ['release_journal', 'release_sha', 'qa_snapshot', 'audit_snapshot', 'pr', 'release_plan']:
                state.pop(key, None)
            state['stage'] = 'audit' if merged.returncode == 0 else 'fix'
            state['audit'] = {'summary': 'Base advanced; merge result needs independent audit',
                              'findings': [merged.stdout[-6000:], merged.stderr[-2000:]]}
            return
        verify_ci(pr, state['release_sha'], state['base_sha'], release['required_checks'])
        state['stage'] = 'migration-preflight'
    elif stage == 'migration-preflight':
        protection = gh(release, cwd, 'api', f'repos/{repository}/branches/main/protection')
        required = protection.get('required_status_checks') or {}
        contexts = set(required.get('contexts', [])) | {x['context'] for x in required.get('checks', [])}
        if required.get('strict') is not True or not set(release['required_checks']) <= contexts:
            raise RuntimeError('Strict up-to-date branch protection with required CI checks is needed')
        if not protection.get('enforce_admins', {}).get('enabled'):
            raise RuntimeError('Branch protection must apply to administrators too')
        # No production mutation starts until exact PR/base/CI have been checked again.
        verify_ci(view(release, cwd, state['pr']['number']), state['release_sha'],
                  state['base_sha'], release['required_checks'])
        validate_configuration(release)
        pre_smoke = json.loads(checked(release['authenticated_smoke_command'] + [state['release_sha']], job_dir))
        if pre_smoke.get('passed') is not True:
            raise RuntimeError('Baseline authenticated smoke failed before migration')
        migration_target = urllib.parse.urlsplit(prod_env()['MIGRATION_DATABASE_URL'])
        branch_url = checked(['neonctl', 'connection-string', release['neon_production_branch_id'],
             '--project-id', release['neon_project_id'], '--role-name', 'bos_owner',
             '--database-name', migration_target.path.lstrip('/'), '--no-pooled'], cwd)
        branch_target = urllib.parse.urlsplit(branch_url)
        if (branch_target.hostname, branch_target.path) != (migration_target.hostname, migration_target.path):
            raise RuntimeError('Recovery branch and migration connection target different databases')
        expected = migration_files(cwd)
        pending = validate_ledger(expected, ledger(cwd), True)
        base_names = set(git(cwd, 'ls-tree', '--name-only', state['base_sha'], 'apps/api/prisma/migrations/').splitlines())
        # Any pending migration must be introduced by this exact reviewed PR.
        baseline = {Path(x).name for x in base_names}
        if set(pending) & baseline:
            raise RuntimeError('Earlier merged migrations are not applied; reconcile production baseline first')
        state['pending_migrations'] = pending
        privileged = git(cwd, 'diff', '--name-only', state['base_sha'], state['release_sha'], '--', 'apps/api/prisma/privileged')
        if pending or privileged:
            if privileged and not release.get('privileged_apply_command'):
                raise RuntimeError('Privileged SQL adapter must be configured before recovery/migration')
            plan = state.get('release_plan', {})
            if plan.get('strategy') != 'additive-before-merge' or plan.get('reviewed_sha') != state['release_sha']:
                raise RuntimeError('Migration needs a separately audited additive-before-merge release plan for this SHA')
            # Upgrade and fresh-data evidence come from a trusted host hook, not a PR-supplied script.
            hook = release.get('migration_qualification_command')
            if not hook:
                raise RuntimeError('Configure representative upgrade/fresh-database qualification command')
            result = json.loads(checked(hook + [str(cwd), state['release_sha']], job_dir))
            if result.get('sha') != state['release_sha'] or result.get('fresh') is not True or result.get('upgrade') is not True:
                raise RuntimeError('Migration qualification evidence is incomplete')
            state['migration_qualification'] = result
            project = release['neon_project_id']
            parent = release['neon_production_branch_id']
            def recovery():
                result = json.loads(checked(['neonctl', 'branches', 'create', '--project-id', project,
                   '--parent', parent, '--name', 'pre-' + state['id'], '--no-secrets', '--no-compute', '--output', 'json'], cwd))
                branch = result.get('branch', result)
                if branch.get('parent_id') != parent or not branch.get('id'):
                    raise RuntimeError('Recovery branch identity was not confirmed')
                return {'id': branch['id'], 'parent_id': parent, 'created_at': branch.get('created_at'),
                        'parent_lsn': branch.get('parent_lsn')}
            state['recovery'] = once(state, 'recovery', recovery, persist)
            if pending:
                once(state, 'migrate', lambda: checked(['pnpm', '--filter', '@business-os/api', 'exec',
                     'prisma', 'migrate', 'deploy'], cwd, prod_env()) and 'applied', persist)
            if privileged:
                hook = release.get('privileged_apply_command')
                if not hook:
                    raise RuntimeError('Configure the audited privileged SQL host adapter')
                def apply_privileged():
                    result = json.loads(checked(hook + [str(cwd), state['release_sha']], job_dir))
                    if result.get('sha') != state['release_sha'] or result.get('passed') is not True:
                        raise RuntimeError('Privileged SQL apply/verification failed')
                    return result
                state['privileged'] = once(state, 'privileged', apply_privileged, persist)
        validate_ledger(expected, ledger(cwd), False)
        state['db_invariants'] = invariants(cwd)
        state['stage'] = 'merge'
    elif stage == 'merge':
        verify_ci(view(release, cwd, state['pr']['number']), state['release_sha'],
                  state['base_sha'], release['required_checks'])
        def merge():
            checked(['gh', 'pr', 'merge', str(state['pr']['number']), '--repo', repository,
                     '--squash', '--match-head-commit', state['release_sha']], cwd)
            pr = view(release, cwd, state['pr']['number'])
            if pr['state'] != 'MERGED' or not pr.get('mergeCommit'):
                raise RuntimeError('Merge is not confirmed')
            return pr['mergeCommit']['oid']
        state['merged_sha'] = once(state, 'merge', merge, persist)
        state['stage'] = 'deployment'
    elif stage == 'deployment':
        state['main_ci'] = main_ci(release, cwd, state['merged_sha'])
        state['deployments'] = vercel_deployments(release, state['merged_sha'])
        request = urllib.request.Request(release['health_url'], headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.load(response)
        if data.get('status') != 'ok' or data.get('service') != 'business-os-api':
            raise RuntimeError('Production health verification failed')
        hook = release.get('authenticated_smoke_command')
        if not hook:
            raise RuntimeError('Authenticated cross-Zone smoke command is required before completion')
        smoke = json.loads(checked(hook + [state['merged_sha']], job_dir))
        if smoke.get('sha') != state['merged_sha'] or smoke.get('passed') is not True:
            raise RuntimeError('Signed-in smoke evidence failed')
        state['smoke'] = smoke
        state['stage'] = 'verified'
    else:
        raise RuntimeError('Unknown release stage')
