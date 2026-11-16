import json
from pathlib import Path
import tempfile
import unittest
from worker import collect, report


class WorkerTests(unittest.TestCase):
    def test_status_reports_pauses_and_corrupt_jobs_without_starting_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            jobs = root/'jobs'
            (jobs/'paused').mkdir(parents=True)
            (jobs/'bad').mkdir()
            (jobs/'paused'/'state.json').write_text(json.dumps({'id': 'paused', 'stage': 'audit', 'paused': 'login'}))
            (jobs/'bad'/'state.json').write_text('broken')
            records = collect(jobs)
            self.assertEqual(len(records), 2)
            report(jobs, root)
            status = json.loads((root/'status.json').read_text())
            self.assertIsNone(status['running'])
            self.assertIn('PAUSED: login', (root/'status.md').read_text())
            self.assertTrue(all(x.get('paused') for x in status['jobs']))


if __name__ == '__main__':
    unittest.main()

class SupervisorProcessTests(unittest.TestCase):
    def test_real_supervisor_runs_qa_child_and_stops_at_release_boundary(self):
        import subprocess
        import sys
        import coordinator
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            job = root/'jobs'/'qa-trial'
            checkout = job/'checkout'
            checkout.mkdir(parents=True)
            subprocess.run(['git','init',str(checkout)],check=True,capture_output=True)
            (checkout/'fixture.txt').write_text('verified')
            subprocess.run(['git','add','.'],cwd=checkout,check=True)
            subprocess.run(['git','-c','user.name=Test','-c','user.email=test@example.test',
                            'commit','-m','fixture'],cwd=checkout,check=True,capture_output=True)
            config = root/'config.json'
            config.write_text(json.dumps({'state_directory':str(root/'jobs'),'max_audit_cycles':3,
                'max_turns':8,'turn_timeout_seconds':15,'qa_commands':[[sys.executable,'-c',
                "from pathlib import Path; assert Path('fixture.txt').read_text()=='verified'"]]}))
            coordinator.save(job/'state.json',{'id':'qa-trial','stage':'qa','cycles':0,'turn':3,
                'checkout':str(checkout),'config_path':str(config)})
            result = subprocess.run([sys.executable,str(Path(__file__).with_name('worker.py')),
                '--config',str(config),'--once'],capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr)
            state=json.loads((job/'state.json').read_text())
            self.assertEqual(state['stage'],'release-unconfigured')
            self.assertEqual(json.loads((root/'status.json').read_text())['jobs'][0]['stage'], 'release-unconfigured')

