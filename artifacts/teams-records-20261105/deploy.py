import hashlib,json,subprocess,sys,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
C=json.loads((HERE/'candidate.json').read_text());R=C['release']
API='pi-durable-verify-api-1';WEB='pi-durable-verify-web-1';WX='pi-durable-verify-wx-bot-1'
def run(args,data=None):
 p=subprocess.run(args,input=data,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if p.returncode:raise RuntimeError('Command failed: '+' '.join(args[:3])+'; private diagnostics suppressed')
 return p.stdout.strip()
def inspect(name):return json.loads(run(['docker','inspect',name]))[0]
def identity(name):
 d=inspect(name);return {'id':d['Id'],'imageId':d['Image'],'startedAt':d['State']['StartedAt']}
def compose():
 result=['docker','compose','-p','pi-durable-verify']
 for path in C['containers'][API]['composeFiles'].split(','):result+=['-f',path]
 return result
SMOKE=r'''
import assert from 'node:assert/strict';import{DatabaseSync}from'node:sqlite';
import{openTeamsArchive}from'/app/apps/server/dist/teams-archive-store.js';import{teamsRecords,enrichTeamsRecordView}from'/app/apps/server/dist/teams-records.js';
import{createTeamsReadPort}from'/app/apps/server/dist/teams-read-port.js';import{createTeamsInbox,teamsPreviewParts}from'/app/packages/features/dist/index.js';
await import('/app/apps/server/dist/application/views.js');await import('/app/apps/server/dist/application/index.js');
const db=new DatabaseSync(':memory:'),archive=openTeamsArchive(db),message={id:'one',createdDateTime:'2026-01-01T00:00:00Z',from:{user:{displayName:'sender'}},body:{content:'literal source'}};
archive.chats([{id:'chat',topic:'chat'}]);archive.save('chat',[message]);
const port=createTeamsReadPort({archive},{},true),ext=createTeamsInbox({list:()=>[],read:port});
const result=await ext.tools.find(t=>t.name==='teams_archive').execute({chatId:'chat'});
assert.match(result.output[0].text,/<teams-records>/);assert.doesNotMatch(result.output[0].text,/<teams-media>/);
const old='notice\n'+JSON.stringify({items:[message]});assert.match(enrichTeamsRecordView(archive,'teams_history',old,{chatId:'chat'}),/<teams-records>/);
assert.equal((await port({kind:'archive'})).records[0].text,'literal source');db.close();console.log(JSON.stringify({faithfulRecords:true,oldViewEnrichment:true,offline:true}));
const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {openTeamsStore}=await import('/app/apps/server/dist/teams-store.js');const dir=mkdtempSync(join(tmpdir(),'teams-preview-smoke-'));const store=openTeamsStore(dir);
try{store.record({id:'chat:one',chatId:'chat',chatType:'oneOnOne',senderId:'peer',senderName:'sender',direction:'in',text:'literal source',createdAt:message.createdDateTime,important:false});store.archive.save('chat',[message]);const inbox=createTeamsInbox({list:q=>store.list(q),records:rows=>store.records(rows)});assert.match((await inbox.tools[0].execute({})).output[0].text,/<teams-records>/);const row=store.list({limit:1})[0],parts=teamsPreviewParts(row);assert.match(enrichTeamsRecordView(store.archive,'teams_messages',parts.prefix+'old-flags'+parts.suffix,{},()=>[row]),/<teams-records>/);console.log(JSON.stringify({legacyPreviewTool:true,legacyPreviewView:true}));}finally{store.close();rmSync(dir,{recursive:true,force:true});}
'''
def prepare():
 for group,name in [('api',API),('web',WEB)]:
  if inspect(name)['Image']!=C['containers'][name]['imageId']:raise RuntimeError('Baseline changed')
  for path,expected in C['hashes'][group].items():
   if hashlib.sha256((HERE/group/path).read_bytes()).hexdigest()!=expected:raise RuntimeError('Candidate fingerprint mismatch')
  run(['docker','tag',C['containers'][name]['imageId'],f'pi-durable-verify-{group}:before-{R}'])
  run(['docker','build','-f',str(HERE/f'Dockerfile.{group}'),'-t',f'pi-durable-verify-{group}:{R}',str(HERE)])
 for path,expected in C['baseHashes'].items():
  if run(['docker','exec',API,'sha256sum','/app/'+path]).split()[0]!=expected:raise RuntimeError('Live source changed')
 check=[json.loads(line)for line in run(['docker','run','--rm','--network','none',f'pi-durable-verify-api:{R}','node','--input-type=module','-e',SMOKE]).splitlines() if line.startswith('{')]
 web=r'''import assert from 'node:assert/strict';import{startWebServer}from'/app/.build/scripts/web-server.js';const w=await startWebServer({port:0,apiOrigin:'http://127.0.0.1:1'});try{const html=await(await fetch(w.origin)).text();const path=html.match(/src="(\/assets\/teams-records-[a-f0-9]+\.js)"/)?.[1];assert.ok(path);assert.equal((await fetch(w.origin+path)).status,200);assert.ok((await(await fetch(w.origin+'/chat.css')).text()).includes('.teams-records-inline'));console.log(JSON.stringify({recordsScript:true,styles:true}));}finally{await w.close();}'''
 static=json.loads(run(['docker','run','--rm','--network','none',f'pi-durable-verify-web:{R}','node','--input-type=module','-e',web]))
 (HERE/'validation.json').write_text(json.dumps({'api':check,'web':static},indent=2)+'\n');print(json.dumps({'candidateReady':True,'api':check,'web':static}),flush=True)
def ready():
 code=r'''(async()=>{const r=await fetch('http://127.0.0.1:3000/api/info',{headers:{authorization:'Basic '+Buffer.from('demo:'+process.env.DEMO_PASSWORD).toString('base64')},signal:AbortSignal.timeout(4000)});if(!r.ok)process.exit(1);const d=await r.json();console.log(JSON.stringify({authenticated:true,configured:d.configured,startedAt:d.startedAt}));})().catch(()=>process.exit(1));'''
 for _ in range(25):
  try:return json.loads(run(['docker','exec',API,'node','-e',code]))
  except RuntimeError:time.sleep(1)
 raise RuntimeError('API not ready')
def deploy():
 if not(HERE/'validation.json').exists():raise RuntimeError('Validation required')
 for name in[API,WEB]:
  if inspect(name)['Image']!=C['containers'][name]['imageId']:raise RuntimeError('Baseline changed')
 base=compose();rendered=json.loads(run(base+['config','--format','json']))
 for name,service in[(API,'api'),(WEB,'web'),(WX,'wx-bot')]:
  old=dict(x.split('=',1)for x in inspect(name)['Config']['Env']);bad=[k for k,v in rendered['services'][service].get('environment',{}).items()if v is not None and old.get(k)!=str(v)]
  if bad:raise RuntimeError('Environment drift: '+','.join(bad))
 protected=[n for n in C['containers']if n not in[API,WEB,WX]];before={n:identity(n)for n in protected}
 (HERE/'before.json').write_text(json.dumps({n:identity(n)for n in C['containers']},indent=2)+'\n')
 update=HERE/'compose.records.yaml';rollback=HERE/'compose.rollback.yaml'
 update.write_text(f'services:\n  api:\n    image: pi-durable-verify-api:{R}\n  web:\n    image: pi-durable-verify-web:{R}\n')
 rollback.write_text(f'services:\n  api:\n    image: pi-durable-verify-api:before-{R}\n  web:\n    image: pi-durable-verify-web:before-{R}\n')
 try:
  run(base+['-f',str(update),'up','-d','--no-deps','--force-recreate','api','wx-bot','web']);health=ready()
  if inspect(WX)['HostConfig']['NetworkMode']!='container:'+inspect(API)['Id']:raise RuntimeError('WeChat network mismatch')
  for group,name in[('api',API),('web',WEB)]:
   for path,expected in C['hashes'][group].items():
    if run(['docker','exec',name,'sha256sum','/app/'+path]).split()[0]!=expected:raise RuntimeError('Deployed fingerprint mismatch')
  if before!={n:identity(n)for n in protected}:raise RuntimeError('Protected service changed')
  run(['docker','exec','pi-durable-public-gateway','nginx','-t']);run(['docker','exec','pi-durable-public-gateway','nginx','-s','reload'])
  for path in['/','/api/info']:
   if run(['curl','-sS','--max-time','15','-o','/dev/null','-w','%{http_code}','https://xiaod.vip.cpolar.cn'+path])!='401':raise RuntimeError('Public authentication changed')
  result={'release':R,'api':identity(API),'web':identity(WEB),'health':health,'databaseSchemaChanged':False,'storedConversationEntriesRewritten':False,'protectedContainersUnchanged':protected,'wechatNetworkVerified':True,'publicAuth':True,'rollback':str(rollback)}
  (HERE/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
 except BaseException:
  run(base+['-f',str(rollback),'up','-d','--no-deps','--force-recreate','api','wx-bot','web']);ready();run(['docker','exec','pi-durable-public-gateway','nginx','-s','reload']);print('Previous services restored; stored records retained.',flush=True);raise
if sys.argv[1:]==['prepare']:prepare()
elif sys.argv[1:]==['deploy']:deploy()
else:raise SystemExit('Use prepare or deploy')
