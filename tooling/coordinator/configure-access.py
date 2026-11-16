#!/usr/bin/env python3
"""Interactive host setup. Secrets remain local; production release stays disabled."""
import getpass
import http.cookiejar
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import termios
import urllib.parse
import urllib.error
import urllib.request

RUNTIME = Path.home()/'Library/Application Support/Pixakova/BusinessOSCoordinator'
LOCAL = RUNTIME/'.coordinator-local'
NEON_PROFILE_NAME = None



def normal_terminal(fd=None):
    if fd is None:
        try:
            fd = sys.stdin.fileno()
        except (AttributeError, OSError, ValueError):
            return
    if not os.isatty(fd):
        return
    attrs = termios.tcgetattr(fd)
    attrs[0] |= termios.ICRNL
    attrs[1] |= termios.OPOST | termios.ONLCR
    attrs[3] |= termios.ECHO | termios.ICANON | termios.ISIG | termios.IEXTEN
    attrs[6][termios.VINTR] = b'\x03'
    attrs[6][termios.VEOF] = b'\x04'
    termios.tcsetattr(fd, termios.TCSANOW, attrs)


def execute(argv, body=None):
    argv = list(argv)
    if argv[0] == 'neonctl' and NEON_PROFILE_NAME and '--profile' not in argv:
        argv += ['--profile', NEON_PROFILE_NAME]
    print('Checking: ' + ' '.join(argv[:3]), flush=True)
    try:
        options = {'input': body} if body is not None else {'stdin': subprocess.DEVNULL}
        environment = dict(os.environ)
        if argv[0] == 'neonctl':
            environment['CI'] = 'true'  # Disable hidden organization/auth prompts in captured CLI calls.
        p = subprocess.run(argv, text=True, capture_output=True, timeout=30, env=environment, **options)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Timed out at ' + ' '.join(argv[:3]) + '; check the operation result before retrying any write')
    finally:
        normal_terminal()
    if p.returncode:
        raise RuntimeError(argv[0] + ' failed; check its login/access in this Terminal. Raw output is not displayed because it may contain secrets.')
    return p.stdout.strip()


def choose(rows, label):
    normal_terminal()
    if not rows:
        raise RuntimeError('No matching ' + label + ' found')
    if len(rows) == 1:
        print(label + ': ' + rows[0].get('name', rows[0].get('slug', rows[0]['id'])))
        return rows[0]
    print('Select the existing production ' + label + ':')
    for i, row in enumerate(rows, 1):
        print(str(i) + '. ' + row.get('name', row.get('slug', row['id'])) + ' (' + row['id'] + ')')
    index = int(input('Number: ')) - 1
    if not 0 <= index < len(rows):
        raise RuntimeError('Invalid selection')
    return rows[index]


def items(value, key):
    return value if isinstance(value, list) else value.get(key, [])


def local_secrets():
    values = {}
    path = LOCAL/'host.env'
    if path.exists():
        for line in path.read_text().splitlines():
            fields = shlex.split(line, comments=True)
            if len(fields) == 1 and '=' in fields[0]:
                key, value = fields[0].split('=', 1)
                values[key] = value
    return values


