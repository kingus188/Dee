import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createContext, SourceTextModule } from "node:vm";

const root = new URL("../dist/", import.meta.url);
async function scripts(dir: URL): Promise<URL[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? scripts(new URL(e.name + "/", dir)) : e.name.endsWith(".js") ? [new URL(e.name, dir)] : []))).flat();
}

test("浏览器 ESM 模块可链接，所有内联按钮仍可访问实际入口", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  assert.match(html, /<script type="module" src="\/app\.js"/);
  const window: Record<string, unknown> = { addEventListener() {} };
  const context = createContext({ window, document: { getElementById: () => null, addEventListener() {} } });
  const modules = new Map<string, SourceTextModule>();
  async function load(url: URL): Promise<SourceTextModule> {
    if (modules.has(url.href)) return modules.get(url.href)!;
    assert.ok(url.href.startsWith(root.href), "浏览器模块不能加载服务端代码");
    const module = new SourceTextModule(await readFile(url, "utf8"), { context, identifier: url.href });
    modules.set(url.href, module);
    await module.link((specifier, parent) => {
      assert.ok(specifier.startsWith("."), "原生浏览器不能解析 npm 包入口");
      return load(new URL(specifier, parent.identifier));
    });
    return module;
  }
  const main = await load(new URL("main.js", root));
  await main.evaluate({ timeout: 1000 });
  const code = (await Promise.all((await scripts(root)).map(p => readFile(p, "utf8")))).join("\n");
  for (const match of (html + code).matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)) {
    assert.equal(typeof window[match[1]], "function", "缺少按钮入口 " + match[1]);
  }
  assert.equal(typeof window.showToast, "function");
});
