import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('access_setup',Path(__file__).with_name('configure-access.py'))
access=importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)


class AccessSetupTests(unittest.TestCase):
    def test_empty_provider_selection_stops(self):
        with self.assertRaises(RuntimeError):
            access.choose([], 'production branch')

    def test_multiple_production_branches_require_explicit_selection(self):
        rows=[{'id':'prod','name':'production'},{'id':'backup','name':'recovery'}]
        with patch('builtins.input', return_value='2'):
            self.assertEqual(access.choose(rows,'branch')['id'],'backup')
        with patch('builtins.input', return_value='0'):
            with self.assertRaises(RuntimeError):
                access.choose(rows,'branch')

    def test_cli_failure_does_not_echo_secrets(self):
        from subprocess import CompletedProcess
        with patch.object(access.subprocess,'run',return_value=CompletedProcess([],1,'secret-token','secret-password')):
            with self.assertRaises(RuntimeError) as caught:
                access.execute(['provider','connection-string'])
            self.assertNotIn('secret-token',str(caught.exception))
            self.assertNotIn('secret-password',str(caught.exception))

    def test_existing_api_profile_does_not_reauthenticate(self):
        with patch.object(access,'execute',return_value='[{"name":"business-os-coordinator","auth":"api-key"}]'), \
             patch.object(access.subprocess,'run',side_effect=AssertionError('must not reauthenticate')):
            self.assertEqual(access.ensure_neon_profile({}),'business-os-coordinator')
        access.NEON_PROFILE_NAME=None

    def test_provider_timeout_identifies_step_without_secret_output(self):
        import subprocess
        with patch.object(access.subprocess,'run',side_effect=subprocess.TimeoutExpired(['neonctl'],30)):
            with self.assertRaises(RuntimeError) as caught:
                access.execute(['neonctl','projects','list'])
            self.assertIn('neonctl projects list',str(caught.exception))

    def test_explicit_organization_prevents_hidden_cli_prompt(self):
        responses=['[{"id":"org-a","name":"A"},{"id":"org-b","name":"B"}]',
                   '[{"id":"project-b","name":"Business OS"}]']
        with patch.object(access,'execute',side_effect=responses) as execute, \
             patch('builtins.input',return_value='2'):
            rows=access.load_neon_projects()
        self.assertEqual(rows[0]['id'],'project-b')
        self.assertIn('--org-id',execute.call_args.args[0])
        self.assertEqual(execute.call_args.args[0][-1],'org-b')

    def test_empty_project_stdout_has_actionable_error(self):
        with patch.object(access,'execute',side_effect=['[]','']):
            with self.assertRaisesRegex(RuntimeError,'no project JSON'):
                access.load_neon_projects()

    def test_terminal_echo_and_line_input_are_restored(self):
        import os
        import pty
        import termios
        master,slave=pty.openpty()
        try:
            attrs=termios.tcgetattr(slave)
            attrs[3] &= ~(termios.ECHO|termios.ICANON|termios.ISIG)
            termios.tcsetattr(slave,termios.TCSANOW,attrs)
            access.normal_terminal(slave)
            result=termios.tcgetattr(slave)
            for flag in [termios.ECHO,termios.ICANON,termios.ISIG]:
                self.assertTrue(result[3]&flag)
            self.assertTrue(result[0]&termios.ICRNL)
        finally:
            os.close(master)
            os.close(slave)

    def test_vercel_team_is_discovered_without_requesting_an_id(self):
        import urllib.error
        projects=[{'id':'api','name':'API','rootDirectory':'apps/api','link':{'repo':'business-OS','org':'reganwagteveld'}},
                  {'id':'web','name':'Web','rootDirectory':'apps/web','link':{'repo':'business-OS','org':'reganwagteveld'}}]
        responses=[urllib.error.HTTPError('https://api.vercel.com',403,'Forbidden',{},None),
                   [{'id':'team-real','name':'Pixakova'}],projects]
        with patch.object(access,'vercel_pages',side_effect=responses), \
             patch.object(access,'request_json',side_effect=lambda url, token: next(p for p in projects if '/'+p['id']+'?' in url)), \
             patch('builtins.input',side_effect=AssertionError('No manual team identifier needed')):
            team,api,web=access.discover_vercel_projects('test-token')
        self.assertEqual((team,api['id'],web['id']),('team-real','api','web'))

    def test_invalid_vercel_token_has_explicit_error(self):
        import urllib.error
        with patch.object(access,'vercel_pages',side_effect=urllib.error.HTTPError('https://api.vercel.com',401,'Unauthorized',{},None)):
            with self.assertRaisesRegex(RuntimeError,'HTTP 401'):
                access.discover_vercel_projects('expired')

    def test_project_details_resolve_missing_summary_fields_by_repository_id(self):
        summaries=[{'id':'api','name':'business-os-api'},{'id':'web','name':'business-os-web'}]
        details={'api':{'rootDirectory':'./apps/api/','link':{'type':'github','repoId':123}},
                 'web':{'rootDirectory':'apps/web','link':{'type':'github','repoId':123}}}
        def detail(url,token):
            return details[url.rsplit('/',1)[-1]]
        with patch.object(access,'vercel_pages',side_effect=[summaries,[]]), \
             patch.object(access,'request_json',side_effect=detail):
            team,api,web=access.discover_vercel_projects('token',123)
        self.assertEqual((api['id'],web['id']),('api','web'))

    def test_known_pixakova_scope_skips_forbidden_account_discovery(self):
        projects=[{'id':'api','name':'business-os','accountId':'team_real',
                   'rootDirectory':'apps/api','link':{'repoId':123,'type':'github'}},
                  {'id':'web','name':'business-os-web','accountId':'team_real',
                   'rootDirectory':'apps/web','link':{'repoId':123,'type':'github'}}]
        with patch.object(access,'vercel_pages',return_value=projects) as pages, \
             patch.object(access,'request_json',side_effect=projects):
            team,api,web=access.discover_vercel_projects('token',123,preferred_team='pixakova')
        self.assertEqual(team,'team_real')
        self.assertEqual(pages.call_count,1)
        self.assertEqual(pages.call_args.args[-1],'pixakova')

    def test_team_slug_becomes_slug_query_not_team_id(self):
        with patch.object(access,'request_json',return_value={'projects':[]}) as request:
            access.vercel_pages('/v9/projects','projects','token','pixakova')
        self.assertIn('slug=pixakova',request.call_args.args[0])
        self.assertNotIn('teamId=pixakova',request.call_args.args[0])

    def test_rejected_replacement_does_not_overwrite_saved_token(self):
        import urllib.error
        secrets={'BOS_VERCEL_TOKEN':'old'}
        with patch.object(access,'request_json',side_effect=urllib.error.HTTPError('https://api.vercel.com',403,'Forbidden',{},None)), \
             patch.object(access,'persist_setup') as save:
            with self.assertRaisesRegex(RuntimeError,'saved token was not changed'):
                access.replace_vercel_token({'release':{}},secrets,'new')
            save.assert_not_called()
        self.assertEqual(secrets['BOS_VERCEL_TOKEN'],'old')

    def test_valid_replacement_is_saved_only_after_validation(self):
        secrets={'BOS_VERCEL_TOKEN':'old'}
        calls=[]
        with patch.object(access,'request_json',side_effect=lambda *args:calls.append('validate') or {'projects':[]}), \
             patch.object(access,'persist_setup',side_effect=lambda *args:calls.append('save')):
            access.replace_vercel_token({'release':{}},secrets,'Bearer new')
        self.assertEqual(calls,['validate','save'])
        self.assertEqual(secrets['BOS_VERCEL_TOKEN'],'new')
