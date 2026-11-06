import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)), root = fileURLToPath(new URL('../../', import.meta.url));
const previous = JSON.parse(await readFile(join(root, 'artifacts/teams-20261105/candidate.json'), 'utf8'));
const host = previous.host, release = 'teams-archive-20261105-01';
const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host];
const paths = ['apps/server/dist/application/index.js','apps/server/dist/integrations.js','apps/server/dist/teams-store.js','apps/server/dist/teams-sync.js','apps/server/dist/http/router.js'];
const capture = `const fs=require('node:fs');console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(paths)}.map(p=>[p,fs.readFileSync('/app/'+p).toString('base64')]))));`;
const original = JSON.parse(execFileSync('ssh', [...ssh, 'docker exec -i pi-durable-verify-api-1 node'], { input: capture, encoding: 'utf8' }));
const inspect = `import json,subprocess
out={}
for name in ['pi-durable-verify-api-1','pi-durable-verify-web-1','pi-durable-verify-wx-bot-1','pi-durable-verify-postgres-1','pi-durable-public-gateway','pi-durable-verify-https-1']:
 d=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
 out[name]={'id':d['Id'],'imageId':d['Image'],'image':d['Config']['Image'],'startedAt':d['State']['StartedAt'],'composeFiles':d['Config']['Labels'].get('com.docker.compose.project.config_files'),'root':d['Config']['Labels'].get('com.docker.compose.project.working_dir')}
print(json.dumps(out))`;
const containers = JSON.parse(execFileSync('ssh', [...ssh, 'python3 -'], { input: inspect, encoding: 'utf8' }));
const html = execFileSync('ssh', [...ssh, 'docker exec pi-durable-verify-web-1 cat /app/apps/web/dist/index.html'], { encoding: 'utf8' });
const hashes = { api: {}, web: {} }, baseHashes = {};
const hash = value => createHash('sha256').update(value).digest('hex');
async function overlay(group, path, content) {
  const file = join(here, 'context', group, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, content); hashes[group][path] = hash(content);
}
function once(text, a, b) { assert.equal(text.split(a).length, 2, 'Ambiguous patch site: '+a.slice(0,70)); return text.replace(a,b); }
for (const [path, value] of Object.entries(original)) {
  const text = Buffer.from(value, 'base64').toString();
  const file = join(here, 'baseline', path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); baseHashes[path] = hash(text);
}
let app = Buffer.from(original[paths[0]], 'base64').toString();
app = once(app, 'import { openTeamsStore } from "../teams-store.js";', 'import { openTeamsStore } from "../teams-store.js";\nimport { createTeamsReadPort } from "../teams-read-port.js";');
app = once(app, 'get read() { return config.offline ? undefined : teamsSender.read; }', 'read: createTeamsReadPort(teamsStore, teamsSender, config.offline)');
await overlay('api', paths[0], app);
let integrations = Buffer.from(original[paths[1]], 'base64').toString();
integrations = once(integrations, 'import { createTeamsReader } from "./teams-reader.js";', 'import { createTeamsReader } from "./teams-reader.js";\nimport { createTeamsArchiveSync } from "./teams-archive-sync.js";');
integrations = once(integrations, 'const read = createTeamsReader({ getToken, getFilesToken, getChannelsToken, signal: controller.signal });', 'const read = createTeamsReader({ getToken, getFilesToken, getChannelsToken, signal: controller.signal, archive: store.archive });\n    const archiveSync = createTeamsArchiveSync(store.archive, read, controller.signal);');
const localIntegration = await readFile(join(root,'apps/server/dist/integrations.js'),'utf8');
const polling = localIntegration.slice(localIntegration.indexOf('    let archiveTimer;'), localIntegration.indexOf('    let closing;'));
assert.ok(polling.includes('void archivePoll();'));
integrations = once(integrations, '    let closing;', polling+'    let closing;');
integrations = once(integrations, 'clearTimeout(timer);', 'clearTimeout(timer);\n        clearTimeout(archiveTimer);');
await overlay('api', paths[1], integrations);
let store = Buffer.from(original[paths[2]], 'base64').toString();
store = once(store, 'import { DatabaseSync } from "node:sqlite";', 'import { DatabaseSync } from "node:sqlite";\nimport { openTeamsArchive } from "./teams-archive-store.js";');
store = once(store, '    try {\n        db.exec(`PRAGMA', '    let archive;\n    try {\n        db.exec("PRAGMA busy_timeout = 5000");\n        archive = openTeamsArchive(db);\n        db.exec(`PRAGMA');
store = once(store, '\n    return {', '\n    return {\n        archive,');
const rowStart = store.indexOf('const row = '), rowEnd = store.indexOf('\n    });', rowStart);
assert.ok(rowStart>0 && rowEnd>rowStart);
store = store.slice(0,rowEnd)+ '\n        media: archive.mediaRows(String(r.chat_id), String(r.id).slice(String(r.chat_id).length + 1)),'+store.slice(rowEnd);
await overlay('api', paths[2], store);
let sync = Buffer.from(original[paths[3]], 'base64').toString();
const localSync = await readFile(join(root,'apps/server/dist/teams-sync.js'),'utf8');
const functionPart = localSync.slice(localSync.indexOf('export function messageText('), localSync.indexOf('// 查询、提醒'));
assert.ok(functionPart.includes('[截图]'));
sync = sync.slice(0,sync.indexOf('export function messageText('))+functionPart+sync.slice(sync.indexOf('// 查询、提醒'));
await overlay('api', paths[3], sync);
let router = Buffer.from(original[paths[4]], 'base64').toString();
const localRouter = await readFile(join(root,'apps/server/dist/http/router.js'),'utf8');
const mediaRoute = localRouter.slice(localRouter.indexOf('            const media = '),localRouter.indexOf('            const stream = '));
assert.ok(mediaRoute.includes('context.teamsStore.archive.media'));
router = once(router, '            const stream = ', mediaRoute+'            const stream = ');
await overlay('api', paths[4], router);
for (const path of ['apps/server/dist/teams-auth.js','apps/server/dist/teams-reader.js','apps/server/dist/teams-graph.js','apps/server/dist/teams-files.js','apps/server/dist/teams-download.js','apps/server/dist/teams-archive-store.js','apps/server/dist/teams-archive-sync.js','apps/server/dist/teams-media.js','apps/server/dist/teams-read-port.js','packages/features/dist/teams/index.js','packages/features/dist/teams/history.js']) await overlay('api',path,await readFile(join(root,path)));