def request_json(url, token=None, cookie=None, body=None):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    headers = {'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if cookie:
        headers['Cookie'] = cookie
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        return json.load(response)



def vercel_pages(endpoint, key, token, team=None):
    rows=[]
    cursor=None
    seen=set()
    while True:
        params={'limit':100}
        if team:
            params['teamId' if team.startswith('team_') else 'slug']=team
        if cursor is not None:
            params['until']=cursor
        result=request_json('https://api.vercel.com'+endpoint+'?'+urllib.parse.urlencode(params),token)
        rows.extend(result.get(key,[]))
        cursor=(result.get('pagination') or {}).get('next')
        if cursor is None or cursor in seen:
            return rows
        seen.add(cursor)


def discover_vercel_projects(token, expected_repository_id=None, diagnostic_path=None, preferred_team=None):
    groups=[]
    diagnostic={'scopes':[],'projects':[],'http_errors':[]}
    def snapshot():
        if diagnostic_path:
            diagnostic_path.write_text(json.dumps(diagnostic,indent=2)+'\n')
    def read(endpoint,key,team=None):
        try:
            return vercel_pages(endpoint,key,token,team)
        except urllib.error.HTTPError as exc:
            diagnostic['http_errors'].append({'endpoint':endpoint,'scope':team,'status':exc.code})
            snapshot()
            if exc.code==401:
                raise RuntimeError('Vercel rejected this access token (HTTP 401). Check its expiry and account access.')
            if exc.code==403:
                return []
            raise
    def repository_matches(project):
        link=project.get('link') or project.get('gitRepository') or {}
        if link.get('type') not in [None,'github']:
            return False
        if expected_repository_id is not None and str(link.get('repoId',''))==str(expected_repository_id):
            return True
        repo=link.get('repo') or link.get('name') or ''
        owner=link.get('org') or link.get('owner') or ''
        return (isinstance(repo,str) and isinstance(owner,str) and repo.lower()=='business-os'
                and owner.lower()=='reganwagteveld')
    def consider(projects,team):
        detailed=[]
        for project in projects:
            # List responses may omit git linkage and rootDirectory. Fetch authoritative details.
            if 'business' in project.get('name','').lower() or repository_matches(project):
                query=urllib.parse.urlencode({'teamId' if team['id'].startswith('team_') else 'slug':team['id']}) if team['id'] else ''
                url='https://api.vercel.com/v9/projects/'+urllib.parse.quote(project['id'],safe='')
                try:
                    detail=request_json(url+('?' + query if query else ''),token)
                    project=dict(project,**detail)
                except urllib.error.HTTPError as exc:
                    diagnostic['http_errors'].append({'endpoint':'project-detail','scope':team['id'],'status':exc.code})
                    if exc.code not in [403,404]:
                        snapshot()
                        raise
            link=project.get('link') or project.get('gitRepository') or {}
            diagnostic['projects'].append({'id':project.get('id'),'name':project.get('name'),
                'scope':team['id'],'rootDirectory':project.get('rootDirectory'),
                'git':{k:link.get(k) for k in ['type','org','owner','repo','repoId']},
                'repository_matched':repository_matches(project)})
            detailed.append(project)
        snapshot()
        matched=[p for p in detailed if repository_matches(p)]
        def root(p):
            return (p.get('rootDirectory') or '').replace('\\','/').removeprefix('./').rstrip('/')
        api=[p for p in matched if root(p)=='apps/api']
        web=[p for p in matched if root(p)=='apps/web']
        if api and web:
            accounts={p.get('accountId') for p in api+web if p.get('accountId')}
            if len(accounts)>1:
                raise RuntimeError('API and web projects have different account ownership')
            if len(accounts)==1 and next(iter(accounts)).startswith('team_'):
                team=dict(team,id=next(iter(accounts)))
            signature=tuple(sorted(p['id'] for p in api+web))
            existing=next((g for g in groups if g['signature']==signature),None)
            if existing:
                if team['id']:
                    existing['id']=team['id']
                    existing['name']=team['name']
                return
            groups.append(dict(team,api=api,web=web,signature=signature))
    print('Discovering Vercel projects and accessible teams...',flush=True)
    if preferred_team:
        diagnostic['scopes'].append({'id':preferred_team,'name':preferred_team})
        consider(read('/v9/projects','projects',preferred_team),{'id':preferred_team,'name':preferred_team})
    else:
        diagnostic['scopes'].append({'id':'','name':'Personal/default account'})
        consider(read('/v9/projects','projects'),{'id':'','name':'Personal/default account'})
        for team in read('/v2/teams','teams'):
            diagnostic['scopes'].append({'id':team['id'],'name':team.get('name')})
            consider(read('/v9/projects','projects',team['id']),
                     {'id':team['id'],'name':team.get('name',team.get('slug',team['id']))})
    snapshot()
    if not groups:
        raise RuntimeError('Business OS projects could not be matched yet. Safe project metadata was recorded; this does not establish that the token is invalid.')
    group=choose(groups,'Vercel account/team containing Business OS')
    api=choose(group['api'],'Vercel API project')
    web=choose(group['web'],'Vercel web project')
    return group['id'],api,web


def persist_setup(config,secrets):
    config['release']['enabled']=False
    env_path=LOCAL/'host.env'
    temp=LOCAL/'host.env.tmp'
    temp.write_text(''.join(k+'='+shlex.quote(v)+'\n' for k,v in secrets.items()))
    temp.chmod(0o600)
    temp.replace(env_path)
    config_path=LOCAL/'config.local.json.tmp'
    config_path.write_text(json.dumps(config,indent=2)+'\n')
    config_path.replace(LOCAL/'config.local.json')



def replace_vercel_token(config,secrets,candidate):
    candidate=candidate.strip()
    if candidate.lower().startswith('bearer '):
        candidate=candidate[7:].strip()
    if not candidate or any(c.isspace() for c in candidate):
        raise RuntimeError('Paste only the actual token value. The saved token was not changed.')
    print('Validating replacement token against the Pixakova team...',flush=True)
    try:
        request_json('https://api.vercel.com/v10/projects?slug=pixakova&limit=1',candidate)
    except urllib.error.HTTPError as error:
        status=error.code
        error.close()
        raise RuntimeError('Vercel rejected replacement access (HTTP '+str(status)+'). The saved token was not changed.')
    updated=dict(secrets,BOS_VERCEL_TOKEN=candidate)
    persist_setup(config,updated)
    secrets.update(updated)
    print('Replacement token accepted by Vercel and saved locally.',flush=True)
    return candidate


def smoke_session(origin):
    print('Create a local smoke-test session using an existing test-business account.')
    print('1. Email/password login (password is not saved)\n2. Existing session cookie (for Google/GitHub sign-in)')
    method = input('Method [1]: ').strip() or '1'
    if method == '2':
        return getpass.getpass('Cookie header for this app (hidden, saved locally): ').strip()
    if method != '1':
        raise RuntimeError('Invalid login method')
    email = input('Business OS login email: ').strip()
    password = getpass.getpass('Business OS password (hidden, not saved): ')
    jar = http.cookiejar.CookieJar()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect())
    body = json.dumps({'email': email, 'password': password}).encode()
    request = urllib.request.Request(origin+'/api/v1/auth/sign-in/email', data=body,
              headers={'Content-Type':'application/json','Origin':origin})
    with opener.open(request, timeout=30) as response:
        response.read()
    cookie = '; '.join(c.name+'='+c.value for c in jar if c.secure and origin.split('://',1)[1].split('/',1)[0].endswith(c.domain.lstrip('.')))
    if not cookie:
        raise RuntimeError('No session cookie was returned; use an existing browser session instead')
    return cookie





