import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { WorkspaceActivities, WorkspaceActivity } from "@assistant/contracts";
import { ActivityPage } from "../dist/today/ActivityPage.js";
import { notificationRevision } from "../dist/today/notificationReads.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const noop = () => {};
function record(id: string, patch: Partial<WorkspaceActivity> = {}): WorkspaceActivity {
  return { id, kind: "reminder", conversationId: 1, conversationTitle: "设计讨论", text: id, status: "scheduled", at: 1_800_000_000_000, createdAt: 1, ...patch };
}
const content = (active: boolean) => <ActivityPage active={active} onConversation={noop} onManage={noop} />;

test("通知版本包含来源身份与变化内容，标题变化不重置阅读状态", () => {
  const first = record("same");
  assert.notEqual(notificationRevision(first), notificationRevision({ ...first, conversationId: 2 }));
  assert.notEqual(notificationRevision(first), notificationRevision({ ...first, kind: "background" }));
  assert.notEqual(notificationRevision(first), notificationRevision({ ...first, status: "done" }));
  assert.notEqual(notificationRevision(first), notificationRevision({ ...first, at: first.at! + 1 }));
  assert.notEqual(notificationRevision(first), notificationRevision({ ...first, result: "新的结果" }));
  assert.equal(notificationRevision(first), notificationRevision({ ...first, conversationTitle: "重命名讨论" }));
});

test("批量已读仅处理当前类型筛选，阅读状态不改变任务状态", async t => {
  const values: WorkspaceActivities = { items: [record("提醒"), record("后台进展", { kind: "background", conversationId: 2, status: "failed" })], total: 10, truncated: true };
  t.mock.method(apiClient, "request", async () => values);
  const view = await mount(t, content(false));
  const document = view.dom.window.document;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await view.render(content(true));
  const select = document.querySelector<HTMLSelectElement>('[aria-label="通知类型"]')!;
  await act(async () => { select.value = "reminder"; select.dispatchEvent(new view.dom.window.Event("change", { bubbles: true })); });
  assert.equal(document.querySelectorAll(".activity-record").length, 1);
  await act(async () => { document.querySelector<HTMLButtonElement>(".inbox-mark-all")!.click(); });
  assert.equal(document.querySelector(".activity-record")!.getAttribute("data-read"), "true");
  assert.match(document.querySelector(".activity-record-state")!.textContent!, /等待提醒/);
  assert.match(document.querySelector(".inbox-title-count")!.textContent!, /1/);
  await act(async () => { select.value = "all"; select.dispatchEvent(new view.dom.window.Event("change", { bubbles: true })); });
  const failed = document.querySelector<HTMLElement>('[data-status="failed"]')!;
  assert.equal(failed.dataset.read, "false");
  assert.match(document.querySelector(".activity-truncation")!.textContent!, /2 \/ 10/);
  assert.equal(JSON.parse(view.dom.window.localStorage.getItem("assistant.notification-reads.v1")!).length, 1);
});

test("通知刷新后状态变更重新未读，另一来源的相同id保持独立", async t => {
  const original = record("相同id");
  let values: WorkspaceActivities = { items: [original, { ...original, conversationId: 2 }], total: 2, truncated: false };
  t.mock.method(apiClient, "request", async () => values);
  const view = await mount(t, content(false));
  const document = view.dom.window.document;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  view.dom.window.localStorage.setItem("assistant.notification-reads.v1", JSON.stringify([notificationRevision(original)]));
  // 阅读 hook 在挂载时初始化；storage 事件模拟另一个页面写入。
  await act(async () => { view.dom.window.dispatchEvent(new view.dom.window.StorageEvent("storage", { key: null })); });
  await view.render(content(true));
  assert.equal(document.querySelectorAll('[data-read="true"]').length, 1);
  values = { ...values, items: [{ ...original, status: "failed", result: "需要重新处理" }, values.items[1]] };
  await act(async () => { document.querySelector<HTMLButtonElement>(".activity-refresh-button")!.click(); });
  assert.equal(document.querySelectorAll('[data-read="false"]').length, 2);
  assert.match(document.querySelector(".inbox-section h2")!.textContent!, /需要关注/);
});

test("存储写入失败保留当前页已读并明确显示持久化限制", async t => {
  t.mock.method(apiClient, "request", async () => ({ items: [record("本地阅读")], total: 1, truncated: false }));
  const view = await mount(t, content(false));
  const document = view.dom.window.document;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  t.mock.method(view.dom.window.Storage.prototype, "setItem", () => { throw new Error("Storage unavailable"); });
  await view.render(content(true));
  await act(async () => { document.querySelector<HTMLButtonElement>(".inbox-read-button")!.click(); });
  assert.equal(document.querySelector(".activity-record")!.getAttribute("data-read"), "true");
  assert.match(document.querySelector(".activity-page-footnote")!.textContent!, /仅在当前页面保留/);
  await act(async () => { document.querySelector<HTMLButtonElement>(".inbox-read-button")!.click(); });
  assert.equal(document.querySelector(".activity-record")!.getAttribute("data-read"), "false");
});


