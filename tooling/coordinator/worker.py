#!/usr/bin/env python3
"""Single persistent host supervisor; only explicit saved jobs are eligible."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import signal
import shlex
import subprocess
import sys
import time
import uuid

TERMINAL = {'verified', 'release-unconfigured', 'reviewed-local'}
LOCK_BUSY = 3  # coordinator.LOCK_BUSY: child found the job locked and did nothing



def refresh_runtime(config_path):
    config=json.loads(config_path.read_text())
    secrets=config_path.parent/'host.env'
    if secrets.exists():
        for line in secrets.read_text().splitlines():
            fields=shlex.split(line,comments=True)
            if len(fields)!=1 or '=' not in fields[0]:
                continue
            name,value=fields[0].split('=',1)
            if name.startswith('BOS_') or name in ['NEON_PROFILE','NEON_API_KEY']:
                os.environ[name]=value
    return config


def collect(jobs):
    records = []
    for path in sorted(jobs.glob('*/state.json')):
        try:
            state = json.loads(path.read_text())
            records.append((path, state))
        except (OSError, ValueError):
            records.append((path, {'id': path.parent.name, 'stage': 'invalid-state',
                                    'paused': 'State unreadable; no work started'}))
    return records


@contextlib.contextmanager
def job_lock(job_dir):
    """Take the same per-job lock used by coordinator run/resume without waiting.

    Yields True when held, False when another run/resume owns the job.
    """
    with (Path(job_dir) / 'lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        yield True


def release_due_retry(state_path, state, now=None):
    """Clear a pause only when its own delayed retry is due.

    A retry schedule belongs to the exact failure that created it (retry_reason). If the job
    is now paused for anything else (login, reconciliation, manual-resume follow-up), the stale
    schedule is discarded and the pause is preserved.

    The collected snapshot may be stale, so the decision is made on state reloaded under the
    job lock; a locked job is skipped. `state` is refreshed in place with the current state so
    the caller's eligibility checks never act on an outdated snapshot.
    """
    if not (state.get('paused') and state.get('retry_at')):
        return False
    from coordinator import save, clear_retry
    with job_lock(state_path.parent) as held:
        if not held:
            return False
        try:
            current = json.loads(state_path.read_text())
        except (OSError, ValueError):
            return False
        state.clear()
        state.update(current)
        if not (state.get('paused') and state.get('retry_at')):
            return False
        if (time.time() if now is None else now) < state['retry_at']:
            return False
        released = state.get('retry_reason') is not None and state['paused'] == state['retry_reason']
        if released:
            state.pop('paused', None)
        clear_retry(state)
        save(state_path, state)
        return released


def pause_after_child_failure(state_path, returncode, attempt, before):
    """Record an unexpected child exit only against state that belongs to that child.

    `attempt` is the token the supervisor gave the child (saved by coordinator run as
    run_attempt) and `before` is the exact state text read just before spawning. The pause is
    written only when the saved state still carries this attempt, or is byte-identical to the
    pre-spawn state (the child died before writing anything). Any intervening run/resume, or a
    terminal stage, is left untouched.
    """
    from coordinator import save
    with job_lock(state_path.parent) as held:
        if not held:
            return False  # another run/resume owns the job; never overwrite its state
        try:
            text = state_path.read_text()
            latest = json.loads(text)
        except (OSError, ValueError):
            return False
        if latest.get('run_attempt') != attempt and text != before:
            return False
        if latest.get('stage') in TERMINAL:
            return False
        latest['paused'] = f'Worker child exited {returncode}; inspect worker.log'
        save(state_path, latest)
        return True


def report(jobs, destination, running=None):
    rows = collect(jobs)
    data = {'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'supervisor_pid': os.getpid(), 'running': running,
            'jobs': [{k: s.get(k) for k in ['id', 'stage', 'paused', 'waiting', 'turn', 'pr']} for _, s in rows]}
    from coordinator import save
    save(destination / 'status.json', data)
    lines = ['# Business OS coordinator status', '', 'Updated: ' + data['updated_at'], '',
             'Supervisor process: ' + str(os.getpid()), '',
             'Active job: ' + (running or 'none — waiting for an eligible saved job'), '']
    for item in data['jobs']:
        lines.append('- ' + item['id'] + ': ' + item['stage'] +
                     (' — PAUSED: ' + item['paused'] if item.get('paused') else '') +
                     (' — ' + item['waiting'] if item.get('waiting') else ''))
    lines += ['', 'A fresh heartbeat proves the supervisor is running. Completion requires job evidence.',
              'Paused jobs are not silently retried. Release-unconfigured means production was not released.', '']
    temporary = destination / 'status.md.tmp'
    temporary.write_text('\n'.join(lines))
    temporary.replace(destination / 'status.md')



def notify_changes(jobs, destination, enabled):
    if not enabled or sys.platform != 'darwin':
        return
    cache_path = destination/'notification-state.json'
    try:
        previous = json.loads(cache_path.read_text())
    except (OSError, ValueError):
        previous = {}
    current = {}
    for _, state in collect(jobs):
        signature = state['stage'] + ':' + str(state.get('paused'))
        current[state['id']] = signature
        if previous.get(state['id']) != signature and (state.get('paused') or state['stage'] in TERMINAL):
            message = state['id'] + ': ' + state['stage']
            if state.get('paused'):
                message += ' — paused; see coordinator status'
            subprocess.run(['osascript', '-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run',
                            'Business OS coordinator', message], capture_output=True, timeout=10)
    from coordinator import save
    save(cache_path, current)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    config = refresh_runtime(args.config)
    jobs = Path(config['state_directory']).resolve()
    jobs.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = args.config.resolve().parent
    child = None
    stopped = False
    def stop(signum, frame):
        nonlocal stopped
        stopped = True
        if child and child.poll() is None:
            child.send_signal(signal.SIGINT)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    with (destination / 'worker.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while not stopped:
            config = refresh_runtime(args.config)
            if Path(config['state_directory']).resolve() != jobs:
                raise RuntimeError('Changing the job state directory requires a worker restart')
            report(jobs, destination)
            try:
                notify_changes(jobs, destination, config.get('notifications', False))
            except (OSError, subprocess.TimeoutExpired):
                pass
            for state_path, state in collect(jobs):
                if stopped:
                    break
                release_due_retry(state_path, state)
                if state.get('paused') or state['stage'] in TERMINAL or state['stage'] == 'invalid-state':
                    continue
                # Config is stored outside the agent checkout. No agent-generated shell is executed here.
                job_config = Path(state.get('config_path', args.config)).resolve()
                if job_config.parent != destination:
                    continue
                with job_lock(state_path.parent) as held:
                    if not held:
                        continue  # a manual run/resume owns this job; never start a competing child
                    try:
                        before = state_path.read_text()
                    except OSError:
                        continue
                # A run/resume may still take the lock before the child does; the child then exits
                # LOCK_BUSY without touching state and the job is simply skipped this cycle.
                attempt = 'worker-' + uuid.uuid4().hex
                with (state_path.parent / 'worker.log').open('a') as log:
                    child = subprocess.Popen([sys.executable, str(Path(__file__).with_name('coordinator.py')),
                        '--config', str(job_config), 'run', state['id']], stdout=log, stderr=log,
                        env=dict(os.environ, BOS_WORKER_ATTEMPT=attempt))
                    while child.poll() is None and not stopped:
                        report(jobs, destination, state['id'])
                        time.sleep(2)
                    if stopped:
                        try:
                            child.wait(timeout=15)
                        except subprocess.TimeoutExpired:
                            child.kill()
                            child.wait()
                    # Unexpected process failures cannot trigger unbounded retries.
                    if child.returncode not in [0, 2, LOCK_BUSY]:
                        pause_after_child_failure(state_path, child.returncode, attempt, before)
                    child = None
                report(jobs, destination)
            if args.once:
                break
            for _ in range(15):
                if stopped:
                    break
                time.sleep(2)
        report(jobs, destination)
        (destination / 'stopped-at.txt').write_text(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))


if __name__ == '__main__':
    main()
