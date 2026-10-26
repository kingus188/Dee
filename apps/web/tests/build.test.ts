import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../dist/", import.meta.url);
test("React 浏览器产物已打包，不依赖 npm 裸导入或内联按钮入口", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const bundle = await readFile(new URL("app.js", root), "utf8");
  assert.match(html, /id="root"/);
  assert.match(html, /<script type="module" src="\/app\.js"/);
  assert.doesNotMatch(html, /onclick=/);
  assert.doesNotMatch(bundle, /(?:from|import)\s*["'](?:react|react-dom)/);
  assert.match(bundle, /api\/socket/);
  assert.doesNotMatch(bundle, /EventSource/);
});

test("workspace stylesheets and current React Lucide icons are packaged", async () => {
  const sprite = await readFile(new URL("assets/icons.svg", root), "utf8");
  for (const name of ["send", "copy", "file-text", "message-circle", "list-todo", "brain", "paperclip", "notebook-pen", "sparkles", "chevron-right", "settings", "plug", "shield-check", "loader-circle", "check", "calendar-days", "more-horizontal", "rotate-ccw"]) assert.ok(sprite.includes(`id="${name}"`), name);
  assert.ok((await readFile(new URL("workspace.css", root))).length > 0);
  assert.ok((await readFile(new URL("today.css", root))).length > 0);
});
