import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from coordinator import git

spec = importlib.util.spec_from_file_location('release_trial', Path(__file__).with_name('queue-release-trial.py'))
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)


class CandidateImportTests(unittest.TestCase):
    def test_import_uses_current_main_and_excludes_unrelated_feature_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'candidate'
            root.mkdir()
            git(root, 'init', '-b', 'main')
            git(root, 'config', 'user.name', 'Coordinator test')
            git(root, 'config', 'user.email', 'test@example.invalid')
            (root / 'product.txt').write_text('baseline\n')
            git(root, 'add', '.')
            git(root, 'commit', '-m', 'baseline')
            upstream = Path(tmp) / 'upstream'
            git(root, 'clone', str(root), str(upstream))
            git(upstream, 'config', 'user.name', 'Coordinator test')
            git(upstream, 'config', 'user.email', 'test@example.invalid')
            (upstream / 'product.txt').write_text('new product main\n')
            git(upstream, 'commit', '-am', 'new product main')
            main_sha = git(upstream, 'rev-parse', 'HEAD')
            git(root, 'switch', '-c', 'tooling/candidate')
            (root / 'tooling/coordinator').mkdir(parents=True)
            (root / 'tooling/coordinator/example.py').write_text('# reviewed tooling\n')
            (root / 'product.txt').write_text('unrelated unmerged feature\n')
            git(root, 'add', '.')
            git(root, 'commit', '-m', 'tooling and unrelated feature')
            checkout = Path(tmp) / 'checkout'
            baseline, candidate, conflicts = trial.import_candidate(root, checkout, 'agent/test', str(upstream))
            self.assertEqual(baseline, main_sha)
            self.assertEqual(candidate, git(root, 'rev-parse', 'HEAD'))
            self.assertEqual(conflicts, [])
            self.assertEqual((checkout / 'product.txt').read_text(), 'new product main\n')
            self.assertEqual((checkout / 'tooling/coordinator/example.py').read_text(), '# reviewed tooling\n')
            self.assertEqual(git(checkout, 'branch', '--show-current'), 'agent/test')
            self.assertEqual(git(checkout, 'diff', '--name-only', 'HEAD'), 'tooling/coordinator/example.py')


if __name__ == '__main__':
    unittest.main()


class QueueAuthorityTests(unittest.TestCase):
    def prepare(self, root):
        local = root / '.coordinator-local'
        jobs = local / 'jobs'
        jobs.mkdir(parents=True)
        config = {'state_directory': str(jobs), 'release': {'enabled': False},
                  'codex_model': 'test', 'claude_model': 'test'}
        (local / 'config.local.json').write_text(json.dumps(config))
        (local / 'status.json').write_text(json.dumps({'running': None}))
        return config, local, jobs

    def test_failed_read_only_preflight_does_not_publish_a_job_or_enable_default_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config, local, jobs = self.prepare(root)
            with patch.object(trial, 'refresh_runtime', return_value=config), patch.object(trial, 'validate_configuration'), \
                    patch.object(trial.shutil, 'which', return_value='/test/bin'), \
                    patch.object(trial, 'checked', side_effect=RuntimeError('provider unavailable')):
                with self.assertRaisesRegex(RuntimeError, 'provider unavailable'):
                    trial.queue(root)
            self.assertEqual(list(jobs.glob('*/state.json')), [])
            self.assertFalse(json.loads((local / 'config.local.json').read_text())['release']['enabled'])

    def test_existing_qualification_is_not_duplicated_or_resumed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config, local, jobs = self.prepare(root)
            job = jobs / 'release-qualification-existing'
            job.mkdir()
            saved = {'id': job.name, 'stage': 'deployment', 'paused': 'needs reconciliation'}
            (job / 'state.json').write_text(json.dumps(saved))
            with patch.object(trial, 'refresh_runtime', return_value=config), \
                    patch.object(trial, 'validate_configuration', side_effect=AssertionError('must not start new work')):
                trial.queue(root)
            self.assertEqual(json.loads((job / 'state.json').read_text()), saved)

    def test_ready_job_has_bounded_per_job_authority_and_keeps_ordinary_release_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config, local, jobs = self.prepare(root)
            def checked(argv, *args, **kwargs):
                if argv[:3] == ['claude', 'auth', 'status']:
                    return '{"loggedIn":true}'
                if argv[:2] == ['gh', 'api'] and argv[-1].endswith('/protection'):
                    return json.dumps({'required_status_checks': {'strict': True, 'contexts': ['CI gate']},
                                       'enforce_admins': {'enabled': True}})
                return ''
            with patch.object(trial, 'refresh_runtime', return_value=config), patch.object(trial, 'validate_configuration'), \
                    patch.object(trial.shutil, 'which', return_value='/test/bin'), \
                    patch.object(trial, 'checked', side_effect=checked), patch.object(trial, 'ensure_database_engine'), \
                    patch.object(trial, 'import_candidate', return_value=('main-sha', 'candidate-sha', [])), \
                    patch.object(trial, 'migration_files', return_value={}), patch.object(trial, 'ledger', return_value=[]), \
                    patch.object(trial, 'invariants'), patch('operations.smoke', return_value={'passed': True}), \
                    patch('release.vercel_deployments', return_value=[]):
                trial.queue(root)
            state_path, = jobs.glob('*/state.json')
            state = json.loads(state_path.read_text())
            self.assertEqual(state['stage'], 'audit')
            self.assertEqual(state['base_sha'], 'main-sha')
            per_job = json.loads(Path(state['config_path']).read_text())
            self.assertTrue(per_job['release']['enabled'])
            self.assertEqual(per_job['release']['approved_paths'], trial.APPROVED_PATHS)
            self.assertFalse(json.loads((local / 'config.local.json').read_text())['release']['enabled'])