class DelayedRetryTests(unittest.TestCase):
    def _state(self, root, **fields):
        import coordinator
        path = root/'state.json'
        state = {'id': 'retry', 'stage': 'audit', **fields}
        coordinator.save(path, state)
        return path, state

    def test_due_retry_releases_only_its_own_pause(self):
        from worker import release_due_retry
        with tempfile.TemporaryDirectory() as tmp:
            path, state = self._state(Path(tmp), paused='codex exited 1', retry_reason='codex exited 1', retry_at=100)
            self.assertFalse(release_due_retry(path, state, now=99))
            self.assertEqual(state['paused'], 'codex exited 1')
            self.assertTrue(release_due_retry(path, state, now=100))
            saved = json.loads(path.read_text())
            self.assertNotIn('paused', saved)
            self.assertNotIn('retry_at', saved)
            self.assertNotIn('retry_reason', saved)

    def test_stale_or_unbound_retry_never_clears_a_different_pause(self):
        from worker import release_due_retry
        with tempfile.TemporaryDirectory() as tmp:
            for extra in [{'retry_reason': 'codex exited 1'}, {}]:
                path, state = self._state(Path(tmp), paused='login required', retry_at=100, **extra)
                self.assertFalse(release_due_retry(path, state, now=500))
                saved = json.loads(path.read_text())
                self.assertEqual(saved['paused'], 'login required')
                self.assertNotIn('retry_at', saved)

    def test_stale_collected_snapshot_never_overwrites_newer_state(self):
        import coordinator
        from worker import release_due_retry
        with tempfile.TemporaryDirectory() as tmp:
            path, stale = self._state(Path(tmp), stage='implement', turn=1, paused='codex exited 1',
                                      retry_reason='codex exited 1', retry_at=100)
            # Between collect() and the retry check, a manual resume advanced the job and hit a new blocker.
            coordinator.save(path, {'id': 'retry', 'stage': 'audit', 'turn': 2, 'paused': 'login required'})
            self.assertFalse(release_due_retry(path, stale, now=500))
            saved = json.loads(path.read_text())
            self.assertEqual(saved, {'id': 'retry', 'stage': 'audit', 'turn': 2, 'paused': 'login required'})
            # The caller's snapshot is refreshed so it cannot start the job from outdated state.
            self.assertEqual(stale, saved)

    def test_locked_job_is_skipped_and_left_untouched(self):
        import fcntl
        from worker import job_lock, pause_after_child_failure, release_due_retry
        with tempfile.TemporaryDirectory() as tmp:
            path, state = self._state(Path(tmp), paused='codex exited 1',
                                      retry_reason='codex exited 1', retry_at=100)
            before = path.read_text()
            with (Path(tmp)/'lock').open('a') as owner:
                fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertFalse(release_due_retry(path, dict(state), now=500))
                self.assertFalse(pause_after_child_failure(path, 1, 'worker-a', before))
                with job_lock(Path(tmp)) as held:
                    self.assertFalse(held)
            self.assertEqual(path.read_text(), before)
            # Once the owner releases the lock, the due retry is processed normally.
            self.assertTrue(release_due_retry(path, state, now=500))
            self.assertNotIn('paused', json.loads(path.read_text()))


