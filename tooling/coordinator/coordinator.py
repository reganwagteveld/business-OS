#!/usr/bin/env python3
"""Persistent local Claude/Codex delivery loop. Python standard library only."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import signal
import uuid
from release import step as release_step, Waiting

ROOT = Path(__file__).resolve().parents[2]
# Exit status when another run/resume already owns the job lock. Nothing was read or written,
# so the supervisor treats it as a skipped job rather than a child failure.
LOCK_BUSY = 3


def acquire_job_lock(lock):
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('Job is locked by another run/resume; nothing started', file=sys.stderr, flush=True)
        raise SystemExit(LOCK_BUSY)
SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'properties': {
        'verdict': {'type': 'string', 'enum': ['pass', 'changes', 'blocked']},
        'summary': {'type': 'string'},
        'findings': {'type': 'array', 'items': {'type': 'string'}},
        'release_strategy': {'type': 'string', 'enum': ['none', 'additive-before-merge', 'manual-decision']},
    }, 'required': ['verdict', 'summary', 'findings', 'release_strategy'],
}
RULES = '''Work only inside this job checkout. Follow repository instructions, architecture,
contracts and existing QA/migration rules. This is an approved engineering task, not authority
to invent feature scope. Do not merge, deploy, migrate production, send external messages,
change credentials, weaken tests or alter coordinator/release policy. The coordinator owns
release execution. Read repository instructions and feature specs relevant to the task.
For product work also read docs/roadmap.md when present, docs/architecture.md, docs/ci.md and
docs/migration-readiness.md. A transport smoke test needs only its brief. Record actual verification and blockers.
Never report a check as passing unless it ran successfully. Return the requested JSON result.
'''


def safe_environment(extra=None):
    # Deliberately excludes production DB/provider secrets and API-key billing overrides.
    keys = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'USER', 'SHELL']
    env = {k: os.environ[k] for k in keys if k in os.environ}
    env['DOTENV_CONFIG_PATH'] = '/dev/null'
    if extra:
        for key, value in extra.items():
            if key.startswith('BOS_') or key in ['NEON_API_KEY', 'VERCEL_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']:
                raise RuntimeError('Production/API secrets cannot enter QA environment')
            if 'DATABASE_URL' in key or key.endswith('_URL'):
                from urllib.parse import urlsplit
                url = urlsplit(value)
                if url.scheme in ['postgres', 'postgresql'] and url.hostname not in ['localhost', '127.0.0.1', '::1']:
                    raise RuntimeError('QA database connections must be local disposable databases')
            env[key] = value
    return env


def command(argv, cwd, timeout=3600, env=None):
    process = subprocess.Popen(argv, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
        raise
    return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)


def git(cwd, *args):
    p = command(['git', *args], cwd)
    if p.returncode:
        raise RuntimeError('git operation failed: ' + p.stderr[-2000:])
    return p.stdout.strip()


def save(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2) + '\n')
    tmp.replace(path)


def decode_result(raw, agent):
    if agent == 'claude':
        envelope = json.loads(raw)
        if envelope.get('is_error'):
            raise RuntimeError('Claude returned an error; inspect local run log')
        value = envelope.get('structured_output')
        if value is None:
            value = json.loads(envelope['result'])
    else:
        value = json.loads(raw)
    if (not isinstance(value, dict) or value.get('verdict') not in ['pass', 'changes', 'blocked']
            or not isinstance(value.get('summary'), str)
            or not isinstance(value.get('findings'), list)
            or not all(isinstance(f, str) for f in value['findings'])):
        raise ValueError('Invalid structured agent result')
    return value


def snapshot(checkout):
    # Includes tracked, staged and untracked content; ignored dependencies excluded.
    import hashlib
    digest = hashlib.sha256()
    names = command(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], checkout).stdout
    for name in sorted(set(names.split('\0')) - {''}):
        p = checkout / name
        if p.is_symlink():
            kind, content = b'link', os.readlink(p).encode()
        elif p.is_file():
            kind = b'executable' if p.stat().st_mode & 0o111 else b'file'
            content = p.read_bytes()
        else:
            continue  # A deleted path is absent from the audited working tree.
        for part in [name.encode(), kind, content]:
            digest.update(len(part).to_bytes(8, 'big'))
            digest.update(part)
    return digest.hexdigest()


def clear_retry(state):
    """Drop any delayed-retry schedule. A schedule is only valid for the exact pause that created it."""
    state.pop('retry_at', None)
    state.pop('retry_reason', None)


def agent_run(job_dir, state, agent, instruction, config):
    # A new attempt supersedes any earlier schedule; only this attempt's own failure may re-arm it.
    clear_retry(state)
    turn = state['turn'] + 1
    state['turn'] = turn
    save(job_dir / 'state.json', state)
    prefix = job_dir / f'{turn:03d}-{agent}'
    prompt = RULES + '\nTask:\n' + state['brief'] + '\nStage:\n' + instruction
    schema_path = job_dir / 'result-schema.json'
    save(schema_path, SCHEMA)
    if agent == 'codex':
        output = prefix.with_suffix('.result.json')
        argv = ['codex', 'exec', '--sandbox', 'workspace-write', '--model', config['codex_model'],
                '--output-schema', str(schema_path), '-o', str(output), prompt]
    else:
        argv = ['claude', '-p', '--model', config['claude_model'], '--permission-mode', 'acceptEdits',
                '--allowedTools', 'Read,Edit,Write,Glob,Grep', '--tools', 'Read,Edit,Write,Glob,Grep',
                '--output-format', 'json',
                '--json-schema', json.dumps(SCHEMA), prompt]
    prefix.with_suffix('.prompt.txt').write_text(prompt)
    p = command(argv, Path(state['checkout']), config['turn_timeout_seconds'], safe_environment())
    prefix.with_suffix('.stdout.log').write_text(p.stdout)
    prefix.with_suffix('.stderr.log').write_text(p.stderr)
    if p.returncode:
        detail = (p.stdout + p.stderr).lower()
        retry_markers = ['rate_limit_error', 'rate limit reached', 'usage limit reached',
                         'usage limit exceeded', 'connection reset', 'could not resolve host',
                         'network is unreachable', 'temporarily unavailable']
        message = f'{agent} exited {p.returncode}; inspect {prefix.name} logs'
        if any(marker in detail for marker in retry_markers):
            retries = state.get('transient_retries', 0) + 1
            state['transient_retries'] = retries
            if retries <= config.get('max_transient_retries', 4):
                state['retry_at'] = time.time() + min(900 * retries, 3600)
                state['retry_reason'] = message
        raise RuntimeError(message)
    raw = output.read_text() if agent == 'codex' else p.stdout
    result = decode_result(raw, agent)
    save(prefix.with_suffix('.result.json'), result)
    return result


def advance(state, result):
    stage = state['stage']
    if result['verdict'] == 'blocked':
        state['paused'] = result['summary']
    elif stage == 'plan':
        if result['verdict'] == 'pass':
            state['plan'] = result
            state['stage'] = 'implement'
        else:
            state['paused'] = 'Planning needs a scope decision: ' + result['summary']
    elif stage in ['implement', 'fix']:
        state['implementation'] = result
        state['stage'] = 'audit'
    elif stage == 'audit':
        state['audit'] = result
        if result['verdict'] == 'pass':
            state['stage'] = 'qa'
        else:
            state['cycles'] += 1
            state['stage'] = 'fix'
    return state


def run(job_dir, config):
    with (job_dir / 'lock').open('a') as lock:
        acquire_job_lock(lock)
        state = json.loads((job_dir / 'state.json').read_text())
        # Bind every state write of this run to one attempt so the supervisor can tell its own
        # child's state apart from a later manual run/resume before recording a child failure.
        state['run_attempt'] = os.environ.get('BOS_WORKER_ATTEMPT') or 'manual-' + uuid.uuid4().hex
        save(job_dir / 'state.json', state)
        persist = lambda: save(job_dir / 'state.json', state)
        while not state.get('paused') and state['stage'] not in ['verified', 'release-unconfigured']:
            previous_stage = state['stage']
            try:
                if state['cycles'] >= config['max_audit_cycles']:
                    raise RuntimeError('Audit cycle allowance reached; paused without releasing')
                if state['turn'] >= config['max_turns'] and state['stage'] in ['plan', 'implement', 'audit', 'fix']:
                    raise RuntimeError('Agent turn allowance reached; paused without releasing')
                stage = state['stage']
                state.pop('waiting', None)
                previous_stage = stage
                print(f"{state['id']}: {stage}", flush=True)
                if stage in ['publish', 'ci', 'migration-preflight', 'merge', 'deployment']:
                    release_step(job_dir, state, config, persist)
                elif stage == 'qa':
                    # QA is executed independently of agent claims, from host-owned configuration.
                    before = snapshot(Path(state['checkout']))
                    if not config['qa_commands']:
                        raise RuntimeError('QA commands are not configured')
                    for i, argv in enumerate(config['qa_commands']):
                        argv = [part.replace('{checkout}', state['checkout']).replace('{job_dir}', str(job_dir)) for part in argv]
                        p = command(argv, state['checkout'], config['turn_timeout_seconds'], safe_environment(config.get('qa_environment', {})))
                        (job_dir / f'qa-{state["turn"]}-{i}.log').write_text(p.stdout + p.stderr)
                        if p.returncode:
                            state['audit'] = {'summary': 'QA command failed', 'findings': [str(argv), (p.stdout + p.stderr)[-12000:]]}
                            state['cycles'] += 1
                            state['stage'] = 'fix'
                            break
                    else:
                        if before != snapshot(Path(state['checkout'])):
                            state['cycles'] += 1
                            state['audit'] = {'summary': 'QA generated tracked changes; audit the actual updated files', 'findings': []}
                            state['stage'] = 'audit'
                        else:
                            state['qa_snapshot'] = before
                            state['stage'] = 'publish' if config.get('release', {}).get('enabled') else 'release-unconfigured'
                else:
                    context = json.dumps({k: state.get(k) for k in ['plan', 'implementation', 'audit']})
                    prompts = {
                        'plan': 'Architect the bounded task and acceptance criteria. Inspect only. Return pass with a concrete plan or blocked for missing feature decisions.',
                        'implement': 'Implement the plan. Provide changed files and verification evidence.',
                        'audit': 'Independently audit actual changes, acceptance criteria, tests and migration compatibility. Inspect only. Return changes for concrete defects. Set release_strategy to none for no schema/privileged changes; additive-before-merge only after verifying compatibility with current production code and explicit migration transactions, or manual-decision for destructive/incompatible changes. A pass means ready for independent QA.',
                        'fix': 'Fix audit/QA findings. Explain resolutions and actual verification.',
                    }
                    checkout = Path(state['checkout'])
                    before = snapshot(checkout) if stage in ['plan', 'audit'] else None
                    head_before = git(checkout, 'rev-parse', 'HEAD') if before else None
                    result = agent_run(job_dir, state, 'codex' if before else 'claude', prompts[stage] + '\n' + context, config)
                    if before and (snapshot(checkout) != before or git(checkout, 'rev-parse', 'HEAD') != head_before):
                        raise RuntimeError('Review/planning modified files; paused for reconciliation')
                    if stage == 'audit' and result['verdict'] == 'pass':
                        state['audit_snapshot'] = snapshot(checkout)
                        state['audit_head'] = head_before
                    advance(state, result)
            except Waiting as exc:
                started = state.setdefault('wait_started_at', time.time())
                if time.time() - started > config.get('external_wait_timeout_seconds', 3600):
                    state['paused'] = 'External CI/deployment wait deadline exceeded: ' + str(exc)
                state['waiting'] = str(exc)
                save(job_dir / 'state.json', state)
                break
            except KeyboardInterrupt:
                state['paused'] = 'Coordinator interrupted; preserved current stage for reconciliation'
                save(job_dir / 'state.json', state)
                break
            except (RuntimeError, ValueError, KeyError, OSError, subprocess.TimeoutExpired) as exc:
                state['paused'] = str(exc)
                if state.get('retry_reason') != state['paused']:
                    clear_retry(state)
            if state['stage'] != previous_stage:
                state.pop('wait_started_at', None)
            save(job_dir / 'state.json', state)
        print(json.dumps({'stage': state['stage'], 'paused': state.get('paused')}, indent=2))
        if state.get('paused'):
            raise SystemExit(2)


def prepare_resume(job):
    """Clear a pause under the job lock and revoke the previous attempt's ownership.

    The lock is released before run() takes it again and assigns a fresh token. Rebinding
    run_attempt here means a failure handler for an earlier child cannot match during that gap
    and restore its pause over the resumed state.
    """
    with (job / 'lock').open('a') as lock:
        acquire_job_lock(lock)
        state = json.loads((job / 'state.json').read_text())
        state.pop('paused', None)
        # A manual resume consumes any pending automatic retry; later blockers must stay paused.
        clear_retry(state)
        state['run_attempt'] = 'resume-' + uuid.uuid4().hex
        save(job / 'state.json', state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=ROOT / 'tooling/coordinator/config.local.json')
    sub = parser.add_subparsers(dest='action', required=True)
    add = sub.add_parser('add')
    add.add_argument('id')
    add.add_argument('brief', type=Path)
    for action in ['run', 'status', 'resume']:
        sub.add_parser(action).add_argument('id')
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    if not args.id.replace('-', '').replace('_', '').isalnum():
        parser.error('Use letters, numbers, hyphens and underscores for job ids')
    jobs = Path(config['state_directory']).resolve()
    jobs.mkdir(parents=True, exist_ok=True, mode=0o700)
    job = jobs / args.id
    if args.action == 'add':
        job.mkdir(mode=0o700)
        checkout = job / 'checkout'
        git(ROOT, 'clone', '--no-hardlinks', str(config.get('source_repository', ROOT)), str(checkout))
        if config.get('source_repository'):
            git(checkout, 'switch', 'main')
        git(checkout, 'switch', '-c', 'agent/' + args.id)
        save(job / 'state.json', {'id': args.id, 'brief': args.brief.read_text(),
             'checkout': str(checkout), 'base_sha': git(checkout, 'rev-parse', 'HEAD'),
             'config_path': str(args.config.resolve()), 'title': args.id, 'stage': 'plan', 'cycles': 0, 'turn': 0})
    elif args.action == 'status':
        print((job / 'state.json').read_text())
    elif args.action == 'resume':
        prepare_resume(job)
        run(job, config)
    else:
        run(job, config)


if __name__ == '__main__':
    main()
