import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
CANDIDATE = json.loads((HERE / 'candidate.json').read_text())
RELEASE = CANDIDATE['release']
API = 'pi-durable-verify-api-1'
WX = 'pi-durable-verify-wx-bot-1'
IMAGE = 'pi-durable-verify-api:' + RELEASE
ROOT = Path(CANDIDATE['containers'][API]['root'])

def run(args, data=None):
    result = subprocess.run(args, input=data, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError('Command failed: ' + ' '.join(args[:3]) + '; private diagnostics suppressed')
    return result.stdout.strip()

def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]

def identity(name):
    d = inspect(name)
    return {'id': d['Id'], 'imageId': d['Image'], 'startedAt': d['State']['StartedAt']}

def base_compose():
    args = ['docker', 'compose', '-p', 'pi-durable-verify']
    for file in CANDIDATE['containers'][API]['composeFiles'].split(','):
        if not Path(file).is_relative_to(ROOT):
            raise RuntimeError('Unexpected Compose path')
        args += ['-f', file]
    return args

SMOKE = r'''
import assert from 'node:assert/strict';
import {createTeamsInbox} from '/app/packages/features/dist/index.js';
import {createTeamsReader} from '/app/apps/server/dist/teams-reader.js';
import {graphPageUrl} from '/app/apps/server/dist/teams-graph.js';
import {startServerIntegrations} from '/app/apps/server/dist/integrations.js';
await import('/app/apps/server/dist/application/index.js');
const ext=createTeamsInbox({list:()=>[],read:async query=>({data:{kind:query.kind}})});
const names=ext.tools.map(tool=>tool.name);
for(const name of ['teams_messages','teams_chats','teams_channels','teams_history','teams_files','teams_file'])assert.ok(names.includes(name));
const chats=ext.tools.find(tool=>tool.name==='teams_chats');
assert.match(JSON.stringify(await chats.execute({})),/chats/);
const before='/chats/19%3Aabc%40thread.v2/messages';
assert.ok(graphPageUrl(before,'https://graph.microsoft.com/v1.0/chats/19:abc@thread.v2/messages?$skiptoken=test'));
assert.throws(()=>graphPageUrl(before,'https://evil.example/steal'));
const sender={};await startServerIntegrations({config:{offline:true,teamsConfigDir:'/must-not-read'},teamsSender:sender})();assert.deepEqual(sender,{});
const read=createTeamsReader({getToken:async()=> 'test',fetchImpl:async()=>Response.json({value:[]})});
assert.deepEqual((await read({kind:'chats'})).data.items,[]);
console.log(JSON.stringify({tools:names,offline:true,paging:true,moduleImports:true}));
'''

def prepare():
    for name, expected in CANDIDATE['hashes'].items():
        if hashlib.sha256((HERE / 'overlay' / name).read_bytes()).hexdigest() != expected:
            raise RuntimeError('Release fingerprint mismatch: ' + name)
    current = inspect(API)
    if current['Image'] != CANDIDATE['containers'][API]['imageId']:
        raise RuntimeError('Live API changed since preparation')
    for name, expected in CANDIDATE['baseHashes'].items():
        actual = run(['docker', 'exec', API, 'sha256sum', '/app/' + name]).split()[0]
        if actual != expected:
            raise RuntimeError('Live source changed: ' + name)
    run(['docker', 'tag', current['Image'], 'pi-durable-verify-api:before-' + RELEASE])
    run(['docker', 'build', '-t', IMAGE, str(HERE)])
    smoke = json.loads(run(['docker', 'run', '--rm', '--network', 'none', IMAGE, 'node', '--input-type=module', '-e', SMOKE]))
    (HERE / 'validation.json').write_text(json.dumps(smoke, indent=2) + '\n')
    print(json.dumps({'candidateBuilt': True, 'image': IMAGE, 'validation': smoke}), flush=True)