const enhanced = await build({ entryPoints: [join(here,'enhance.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', minify: true, define:{'process.env.NODE_ENV':'"production"'} });
const code = enhanced.outputFiles[0].text;
// Self-check the exact deployed enhancement against the existing live DOM structure.
const require = createRequire(join(root,'apps/web/package.json'));
const {JSDOM}=require('jsdom');
const enhance = await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const dom=new JSDOM('<section class="chat-turn"><div class="user-row"></div><details class="turn-activities"><div class="turn-activity"><pre></pre></div></details></section>');
const id='a'.repeat(64);dom.window.document.querySelector('pre').textContent='<teams-media>'+JSON.stringify([{id,name:'截图',kind:'image',status:'ready',previewUrl:'/api/teams/media/'+id},{id:'b'.repeat(64),name:'合同.docx',kind:'file',status:'reference',url:'https://tenant.sharepoint.com/contract.docx'}])+'</teams-media>';
const stop=enhance.startTeamsMedia(dom.window.document);
assert.equal(dom.window.document.querySelectorAll('.teams-media-inline img').length,1);
assert.equal(dom.window.document.querySelector('.teams-media-inline img').getAttribute('src'),'/api/teams/media/'+id);
assert.equal(dom.window.document.querySelectorAll('.teams-media-inline a').length,2);stop();dom.window.close();
const asset='assets/teams-media-'+hash(code).slice(0,12)+'.js';
await overlay('web','apps/web/dist/'+asset,code);
await overlay('web','apps/web/dist/index.html',once(html,'</body>',`<script type="module" src="/${asset}"></script>\n</body>`));
await writeFile(join(here,'context','Dockerfile.api'),`FROM pi-durable-verify-api:before-${release}\nCOPY api/ /app/\n`);
await writeFile(join(here,'context','Dockerfile.web'),`FROM pi-durable-verify-web:before-${release}\nCOPY web/ /app/\n`);
const candidate={host,release,containers,baseHashes,hashes,asset,preparedAt:new Date().toISOString(),scope:'Additive Teams archive and attachment display over current live API and Web images'};
await writeFile(join(here,'candidate.json'),JSON.stringify(candidate,null,2)+'\n');
await copyFile(join(here,'candidate.json'),join(here,'context','candidate.json'));
await copyFile(join(here,'deploy.py'),join(here,'context','deploy.py'));
execFileSync('/usr/bin/tar',['--no-xattrs','--no-acls','--no-fflags','-czf',join(here,'release.tar.gz'),'-C',join(here,'context'),'.'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
console.log(JSON.stringify({release,apiFiles:Object.keys(hashes.api).length,webFiles:Object.keys(hashes.web).length,frontendSelfCheck:true,asset},null,2));
