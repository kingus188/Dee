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
  await act(async () => { document.querySelector<HTMLButtonElement>(".inbox-overview button")!.click(); });
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