def ready():
    code = r'''const http=require('node:http');const request=http.get({host:'127.0.0.1',port:3000,path:'/api/info',headers:{authorization:'Basic '+Buffer.from('demo:'+process.env.DEMO_PASSWORD).toString('base64')}},r=>{let s='';r.on('data',x=>s+=x);r.on('end',()=>{if(r.statusCode!==200)process.exit(1);const d=JSON.parse(s);console.log(JSON.stringify({authenticated:true,configured:d.configured,startedAt:d.startedAt}));});});request.on('error',()=>process.exit(1));request.setTimeout(3000,()=>{request.destroy();process.exit(1)});'''
    for _ in range(25):
        try:
            return json.loads(run(['docker', 'exec', API, 'node', '-e', code]))
        except RuntimeError:
            time.sleep(1)
    raise RuntimeError('API did not become ready')

def deploy():
    if not (HERE / 'validation.json').is_file():
        raise RuntimeError('Candidate validation is required')
    current = inspect(API)
    if current['Image'] != CANDIDATE['containers'][API]['imageId']:
        raise RuntimeError('Live API changed since validation')
    base = base_compose()
    # Render in memory only: deployment files must preserve the exact existing credentials and environment.
    rendered = json.loads(run(base + ['config', '--format', 'json']))
    for name, service in [(API, 'api'), (WX, 'wx-bot')]:
        existing = dict(item.split('=', 1) for item in inspect(name)['Config']['Env'])
        configured = rendered['services'][service].get('environment', {})
        mismatches = [key for key, value in configured.items() if value is not None and str(value) != existing.get(key)]
        if mismatches:
            raise RuntimeError('Environment drift; stopped before deployment. Keys: ' + ','.join(mismatches))
    protected = [name for name in CANDIDATE['containers'] if name not in [API, WX]]
    unchanged = {name: identity(name) for name in protected}
    previous = {'api': identity(API), 'wechat': identity(WX), 'protected': unchanged}
    (HERE / 'before.json').write_text(json.dumps(previous, indent=2) + '\n')
    (HERE / 'compose.teams.yaml').write_text('services:\n  api:\n    image: ' + IMAGE + '\n')
    (HERE / 'compose.rollback.yaml').write_text('services:\n  api:\n    image: pi-durable-verify-api:before-' + RELEASE + '\n')
    try:
        run(base + ['-f', str(HERE / 'compose.teams.yaml'), 'up', '-d', '--no-deps', '--force-recreate', 'api', 'wx-bot'])
        health = ready()
        api = inspect(API)
        wx = inspect(WX)
        if api['Image'] != inspect(IMAGE)['Id']:
            raise RuntimeError('Unexpected API image after deployment')
        if wx['HostConfig']['NetworkMode'] != 'container:' + api['Id']:
            raise RuntimeError('WeChat network is not bound to current API')
        if unchanged != {name: identity(name) for name in protected}:
            raise RuntimeError('An out-of-scope container changed')
        for path in ['/', '/api/info']:
            status = run(['curl', '-sS', '--max-time', '15', '-o', '/dev/null', '-w', '%{http_code}', 'https://xiaod.vip.cpolar.cn' + path])
            if status != '401':
                raise RuntimeError('Public authentication did not remain enforced')
        for name, expected in CANDIDATE['hashes'].items():
            if run(['docker', 'exec', API, 'sha256sum', '/app/' + name]).split()[0] != expected:
                raise RuntimeError('Deployed fingerprint mismatch')
        result = {'release': RELEASE, 'api': identity(API), 'wechatNetworkVerified': True, 'apiHealth': health, 'publicAuth': True, 'protectedContainersUnchanged': list(unchanged), 'rollback': str(HERE / 'compose.rollback.yaml'), 'filesVerified': len(CANDIDATE['hashes'])}
        (HERE / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result), flush=True)
    except BaseException:
        run(base + ['-f', str(HERE / 'compose.rollback.yaml'), 'up', '-d', '--no-deps', '--force-recreate', 'api', 'wx-bot'])
        ready()
        print('Deployment failed; original API restored and WeChat network rebound.', flush=True)
        raise

if sys.argv[1:] == ['prepare']:
    prepare()
elif sys.argv[1:] == ['deploy']:
    deploy()
else:
    raise SystemExit('Use prepare or deploy')
