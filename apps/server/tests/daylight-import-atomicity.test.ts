import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDaylightStore } from "../dist/daylight-store.js";

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
  const store = openDaylightStore(dir);
  try {
    assert.throws(() => store.importSource(source));
    assert.deepEqual(store.snapshot(), { projects: [], tasks: [] });
    db.prepare("UPDATE tasks SET tags='[]'").run();
    assert.deepEqual(store.importSource(source), { projects: 1, tasks: 1 });
    assert.equal(store.getTask(taskId).position, -5);
  } finally { store.close(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("legacy failed batch and replay result serialization roll back every mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daylight-atomic-"));
  const store = openDaylightStore(dir);
  try {
    assert.throws(() => store.importLegacy(1, [{ text: "valid", done: false }, { text: "x".repeat(8 * 1024 * 1024 + 1), done: false }]));
    assert.deepEqual(store.snapshot(), { projects: [], tasks: [] });
    assert.equal(store.importLegacy(1, [{ text: "valid", done: false }]).tasks, 1);
    assert.throws(() => store.replayAction("serialize", () => { store.ensureDefaultProject(); return 1n; }));
    assert.equal(store.snapshot().projects.length, 1);
    assert.equal(store.replayAction("serialize", () => { store.ensureDefaultProject(); return "ok"; }), "ok");
    assert.equal(store.snapshot().projects.length, 2);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
