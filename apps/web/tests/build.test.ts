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
  for (const name of ["arrow-up", "plus", "square-check", "chevron-left", "search", "message-circle-more", "copy", "file-text", "message-circle", "list-todo", "brain", "notebook-pen", "sparkles", "chevron-right", "settings", "sliders-horizontal", "plug", "shield-check", "loader-circle", "check", "calendar-days", "more-horizontal", "rotate-ccw", "users-round"]) assert.ok(sprite.includes(`id="${name}"`), name);
  assert.ok((await readFile(new URL("prototype.css", root))).length > 0);
  assert.ok((await readFile(new URL("workspace.css", root))).length > 0);
  assert.ok((await readFile(new URL("today.css", root))).length > 0);
  assert.ok((await readFile(new URL("teams-conversations.css", root))).length > 0);
  assert.match(await readFile(new URL("index.html", root), "utf8"), /href="\/teams-conversations\.css"/);
});

test("打包后跨页面字号受同一偏好控制，组件尺寸不缩放外框或原生按钮空间", async () => {
  for (const name of ["workspace", "chat", "prototype", "daylight", "notes", "daily-reports", "teams-conversations", "editor"]) {
    const css = await readFile(new URL(name + ".css", root), "utf8");
    assert.match(css, /font-size:\s*calc\([^;]+var\(--ui-font-scale, 1\)/, name);
    assert.doesNotMatch(css, /font-size:\s*\d+(?:\.\d+)?px/, name);
  }
  const css = await readFile(new URL("workspace.css", root), "utf8");
  assert.doesNotMatch(css, /zoom\s*:/);
  assert.doesNotMatch(css, /100dvh \/ var\(--ui-scale/);
  const prototype = await readFile(new URL("prototype.css", root), "utf8");
  assert.match(prototype, /\[data-desktop="darwin"\] \.conversation-history \{ padding-top: var\(--header-height\); \}/);
  assert.match(prototype, /padding: calc\(18px \* var\(--ui-component-scale, 1\)\)/);
  assert.doesNotMatch(prototype, /var\(--ui-scale/);
});

test("打包资源包含侧栏各个真实状态的图标", async () => {
  const sprite = await readFile(new URL("assets/icons.svg", root), "utf8");
  for (const name of ["loader-circle", "circle-pause", "circle-check", "circle-alert", "circle-slash", "panel-left-close"]) {
    assert.ok(sprite.includes(`id="${name}"`), `Missing sidebar icon: ${name}`);
  }
});
