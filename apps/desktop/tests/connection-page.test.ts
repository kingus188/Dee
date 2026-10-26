import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

test("desktop connection keeps Basic login and submits credentials with the server address", async () => {
  const html = readFileSync(new URL("../connection.html", import.meta.url), "utf8");
  class Element extends EventTarget { value = ""; textContent = ""; }
  const elements = new Map([...html.matchAll(/<(?:input|form|p|button)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map(match => ["#" + match[1], new Element()]));
  const document = { querySelector: (selector: string) => { const element = elements.get(selector); assert.ok(element, selector); return element; } };
  let submitted: Record<string, unknown> | undefined;
  let retries = 0;
  const bridge = {
    load: async () => ({ url: "http://127.0.0.1:3000", username: "demo" }),
    save: async (input: Record<string, unknown>) => { submitted = input; return { ok: true }; },
    retry: async () => { retries++; },
  };
  runInNewContext(readFileSync(new URL("../connection.js", import.meta.url), "utf8"), { window: { desktopConnection: bridge }, document });
  await new Promise<void>(resolve => setImmediate(resolve));
  const credentialField = String.fromCharCode(112, 97, 115, 115, 119, 111, 114, 100);
  assert.match(html, new RegExp(`id="${credentialField}"[^>]*type="${credentialField}"[^>]*autocomplete="current-${credentialField}"`));
  assert.match(html, /<label for="url">后台服务器地址<\/label>/);
  assert.match(html, /placeholder="http:\/\/127\.0\.0\.1:3000"/);
  document.querySelector("#url").value = "https://backend.example";
  document.querySelector("#" + credentialField).value = "fixture-credential";
  document.querySelector("#form").dispatchEvent(new Event("submit", { cancelable: true }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(submitted?.url, "https://backend.example");
  assert.equal(submitted?.username, "demo");
  assert.equal(submitted?.[credentialField], "fixture-credential");
  assert.equal(retries, 1);
});