test("通知默认收起高级筛选，收起后仍显示选中条件且可清除", async t => {
  t.mock.method(apiClient, "request", async () => ({ items: [record("提醒"), record("后台结果", { kind: "background", status: "done", result: "完整结果" })], total: 2, truncated: false }));
  const view = await mount(t, content(false));
  const document = view.dom.window.document;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await view.render(content(true));
  const details = document.querySelector<HTMLDetailsElement>(".inbox-filter-disclosure")!;
  assert.equal(details.open, false);
  assert.equal(document.querySelector(".inbox-overview"), null);
  const select = details.querySelector<HTMLSelectElement>('[aria-label="通知类型"]')!;
  await act(async () => { details.open = true; select.value = "background"; select.dispatchEvent(new view.dom.window.Event("change", { bubbles: true })); });
  details.open = false;
  assert.match(details.querySelector("summary")!.textContent!, /后台任务/);
  assert.equal(document.querySelectorAll(".activity-record").length, 1);
  assert.match(document.querySelector("#inbox-results")!.textContent!, /结果与已结束/);
  assert.match(document.querySelector(".activity-record-result")!.textContent!, /完整结果/);
  await act(async () => { document.querySelector<HTMLButtonElement>(".inbox-reset")!.click(); });
  assert.equal(document.querySelectorAll(".activity-record").length, 2);
  assert.equal(document.querySelector(".inbox-active-filter"), null);
});

test("通知来源、管理与设置入口保留，状态筛选收起后仍可见", async t => {
  t.mock.method(apiClient, "request", async () => ({ items: [record("失败提醒", { status: "failed", result: "连接中断" }), record("正常提醒")], total: 2, truncated: false }));
  const conversations: number[] = [];
  const managed: number[] = [];
  let settings = 0;
  const render = (active: boolean) => <ActivityPage active={active} onConversation={id => conversations.push(id)} onManage={id => managed.push(id)} onSettings={() => { settings++; }} />;
  const view = await mount(t, render(false));
  const document = view.dom.window.document;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await view.render(render(true));
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>(".activity-filter")].find(button => button.textContent?.includes("执行失败"))!.click(); });
  assert.match(document.querySelector(".inbox-filter-disclosure > summary")!.textContent!, /执行失败/);
  assert.equal(document.querySelectorAll(".activity-record").length, 1);
  assert.match(document.querySelector(".activity-record-result")!.textContent!, /连接中断/);
  await act(async () => {
    document.querySelector<HTMLButtonElement>(".activity-source-button")!.click();
    document.querySelector<HTMLButtonElement>(".activity-record-actions button")!.click();
    document.querySelector<HTMLButtonElement>('[aria-label="通知投递设置"]')!.click();
  });
  assert.deepEqual(conversations, [1]);
  assert.deepEqual(managed, [1]);
  assert.equal(settings, 1);
  assert.equal(document.querySelector(".activity-record")!.getAttribute("data-read"), "true");
});

test("通知从真实个人数据展示待批准候选，只导航不批准，错误仍显示", async t => {
  const pending = { status: "pending", source: "agent", createdAt: 1, decidedAt: null };
  let broken = false;
  const paths: string[] = [];
  t.mock.method(apiClient, "request", async (path: string) => {
    paths.push(path);
    if (path === "/api/personal") {
      if (broken) throw new Error("审批数据暂不可用");
      return { memory: [{ ...pending, id: "memory", text: "先说结论" }], skills: [{ ...pending, id: "skill", name: "代码审查", description: "审查代码", body: "逐项检查" }], knowledge: { enabled: false, allow: [] } };
    }
    return { items: [], total: 0, truncated: false };
  });
  const groups: string[] = [];
  const render = (active: boolean) => <ActivityPage active={active} onConversation={noop} onManage={noop} onGroup={group => groups.push(group)} />;
  const view = await mount(t, render(false));
  const document = view.dom.window.document;
  assert.equal(paths.includes("/api/personal"), false);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await view.render(render(true));
  assert.match(document.querySelector(".inbox-approvals")!.textContent!, /先说结论.*代码审查/);
  await act(async () => { document.querySelectorAll<HTMLButtonElement>(".inbox-approval-link").forEach(button => button.click()); });
  assert.deepEqual(groups, ["memory", "skills"]);
  assert.ok(paths.every(path => ["/api/personal", "/api/workspace/activities", "/api/notifications/reads"].includes(path)));
  broken = true;
  await act(async () => { document.querySelector<HTMLButtonElement>(".activity-refresh-button")!.click(); });
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /审批数据暂不可用/);
  assert.equal(document.querySelectorAll(".inbox-approval-link").length, 2);
});
