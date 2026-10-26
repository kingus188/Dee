import assert from "node:assert/strict";
import test from "node:test";
import { connectionStatusPage } from "../dist/connection-status.js";

const html = (origin: string, error?: string) => decodeURIComponent(connectionStatusPage(origin, error).split(",").slice(1).join(","));

test("connection status is a script-free main-window page, not a credential form", () => {
  const page = html("https://assistant.example");
  assert.match(page, /正在使用已保存的连接/);
  assert.match(page, /default-src 'none'/);
  assert.doesNotMatch(page, /<script|<form|<input|重新连接/);
  const offline = html("https://assistant.example", "服务暂时未连接");
  assert.match(offline, /href="https:\/\/assistant.example"/);
  assert.match(offline, /重新连接/);
  assert.match(offline, /手动打开/);
});

test("connection errors are escaped rather than rendered as markup", () => {
  const page = html("http://127.0.0.1:8080", '<img src=x onerror="alert(1)"> & \'error\'');
  assert.match(page, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; &#39;error&#39;/);
  assert.doesNotMatch(page, /<img/);
});

test("the status page only links to a validated service origin without embedded credentials", () => {
  for (const origin of ["javascript:alert(1)", "https://user:fixture@assistant.example", "http://remote.example", 'https://assistant.example/"onclick="alert(1)']) {
    assert.throws(() => connectionStatusPage(origin, "offline"));
  }
});
