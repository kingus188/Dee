import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDaylightStore } from "../dist/daylight-store.js";
import { openBusinessDatabase } from "../dist/postgres.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
test("failed source import rolls back rows and ledger, allowing corrected import", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daylight-atomic-"));
  const source = join(dir, "source.sqlite");
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,description TEXT,color TEXT,deleted_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,description TEXT,status TEXT,priority TEXT,color TEXT,due_date TEXT,tags TEXT,checklist TEXT,created_at INTEGER,deleted_at INTEGER,position REAL);
    PRAGMA user_version=3`);
  db.prepare("INSERT INTO projects VALUES (?,?, '', 'mint', NULL)").run(projectId, "项目");
  db.prepare("INSERT INTO tasks VALUES (?,?, '任务', '', 'todo','medium','mint',NULL,'invalid','[]',5,NULL,-5)").run(taskId, projectId);
  const pool = await openBusinessDatabase(process.env.DATABASE_URL!, dir, true);
  const store = await openDaylightStore(pool);
  try {
    await assert.rejects(store.importSource(source));
    assert.deepEqual(await store.snapshot(), { projects: [], tasks: [] });
    db.prepare("UPDATE tasks SET tags='[]'").run();
    assert.deepEqual(await store.importSource(source), { projects: 1, tasks: 1 });
    assert.equal((await store.getTask(taskId)).position, -5);
  } finally { await pool.end(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("legacy failed batch and replay result serialization roll back every mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daylight-atomic-"));
  const pool = await openBusinessDatabase(process.env.DATABASE_URL!, dir, true);
  const store = await openDaylightStore(pool);
  try {
    await assert.rejects(store.importLegacy(1, [{ text: "valid", done: false }, { text: "x".repeat(8 * 1024 * 1024 + 1), done: false }]));
    assert.deepEqual(await store.snapshot(), { projects: [], tasks: [] });
    assert.equal((await store.importLegacy(1, [{ text: "valid", done: false }])).tasks, 1);
    await assert.rejects(store.replayAction("serialize", async tx => { await tx.ensureDefaultProject(); return 1n; }));
    assert.equal((await store.snapshot()).projects.length, 1);
    assert.equal(await store.replayAction("serialize", async tx => { await tx.ensureDefaultProject(); return "ok"; }), "ok");
    assert.equal((await store.snapshot()).projects.length, 2);
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

test("differing source collisions reject the entire import without recording its marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daylight-collision-"));
  const source = join(dir, "source.sqlite");
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,description TEXT,color TEXT,deleted_at INTEGER);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,description TEXT,status TEXT,priority TEXT,color TEXT,due_date TEXT,tags TEXT,checklist TEXT,created_at INTEGER,deleted_at INTEGER,position REAL);
    CREATE TABLE daylight_imports(source TEXT PRIMARY KEY,imported_at INTEGER);
    CREATE TABLE daylight_actions(key TEXT PRIMARY KEY,result TEXT);`);
  db.prepare("INSERT INTO projects VALUES (?,?, '', 'mint', NULL)").run(projectId, "源项目");
  db.prepare("INSERT INTO daylight_actions VALUES (?,?)").run("existing", '{"value":"different"}');
  const pool = await openBusinessDatabase(process.env.DATABASE_URL!, dir, true);
  const store = await openDaylightStore(pool);
  try {
    await store.replayAction("existing", async () => "original");
    await assert.rejects(store.importSource(source), /冲突/);
    assert.deepEqual(await store.snapshot(), { projects: [], tasks: [] });
    db.prepare("UPDATE daylight_actions SET result=?").run('{"value":"original"}');
    await store.saveProject({ id: projectId, name: "本地项目", description: "", color: "mint" });
    await assert.rejects(store.importSource(source), /冲突/);
    db.prepare("UPDATE projects SET name='本地项目'").run();
    db.prepare("INSERT INTO daylight_imports VALUES ('legacy:99',55)").run();
    assert.deepEqual(await store.importSource(source), { projects: 0, tasks: 0 });
    assert.deepEqual(await store.importLegacy(99, [{ text: "duplicate", done: false }]), { projects: 0, tasks: 0 });
  } finally { await pool.end(); db.close(); await rm(dir, { recursive: true, force: true }); }
});
