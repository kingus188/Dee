import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDaylightStore } from "../dist/daylight-store.js";

const project = { id: "11111111-1111-4111-8111-111111111111", name: "项目", description: "", color: "mint" as const };
const task = { id: "22222222-2222-4222-8222-222222222222", projectId: project.id, title: "任务", description: "![image](data:image/png;base64,abc)", status: "todo" as const, priority: "high" as const, color: "sky" as const, dueDate: "2028-02-29", tags: ["标签"], checklist: [{ id: "check", title: "检查", done: false }], createdAt: 100, position: -100 };

test("Daylight persists rich content, patches preserve ordering and tombstones cannot resurrect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daylight-"));
  let store = openDaylightStore(dir);
  try {
    store.saveProject(project); store.saveTask(task);
    store.moveTask(task.id, "review", 12.5);
    store.patchTask(task.id, { title: "修改" });
    store.saveTask({ ...task, title: "保存", position: -999 });
    assert.equal(store.getTask(task.id).position, 12.5);
    assert.equal(store.getTask(task.id).description, task.description);
    store.close(); store = openDaylightStore(dir);
    assert.equal(store.getTask(task.id).title, "保存");
    assert.throws(() => store.patchTask(task.id, { dueDate: "2027-02-29" }));
    assert.equal(store.getTask(task.id).dueDate, "2028-02-29");
    store.deleteProject(project.id);
    assert.deepEqual(store.snapshot(), { projects: [], tasks: [] });
    assert.throws(() => store.saveProject(project));
    assert.throws(() => store.saveTask(task));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Daylight replay and legacy import are durable, atomic and do not resurrect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daylight-"));
  let store = openDaylightStore(dir);
  try {
    assert.throws(() => store.replayAction("rollback", () => { store.saveProject(project); throw new Error("failed"); }));
    assert.equal(store.snapshot().projects.length, 0);
    const result = store.replayAction("one", () => { store.saveProject(project); store.saveTask(task); return { id: task.id }; });
    store.deleteTask(task.id);
    store.close(); store = openDaylightStore(dir);
    assert.deepEqual(store.replayAction("one", () => { throw new Error("must not run"); }), result);
    const legacy = [{ text: "long ".repeat(100), done: true }, { text: "重复", done: false }, { text: "重复", done: false }];
    assert.equal(store.importLegacy(7, legacy).tasks, 3);
    const imported = store.snapshot().tasks;
    assert.equal(imported.length, 3);
    assert.equal(imported.find(t => t.status === "done")?.description, legacy[0].text);
    for (const item of imported) store.deleteTask(item.id);
    assert.equal(store.importLegacy(7, legacy).tasks, 0);
    assert.equal(store.snapshot().tasks.length, 0);
    assert.equal(store.importLegacy(8, legacy).tasks, 3);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const version of [1, 2, 3]) test(`Daylight imports source v${version} read-only once, preserving order and deletion`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "daylight-import-"));
  const source = join(dir, "source.sqlite");
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,description TEXT,color TEXT${version >= 2 ? ",deleted_at INTEGER" : ""});
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,description TEXT,status TEXT,priority TEXT,color TEXT,due_date TEXT,tags TEXT,checklist TEXT,created_at INTEGER${version >= 2 ? ",deleted_at INTEGER" : ""}${version === 3 ? ",position REAL" : ""}); PRAGMA user_version=${version}`);
  db.prepare(`INSERT INTO projects VALUES (?,?,?,?${version >= 2 ? ",NULL" : ""})`).run(project.id, project.name, "", project.color);
  const insert = db.prepare(`INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?${version >= 2 ? ",?" : ""}${version === 3 ? ",?" : ""})`);
  insert.run(task.id, project.id, task.title, task.description, task.status, task.priority, task.color, task.dueDate, JSON.stringify(task.tags), JSON.stringify(task.checklist), task.createdAt, ...(version >= 2 ? [null] : []), ...(version === 3 ? [3.5] : []));
  const deletedId = "33333333-3333-4333-8333-333333333333";
  if (version >= 2) insert.run(deletedId, project.id, "已删", "", "done", "low", "rose", null, "[]", "[]", 20, 42, ...(version === 3 ? [7] : []));
  db.close();
  const before = await readFile(source);
  const store = openDaylightStore(dir);
  try {
    assert.deepEqual(store.importSource(source), { projects: 1, tasks: version >= 2 ? 2 : 1 });
    assert.equal(store.getTask(task.id).position, version === 3 ? 3.5 : -100);
    assert.equal(store.snapshot().tasks.length, 1);
    if (version >= 2) assert.throws(() => store.saveTask({ ...task, id: deletedId }));
    store.patchTask(task.id, { title: "本地编辑" });
    assert.deepEqual(store.importSource(source), { projects: 0, tasks: 0 });
    assert.equal(store.getTask(task.id).title, "本地编辑");
    assert.deepEqual(await readFile(source), before);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
