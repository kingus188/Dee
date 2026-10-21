import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { openBusinessDatabase } from "../dist/postgres.js";
import WebSocket from "ws";
import { createDailyReports } from "../dist/daily-reports.js";
import { readConfig } from "../dist/config.js";
import { startServer } from "../dist/lifecycle.js";

function databaseUrl() {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for PostgreSQL integration tests");
  return process.env.DATABASE_URL;
}

async function openReports(dir: string) {
  const pool = await openBusinessDatabase(databaseUrl(), dir, true);
  try { return { pool, store: await createDailyReports(pool) }; }
  catch (error) { await pool.end(); throw error; }
}

test("日报按日期持久化、原文保留、倒序列表，过期版本不能覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reports-"));
  const { pool, store } = await openReports(dir);
  try {
    assert.equal(await store.get("2026-10-01"), null);
    const markdown = "# 今日完成\n\n- 修复问题  \n<script>alert(1)</script>\n";
    const first = await store.save("2026-10-01", { markdown, revision: null });
    assert.equal(first.revision, 1);
    assert.match(first.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const reopened = await openReports(dir);
    try { assert.deepEqual(await reopened.store.get(first.date), first); }
    finally { await reopened.pool.end(); }
    await store.save("2026-10-02", { markdown: "明天", revision: null });
    assert.deepEqual((await store.list()).map(item => item.date), ["2026-10-02", "2026-10-01"]);
    assert.ok((await store.list()).every(item => !Object.hasOwn(item, "markdown")));
    await assert.rejects(store.save(first.date, { markdown: "覆盖", revision: null }), { status: 409 });
    const second = await store.save(first.date, { markdown: "", revision: first.revision });
    assert.equal(second.revision, 2);
    await assert.rejects(store.save(first.date, { markdown: "旧页面", revision: first.revision }), { status: 409 });
    assert.equal((await store.get(first.date))?.markdown, "");
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

test("日报校验日期、长度与版本，不静默改写原文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reports-input-"));
  const { pool, store } = await openReports(dir);
  try {
    for (const date of ["2025-02-29", "2026-02-30", "2026-13-01", "2026-1-01", "../notes", "2026-01-01'", "0000-01-01"]) {
      await assert.rejects(store.get(date), { status: 400 });
      await assert.rejects(store.save(date, { markdown: "日报", revision: null }), { status: 400 });
    }
    for (const input of [{ markdown: 1, revision: null }, { markdown: "x".repeat(16001), revision: null }, { markdown: "text" }, { markdown: "text", revision: -1 }, { markdown: "text", revision: 1.5 }]) {
      await assert.rejects(store.save("2024-02-29", input), { status: 400 });
    }
    assert.equal((await store.save("2024-02-29", { markdown: "中".repeat(16000), revision: null })).markdown.length, 16000);
    await assert.rejects(store.save("2024-02-29", { markdown: "旧版本", revision: Number.MAX_SAFE_INTEGER }), { status: 409 });
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

test("未配置模型时 HTTP/WS 日报可用，鉴权、同源校验与服务重启持久化", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reports-api-"));
  const config = readConfig({ NODE_ENV: "test", DATABASE_URL: databaseUrl(), DATA_DIR: dir, PORT: "0", DEMO_PASSWORD: "report-test-password", PI_OFFLINE: "1", NOTIFY_MODE: "off" });
  let server = await startServer(config, "127.0.0.1");
  let socket: WebSocket | undefined;
  const headers = { Authorization: "Basic " + Buffer.from("demo:report-test-password").toString("base64"), "Content-Type": "application/json" };
  try {
    assert.equal((await fetch(server.origin + "/api/daily-reports")).status, 401);
    const info = await (await fetch(server.origin + "/api/info", { headers })).json() as { configured: boolean };
    assert.equal(info.configured, false);
    const path = "/api/daily-reports/2026-10-14";
    const body = { markdown: "# 日报\n- 无模型也能写", revision: null };
    assert.equal((await fetch(server.origin + path, { method: "POST", headers: { ...headers, Origin: "https://other.example" }, body: JSON.stringify(body) })).status, 403);
    assert.equal((await fetch(server.origin + path, { method: "POST", headers, body: JSON.stringify(body) })).status, 200);
    assert.equal((await fetch(server.origin + path, { method: "POST", headers, body: JSON.stringify(body) })).status, 409);
    socket = new WebSocket(server.origin.replace("http", "ws") + "/api/socket", { headers: { ...headers, Origin: server.origin } });
    await once(socket, "open");
    let response = once(socket, "message");
    socket.send(JSON.stringify({ type: "request", id: "1", method: "GET", path }));
    assert.equal(JSON.parse(String((await response)[0])).data.markdown, body.markdown);
    response = once(socket, "message");
    socket.send(JSON.stringify({ type: "request", id: "2", method: "POST", path, body: { markdown: "## 更新日报", revision: 1 } }));
    assert.equal(JSON.parse(String((await response)[0])).data.revision, 2);
    socket.close(); await once(socket, "close");
    await server.close();
    server = await startServer(config, "127.0.0.1");
    const loaded = await (await fetch(server.origin + path, { headers })).json() as { markdown: string };
    assert.equal(loaded.markdown, "## 更新日报");
    assert.equal((await fetch(server.origin + "/api/daily-reports/2026-02-30", { headers })).status, 400);
  } finally { socket?.terminate(); await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("并发创建与版本更新各只有一个写入成功", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reports-race-"));
  const first = await openReports(dir);
  const second = await openReports(dir);
  try {
    for (const revision of [null, 1] as const) {
      const results = await Promise.allSettled([
        first.store.save("2026-10-01", { markdown: "first", revision }),
        second.store.save("2026-10-01", { markdown: "second", revision }),
      ]);
      const successes = results.filter(result => result.status === "fulfilled");
      const failures = results.filter(result => result.status === "rejected");
      assert.equal(successes.length, 1);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].reason.status, 409);
      assert.deepEqual(await first.store.get("2026-10-01"), successes[0].value);
      assert.equal(successes[0].value.revision, revision === null ? 1 : 2);
    }
  } finally {
    await Promise.all([first.pool.end(), second.pool.end()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("只读导入日报，完整保留内容、版本与时间，独立标记保证并发幂等", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reports-import-"));
  const source = join(dir, "agent.sqlite");
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE daily_reports (date TEXT PRIMARY KEY, markdown TEXT NOT NULL, revision INTEGER NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE chat_messages (body TEXT);
    INSERT INTO chat_messages VALUES ('leave untouched');
    PRAGMA user_version=17`);
  const report = { date: "2026-09-30", markdown: "# 原文\r\n\n- 保留空格  \n<script>hello</script>\n", revision: 7, updatedAt: "2026-09-30T22:13:14.123+08:00" };
  db.prepare("INSERT INTO daily_reports VALUES (?, ?, ?, ?)").run(report.date, report.markdown, report.revision, report.updatedAt);
  const { pool, store } = await openReports(dir);
  try {
    // A Daylight import marker for the same file must not suppress report import.
    await pool.query("CREATE TABLE IF NOT EXISTS daylight_imports (source TEXT PRIMARY KEY, imported_at BIGINT NOT NULL)");
    await pool.query("INSERT INTO daylight_imports VALUES ($1, $2)", [source, Date.now()]);
    const imports = await Promise.all([store.importSource(source), store.importSource(source)]);
    assert.deepEqual(imports.map(result => result.reports).sort(), [0, 1]);
    assert.deepEqual(await store.get(report.date), report);
    await store.save(report.date, { markdown: "编辑后", revision: report.revision });
    assert.deepEqual(await store.importSource(source), { reports: 0 });
    assert.equal((await store.get(report.date))?.markdown, "编辑后");
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 17);
    assert.deepEqual({ ...db.prepare("SELECT * FROM daily_reports").get() }, report);
    assert.equal(db.prepare("SELECT body FROM chat_messages").get()?.body, "leave untouched");
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='daily_report_imports'").get()?.count, 0);
  } finally { db.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

test("没有日报表的 SQLite 来源不创建业务记录或导入标记", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reports-empty-import-"));
  const source = join(dir, "agent.sqlite");
  const db = new DatabaseSync(source);
  db.exec("CREATE TABLE unrelated (value TEXT)");
  const { pool, store } = await openReports(dir);
  try {
    assert.deepEqual(await store.importSource(source), { reports: 0 });
    assert.deepEqual(await store.list(), []);
    assert.equal((await pool.query("SELECT * FROM daily_report_imports")).rowCount, 0);
  } finally { db.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

for (const field of ["markdown", "revision", "updatedAt"] as const) {
  test(`导入遇到不同 ${field} 时回滚所有日报及标记，修正后允许重试`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-reports-rollback-"));
    const source = join(dir, "agent.sqlite");
    const db = new DatabaseSync(source);
    db.exec("CREATE TABLE daily_reports (date TEXT PRIMARY KEY, markdown TEXT NOT NULL, revision INTEGER NOT NULL, updatedAt TEXT NOT NULL)");
    const { pool, store } = await openReports(dir);
    try {
      const existing = await store.save("2026-10-02", { markdown: "已有日报", revision: null });
      const collision = { ...existing, [field]: field === "revision" ? 2 : "different" };
      db.prepare("INSERT INTO daily_reports VALUES (?, ?, ?, ?)").run("2026-10-01", "先导入后回滚", 5, "2026-10-01T01:02:03.004Z");
      db.prepare("INSERT INTO daily_reports VALUES (?, ?, ?, ?)").run(collision.date, collision.markdown, collision.revision, collision.updatedAt);
      await assert.rejects(store.importSource(source), /日报导入冲突/);
      assert.equal(await store.get("2026-10-01"), null);
      assert.deepEqual(await store.get(existing.date), existing);
      assert.equal((await pool.query("SELECT * FROM daily_report_imports")).rowCount, 0);
      db.prepare("UPDATE daily_reports SET markdown=?, revision=?, updatedAt=? WHERE date=?").run(existing.markdown, existing.revision, existing.updatedAt, existing.date);
      assert.deepEqual(await store.importSource(source), { reports: 2 });
      assert.equal((await store.get("2026-10-01"))?.revision, 5);
      assert.deepEqual(await store.get(existing.date), existing);
      assert.equal((await pool.query("SELECT * FROM daily_report_imports")).rowCount, 1);
    } finally { db.close(); await pool.end(); await rm(dir, { recursive: true, force: true }); }
  });
}
