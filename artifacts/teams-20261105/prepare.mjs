import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const docs = await readFile(join(root, 'docs/DEPLOYMENT.md'), 'utf8');
const host = docs.match(/^ssh ([^\s]+@192\.168\.31\.5)\s*$/m)?.[1];
assert.ok(host);
const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host];
const release = 'teams-20261105-01';
const baselinePaths = ['apps/server/dist/application/index.js', 'apps/server/dist/integrations.js', 'apps/server/dist/teams-auth.js', 'packages/features/dist/teams/index.js'];
const capture = `const fs=require('node:fs');const paths=${JSON.stringify(baselinePaths)};console.log(JSON.stringify(Object.fromEntries(paths.map(p=>[p,fs.readFileSync('/app/'+p).toString('base64')]))));`;
const baseline = JSON.parse(execFileSync('ssh', [...ssh, 'docker exec -i pi-durable-verify-api-1 node'], { input: capture, encoding: 'utf8' }));
const inspection = `import json,subprocess
names=['pi-durable-verify-api-1','pi-durable-verify-wx-bot-1','pi-durable-verify-web-1','pi-durable-verify-postgres-1','pi-durable-public-gateway','pi-durable-verify-https-1']
out={}
for name in names:
 d=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
 out[name]={'id':d['Id'],'imageId':d['Image'],'image':d['Config']['Image'],'startedAt':d['State']['StartedAt'],'composeFiles':d['Config']['Labels'].get('com.docker.compose.project.config_files'),'root':d['Config']['Labels'].get('com.docker.compose.project.working_dir'),'networkMode':d['HostConfig']['NetworkMode']}
print(json.dumps(out))
`;
const containers = JSON.parse(execFileSync('ssh', [...ssh, 'python3 -'], { input: inspection, encoding: 'utf8' }));
const context = join(here, 'context');
const hashes = {}, baseHashes = {};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function overlay(path, bytes) {
  const target = join(context, 'overlay', path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  hashes[path] = hash(bytes);
}
function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length, 2, 'Expected one exact insertion site');
  return text.replace(before, after);
}
for (const [path, encoded] of Object.entries(baseline)) {
  const bytes = Buffer.from(encoded, 'base64');
  await mkdir(dirname(join(here, 'baseline', path)), { recursive: true });
  await writeFile(join(here, 'baseline', path), bytes);
  baseHashes[path] = hash(bytes);
}
let app = Buffer.from(baseline[baselinePaths[0]], 'base64').toString();
app = replaceOnce(app, 'syncStatus: () => teamsSender.syncStatus?.() ?? { lastSuccessAt: null } }), createTeamsReply', 'syncStatus: () => teamsSender.syncStatus?.() ?? { lastSuccessAt: null },\n                    get read() { return config.offline ? undefined : teamsSender.read; } }), createTeamsReply');
await overlay(baselinePaths[0], app);
let integrations = Buffer.from(baseline[baselinePaths[1]], 'base64').toString();
integrations = replaceOnce(integrations, 'import { createTeamsTokenProvider, SEND_SCOPE } from "./teams-auth.js";', 'import { createTeamsTokenProvider, SEND_SCOPE, FILES_SCOPE, CHANNELS_SCOPE } from "./teams-auth.js";\nimport { createTeamsReader } from "./teams-reader.js";');
integrations = replaceOnce(integrations, 'const controller = new AbortController();', 'const getFilesToken = authAccount ? createTeamsTokenProvider(authAccount, FILES_SCOPE) : getToken;\n    const getChannelsToken = authAccount ? createTeamsTokenProvider(authAccount, CHANNELS_SCOPE) : getToken;\n    const controller = new AbortController();');
integrations = replaceOnce(integrations, 'teamsSender.syncStatus = sync.status;', 'teamsSender.syncStatus = sync.status;\n    const read = createTeamsReader({ getToken, getFilesToken, getChannelsToken, signal: controller.signal });\n    teamsSender.read = query => {\n        if (!active) return Promise.reject(new Error("Teams 集成已停止"));\n        return track(read(query));\n    };');
assert.equal((integrations.match(/delete teamsSender\.syncStatus;/g) ?? []).length, 2);
integrations = integrations.replaceAll('delete teamsSender.syncStatus;', 'delete teamsSender.syncStatus;\n        delete teamsSender.read;');
await overlay(baselinePaths[1], integrations);
const auth = Buffer.from(baseline[baselinePaths[2]], 'base64').toString();
assert.ok(!auth.includes('FILES_SCOPE'));
await overlay(baselinePaths[2], auth + '\nexport const FILES_SCOPE = "https://graph.microsoft.com/Files.Read.All offline_access";\nexport const CHANNELS_SCOPE = "https://graph.microsoft.com/Team.ReadBasic.All https://graph.microsoft.com/Channel.ReadBasic.All https://graph.microsoft.com/ChannelMessage.Read.All offline_access";\n');
for (const path of ['apps/server/dist/teams-reader.js', 'apps/server/dist/teams-graph.js', 'apps/server/dist/teams-files.js', 'packages/features/dist/teams/index.js', 'packages/features/dist/teams/history.js']) {
  await overlay(path, await readFile(join(root, path)));
}
await writeFile(join(context, 'Dockerfile'), `FROM pi-durable-verify-api:before-${release}\nCOPY overlay/ /app/\n`);
const candidate = { release, host, containers, baseHashes, hashes, preparedAt: new Date().toISOString(), scope: 'Teams only; application and integration insertion against current live baseline; no schema changes' };
await writeFile(join(here, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n');
await writeFile(join(context, 'manifest.json'), JSON.stringify(hashes, null, 2) + '\n');
await copyFile(join(here, 'deploy.py'), join(context, 'deploy.py'));
await copyFile(join(here, 'candidate.json'), join(context, 'candidate.json'));
execFileSync('/usr/bin/tar', ['--no-xattrs', '--no-acls', '--no-fflags', '-czf', join(here, 'release.tar.gz'), '-C', context, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
console.log(JSON.stringify({ release, files: Object.keys(hashes), liveBaseImage: containers['pi-durable-verify-api-1'].image, archive: join(here, 'release.tar.gz') }, null, 2));
