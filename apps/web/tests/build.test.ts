import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../dist/", import.meta.url);
test("React 浏览器产物已打包，不依赖 npm 裸导入或内联按钮入口", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const entry = html.match(/<script type="module" src="(\/assets\/app-[A-Z0-9]{8}\.js)"/)?.[1];
  assert.ok(entry, "the browser entry must be content-versioned");
  const bundle = (await Promise.all((await readdir(new URL("assets/", root))).filter(name => /^(app|chunk)-[A-Z0-9]{8}\.js$/.test(name)).map(name => readFile(new URL("assets/" + name, root), "utf8")))).join("\n");
  assert.match(html, /id="root"/);
  assert.match(html, /id="startup"/);
  assert.doesNotMatch(html, /onclick=/);
  assert.doesNotMatch(bundle, /(?:from|import)\s*["'](?:react|react-dom)/);
  assert.match(bundle, /api\/socket/);
  assert.doesNotMatch(bundle, /EventSource/);
  assert.match(bundle, /import\("\.\/chunk-/);
  assert.ok((await readFile(new URL(entry.slice(1), root))).length < 400_000, "the entry must not eagerly include the editor and todo UI");
});

test("workspace stylesheets and current React Lucide icons are packaged", async () => {
  const sprite = await readFile(new URL("assets/icons.svg", root), "utf8");
  for (const name of ["send", "square-check", "chevron-left", "history", "copy", "file-text", "message-circle", "list-todo", "brain", "paperclip", "notebook-pen", "sparkles", "chevron-right", "settings", "plug", "shield-check", "loader-circle", "check", "calendar-days", "more-horizontal", "rotate-ccw"]) assert.ok(sprite.includes(`id="${name}"`), name);
  assert.ok((await readFile(new URL("workspace.css", root))).length > 0);
  assert.ok((await readFile(new URL("today.css", root))).length > 0);
});
