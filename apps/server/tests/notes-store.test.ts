import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openBusinessDatabase } from "../dist/postgres.js";
import { createNotesStore } from "../dist/notes-store.js";
import { readConfig } from "../dist/config.js";
import { startServer } from "../dist/lifecycle.js";

const databaseUrl = () => { assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required"); return process.env.DATABASE_URL; };

test("个人笔记真实落 PostgreSQL，重连保留，版本比较拒绝覆盖并传递写入失败", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notes-store-"));
  const pool = await openBusinessDatabase(databaseUrl(), dir, true);
  try {
    const store = await createNotesStore(pool);
    const initial = await store.get();
    const text = "# 笔记\n中文 ' SQL ; <script> 不改写\n";
    const first = await store.edit(null, text, initial);
    assert.equal(first.revision, 1);
    assert.deepEqual((await pool.query("SELECT memos FROM personal_notes")).rows[0].memos, [text]);
    const pool2 = await openBusinessDatabase(databaseUrl(), dir, true);
    try {
      const reopened = await createNotesStore(pool2);
      assert.deepEqual(await reopened.get(), first);
      const results = await Promise.allSettled([store.edit(0, "甲", first), reopened.edit(0, "乙", first)]);
      assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
      await assert.rejects(store.edit(0, "旧页面", first), { status: 409 });
      await assert.rejects(store.edit(0, "x".repeat(16001), await store.get()), { status: 400 });
      await assert.rejects(store.edit(0, "invalid", {}), { status: 400 });
    } finally { await pool2.end(); }
    await pool.query("ALTER TABLE personal_notes RENAME TO notes_unavailable");
    await assert.rejects(store.edit(0, "不能假成功", { revision: 2 }));
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

test("旧笔记导入原子且幂等，不覆盖已有笔记，失败不留下导入标记", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notes-migration-"));
  const pool = await openBusinessDatabase(databaseUrl(), dir, true);
  try {
    const store = await createNotesStore(pool);
    await store.edit(null, "新库原文", await store.get());
    const source = { source: '[3,"2026-11-13T00:00:00Z"]', memos: ["旧文一", "旧文二"] };
    await assert.rejects(store.importLegacy([source, { source: "bad", memos: [42 as unknown as string] }]), /历史笔记格式不合法/);
    assert.deepEqual((await store.get()).memos, ["新库原文"]);
    assert.equal((await pool.query("SELECT * FROM personal_note_imports")).rowCount, 0);
    await Promise.all([store.importLegacy([source]), store.importLegacy([source])]);
    assert.deepEqual((await store.get()).memos, ["新库原文", "旧文一", "旧文二"]);
    const edited = await store.edit(0, "已编辑", await store.get());
    await store.importLegacy([source]);
    assert.deepEqual(await store.get(), edited);
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

test("个人笔记 HTTP 鉴权、导出、旧会话迁移和删除运行时目录后重部署保留", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "notes-redeploy-"));
  const config = readConfig({ NODE_ENV: "test", DATABASE_URL: databaseUrl(), DATA_DIR: dir, PORT: "0", DEMO_PASSWORD: "notes-test-only", PI_OFFLINE: "1", NOTIFY_MODE: "off" });
  const headers = { Authorization: "Basic " + Buffer.from("demo:notes-test-only").toString("base64"), "Content-Type": "application/json" };
  let server = await startServer(config, "127.0.0.1");
  const get = (path: string) => fetch(server.origin + path, { headers });
  const post = (path: string, body: unknown) => fetch(server.origin + path, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(server.origin + "/api/notes")).status, 401);
    assert.equal((await fetch(server.origin + "/api/notes", { method: "POST", headers: { ...headers, Origin: "https://wrong.example" }, body: "{}" })).status, 403);
    const conversation = await (await post("/api/conversations/direct", {})).json() as { id: number };
    const oldNotes = { todos: [], memos: ["# 部署前的旧笔记"] };
    assert.equal((await post(`/api/conversations/${conversation.id}/notes`, { notes: oldNotes, base: { todos: [], memos: [] } })).status, 200);
    await server.close(); server = await startServer(config, "127.0.0.1");
    const migrated = await (await get("/api/notes")).json() as { revision: number; memos: string[] };
    assert.deepEqual(migrated.memos, oldNotes.memos);
    const notes = { todos: [], memos: ["# 编辑后的笔记", "# 新笔记\n" + "中".repeat(15000)] };
    assert.equal((await post("/api/notes", { index: 0, text: notes.memos[0], base: migrated })).status, 200);
    const updated = await (await get("/api/notes")).json();
    assert.equal((await post("/api/notes", { index: null, text: notes.memos[1], base: updated })).status, 200);
    assert.equal((await post("/api/notes", { index: 0, text: "旧页面", base: migrated })).status, 409);
    const exported = await get("/api/notes/export.md");
    assert.match(exported.headers.get("content-disposition")!, /notes.md/);
    assert.equal(await exported.text(), notes.memos.join("\n\n---\n\n"));
    await server.close();
    // Simulates replacing the ephemeral runtime filesystem while retaining PostgreSQL.
    await rm(dir, { recursive: true, force: true });
    server = await startServer(config, "127.0.0.1");
    assert.deepEqual(((await (await get("/api/notes")).json()) as { memos: string[] }).memos, notes.memos);
    assert.deepEqual(await (await get("/api/conversations")).json(), []);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});


test("历史超限笔记不阻止迁移，超额笔记库仍可逐篇修改且不截断其它正文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notes-large-"));
  const pool = await openBusinessDatabase(databaseUrl(), dir, true);
  try {
    const store = await createNotesStore(pool);
    const large = "长".repeat(16001);
    await store.importLegacy([{ source: "old-a", memos: Array(1001).fill(large) }]);
    const imported = await store.get();
    assert.equal(imported.memos.length, 1001);
    const edited = await store.edit(0, "缩短第一篇", { revision: imported.revision });
    assert.equal(edited.memos[0], "缩短第一篇");
    assert.equal(edited.memos[1000], large);
    await assert.rejects(store.edit(null, "new", edited), { status: 400 });
    await assert.rejects(store.edit(1, "旧版本", imported), { status: 409 });
    await assert.rejects(store.edit(1002, "无效", edited), { status: 400 });
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});
