import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { LocalSkillDetail, LocalSkillsBridge, LocalSkillsSnapshot } from "@assistant/contracts";
import type { JSDOM } from "jsdom";
import { LocalSkillsPage } from "../dist/workspace/LocalSkillsPage.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const data = (): LocalSkillsSnapshot => ({ roots: [
  { id: "agents", label: "Agents", path: "/home/test/.agents/skills", exists: true, custom: false },
  { id: "claude", label: "Claude Code", path: "/home/test/.claude/skills", exists: true, custom: false },
], skills: [
  { id: "review", name: "项目复盘", description: "每周整理进展", locations: [{ rootId: "agents", label: "Agents", path: "/shared/review" }, { rootId: "claude", label: "Claude Code", path: "/linked/review" }] },
  { id: "release", name: "发布检查", description: "发布前核对", locations: [{ rootId: "claude", label: "Claude Code", path: "/local/release" }] },
], warnings: [] });
function bridge() {
  let snapshot = data(); const calls: string[] = [];
  const native: LocalSkillsBridge = { version: 1,
    list: async () => { calls.push("list"); return snapshot; },
    read: async id => { calls.push(`read:${id}`); const item = snapshot.skills.find(skill => skill.id === id); if (!item) throw new Error("技能文件已移除"); return { ...item, content: "\uFEFF---\nname: review\ndescription: test\n...\n## 核对证据\n\n<img src=x onerror=alert(1)>", filePath: `/shared/${id}/SKILL.md` } satisfies LocalSkillDetail; },
    reveal: async id => { calls.push(`reveal:${id}`); },
    addDirectory: async () => { calls.push("add"); return snapshot; },
    removeDirectory: async id => { calls.push(`remove:${id}`); return snapshot; },
    importSkill: async () => { calls.push("import"); return { snapshot, skillId: "review" }; },
  };
  return { native, calls, set(value: LocalSkillsSnapshot) { snapshot = value; } };
}
async function click(dom: JSDOM, text: string) {
  const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text);
  assert.ok(button, `Missing button: ${text}`); await act(async () => button.click());
}

test("本机技能按来源浏览，详情按需读取且始终只读", async t => {
  const source = bridge();
  const { dom, render } = await mount(t, <LocalSkillsPage active={false} />);
  dom.window.localSkills = source.native;
  await render(<LocalSkillsPage active />);
  const document = dom.window.document;
  assert.equal(document.querySelectorAll(".workspace-library-item").length, 2);
  assert.deepEqual(source.calls, ["list"]);
  assert.equal(document.querySelector(".markdown-editor,textarea,[contenteditable=true]"), null);
  const search = document.querySelector<HTMLInputElement>('[aria-label="搜索本机技能"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "发布"); search.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  assert.equal(document.querySelectorAll(".workspace-library-item").length, 1);
  await click(dom, document.querySelector(".workspace-library-item")!.textContent!.trim());
  assert.deepEqual(source.calls, ["list", "read:release"]);
  assert.match(document.querySelector('[aria-label="本机技能详情"]')!.textContent!, /核对证据/);
  assert.equal(document.querySelector(".md img, .md script"), null);
  assert.doesNotMatch(document.querySelector(".md")!.textContent!, /description: test/);
  await click(dom, "在文件夹中显示"); assert.equal(source.calls.at(-1), "reveal:release");
  await click(dom, "返回技能列表");
  await render(<LocalSkillsPage active={false} />); await render(<LocalSkillsPage active />);
  assert.equal(document.querySelector<HTMLInputElement>('[aria-label="搜索本机技能"]')!.value, "发布");
});

test("浏览器明确说明本机能力边界，远程历史记录仍可打开", async t => {
  const writes: string[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => { if (body) writes.push(path); return { memory: [], skills: [], knowledge: { enabled: false, allow: [] } }; });
  const { dom } = await mount(t, <LocalSkillsPage active />);
  assert.match(dom.window.document.body.textContent!, /在桌面客户端中管理本机技能/);
  assert.equal(dom.window.document.querySelector(".markdown-editor"), null);
  await click(dom, "查看远程小 D 的技能记录"); assert.match(dom.window.document.body.textContent!, /还没有技能/);
  await click(dom, "新增技能");
  const name = dom.window.document.querySelector<HTMLInputElement>('[placeholder="例如：每周项目复盘"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(name, "尚未保存的记录"); name.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  await click(dom, "返回本机技能"); assert.match(dom.window.document.body.textContent!, /这台电脑的技能/);
  await click(dom, "查看远程小 D 的技能记录");
  assert.equal(dom.window.document.querySelector<HTMLInputElement>('[placeholder="例如：每周项目复盘"]')!.value, "尚未保存的记录");
  assert.deepEqual(writes, []);
});

test("本机目录操作支持取消、导入结果跳转及刷新失败保留列表", async t => {
  const source = bridge();
  const { dom, render } = await mount(t, <LocalSkillsPage active={false} />); dom.window.localSkills = source.native;
  await render(<LocalSkillsPage active />);
  const importer = t.mock.method(source.native, "importSkill", async () => null);
  await click(dom, "导入本地技能"); assert.equal(dom.window.document.querySelector('[aria-label="本机技能详情"]'), null);
  importer.mock.restore(); await click(dom, "导入本地技能");
  assert.ok(dom.window.document.querySelector('[aria-label="本机技能详情"]'));
  await click(dom, "返回技能列表");
  await click(dom, "添加目录"); assert.equal(source.calls.at(-1), "add");
  t.mock.method(source.native, "list", async () => { throw new Error("目录权限已变化"); });
  await click(dom, "刷新");
  assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /目录权限已变化/);
  assert.equal(dom.window.document.querySelectorAll(".workspace-library-item").length, 2);
});

test("切换技能会忽略旧详情响应，目录失败和空目录分别显示", async t => {
  const source = bridge(); let release!: (value: LocalSkillDetail) => void;
  t.mock.method(source.native, "read", (id: string) => id === "review" ? new Promise<LocalSkillDetail>(resolve => { release = resolve; }) : Promise.resolve({ ...data().skills[1]!, content: "最新说明", filePath: "/local/release/SKILL.md" }));
  const { dom, render } = await mount(t, <LocalSkillsPage active={false} />); dom.window.localSkills = source.native; await render(<LocalSkillsPage active />);
  await click(dom, dom.window.document.querySelector(".workspace-library-item")!.textContent!.trim());
  await click(dom, "返回技能列表");
  await click(dom, dom.window.document.querySelectorAll(".workspace-library-item")[1]!.textContent!.trim());
  await act(async () => release({ ...data().skills[0]!, content: "过时结果", filePath: "/old/SKILL.md" }));
  assert.match(dom.window.document.querySelector(".workspace-reading")!.textContent!, /最新说明/);
  assert.doesNotMatch(dom.window.document.querySelector(".workspace-reading")!.textContent!, /过时结果/);
  await click(dom, "返回技能列表"); source.set({ ...data(), skills: [] }); await click(dom, "刷新");
  assert.match(dom.window.document.body.textContent!, /还没有发现本机技能/);
});
