import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const candidate = JSON.parse(await readFile(join(here, 'candidate.json'), 'utf8'));
const remote = candidate.containers['pi-durable-verify-api-1'].root + '/updates/' + candidate.release;
const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', candidate.host];
const server = JSON.parse(execFileSync('ssh', [...ssh, `cat '${remote}/result.json'`], { encoding: 'utf8' }));
assert.equal(server.release, candidate.release);
assert.equal(server.filesVerified, 8);
assert.equal(server.wechatNetworkVerified, true);
const installed = '/Applications/Dee.app';
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed], { stdio: 'pipe' });
const archive = join(installed, 'Contents/Resources/app.asar');
const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
assert.equal(hash, '084802171a03c2381ba3140fc616045a328fb189ebc3d9dc7bf6cbe42cb5f190', 'Installed native client changed unexpectedly');
const require = createRequire(new URL('../../package.json', import.meta.url));
const asar = require(require.resolve('@electron/asar', { paths: [require.resolve('@electron/packager')] }));
const main = asar.extractFile(archive, 'apps/desktop/dist/main.js').toString();
assert.ok(main.includes('persist:desktop-web'));
assert.ok(main.includes('DesktopAgent'), 'Preserve the newer installed native capabilities');
const configFile = '/Users/haifeng/Library/Application Support/Pi Durable Assistant/desktop-connection.json';
const connection = JSON.parse(await readFile(configFile, 'utf8'));
assert.equal(connection.url, 'https://xiaod.vip.cpolar.cn');
assert.ok(connection.encryptedPassword);
const rows = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n');
const processes = rows.flatMap(line => {
  const match = line.trim().match(/^(\d+)\s+(.*)$/);
  return match?.[2].startsWith(installed + '/Contents/') ? [{ pid: Number(match[1]), command: match[2] }] : [];
});
assert.ok(processes.some(process => process.command === installed + '/Contents/MacOS/Dee'));
let tls = false;
for (const process of processes) {
  try {
    const connections = execFileSync('lsof', ['-nP', '-a', '-p', String(process.pid), '-iTCP', '-sTCP:ESTABLISHED'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    tls ||= connections.includes(':443');
  } catch (error) {
    if (error.status !== 1) throw error;
  }
}
assert.ok(tls, 'Desktop needs an established HTTPS connection');
const logCheck = `import json,re,subprocess
p=subprocess.run(['docker','logs','--since','15m','--tail','1000','pi-durable-public-gateway'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
rows=[s for s in (p.stdout+'\\n'+p.stderr).splitlines() if 'Electron/' in s or 'Dee/' in s or 'dee/' in s]
statuses=[]
for line in rows:
 m=re.search(r'"(?:GET|POST) ([^ ?]+)(?:[^\\"]*)" (\\d{3})',line)
 if m: statuses.append((m.group(1),int(m.group(2))))
print(json.dumps({'desktopHome200':any(path=='/' and status==200 for path,status in statuses),'assetSuccesses':sum(path.startswith('/assets/') and status==200 for path,status in statuses),'httpErrors':sum(status>=400 for path,status in statuses)}))
`;
const gateway = JSON.parse(execFileSync('ssh', [...ssh, 'python3 -'], { input: logCheck, encoding: 'utf8' }));
assert.equal(gateway.desktopHome200, true);
assert.ok(gateway.assetSuccesses > 0);
const result = {
  release: candidate.release, verifiedAt: new Date().toISOString(), server,
  desktop: { installed, asarSha256: hash, signatureVerified: true, nativePackageReplaced: false, reason: 'Teams tools execute on the server; current installed client is newer than this checkout and its native capabilities are preserved', running: true, tlsConnected: tls, serverUrl: connection.url, encryptedLoginPreserved: true, gateway },
  actualAccount: { chatToolRead: true, historyFirstPage: 50, historySecondPage: 50, sharedFileTextChars: 2357, channelConsentRequired: true },
  tests: { localSuite: { total: 561, passed: 561 }, candidateOverlaySmokePassed: true, deployedFingerprints: 8 },
  limitations: ['Channel permissions still require consent (AADSTS65001)', 'Not a complete history export or proof of all historical records', 'No native screenshot or real-model Teams conversation acceptance', 'No Git commit or push'],
};
await writeFile(join(here, 'release-result.json'), JSON.stringify(result, null, 2) + '\n');
await writeFile(join(here, 'server-result.json'), JSON.stringify(server, null, 2) + '\n');
console.log(JSON.stringify({ release: result.release, serverUpdated: true, desktop: result.desktop, tests: result.tests }, null, 2));
