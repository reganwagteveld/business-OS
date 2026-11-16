import importlib.util
from pathlib import Path
import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

spec=importlib.util.spec_from_file_location('vercel_check',Path(__file__).with_name('vercel-access-check.py'))
check=importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class VercelDiagnosticTests(unittest.TestCase):
    def test_actual_error_is_captured_with_token_redacted(self):
        token='private-token-value'
        payload={'error':{'code':'forbidden','message':'Rejected '+token,'invalidToken':True}}
        error=HTTPError('https://api.vercel.com',403,'Forbidden',{'Content-Type':'application/json'},
                        io.BytesIO(json.dumps(payload).encode()))
        with patch.object(check.urllib.request,'build_opener') as opener:
            opener.return_value.open.side_effect=error
            result=check.inspect_response('https://api.vercel.com/v2/user',token)
        self.assertEqual(result['code'],'forbidden')
        self.assertNotIn(token,json.dumps(result))
        self.assertEqual(result['invalidToken'],'True')

    def test_success_does_not_retain_account_data(self):
        class Response:
            status=200
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def read(self): return b'{"email":"private@example.test"}'
        with patch.object(check.urllib.request,'build_opener') as opener:
            opener.return_value.open.return_value=Response()
            result=check.inspect_response('https://api.vercel.com/v2/user','secret')
        self.assertTrue(result['authenticated_read'])
        self.assertNotIn('private@example.test',json.dumps(result))
