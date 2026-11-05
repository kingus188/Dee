import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent
C=json.loads((HERE/'candidate.json').read_text())
R=C['release']
API='pi-durable-verify-api-1'
WEB='pi-durable-verify-web-1'
WX='pi-durable-verify-wx-bot-1'

def run(args,data=None):
    p=subprocess.run(args,input=data,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if p.returncode: raise RuntimeError('Command failed: '+' '.join(args[:3])+'; private diagnostics suppressed')
    return p.stdout.strip()

def inspect(name): return json.loads(run(['docker','inspect',name]))[0]
def identity(name):
    d=inspect(name)
    return {'id':d['Id'],'imageId':d['Image'],'startedAt':d['State']['StartedAt']}
def compose():
    args=['docker','compose','-p','pi-durable-verify']
    for name in C['containers'][API]['composeFiles'].split(','): args+=['-f',name]
    return args
def fingerprint(group):
    for path,expected in C['hashes'][group].items():
        if hashlib.sha256((HERE/group/path).read_bytes()).hexdigest()!=expected: raise RuntimeError('Candidate fingerprint mismatch')

SMOKE=r'''
import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {openTeamsArchive} from '/app/apps/server/dist/teams-archive-store.js';
import {createTeamsInbox} from '/app/packages/features/dist/index.js';
import {createTeamsReadPort} from '/app/apps/server/dist/teams-read-port.js';
await import('/app/apps/server/dist/application/index.js');await import('/app/apps/server/dist/http/router.js');
await import('/app/apps/server/dist/integrations.js');
const db=new DatabaseSync(':memory:');const archive=openTeamsArchive(db);
archive.bindAccount('self-check');archive.save('chat',[{id:'old',createdDateTime:'2020-01-01T00:00:00Z',body:{content:'full text'},attachments:[{id:'file',name:'file.docx',contentUrl:'https://tenant.sharepoint.com/file.docx'}]}]);
const read=createTeamsReadPort({archive},{},true);assert.equal((await read({kind:'archive'})).data.items.length,1);
await assert.rejects(read({kind:'chats'}));
const ext=createTeamsInbox({list:()=>[],read});for(const name of ['teams_archive','teams_archive_status','teams_media_read','teams_history'])assert.ok(ext.tools.some(t=>t.name===name));
console.log(JSON.stringify({archive:true,offline:true,tools:ext.tools.map(t=>t.name)}));db.close();
'''

def prepare():
    for group,name in [('api',API),('web',WEB)]:
        fingerprint(group)
        if inspect(name)['Image']!=C['containers'][name]['imageId']: raise RuntimeError('Live baseline changed')
        run(['docker','tag',C['containers'][name]['imageId'],f'pi-durable-verify-{group}:before-{R}'])
        run(['docker','build','-f',str(HERE/f'Dockerfile.{group}'),'-t',f'pi-durable-verify-{group}:{R}',str(HERE)])
    for path,expected in C['baseHashes'].items():
        if run(['docker','exec',API,'sha256sum','/app/'+path]).split()[0]!=expected: raise RuntimeError('Live source drift')
    smoke=json.loads(run(['docker','run','--rm','--network','none',f'pi-durable-verify-api:{R}','node','--input-type=module','-e',SMOKE]))
    web=r'''import assert from 'node:assert/strict';import fs from 'node:fs';import {startWebServer} from '/app/.build/scripts/web-server.js';const web=await startWebServer({port:0,apiOrigin:'http://127.0.0.1:1'});try{const text=await(await fetch(web.origin)).text();const asset=text.match(/src="(\/assets\/teams-media-[a-f0-9]+\.js)"/)?.[1];assert.ok(asset);const r=await fetch(web.origin+asset);assert.equal(r.status,200);assert.ok((await r.text()).includes('teams-media'));console.log(JSON.stringify({asset,served:true}));}finally{await web.close();}'''
    static=json.loads(run(['docker','run','--rm','--network','none',f'pi-durable-verify-web:{R}','node','--input-type=module','-e',web]))
    (HERE/'validation.json').write_text(json.dumps({'api':smoke,'web':static},indent=2)+'\n')
    print(json.dumps({'candidateReady':True,'validation':smoke,'web':static}),flush=True)

def health():
    code=r'''(async()=>{const r=await fetch('http://127.0.0.1:3000/api/info',{headers:{authorization:'Basic '+Buffer.from('demo:'+process.env.DEMO_PASSWORD).toString('base64')},signal:AbortSignal.timeout(4000)});if(!r.ok)process.exit(1);const d=await r.json();console.log(JSON.stringify({authenticated:true,configured:d.configured,startedAt:d.startedAt}));})().catch(()=>process.exit(1));'''
    for _ in range(25):
        try: return json.loads(run(['docker','exec',API,'node','-e',code]))
        except RuntimeError: time.sleep(1)
    raise RuntimeError('New API not ready')

def deploy():
    if not (HERE/'validation.json').exists(): raise RuntimeError('Candidate validation required')
    for name in [API,WEB]:
        if inspect(name)['Image']!=C['containers'][name]['imageId']: raise RuntimeError('Deployment baseline changed')
    base=compose()
    rendered=json.loads(run(base+['config','--format','json']))
    for name,service in [(API,'api'),(WEB,'web'),(WX,'wx-bot')]:
        existing=dict(x.split('=',1) for x in inspect(name)['Config']['Env'])
        bad=[k for k,v in rendered['services'][service].get('environment',{}).items() if v is not None and existing.get(k)!=str(v)]
        if bad: raise RuntimeError('Environment drift: '+','.join(bad))
    protected=[n for n in C['containers'] if n not in [API,WEB,WX]]
    before={n:identity(n) for n in protected}
    # SQLite online backup stays private on the server; never export it into release artifacts.
    backup=r'''const fs=require('node:fs'),path=require('node:path');const {DatabaseSync,backup}=require('node:sqlite');(async()=>{const dir=path.join(process.env.DATA_DIR||'/data','teams-backups');fs.mkdirSync(dir,{recursive:true,mode:0o700});const target=path.join(dir,'teams-archive-20261105-01.sqlite');if(fs.existsSync(target))throw Error('backup already exists');const db=new DatabaseSync(path.join(process.env.DATA_DIR||'/data','agent.sqlite'));try{await backup(db,target);fs.chmodSync(target,0o600);console.log(JSON.stringify({backupCreated:true,path:target,mode:'600'}));}finally{db.close();}})().catch(()=>{console.log('Private backup failed');process.exitCode=1;});'''
    saved=json.loads(run(['docker','exec',API,'node','-e',backup]))
    (HERE/'before.json').write_text(json.dumps({'containers':{n:identity(n) for n in C['containers']},'backup':saved},indent=2)+'\n')
    override=HERE/'compose.archive.yaml';rollback=HERE/'compose.rollback.yaml'
    override.write_text(f'services:\n  api:\n    image: pi-durable-verify-api:{R}\n  web:\n    image: pi-durable-verify-web:{R}\n')
    rollback.write_text(f'services:\n  api:\n    image: pi-durable-verify-api:before-{R}\n  web:\n    image: pi-durable-verify-web:before-{R}\n')
    try:
        run(base+['-f',str(override),'up','-d','--no-deps','--force-recreate','api','wx-bot','web'])
        ready=health()
        if inspect(WX)['HostConfig']['NetworkMode']!='container:'+inspect(API)['Id']: raise RuntimeError('WeChat network mismatch')
        for group,name in [('api',API),('web',WEB)]:
            for path,expected in C['hashes'][group].items():
                if run(['docker','exec',name,'sha256sum','/app/'+path]).split()[0]!=expected: raise RuntimeError('Deployed fingerprint mismatch')
        if before!={n:identity(n) for n in protected}: raise RuntimeError('Protected service changed')
        # Nginx keeps upstream addresses for the old Web container; reload the existing configuration only.
        run(['docker','exec','pi-durable-public-gateway','nginx','-t'])
        run(['docker','exec','pi-durable-public-gateway','nginx','-s','reload'])
        for path in ['/','/api/info','/api/teams/media/'+'0'*64]:
            status=run(['curl','-sS','--max-time','15','-o','/dev/null','-w','%{http_code}','https://xiaod.vip.cpolar.cn'+path])
            if status!='401': raise RuntimeError('Public authentication changed')
        result={'release':R,'api':identity(API),'web':identity(WEB),'health':ready,'wechatNetworkVerified':True,'protectedContainersUnchanged':list(before),'publicAuth':True,'databaseBackup':saved,'rollback':str(rollback),'asset':C['asset']}
        (HERE/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
    except BaseException:
        run(base+['-f',str(rollback),'up','-d','--no-deps','--force-recreate','api','wx-bot','web']);health()
        run(['docker','exec','pi-durable-public-gateway','nginx','-s','reload'])
        print('Previous services restored; additive archive data retained.',flush=True)
        raise

if sys.argv[1:]==['prepare']: prepare()
elif sys.argv[1:]==['deploy']: deploy()
else: raise SystemExit('Use prepare or deploy')
