#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// Backups intentionally contain private runtime data. Never print their contents.
async function files(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error('Backup does not support symlinks or special files');
  }
  return result.sort();
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function integrity(path) {
  // Read-only WAL access can still change shared-memory sidecars. Check a disposable
  // copy so verification never mutates a backup or its manifest checksums.
  const temporary = await mkdtemp(resolve(tmpdir(), 'dee-integrity-'));
  try {
    const copy = resolve(temporary, 'agent.sqlite');
    await cp(path, copy);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { await cp(`${path}${suffix}`, `${copy}${suffix}`); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const rows = db.prepare('PRAGMA integrity_check').all();
      if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new Error('SQLite integrity check failed');
    } finally { db.close(); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
function databaseEnvironment(databaseUrl) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) };
  const options = { sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY', connect_timeout: 'PGCONNECT_TIMEOUT', application_name: 'PGAPPNAME' };
  for (const [key, value] of url.searchParams) {
    if (!options[key]) throw new Error('Unsupported DATABASE_URL option; use standard libpq connection options');
    env[options[key]] = value;
  }
  return env;
}
function command(name, args, env = process.env) {
  const result = spawnSync(name, args, { env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 300_000 });
  if (result.error || result.status !== 0) throw new Error(`${name} failed; check installed tools, database access and free space (no credentials logged)`);
}
export async function createBackup({ dataDir, destination, writersStopped, revision, databaseUrl = process.env.DATABASE_URL }) {
  if (!writersStopped) throw new Error('Stop all SQLite and PostgreSQL writers, then pass --writers-stopped');
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!revision || !/^[a-f0-9]{7,40}$/.test(revision)) throw new Error('Supply the deployed Git revision with --revision');
  const source = resolve(dataDir), target = resolve(destination);
  const within = relative(source, target);
  if (!within || (!within.startsWith(`..${sep}`) && within !== '..' && !within.startsWith(sep))) throw new Error('Backup destination must be outside DATA_DIR');
  if (!(await lstat(source)).isDirectory()) throw new Error('DATA_DIR must be a real directory');
  await files(source); // Fail before copying unsafe entries.
  if (!(await lstat(resolve(source, 'agent.sqlite'))).isFile()) throw new Error('Missing agent.sqlite');
  await mkdir(target, { mode: 0o700 }); // Never overwrite an existing backup.
  await cp(source, resolve(target, 'runtime'), { recursive: true, errorOnExist: true, force: false });
  await integrity(resolve(target, 'runtime/agent.sqlite'));
  command('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', resolve(target, 'business.dump')], databaseEnvironment(databaseUrl));
  command('pg_restore', ['--list', resolve(target, 'business.dump')]);
  const entries = [];
  for (const name of await files(target)) entries.push({ path: name, sha256: await digest(resolve(target, name)) });
  await writeFile(resolve(target, 'manifest.json'), JSON.stringify({ format: 1, revision, createdAt: new Date().toISOString(), writersStopped: true, files: entries }, null, 2), { flag: 'wx', mode: 0o600 });
  return { revision, files: entries.length };
}
export async function verifyBackup(directory) {
  const root = resolve(directory);
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid backup manifest');
  const actual = (await files(root)).filter(name => name !== 'manifest.json');
  const expected = manifest.files.map(entry => entry.path);
  if (new Set(expected).size !== expected.length || JSON.stringify([...expected].sort()) !== JSON.stringify(actual)) throw new Error('Backup file list differs from manifest');
  if (!expected.includes('runtime/agent.sqlite') || !expected.includes('business.dump')) throw new Error('Backup must include both databases');
  for (const entry of manifest.files) {
    if (typeof entry.sha256 !== 'string' || await digest(resolve(root, entry.path)) !== entry.sha256) throw new Error('Backup checksum mismatch');
  }
  await integrity(resolve(root, 'runtime/agent.sqlite'));
  command('pg_restore', ['--list', resolve(root, 'business.dump')]);
  return { revision: manifest.revision, files: expected.length };
}
export async function restoreRuntime(directory, destination) {
  await verifyBackup(directory);
  const target = resolve(destination);
  await mkdir(target, { mode: 0o700 }); // Require a new directory, never overwrite live data.
  for (const entry of await readdir(resolve(directory, 'runtime'))) {
    await cp(resolve(directory, 'runtime', entry), resolve(target, entry), { recursive: true, force: false, errorOnExist: true });
  }
  await integrity(resolve(target, 'agent.sqlite'));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const [action, directory, target, ...flags] = process.argv.slice(2);
  try {
    if (action === 'verify' && directory && !target) console.log(await verifyBackup(directory));
    else if (action === 'restore-runtime' && directory && target && !flags.length) { await restoreRuntime(directory, target); console.log('Runtime restored to new directory; restore PostgreSQL separately before starting Dee'); }
    else if (action === 'backup' && directory && target) {
      const revisionAt = flags.indexOf('--revision');
      console.log(await createBackup({ dataDir: directory, destination: target, writersStopped: flags.includes('--writers-stopped'), revision: revisionAt >= 0 ? flags[revisionAt + 1] : undefined }));
    } else throw new Error('Usage: data-backup.mjs backup DATA_DIR NEW_BACKUP --writers-stopped --revision SHA | verify BACKUP | restore-runtime BACKUP NEW_DATA_DIR');
  } catch (error) { console.error(error instanceof Error ? error.message : 'Backup operation failed'); process.exitCode = 1; }
}
