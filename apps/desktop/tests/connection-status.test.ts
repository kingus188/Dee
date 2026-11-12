import assert from "node:assert/strict";
import test from "node:test";
import { connectionStatusPage } from "../dist/connection-status.js";

test("connection status stays on a packaged local page with local actions", () => {
  const page = new URL(connectionStatusPage("https://assistant.example"));
  assert.equal(page.protocol, "file:");
  assert.match(page.pathname, /connection-status\.html$/);
  assert.equal(page.searchParams.get("origin"), "https://assistant.example");
  assert.match(page.searchParams.get("message")!, /正在使用已保存的连接/);
  assert.equal(page.searchParams.get("title"), "正在连接 Dee");
  const offline = new URL(connectionStatusPage("https://assistant.example", "服务暂时未连接"));
  assert.equal(offline.searchParams.get("title"), "暂时未连接");
  assert.equal(offline.searchParams.get("message"), "服务暂时未连接");
});

test("connection errors are URL encoded and cannot inject markup", () => {
  const page = new URL(connectionStatusPage("http://127.0.0.1:8080", '<img src=x onerror="alert(1)"> & \'error\''));
  assert.equal(page.searchParams.get("message"), '<img src=x onerror="alert(1)"> & \'error\'');
  assert.doesNotMatch(page.href, /<img|javascript:/);
});

test("the status page only uses a validated service origin", () => {
  for (const origin of ["javascript:alert(1)", "https://user:fixture@assistant.example", "http://remote.example", 'https://assistant.example/"onclick="alert(1)']) {
    assert.throws(() => connectionStatusPage(origin, "offline"));
  }
});