def load_neon_projects():
    raw=execute(['neonctl','orgs','list','--output','json'])
    if not raw:
        raise RuntimeError('Neon returned no organization data; no targets were selected')
    organizations=items(json.loads(raw),'organizations')
    args=['neonctl','projects','list','--output','json']
    if organizations:
        organization=choose(organizations,'Neon organization')
        args += ['--org-id',organization['id']]
    raw=execute(args)
    if not raw:
        raise RuntimeError('Neon returned no project JSON; no targets were selected')
    return items(json.loads(raw),'projects')


def ensure_neon_profile(secrets):
    global NEON_PROFILE_NAME
    profiles=items(json.loads(execute(['neonctl','profile','list','--output','json'])),'profiles')
    preferred=secrets.get('NEON_PROFILE') or 'business-os-coordinator'
    candidate=next((p for p in profiles if p.get('name')==preferred),None)
    if candidate and candidate.get('auth') not in ['oauth','browser','session']:
        NEON_PROFILE_NAME=preferred
    else:
        if candidate:
            import time
            preferred += '-' + time.strftime('%Y%m%d%H%M%S')
        print('Neon has a browser-session login. Unattended CLI work needs an API-key profile.',flush=True)
        print('Opening Neon sign-in to create the coordinator profile. Complete it in your browser.',flush=True)
        # Auth is deliberately interactive and visible. Existing profiles are never replaced.
        try:
            result=subprocess.run(['neonctl','profile','create',preferred,'--mint'],timeout=300)
        finally:
            normal_terminal()
        if result.returncode:
            raise RuntimeError('Neon coordinator profile setup did not complete')
        NEON_PROFILE_NAME=preferred
    secrets['NEON_PROFILE']=NEON_PROFILE_NAME
    return NEON_PROFILE_NAME


