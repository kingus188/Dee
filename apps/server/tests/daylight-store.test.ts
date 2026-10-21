import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDaylightStore } from "../dist/daylight-store.js";
import { openBusinessDatabase } from "../dist/postgres.js";
import type { DaylightPort } from "@assistant/contracts";

const project = { id: "11111111-1111-4111-8111-111111111111", name: "项目", description: "", color: "mint" as const };
const task = { id: "22222222-2222-4222-8222-222222222222", projectId: project.id, title: "任务", description: "![image](data:image/png;base64,abc)", status: "todo" as const, priority: "high" as const, color: "sky" as const, dueDate: "2028-02-29", tags: ["标签"], checklist: [{ id: "check", title: "检查", done: false }], createdAt: 100, position: -100 };

test("Daylight persists rich content, patches preserve ordering and tombstones cannot resurrect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daylight-"));
  let pool = await openBusinessDatabase(process.env.DATABASE_URL!, dir, true);
  let store = await openDaylightStore(pool);
  try {
    await store.saveProject(project); await store.saveTask(task);
    await store.moveTask(task.id, "review", 12.5);
    await store.patchTask(task.id, { title: "修改" });
    await store.saveTask({ ...task, title: "保存", position: -999 });
    assert.equal((await store.getTask(task.id)).position, 12.5);
    assert.equal((await store.getTask(task.id)).description, task.description);
    store = await openDaylightStore(pool);
    assert.equal((await store.getTask(task.id)).title, "保存");
    await assert.rejects(store.patchTask(task.id, { dueDate: "2027-02-29" }));
    assert.equal((await store.getTask(task.id)).dueDate, "2028-02-29");
    await store.deleteProject(project.id);
    assert.deepEqual(await store.snapshot(), { projects: [], tasks: [] });
    await assert.rejects(store.saveProject(project));
    await assert.rejects(store.saveTask(task));
    assert.equal(store.location, "PostgreSQL · Daylight");
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

test("Daylight replay and legacy import are durable, atomic and do not resurrect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daylight-"));
  let pool = await openBusinessDatabase(process.env.DATABASE_URL!, dir, true);
  let store = await openDaylightStore(pool);
  try {
    await assert.rejects(store.replayAction("rollback", async tx => { await tx.saveProject(project); throw new Error("failed"); }));
    assert.equal((await store.snapshot()).projects.length, 0);
    const result = await store.replayAction("one", async tx => { await tx.saveProject(project); await tx.saveTask(task); return { id: task.id }; });
    await store.deleteTask(task.id);
    await pool.end(); pool = await openBusinessDatabase(process.env.DATABASE_URL!, dir, true); store = await openDaylightStore(pool);
    assert.deepEqual(await store.replayAction("one", async () => { throw new Error("must not run"); }), result);
    const legacy = [{ text: "long ".repeat(100), done: true }, { text: "重复", done: false }, { text: "重复", done: false }];
    assert.equal((await store.importLegacy(7, legacy)).tasks, 3);
    const imported = (await store.snapshot()).tasks;
    assert.equal(imported.length, 3);
    assert.equal(imported.find(t => t.status === "done")?.description, legacy[0].text);
    for (const item of imported) await store.deleteTask(item.id);
    assert.equal((await store.importLegacy(7, legacy)).tasks, 0);
    assert.equal((await store.snapshot()).tasks.length, 0);
    assert.equal((await store.importLegacy(8, legacy)).tasks, 3);
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

test("concurrent replay keys execute once and independent patches do not lose fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daylight-concurrent-"));
  const pool = await openBusinessDatabase(process.env.DATABASE_URL!, dir, true);
  const store = await openDaylightStore(pool);
  const other = await openDaylightStore(pool);
  try {
    let calls = 0;
    const action = async (tx: DaylightPort) => {
      calls++;
      await tx.saveProject(project);
      await tx.saveTask(task);
      return { id: task.id, calls };
    };
    const results = await Promise.all([store.replayAction("same", action), other.replayAction("same", action)]);
    assert.deepEqual(results[0], results[1]); assert.equal(calls, 1);
    await Promise.all([store.patchTask(task.id, { title: "new title" }), other.patchTask(task.id, { priority: "low" })]);
    const saved = await store.getTask(task.id);
    assert.equal(saved.title, "new title"); assert.equal(saved.priority, "low");
    await Promise.all([store.deleteProject(project.id), other.saveTask({ ...task, title: "racing save" }).catch(error => { assert.match(error.message, /不存在|删除/); })]);
    assert.deepEqual(await store.snapshot(), { projects: [], tasks: [] });
    await assert.rejects(other.saveProject(project), /删除/);
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

for (const version of [0, 1, 2, 3]) test(`Daylight imports source v${version} read-only once, preserving order and deletion`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "daylight-import-"));
  const source = join(dir, "source.sqlite");
  const db = new DatabaseSync(source);
  const modern = version === 0 || version >= 2, positioned = version === 0 || version === 3;
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,description TEXT,color TEXT${modern ? ",deleted_at INTEGER" : ""});
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,description TEXT,status TEXT,priority TEXT,color TEXT,due_date TEXT,tags TEXT,checklist TEXT,created_at INTEGER${modern ? ",deleted_at INTEGER" : ""}${positioned ? ",position REAL" : ""}); PRAGMA user_version=${version}`);
  db.prepare(`INSERT INTO projects VALUES (?,?,?,?${modern ? ",NULL" : ""})`).run(project.id, project.name, "", project.color);
  const insert = db.prepare(`INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?${modern ? ",?" : ""}${positioned ? ",?" : ""})`);
  insert.run(task.id, project.id, task.title, task.description, task.status, task.priority, task.color, task.dueDate, JSON.stringify(task.tags), JSON.stringify(task.checklist), task.createdAt, ...(modern ? [null] : []), ...(positioned ? [3.5] : []));
  const deletedId = "33333333-3333-4333-8333-333333333333";
  if (modern) insert.run(deletedId, project.id, "已删", "", "done", "low", "rose", null, "[]", "[]", 20, 42, ...(positioned ? [7] : []));
  if (version === 0) {
    db.exec("CREATE TABLE daylight_imports(source TEXT PRIMARY KEY,imported_at INTEGER); CREATE TABLE daylight_actions(key TEXT PRIMARY KEY,result TEXT)");
    db.prepare("INSERT INTO daylight_imports VALUES (?,?)").run("legacy:77", 123);
    db.prepare("INSERT INTO daylight_actions VALUES (?,?)").run("tool:old-call", JSON.stringify({ value: { id: task.id } }));
  }
  db.close();
  const before = await readFile(source);
  const pool = await openBusinessDatabase(process.env.DATABASE_URL!, dir, true);
  const store = await openDaylightStore(pool);
  try {
    assert.deepEqual(await store.importSource(source), { projects: 1, tasks: modern ? 2 : 1 });
    assert.equal((await store.getTask(task.id)).position, positioned ? 3.5 : -100);
    assert.equal((await store.snapshot()).tasks.length, 1);
    if (modern) await assert.rejects(store.saveTask({ ...task, id: deletedId }));
    if (version === 0) {
      assert.deepEqual(await store.replayAction("tool:old-call", async () => { throw new Error("replayed"); }), { id: task.id });
      assert.deepEqual(await store.importLegacy(77, [{ text: "must not duplicate", done: false }]), { projects: 0, tasks: 0 });
    }
    await store.patchTask(task.id, { title: "本地编辑" });
    assert.deepEqual(await store.importSource(source), { projects: 0, tasks: 0 });
    assert.equal((await store.getTask(task.id)).title, "本地编辑");
    assert.deepEqual(await readFile(source), before);
    const changedSource = new DatabaseSync(source);
    changedSource.exec("PRAGMA user_version=99; DROP TABLE tasks");
    changedSource.close();
    assert.deepEqual(await store.importSource(source), { projects: 0, tasks: 0 });
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});
