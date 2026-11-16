import json
import unittest
import tempfile
import subprocess
from pathlib import Path
from unittest.mock import patch
import coordinator
from coordinator import advance, decode_result


class CoordinatorTests(unittest.TestCase):
    def test_snapshot_real_git_detects_untracked_and_tracked_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            checkout = Path(tmp)
            subprocess.run(['git', 'init', tmp], check=True, capture_output=True)
            tracked = checkout / 'tracked.txt'
            tracked.write_text('original')
            subprocess.run(['git', 'add', '.'], cwd=tmp, check=True)
            subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
                            'commit', '-m', 'fixture'], cwd=tmp, check=True, capture_output=True)
            baseline = coordinator.snapshot(checkout)
            self.assertEqual(baseline, coordinator.snapshot(checkout))
            tracked.write_text('edited')
            self.assertNotEqual(baseline, coordinator.snapshot(checkout))
            tracked.write_text('original')
            tracked.chmod(0o755)
            self.assertNotEqual(baseline, coordinator.snapshot(checkout))
            tracked.chmod(0o644)
            untracked = checkout / 'new.txt'
            untracked.write_text('new')
            self.assertNotEqual(baseline, coordinator.snapshot(checkout))
            untracked.unlink()
            self.assertEqual(baseline, coordinator.snapshot(checkout))
            subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
                            'commit', '--allow-empty', '-m', 'same tree'], cwd=tmp, check=True, capture_output=True)
            self.assertEqual(baseline, coordinator.snapshot(checkout))

    def test_complete_handoff_loop_stops_at_unconfigured_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            job = Path(tmp)
            coordinator.save(job / 'state.json', {
                'id': 'trial', 'stage': 'plan', 'cycles': 0, 'turn': 0,
                'checkout': tmp, 'brief': 'bounded test change',
            })
            agents = []
            verdicts = iter(['pass', 'pass', 'changes', 'pass', 'pass'])
            def fake_agent(directory, state, agent, instruction, config):
                agents.append(agent)
                state['turn'] += 1
                return {'verdict': next(verdicts), 'summary': 'test', 'findings': []}
            config = {'max_audit_cycles': 4, 'max_turns': 12,
                      'qa_commands': [['test-check']], 'turn_timeout_seconds': 10}
            with patch.object(coordinator, 'agent_run', side_effect=fake_agent), \
                 patch.object(coordinator, 'git', return_value='head'), \
                 patch.object(coordinator, 'snapshot', return_value='same-content'), \
                 patch.object(coordinator, 'command', return_value=type('Result', (), {
                     'returncode': 0, 'stdout': 'pass', 'stderr': ''})()):
                coordinator.run(job, config)
            self.assertEqual(agents, ['codex', 'claude', 'codex', 'claude', 'codex'])
            state = json.loads((job / 'state.json').read_text())
            self.assertEqual(state['stage'], 'release-unconfigured')
            self.assertEqual(state['cycles'], 1)

    def test_claude_error_is_not_clearance(self):
        with self.assertRaises(RuntimeError):
            decode_result(json.dumps({'is_error': True, 'result': 'rate limited'}), 'claude')

    def test_invalid_verdict_cannot_advance(self):
        with self.assertRaises(ValueError):
            decode_result('{"verdict":"approved","summary":"yes","findings":[]}', 'codex')

    def test_review_findings_loop_back_to_implementation(self):
        state = {'stage': 'audit', 'cycles': 0}
        advance(state, {'verdict': 'changes', 'summary': 'race', 'findings': ['reproduce race']})
        self.assertEqual(state['stage'], 'fix')
        self.assertEqual(state['cycles'], 1)
        advance(state, {'verdict': 'pass', 'summary': 'fixed', 'findings': []})
        self.assertEqual(state['stage'], 'audit')

    def test_review_pass_requires_independent_qa(self):
        state = {'stage': 'audit', 'cycles': 0}
        advance(state, {'verdict': 'pass', 'summary': 'reviewed', 'findings': []})
        self.assertEqual(state['stage'], 'qa')

    def test_blocker_preserves_stage(self):
        state = {'stage': 'implement'}
        advance(state, {'verdict': 'blocked', 'summary': 'login required', 'findings': []})
        self.assertEqual(state['stage'], 'implement')
        self.assertEqual(state['paused'], 'login required')


if __name__ == '__main__':
    unittest.main()

