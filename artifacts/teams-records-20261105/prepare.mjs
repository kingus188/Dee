import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,rm} from 'node:fs/promises';
import{execFileSync}from'node:child_process';
import{createHash}from'node:crypto';
import{createRequire}from'node:module';
import{fileURLToPath}from'node:url';
import{dirname,join}from'node:path';
import{build}from'esbuild';

const here=dirname(fileURLToPath(import.meta.url)),root=fileURLToPath(new URL('../../',import.meta.url));
const prior=JSON.parse(await readFile(join(root,'artifacts/teams-archive-20261105/candidate.json'),'utf8'));
const host=prior.host,release='teams-records-20261105-02',ssh=['-o','BatchMode=yes','-o','ConnectTimeout=8',host];
const paths=['apps/server/dist/application/views.js','apps/server/dist/teams-archive-store.js','apps/server/dist/teams-read-port.js','apps/server/dist/teams-reader.js','packages/features/dist/teams/index.js','packages/features/dist/teams/history.js','apps/server/dist/application/index.js','apps/server/dist/teams-store.js'];
await rm(join(here,'context'),{recursive:true,force:true});
const capture=`const fs=require('node:fs');console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(paths)}.map(p=>[p,fs.readFileSync('/app/'+p).toString('base64')]))));`;
const original=JSON.parse(execFileSync('ssh',[...ssh,'docker exec -i pi-durable-verify-api-1 node'],{input:capture,encoding:'utf8'}));
const inspection=`import json,subprocess
out={}
for name in ['pi-durable-verify-api-1','pi-durable-verify-web-1','pi-durable-verify-wx-bot-1','pi-durable-verify-postgres-1','pi-durable-public-gateway','pi-durable-verify-https-1']:
 d=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
 out[name]={'id':d['Id'],'imageId':d['Image'],'image':d['Config']['Image'],'startedAt':d['State']['StartedAt'],'composeFiles':d['Config']['Labels'].get('com.docker.compose.project.config_files'),'root':d['Config']['Labels'].get('com.docker.compose.project.working_dir')}
print(json.dumps(out))`;
const containers=JSON.parse(execFileSync('ssh',[...ssh,'python3 -'],{input:inspection,encoding:'utf8'}));
const hashes={api:{},web:{}},baseHashes={};
const hash=x=>createHash('sha256').update(x).digest('hex');
const once=(text,a,b)=>{assert.equal(text.split(a).length,2,'Ambiguous patch site: '+a.slice(0,70));return text.replace(a,b);};
async function overlay(group,path,bytes){const file=join(here,'context',group,path);await mkdir(dirname(file),{recursive:true});await writeFile(file,bytes);hashes[group][path]=hash(bytes);}
for(const[path,encoded]of Object.entries(original)){const data=Buffer.from(encoded,'base64');await mkdir(dirname(join(here,'baseline',path)),{recursive:true});await writeFile(join(here,'baseline',path),data);baseHashes[path]=hash(data);}
let views=Buffer.from(original[paths[0]],'base64').toString();
assert.ok(views.includes('enrichTeamsRecordView')&&views.includes('redact, teamsStore'));
views=once(views,'entries.flatMap(e => e.toolCalls ?? []).find(call => call.id === message.toolCallId)?.args),','entries.flatMap(e => e.toolCalls ?? []).find(call => call.id === message.toolCallId)?.args, query => teamsStore.list(query)),');
assert.ok(views.includes('app.goal-report'),'Preserve newer live view handling');
await overlay('api',paths[0],views);
for(const path of [...paths.slice(1,6),'apps/server/dist/teams-records.js'])await overlay('api',path,await readFile(join(root,path)));
let app=Buffer.from(original[paths[6]],'base64').toString();
app=once(app,'createTeamsInbox({ list: query => teamsStore.list(query),','createTeamsInbox({ list: query => teamsStore.list(query), records: rows => teamsStore.records(rows),');
await overlay('api',paths[6],app);
let store=Buffer.from(original[paths[7]],'base64').toString();
store='import { teamsRecords } from "./teams-records.js";\n'+store;
const localStore=await readFile(join(root,paths[7]),'utf8');
const method=localStore.slice(localStore.indexOf('        records(rows) {'),localStore.indexOf('        // 重复写入'));
assert.ok(method.includes('teamsRecords(archive, messages)'));
store=once(store,'        archive,','        archive,\n'+method);
await overlay('api',paths[7],store);
const built=await build({entryPoints:[join(here,'enhance.ts')],bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
const code=built.outputFiles[0].text,asset='assets/teams-records-'+hash(code).slice(0,12)+'.js';
const require=createRequire(join(root,'apps/web/package.json')),{JSDOM}=require('jsdom');
const module=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const dom=new JSDOM('<section class="chat-turn"><div class="user-row"></div><details class="turn-activities"><div class="turn-activity"><pre></pre></div></details><div class="assistant-row"><div class="response-card">图片解读</div></div></section>');
const id='a'.repeat(64),a={chatId:'chat',id:'1',chatLabel:'原聊天',sender:'甲',createdAt:'2026-01-01T00:00:00Z',text:'原话一\n保留段落',media:[{id,name:'截图',kind:'image',status:'ready',previewUrl:'/api/teams/media/'+id}]},b={...a,id:'2',sender:'乙',createdAt:'2026-01-02T00:00:00Z',text:'原话二',media:[]};
dom.window.document.querySelector('pre').textContent='<teams-records>'+JSON.stringify([b,a])+'</teams-records>';
const stop=module.startTeamsRecords(dom.window.document),rows=dom.window.document.querySelectorAll('.teams-record');
assert.equal(rows.length,2);assert.equal(rows[0].dataset.teamsMessageId,'1');assert.equal(rows[0].querySelectorAll('img').length,1);assert.equal(rows[1].querySelectorAll('img').length,0);assert.equal(dom.window.document.querySelector('.response-card').hidden,true);
const details=dom.window.document.querySelector('.teams-records-summary');details.open=true;details.dispatchEvent(new dom.window.Event('toggle'));assert.equal(dom.window.document.querySelector('.response-card').hidden,false);stop();dom.window.close();
let html=execFileSync('ssh',[...ssh,'docker exec pi-durable-verify-web-1 cat /app/apps/web/dist/index.html'],{encoding:'utf8'});
const priorScript=html.match(/<script type="module" src="\/assets\/teams-records-[a-f0-9]+\.js"><\/script>/g);assert.equal(priorScript?.length,1);
html=once(html,priorScript[0],`<script type="module" src="/${asset}"></script>`);
const liveCss=execFileSync('ssh',[...ssh,'docker exec pi-durable-verify-web-1 cat /app/apps/web/dist/chat.css'],{encoding:'utf8'});
const sourceCss=await readFile(join(root,'apps/web/public/chat.css'),'utf8');
const styles=sourceCss.match(/\.teams-records-inline \{[\s\S]*?\.response-card\[hidden\] \{ display: none; \}/)?.[0];assert.ok(styles);
assert.ok(liveCss.includes(styles));
await overlay('web','apps/web/dist/index.html',html);await overlay('web','apps/web/dist/'+asset,code);
for(const group of['api','web'])await writeFile(join(here,'context','Dockerfile.'+group),`FROM pi-durable-verify-${group}:before-${release}\nCOPY ${group}/ /app/\n`);
const candidate={host,release,containers,baseHashes,hashes,asset,preparedAt:new Date().toISOString(),scope:'Faithful original messages with per-message media; preserve newer live views and stored conversations'};
await writeFile(join(here,'candidate.json'),JSON.stringify(candidate,null,2)+'\n');await copyFile(join(here,'candidate.json'),join(here,'context','candidate.json'));await copyFile(join(here,'deploy.py'),join(here,'context','deploy.py'));
execFileSync('/usr/bin/tar',['--no-xattrs','--no-acls','--no-fflags','-czf',join(here,'release.tar.gz'),'-C',join(here,'context'),'.'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
console.log(JSON.stringify({release,apiFiles:Object.keys(hashes.api).length,webFiles:Object.keys(hashes.web).length,frontendOrderingAndMediaOwnership:true,oldSummaryCollapsible:true,asset},null,2));
