import json
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import coordinator
from release import Waiting, once, prod_env, validate_ledger, verify_ci, vercel_deployments, main_ci, validate_scope, database_error, postgres_environment


class ReleaseTests(unittest.TestCase):
    def test_invariants_use_one_select_with_connection_enforced_read_only(self):
        from release import invariants
        expected = {'unprotected': 0, 'unsafe_roles': 0, 'invalid_constraints': 0, 'app_create': False}
        def psql(argv, cwd, env):
            sql = argv[argv.index('-c') + 1]
            self.assertTrue(sql.startswith('SELECT'))
            self.assertNotIn('ROLLBACK', sql)
            self.assertEqual(sql.count(';'), 1)
            self.assertIn('default_transaction_read_only=on', env['PGOPTIONS'])
            return json.dumps(expected)
        with patch('release.prod_env', return_value={'PGOPTIONS': '-c statement_timeout=60000'}), \
                patch('release.checked', side_effect=psql):
            self.assertEqual(invariants(Path('/tmp')), expected)

    def test_missing_invariant_output_is_a_clear_blocker_not_stop_iteration(self):
        from release import invariants
        for output in ['', 'ROLLBACK', '{}', '{"unprotected":1}']:
            with patch('release.prod_env', return_value={'PGOPTIONS': ''}), \
                    patch('release.checked', return_value=output), self.assertRaises(RuntimeError):
                invariants(Path('/tmp'))

    def test_psql_receives_explicit_neon_connection_fields_instead_of_local_defaults(self):
        url = 'postgresql://bos_owner:encoded%40password@db.example:6543/neondb?sslmode=require&channel_binding=require'
        with patch.dict(os.environ, {'BOS_MIGRATION_DATABASE_URL': url}):
            env = prod_env()
        self.assertEqual(env['PGHOST'], 'db.example')
        self.assertEqual(env['PGPORT'], '6543')
        self.assertEqual(env['PGUSER'], 'bos_owner')
        self.assertEqual(env['PGDATABASE'], 'neondb')
        self.assertEqual(env['PGPASSWORD'], 'encoded@password')
        self.assertEqual(env['PGSSLMODE'], 'require')
        self.assertEqual(env['PGCHANNELBINDING'], 'require')
        self.assertEqual(env['MIGRATION_DATABASE_URL'], url)

    def test_upgrade_fixture_counts_target_the_disposable_database_port(self):
        from operations import local_env
        env = local_env(55443)
        psql = postgres_environment(env['TEST_ADMIN_URL'], env)
        self.assertEqual(psql['PGHOST'], '127.0.0.1')
        self.assertEqual(psql['PGPORT'], '55443')
        self.assertEqual(psql['PGUSER'], 'postgres')
        self.assertEqual(psql['PGDATABASE'], 'business_os')
        self.assertNotIn('://', psql['PGDATABASE'])

    def test_database_errors_report_cause_without_provider_credentials(self):
        for message, expected in [
            ('password authentication failed for user "secret-user"', 'password was rejected'),
            ('could not translate host name "private-host" to address', 'could not be resolved'),
            ('connection to postgresql://user:secret@private-host/db failed: timeout expired', 'timed out'),
            ('invalid URI query parameter: "private-option"', 'URL option'),
            ('unexpected provider response secret-value', 'details were withheld'),
        ]:
            result = database_error(message)
            self.assertIn(expected, result)
            self.assertNotIn('secret', result)
            self.assertNotIn('private', result)

    def pr(self):
        return {'headRefOid': 'head', 'baseRefOid': 'base', 'state': 'OPEN', 'isDraft': False,
                'statusCheckRollup': [{'name': 'CI gate', 'status': 'COMPLETED', 'conclusion': 'SUCCESS'}],
                'mergeStateStatus': 'CLEAN'}

    def test_exact_commit_and_base_required(self):
        for head, base in [('changed', 'base'), ('head', 'changed')]:
            with self.assertRaises(RuntimeError):
                verify_ci(self.pr(), head, base, ['CI gate'])

    def test_missing_and_running_ci_are_waiting(self):
        pr = self.pr()
        pr['statusCheckRollup'] = []
        with self.assertRaises(Waiting):
            verify_ci(pr, 'head', 'base', ['CI gate'])
        pr['statusCheckRollup'] = [{'name': 'CI gate', 'status': 'IN_PROGRESS'}]
        with self.assertRaises(Waiting):
            verify_ci(pr, 'head', 'base', ['CI gate'])

    def test_failed_or_skipped_ci_never_clears(self):
        for result in ['FAILURE', 'SKIPPED', 'CANCELLED', 'NEUTRAL']:
            pr = self.pr()
            pr['statusCheckRollup'][0]['conclusion'] = result
            with self.assertRaises(RuntimeError):
                verify_ci(pr, 'head', 'base', ['CI gate'])

    def test_successful_ci_clears_only_current_open_pr(self):
        verify_ci(self.pr(), 'head', 'base', ['CI gate'])
        pr = self.pr()
        pr['isDraft'] = True
        with self.assertRaises(RuntimeError):
            verify_ci(pr, 'head', 'base', ['CI gate'])

    def test_migration_checksums_pending_and_incomplete(self):
        row = {'migration_name': 'one', 'checksum': 'hash', 'finished_at': 'now', 'rolled_back_at': None}
        self.assertEqual(validate_ledger({'one': 'hash', 'two': 'new'}, [row], True), ['two'])
        for rows in [[dict(row, checksum='different')], [dict(row, finished_at=None)], [row, row]]:
            with self.assertRaises(RuntimeError):
                validate_ledger({'one': 'hash'}, rows, True)
        with self.assertRaises(RuntimeError):
            validate_ledger({'one': 'hash', 'two': 'new'}, [row], False)

    def test_production_write_is_not_repeated(self):
        state = {}
        calls = []
        result = once(state, 'migration', lambda: calls.append(1) or 'done', lambda: None)
        self.assertEqual(result, 'done')
        once(state, 'migration', lambda: calls.append(2), lambda: None)
        self.assertEqual(calls, [1])

    def test_interrupted_write_is_not_replayed(self):
        state = {}
        def fail():
            raise OSError('lost connection after write')
        with self.assertRaises(OSError):
            once(state, 'merge', fail, lambda: None)
        with self.assertRaises(RuntimeError):
            once(state, 'merge', lambda: self.fail('must not replay'), lambda: None)

    def test_production_secrets_do_not_enter_agent_or_qa_environment(self):
        with patch.dict(os.environ, {'BOS_MIGRATION_DATABASE_URL': 'secret', 'VERCEL_TOKEN': 'secret',
                                     'ANTHROPIC_API_KEY': 'billed-key'}):
            env = coordinator.safe_environment()
            self.assertNotIn('BOS_MIGRATION_DATABASE_URL', env)
            self.assertNotIn('VERCEL_TOKEN', env)
            self.assertNotIn('ANTHROPIC_API_KEY', env)
        with self.assertRaises(RuntimeError):
            coordinator.safe_environment({'DATABASE_URL': 'postgresql://user@production.example/db'})

    def test_wrong_role_or_pooler_cannot_migrate(self):
        for url in ['postgresql://bos_owner@db-pooler.example/db', 'postgresql://postgres@db.example/db']:
            with patch.dict(os.environ, {'BOS_MIGRATION_DATABASE_URL': url}):
                with self.assertRaises(RuntimeError):
                    prod_env()

    def test_release_disabled_performs_no_external_action(self):
        from release import step
        state = {'stage': 'publish'}
        with patch('release.checked', side_effect=AssertionError('external call')):
            step(Path('/tmp'), state, {'release': {'enabled': False}}, lambda: None)
        self.assertEqual(state['stage'], 'release-unconfigured')

    def deployment(self, **extra):
        return dict({'uid': 'dpl-reviewed', 'state': 'READY', 'target': 'production',
                     'aliasAssigned': 1794760000000, 'meta': {'githubCommitSha': 'merged'}}, **extra)

    def vercel_responses(self, deployment, current='dpl-reviewed'):
        return [io.BytesIO(json.dumps({'deployments': [deployment]}).encode()),
                io.BytesIO(json.dumps({'targets': {'production': {'id': current}}}).encode())]

    def test_promoted_deployment_accepts_boolean_or_timestamp_alias_assignment(self):
        for assigned in [True, 1794760000000]:
            with patch.dict(os.environ, {'BOS_VERCEL_TOKEN': 'test'}), patch('release.urllib.request.urlopen',
                    side_effect=self.vercel_responses(self.deployment(aliasAssigned=assigned))) as request:
                result = vercel_deployments({'vercel_project_ids': ['prj-one'], 'vercel_team_id': 'team_one'}, 'merged')
                self.assertEqual(result[0]['deployment'], 'dpl-reviewed')
                self.assertIn('teamId=team_one', request.call_args.args[0].full_url)

    def test_ready_historical_deployment_does_not_count_as_current_production(self):
        with patch.dict(os.environ, {'BOS_VERCEL_TOKEN': 'test'}), patch('release.urllib.request.urlopen',
                side_effect=self.vercel_responses(self.deployment(), current='dpl-something-else')):
            with self.assertRaises(Waiting):
                vercel_deployments({'vercel_project_ids': ['prj-one']}, 'merged')

    def test_unassigned_staged_failed_or_wrong_sha_deployment_never_passes(self):
        for change, error in [({'aliasAssigned': False}, Waiting), ({'aliasAssigned': 0}, Waiting),
                              ({'readySubstate': 'STAGED'}, Waiting), ({'state': 'ERROR'}, RuntimeError),
                              ({'meta': {'githubCommitSha': 'other'}}, Waiting)]:
            with patch.dict(os.environ, {'BOS_VERCEL_TOKEN': 'test'}), patch('release.urllib.request.urlopen',
                    side_effect=self.vercel_responses(self.deployment(**change))):
                with self.assertRaises(error):
                    vercel_deployments({'vercel_project_ids': ['prj-one']}, 'merged')

    def test_main_ci_requires_merged_sha_success(self):
        for runs, error in [([], Waiting), ([{'headSha': 'other'}], Waiting),
                            ([{'headSha': 'merged', 'status': 'in_progress'}], Waiting),
                            ([{'headSha': 'merged', 'status': 'completed', 'conclusion': 'failure'}], RuntimeError)]:
            with patch('release.gh', return_value=runs), self.assertRaises(error):
                main_ci({'repository': 'owner/repo'}, Path('/tmp'), 'merged')
        run = {'headSha': 'merged', 'status': 'completed', 'conclusion': 'success', 'url': 'https://example.test/run'}
        with patch('release.gh', return_value=[run]):
            self.assertEqual(main_ci({'repository': 'owner/repo'}, Path('/tmp'), 'merged')['sha'], 'merged')

    def test_qualification_scope_rejects_product_changes_including_untracked_files(self):
        for results in [['tooling/coordinator/example.py', 'apps/api/src/change.ts'],
                        ['apps/api/src/change.ts', ''], ['', 'secret.txt']]:
            with patch('release.checked', side_effect=results), self.assertRaises(RuntimeError):
                validate_scope(Path('/tmp'), 'base', ['tooling/coordinator/*'])
        with patch('release.checked', side_effect=['tooling/coordinator/example.py', '']):
            validate_scope(Path('/tmp'), 'base', ['tooling/coordinator/*'])


if __name__ == '__main__':
    unittest.main()

class ConfigurationTests(unittest.TestCase):
    def test_incomplete_configuration_stops_before_writes(self):
        from release import validate_configuration
        with self.assertRaises(RuntimeError):
            validate_configuration({'repository': 'reganwagteveld/business-OS'})

    def test_qa_credentials_are_local_disposable_only(self):
        from operations import local_env
        env = local_env(55443)
        self.assertIn('127.0.0.1:55443', env['DATABASE_URL'])
        self.assertNotIn('BOS_MIGRATION_DATABASE_URL', env)
        self.assertEqual(env['DEPLOYMENT_REGION'], 'local')