class ChildFailureBindingTests(unittest.TestCase):
    """Audit interleaving: the child loses the lock race to a manual run, which then saves."""

    def _job(self, root, **fields):
        import coordinator
        path = root/'state.json'
        coordinator.save(path, {'id': 'race', 'stage': 'implement', 'turn': 1, **fields})
        return path, path.read_text()

    def test_failure_never_lands_on_state_from_a_later_manual_run(self):
        import coordinator
        from worker import pause_after_child_failure
        with tempfile.TemporaryDirectory() as tmp:
            for later in [{'id': 'race', 'stage': 'verified', 'turn': 4, 'run_attempt': 'manual-b'},
                          {'id': 'race', 'stage': 'audit', 'turn': 2, 'run_attempt': 'manual-b',
                           'paused': 'login required'}]:
                path, before = self._job(Path(tmp))
                coordinator.save(path, later)
                self.assertFalse(pause_after_child_failure(path, 1, 'worker-a', before))
                self.assertEqual(json.loads(path.read_text()), later)

    def test_failure_is_recorded_for_the_childs_own_attempt(self):
        import coordinator
        from worker import pause_after_child_failure
        with tempfile.TemporaryDirectory() as tmp:
            path, before = self._job(Path(tmp))
            coordinator.save(path, {'id': 'race', 'stage': 'audit', 'turn': 2, 'run_attempt': 'worker-a'})
            self.assertTrue(pause_after_child_failure(path, 1, 'worker-a', before))
            self.assertEqual(json.loads(path.read_text())['paused'], 'Worker child exited 1; inspect worker.log')

    def test_failure_before_any_write_is_still_recorded(self):
        from worker import pause_after_child_failure
        with tempfile.TemporaryDirectory() as tmp:
            path, before = self._job(Path(tmp))
            self.assertTrue(pause_after_child_failure(path, 1, 'worker-a', before))
            self.assertIn('Worker child exited 1', json.loads(path.read_text())['paused'])

    def test_terminal_state_from_own_attempt_is_not_paused(self):
        import coordinator
        from worker import pause_after_child_failure
        with tempfile.TemporaryDirectory() as tmp:
            path, before = self._job(Path(tmp))
            coordinator.save(path, {'id': 'race', 'stage': 'verified', 'turn': 4, 'run_attempt': 'worker-a'})
            self.assertFalse(pause_after_child_failure(path, 1, 'worker-a', before))
            self.assertNotIn('paused', json.loads(path.read_text()))

    def test_coordinator_run_on_locked_job_exits_lock_busy_without_touching_state(self):
        import fcntl
        import coordinator
        import worker
        self.assertEqual(coordinator.LOCK_BUSY, worker.LOCK_BUSY)
        with tempfile.TemporaryDirectory() as tmp:
            path, before = self._job(Path(tmp))
            with (Path(tmp)/'lock').open('a') as owner:
                fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(SystemExit) as raised:
                    coordinator.run(Path(tmp), {'max_audit_cycles': 3, 'max_turns': 8})
            self.assertEqual(raised.exception.code, coordinator.LOCK_BUSY)
            self.assertEqual(path.read_text(), before)

    def test_resume_revokes_previous_attempt_before_run_rebinds(self):
        import coordinator
        from worker import pause_after_child_failure
        with tempfile.TemporaryDirectory() as tmp:
            # The worker's child wrote state under its own token, then crashed.
            path, _ = self._job(Path(tmp))
            coordinator.save(path, {'id': 'race', 'stage': 'audit', 'turn': 2, 'run_attempt': 'worker-a',
                                    'paused': 'codex exited 1', 'retry_reason': 'codex exited 1',
                                    'retry_at': 100})
            before = path.read_text()
            # Manual resume clears the pause and releases the lock before run() takes it again.
            coordinator.prepare_resume(Path(tmp))
            resumed = json.loads(path.read_text())
            self.assertNotIn('paused', resumed)
            self.assertNotIn('retry_at', resumed)
            self.assertNotEqual(resumed['run_attempt'], 'worker-a')
            self.assertTrue(resumed['run_attempt'].startswith('resume-'))
            # The stale child's failure handler runs in that gap and must not restore a pause.
            self.assertFalse(pause_after_child_failure(path, 1, 'worker-a', before))
            self.assertEqual(json.loads(path.read_text()), resumed)

    def test_coordinator_run_binds_state_to_supervisor_attempt(self):
        import os
        from unittest.mock import patch
        import coordinator
        with tempfile.TemporaryDirectory() as tmp:
            path, _ = self._job(Path(tmp), paused='login required')
            with patch.dict(os.environ, {'BOS_WORKER_ATTEMPT': 'worker-a'}):
                with self.assertRaises(SystemExit):
                    coordinator.run(Path(tmp), {'max_audit_cycles': 3, 'max_turns': 8})
            self.assertEqual(json.loads(path.read_text())['run_attempt'], 'worker-a')


class RuntimeReloadTests(unittest.TestCase):
    def test_host_access_and_configuration_reload_without_stopping_worker(self):
        import os
        from unittest.mock import patch
        from worker import refresh_runtime
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            config=root/'config.json'
            config.write_text(json.dumps({'state_directory':str(root/'jobs'),'release':{'enabled':False}}))
            (root/'host.env').write_text("BOS_VERCEL_TOKEN='test value'\nNEON_PROFILE=coordinator\nPATH=/unwanted\n")
            with patch.dict(os.environ,{},clear=True):
                first=refresh_runtime(config)
                self.assertFalse(first['release']['enabled'])
                self.assertEqual(os.environ['BOS_VERCEL_TOKEN'],'test value')
                self.assertNotIn('PATH',os.environ)
                config.write_text(json.dumps({'state_directory':str(root/'jobs'),'release':{'enabled':True}}))
                self.assertTrue(refresh_runtime(config)['release']['enabled'])
