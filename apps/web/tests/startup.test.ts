import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test("startup has visible content before the app, offers retry on script failure, and releases listeners after mount", async t => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://assistant.example" });
  t.after(() => dom.window.close());
  const { document, Event } = dom.window;
  const shell = document.getElementById("startup")!;
  assert.match(shell.textContent!, /正在打开/);
  assert.equal(document.querySelector('link[rel="stylesheet"]'), null, "external CSS must not block the loading frame");
  const style = document.querySelector('link[as="style"]')!;
  style.dispatchEvent(new Event("load"));
  assert.equal(style.getAttribute("rel"), "stylesheet");
  const retry = document.getElementById("startup-retry") as HTMLButtonElement;
  assert.equal(retry.hidden, true);
  const script = document.querySelector('script[type="module"]')!;
  script.dispatchEvent(new Event("error"));
  assert.equal(retry.hidden, false);
  assert.match(shell.textContent!, /检查网络/);
  document.getElementById("root")!.replaceChildren(document.createElement("main"));
  await new Promise(resolve => setImmediate(resolve));
  dom.window.dispatchEvent(new Event("unhandledrejection"));
  assert.equal(document.getElementById("startup"), null);
});