class RetryTests(unittest.TestCase):
    def test_known_usage_limit_gets_bounded_delayed_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = {'turn': 0, 'brief': 'test', 'checkout': tmp}
            config = {'codex_model': 'gpt-6.1-sol', 'turn_timeout_seconds': 10, 'max_transient_retries': 1}
            result = subprocess.CompletedProcess([], 1, '', 'rate_limit_error')
            with patch.object(coordinator, 'command', return_value=result):
                with self.assertRaises(RuntimeError):
                    coordinator.agent_run(Path(tmp), state, 'codex', 'test', config)
                self.assertIn('retry_at', state)
                state.pop('retry_at')
                with self.assertRaises(RuntimeError):
                    coordinator.agent_run(Path(tmp), state, 'codex', 'test', config)
                self.assertNotIn('retry_at', state)

    def test_retry_schedule_is_bound_to_the_failure_that_created_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = {'turn': 0, 'brief': 'test', 'checkout': tmp}
            config = {'codex_model': 'gpt-6.1-sol', 'turn_timeout_seconds': 10, 'max_transient_retries': 4}
            limited = subprocess.CompletedProcess([], 1, '', 'rate_limit_error')
            with patch.object(coordinator, 'command', return_value=limited):
                with self.assertRaises(RuntimeError) as raised:
                    coordinator.agent_run(Path(tmp), state, 'codex', 'test', config)
            self.assertEqual(state['retry_reason'], str(raised.exception))
            # An unclassified failure on the next attempt must not inherit the earlier timer.
            failed = subprocess.CompletedProcess([], 1, '', 'segmentation fault')
            with patch.object(coordinator, 'command', return_value=failed):
                with self.assertRaises(RuntimeError):
                    coordinator.agent_run(Path(tmp), state, 'codex', 'test', config)
            self.assertNotIn('retry_at', state)
            self.assertNotIn('retry_reason', state)

    def test_manual_resume_before_retry_keeps_later_blocker_paused(self):
        import sys
        from worker import release_due_retry
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            job = root / 'jobs' / 'resume-trial'
            job.mkdir(parents=True)
            config_path = root / 'config.json'
            config_path.write_text(json.dumps({'state_directory': str(root / 'jobs'),
                                               'max_audit_cycles': 4, 'max_turns': 12}))
            coordinator.save(job / 'state.json', {
                'id': 'resume-trial', 'stage': 'implement', 'cycles': 0, 'turn': 1,
                'checkout': tmp, 'brief': 'test', 'transient_retries': 1,
                'paused': 'claude exited 1; inspect 001-claude logs',
                'retry_reason': 'claude exited 1; inspect 001-claude logs',
                'retry_at': 4102444800})
            def login_blocker(directory, state, agent, instruction, config):
                state['turn'] += 1
                return {'verdict': 'blocked', 'summary': 'login required', 'findings': []}
            argv = ['coordinator.py', '--config', str(config_path), 'resume', 'resume-trial']
            with patch.object(sys, 'argv', argv), \
                 patch.object(coordinator, 'agent_run', side_effect=login_blocker):
                with self.assertRaises(SystemExit):
                    coordinator.main()
            state = json.loads((job / 'state.json').read_text())
            self.assertEqual(state['paused'], 'login required')
            self.assertNotIn('retry_at', state)
            # Long after the original retry time, the worker must still leave the new pause alone.
            self.assertFalse(release_due_retry(job / 'state.json', state, now=4102444800 + 1))
            self.assertEqual(json.loads((job / 'state.json').read_text())['paused'], 'login required')

    def test_unrelated_pause_discards_pending_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            job = Path(tmp)
            coordinator.save(job / 'state.json', {
                'id': 'trial', 'stage': 'implement', 'cycles': 0, 'turn': 0,
                'checkout': tmp, 'brief': 'test', 'retry_at': 1, 'retry_reason': 'old failure'})
            config = {'max_audit_cycles': 4, 'max_turns': 12}
            with patch.object(coordinator, 'agent_run', side_effect=RuntimeError('needs reconciliation')):
                with self.assertRaises(SystemExit):
                    coordinator.run(job, config)
            state = json.loads((job / 'state.json').read_text())
            self.assertEqual(state['paused'], 'needs reconciliation')
            self.assertNotIn('retry_at', state)
            self.assertNotIn('retry_reason', state)
