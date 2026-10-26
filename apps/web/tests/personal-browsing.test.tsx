import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { JSDOM } from "jsdom";
import type { SkillItem } from "@assistant/contracts";
import { PersonalPage } from "../dist/workspace/PersonalPage.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

function skill(id: string, status: SkillItem["status"] = "approved"): SkillItem {
  return { id, status, name: id === "review" ? "项目复盘" : "发布检查", description: id === "review" ? "每周整理项目进展时使用" : "发布前逐项核对", body: "## 操作步骤\n\n先核对证据，再整理结果。", source: status === "pending" ? "agent" : "user", createdAt: 1, decidedAt: status === "pending" ? null : 1 };
}
const data = (skills: SkillItem[]) => ({ memory: [], skills, knowledge: { enabled: false, allow: [] } });
async function click(dom: JSDOM, text: string) {
  const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === text);
  assert.ok(button, `Missing button: ${text}`);
  await act(async () => button.click());
}
async function markdown(dom: JSDOM, text: string) {
  await click(dom, "Markdown 源码");
  const input = dom.window.document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("技能空页先浏览，主动新增才进入编辑，切页保留草稿且取消有放弃保护", async t => {
  const writes: string[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => { if (body) writes.push(path); return data([]); });
  const { dom, render } = await mount(t, <PersonalPage kind="skills" active />);
  const document = dom.window.document;
  assert.match(document.body.textContent!, /还没有技能/);
  assert.equal(document.querySelector(".markdown-editor"), null);
  assert.equal(document.querySelector("input"), null);
  await click(dom, "新增技能");
  assert.ok(document.querySelector('[aria-label="技能编辑"]'));
  await markdown(dom, "准备好证据再发布");
  await render(<PersonalPage kind="skills" active={false} />);
  await render(<PersonalPage kind="skills" active />);
  assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")!.value, "准备好证据再发布");
  const confirm = t.mock.method(dom.window, "confirm", () => false);
  await click(dom, "取消编辑");
  assert.ok(document.querySelector(".markdown-editor"));
  confirm.mock.mockImplementation(() => true);
  await click(dom, "取消编辑");
  assert.equal(document.querySelector(".markdown-editor"), null);
  assert.deepEqual(writes, []);
});

test("技能条目先展示只读详情，编辑冲突保留草稿与原记录 base", async t => {
  const original = skill("review");
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: Record<string, unknown>) => {
    if (!body) return data([original]);
    writes.push({ path, body }); throw new Error("技能已被其他页面更新");
  });
  const { dom } = await mount(t, <PersonalPage kind="skills" active />);
  const document = dom.window.document;
  assert.equal(document.querySelector(".markdown-editor"), null);
  await act(async () => document.querySelector<HTMLButtonElement>(".workspace-library-item")!.click());
  assert.ok(document.querySelector('[aria-label="技能详情"]'));
  assert.match(document.querySelector(".workspace-reading :is(h1, h2, h3, h4, h5, h6)")!.textContent!, /操作步骤/);
  assert.equal(document.querySelector(".markdown-editor"), null);
  await click(dom, "编辑技能");
  await markdown(dom, "## 新步骤\n\n待核对的草稿");
  await click(dom, "保存技能");
  assert.equal(writes[0].path, "/api/personal/skills/review/edit");
  assert.deepEqual(writes[0].body.base, original);
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /其他页面更新/);
  assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")!.value, "## 新步骤\n\n待核对的草稿");
});

test("技能库支持状态与搜索，候选在只读详情批准后生效，撤回后只读", async t => {
  const approved = skill("release"), proposed = skill("review", "pending");
  let values = [approved, proposed];
  const writes: string[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    if (!body) return data(values);
    writes.push(path);
    const item = { ...proposed, status: (path.endsWith("/approve") ? "approved" : "rejected") as SkillItem["status"], decidedAt: 2 };
    values = values.map(value => value.id === item.id ? item : value); return { item };
  });
  const { dom } = await mount(t, <PersonalPage kind="skills" active />);
  const document = dom.window.document;
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".workspace-status-filters button")].find(button => button.textContent?.startsWith("待确认"))!.click());
  assert.equal(document.querySelectorAll(".workspace-library-item").length, 1);
  await act(async () => document.querySelector<HTMLButtonElement>(".workspace-library-item")!.click());
  assert.match(document.body.textContent!, /确认后才会生效/);
  assert.equal(document.querySelector(".markdown-editor"), null);
  await click(dom, "批准技能");
  assert.deepEqual(writes, ["/api/personal/skills/review/approve"]);
  assert.equal(document.querySelector('.workspace-content-status[data-status="approved"]')!.textContent, "已生效");
  await click(dom, "撤回技能");
  assert.equal(document.querySelector('[aria-label="技能编辑"]'), null);
  assert.equal([...document.querySelectorAll("button")].some(button => button.textContent?.trim() === "编辑技能"), false);
  await click(dom, "全部技能");
  await click(dom, "清除筛选");
  const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "发布前");
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(document.querySelectorAll(".workspace-library-item").length, 1);
  assert.match(document.querySelector(".workspace-library-item")!.textContent!, /发布检查/);
});
