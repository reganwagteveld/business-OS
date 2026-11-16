#!/usr/bin/env python3
"""Read-only Vercel authentication check. Never outputs token or successful account data."""
import json
import os
from pathlib import Path
import re
import shlex
import urllib.error
import urllib.request

LOCAL = Path.home()/'Library/Application Support/Pixakova/BusinessOSCoordinator/.coordinator-local'


def sanitize(value, token):
    text=str(value).replace(token,'<token-redacted>')
    text=re.sub(r'(?i)bearer\s+[^\s"<>]+','Bearer <redacted>',text)
    return text[:1000]


def inspect_response(url,token):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args):
            return None
    request=urllib.request.Request(url,headers={'Authorization':'Bearer '+token,
        'Accept':'application/json','User-Agent':'business-os-coordinator/0.1'})
    opener=urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request,timeout=20) as response:
            # Consume without retaining account/profile/project data.
            response.read()
            return {'url':url,'status':response.status,'authenticated_read':True}
    except urllib.error.HTTPError as error:
        raw=error.read(16384).decode('utf-8','replace')
        result={'url':url,'status':error.code,'authenticated_read':False,
                'content_type':error.headers.get('Content-Type','')}
        try:
            payload=json.loads(raw)
            detail=payload.get('error',payload) if isinstance(payload,dict) else {}
            if isinstance(detail,dict):
                for key in ['code','message','invalidToken','tokenExpired','missingToken','teamIdRequired']:
                    if key in detail:
                        result[key]=sanitize(detail[key],token)
        except ValueError:
            # HTML can signal a network security challenge; don't persist page contents.
            result['non_json_response']=True
            result['security_challenge']=any(x in raw.lower() for x in ['security checkpoint','captcha','challenge'])
        error.close()
        return result
    except (OSError,TimeoutError) as error:
        return {'url':url,'authenticated_read':False,'network_error':sanitize(type(error).__name__,token)}


def main():
    os.umask(0o077)
    values={}
    env_file=LOCAL/'host.env'
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            fields=shlex.split(line,comments=True)
            if len(fields)==1 and '=' in fields[0]:
                key,value=fields[0].split('=',1)
                values[key]=value
    token=os.environ.get('BOS_VERCEL_TOKEN') or values.get('BOS_VERCEL_TOKEN')
    if not token:
        raise SystemExit('No saved Vercel token found. Nothing was requested or changed.')
    urls=['https://api.vercel.com/v2/user',
          'https://api.vercel.com/v9/projects?slug=pixakova&limit=2',
          'https://api.vercel.com/v10/projects?slug=pixakova&limit=2']
    checks=[]
    for url in urls:
        print('Checking read access: '+url,flush=True)
        checks.append(inspect_response(url,token))
    report={'read_only':True,'team_slug':'pixakova','checks':checks}
    path=LOCAL/'vercel-auth-check.json'
    path.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
    print('Diagnostic saved. No settings, credentials, migrations or deployments changed.')


if __name__=='__main__':
    main()