def ensure_branch_protection(repository):
    endpoint='repos/'+repository+'/branches/main/protection'
    probe=subprocess.run(['gh','api',endpoint],text=True,capture_output=True,timeout=30)
    if probe.returncode:
        try:
            error=json.loads(probe.stdout)
        except ValueError:
            raise RuntimeError('Unable to inspect main branch protection')
        if error.get('message')!='Branch not protected':
            raise RuntimeError('GitHub branch protection access is unavailable; no protection was changed')
        payload={'required_status_checks':{'strict':True,'contexts':['CI gate']},
                 'enforce_admins':True,'required_pull_request_reviews':None,'restrictions':None,
                 'allow_force_pushes':False,'allow_deletions':False}
        execute(['gh','api','--method','PUT',endpoint,'--input','-'],json.dumps(payload))
    else:
        protection=json.loads(probe.stdout)
        required=protection.get('required_status_checks') or {}
        checks=[{'context':c['context'],**({'app_id':c['app_id']} if c.get('app_id') is not None else {})}
                for c in required.get('checks',[])]
        known={c['context'] for c in checks}
        for context in required.get('contexts',[]):
            if context not in known:
                checks.append({'context':context})
                known.add(context)
        if 'CI gate' not in known:
            checks.append({'context':'CI gate'})
        execute(['gh','api','--method','PATCH',endpoint+'/required_status_checks','--input','-'],
                json.dumps({'strict':True,'checks':checks}))
        if not protection.get('enforce_admins',{}).get('enabled'):
            execute(['gh','api','--method','POST',endpoint+'/enforce_admins'])
    verified=json.loads(execute(['gh','api',endpoint]))
    required=verified.get('required_status_checks') or {}
    contexts=set(required.get('contexts',[]))|{c['context'] for c in required.get('checks',[])}
    if not required.get('strict') or 'CI gate' not in contexts or not verified.get('enforce_admins',{}).get('enabled'):
        raise RuntimeError('Required branch protection was not confirmed')
    return {'required_check':'CI gate','strict':True,'enforce_admins':True}


