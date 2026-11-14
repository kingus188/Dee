import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

test('backup validates both artifacts and restores only into a new directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dee-backup-test-'));
  try {
    const data = join(root, 'data'), backup = join(root, 'backup'), bin = join(root, 'bin'), restored = join(root, 'restored');
    await mkdir(data); await mkdir(bin);
    const db = new DatabaseSync(join(data, 'agent.sqlite'));
    db.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('retained conversation')"); db.close();
    // Unit fixture only; the separate restore drill uses real pg_dump/pg_restore.
    await writeFile(join(bin, 'pg_dump'), '#!/bin/sh\nwhile [ "$1" != "--file" ]; do shift; done\nshift\nprintf dump > "$1"\n', { mode: 0o700 });
    await writeFile(join(bin, 'pg_restore'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const run = (...args: string[]) => spawnSync(process.execPath, [resolve('scripts/data-backup.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgresql://fixture', PATH: `${bin}:${process.env.PATH}` } });
    assert.notEqual(run('backup', data, backup, '--revision', '1234567').status, 0);
    assert.notEqual(run('backup', data, join(data, 'backup'), '--writers-stopped', '--revision', '1234567').status, 0);
    const first = run('backup', data, backup, '--writers-stopped', '--revision', '1234567');
    assert.equal(first.status, 0, first.stderr);
    const verified = run('verify', backup); assert.equal(verified.status, 0, verified.stderr);
    assert.notEqual(run('backup', data, backup, '--writers-stopped', '--revision', '1234567').status, 0);
    const restoredResult = run('restore-runtime', backup, restored); assert.equal(restoredResult.status, 0, restoredResult.stderr);
    const copy = new DatabaseSync(join(restored, 'agent.sqlite'), { readOnly: true });
    assert.equal(copy.prepare('SELECT value FROM sample').get()?.value, 'retained conversation'); copy.close();
    assert.notEqual(run('restore-runtime', backup, restored).status, 0);
    await writeFile(join(backup, 'business.dump'), 'tampered');
    assert.notEqual(run('verify', backup).status, 0);
    const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
    assert.equal(manifest.revision, '1234567');
    assert.equal(JSON.stringify(manifest).includes('postgresql'), false);
    await symlink(join(root, 'missing'), join(data, 'link'));
    assert.notEqual(run('backup', data, join(root, 'linked'), '--writers-stopped', '--revision', '1234567').status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
