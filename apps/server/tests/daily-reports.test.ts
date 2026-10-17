import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { createDailyReports } from "../dist/daily-reports.js";
import { readConfig } from "../dist/config.js";
import { startServer } from "../dist/lifecycle.js";

test("日报按日期持久化、原文保留、倒序列表，过期版本不能覆盖", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reports-"));
  try {
    const store = createDailyReports(dir);
    assert.equal(store.get("2026-10-01"), null);
    const markdown = "# 今日完成\n\n- 修复问题  \n<script>alert(1)</script>\n";
    const first = store.save("2026-10-01", { markdown, revision: null });
    assert.equal(first.revision, 1);
    assert.equal(createDailyReports(dir).get(first.date)?.markdown, markdown);
    store.save("2026-10-02", { markdown: "明天", revision: null });
    assert.deepEqual(store.list().map(item => item.date), ["2026-10-02", "2026-10-01"]);
    assert.ok(store.list().every(item => !Object.hasOwn(item, "markdown")));
    assert.throws(() => store.save(first.date, { markdown: "覆盖", revision: null }), { status: 409 });
    const second = store.save(first.date, { markdown: "", revision: first.revision });
    assert.equal(second.revision, 2);
    assert.throws(() => store.save(first.date, { markdown: "旧页面", revision: first.revision }), { status: 409 });
    assert.equal(store.get(first.date)?.markdown, "");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("日报校验日期、长度与版本，不静默改写原文", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reports-input-"));
  try {
    const store = createDailyReports(dir);
    for (const date of ["2025-02-29", "2026-02-30", "2026-13-01", "2026-1-01", "../notes", "2026-01-01'", "0000-01-01"]) {
      assert.throws(() => store.get(date), { status: 400 });
      assert.throws(() => store.save(date, { markdown: "日报", revision: null }), { status: 400 });
    }
    for (const input of [{ markdown: 1, revision: null }, { markdown: "x".repeat(16001), revision: null }, { markdown: "text" }, { markdown: "text", revision: -1 }, { markdown: "text", revision: 1.5 }]) {
      assert.throws(() => store.save("2024-02-29", input), { status: 400 });
    }
    assert.equal(store.save("2024-02-29", { markdown: "中".repeat(16000), revision: null }).markdown.length, 16000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("未配置模型时 HTTP/WS 日报可用，鉴权、同源校验与服务重启持久化", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-reports-api-"));
  const config = readConfig({ NODE_ENV: "test", DATA_DIR: dir, PORT: "0", DEMO_PASSWORD: "report-test-password", PI_OFFLINE: "1", NOTIFY_MODE: "off" });
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