def main():
    normal_terminal()
    os.umask(0o077)
    path = LOCAL/'config.local.json'
    if not path.exists():
        raise RuntimeError('Install the persistent worker first')
    config = json.loads(path.read_text())
    release = config['release']
    secrets = local_secrets()
    replacement=None
    if '--replace-vercel-token' in sys.argv:
        replacement=replace_vercel_token(config,secrets,getpass.getpass('New Vercel API access token (hidden): '))
    if '--check-vercel' in sys.argv or '--replace-vercel-token' in sys.argv:
        token=replacement or os.environ.get('BOS_VERCEL_TOKEN') or secrets.get('BOS_VERCEL_TOKEN')
        if not token:
            raise RuntimeError('No saved Vercel token was found; no further setup attempted')
        repo_id=execute(['gh','api','repos/reganwagteveld/business-OS','--jq','.id'])
        team,api,web=discover_vercel_projects(token,repo_id,LOCAL/'vercel-discovery.json',release.get('vercel_team_id') or 'pixakova')
        release['vercel_project_ids']=[api['id'],web['id']]
        release['vercel_team_id']=team
        release['vercel_team_slug']='pixakova'
        persist_setup(config,secrets)
        print('Read-only project discovery passed. Confirmed IDs saved locally; no production changes.')
        return
    print('Configuring existing production targets. No migration, merge or deployment will run.',flush=True)
    ensure_neon_profile(secrets)
    projects = load_neon_projects()
    candidates = [p for p in projects if 'business' in p.get('name','').lower()]
    saved_project=[p for p in projects if p['id']==release.get('neon_project_id')]
    project = choose(saved_project or candidates or projects, 'Neon project')
    branches = items(json.loads(execute(['neonctl','branches','list','--project-id',project['id'],'--output','json'])), 'branches')
    # Do not guess the production branch when multiple branches exist.
    saved_branch=[b for b in branches if b['id']==release.get('neon_production_branch_id')]
    branch = choose(saved_branch or branches, 'Neon branch')
    owner_url = execute(['neonctl','connection-string',branch['id'],'--project-id',project['id'],
                         '--role-name','bos_owner','--no-pooled'])
    target = urllib.parse.urlsplit(owner_url)
    if target.scheme not in ['postgres','postgresql']:
        raise RuntimeError('Neon returned an unexpected connection-string format')
    admin_url = execute(['neonctl','connection-string',branch['id'],'--project-id',project['id'],
                         '--database-name',target.path.lstrip('/'),'--no-pooled'])
    admin_target = urllib.parse.urlsplit(admin_url)
    if (target.hostname,target.path)!=(admin_target.hostname,admin_target.path):
        raise RuntimeError('Administrative and migration database targets differ')
    secrets['BOS_MIGRATION_DATABASE_URL'] = owner_url
    secrets['BOS_ADMIN_DATABASE_URL'] = admin_url
    release['neon_project_id'] = project['id']
    release['neon_production_branch_id'] = branch['id']
    persist_setup(config,secrets)
    token = os.environ.get('BOS_VERCEL_TOKEN') or secrets.get('BOS_VERCEL_TOKEN')
    if not token:
        print('Provide a Vercel access token with read access to the API and web projects.')
        token = getpass.getpass('Vercel token (hidden, saved locally): ').strip()
    if not token:
        raise RuntimeError('No Vercel access token supplied')
    secrets['BOS_VERCEL_TOKEN']=token
    persist_setup(config,secrets)
    repo_id=execute(['gh','api','repos/reganwagteveld/business-OS','--jq','.id'])
    team,api,web=discover_vercel_projects(token,repo_id,LOCAL/'vercel-discovery.json',release.get('vercel_team_id') or 'pixakova')
    release['vercel_project_ids']=[api['id'],web['id']]
    release['vercel_team_id']=team
    release['vercel_team_slug']='pixakova'
    secrets['BOS_VERCEL_TOKEN']=token
    persist_setup(config,secrets)
    origin = 'https://app.pixakova.com'
    cookie = secrets.get('BOS_SMOKE_COOKIE') or smoke_session(origin)
    businesses = request_json(origin+'/api/v1/businesses',cookie=cookie).get('businesses',[])
    businesses = [dict(b,id=b['slug']) for b in businesses if b.get('role') in ['OWNER','ADMIN']]
    business = choose(businesses,'smoke-test business (read-only checks)')
    secrets['BOS_SMOKE_COOKIE']=cookie
    secrets['BOS_SMOKE_BUSINESS_SLUG']=business['slug']
    secrets['BOS_SMOKE_ORIGIN']=origin
    persist_setup(config,secrets)
    # Verify read access now, with credentials passed only to this host check process.
    env=dict(os.environ,**secrets)
    p=subprocess.run([sys.executable,str(RUNTIME/'tooling/coordinator/operations.py'),'smoke','access-check'],
                      env=env,text=True,capture_output=True,timeout=120)
    if p.returncode:
        raise RuntimeError('Access was saved, but authenticated cross-Zone smoke failed. Production stays disabled; inspect the account permissions/session.')
    result=json.loads(p.stdout)
    print('Enforcing the existing CI gate on main, including up-to-date branches and administrators.')
    protection=ensure_branch_protection(release['repository'])
    (LOCAL/'production-access-check.json').write_text(json.dumps({'configured':True,
        'authenticated_smoke':result,'branch_protection':protection,'production_release_enabled':False},indent=2)+'\n')
    print('Production targets and local credentials configured; authenticated read checks passed.')
    print('Production release is still disabled pending full live release qualification.')
    print('Configuration saved. The updated worker reloads host access before starting jobs; no service stop is required.')


if __name__=='__main__':
    try:
        main()
    except Exception as exc:
        # urllib errors contain status/URL only; never print response bodies or credential values.
        if isinstance(exc,(RuntimeError,ValueError)):
            print('Setup stopped: '+str(exc),file=sys.stderr)
        else:
            print('Setup stopped: '+type(exc).__name__+'; check provider login/access. Secrets were not printed.',file=sys.stderr)
        sys.exit(1)
