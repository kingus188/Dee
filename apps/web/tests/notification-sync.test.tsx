import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { WorkspaceActivity } from "@assistant/contracts";
import { useNotificationReads, notificationRevision } from "../dist/today/notificationReads.js";
import { NotificationSettings } from "../dist/settings/NotificationSettings.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const item: WorkspaceActivity = { id: "cross-device", kind: "reminder", conversationId: 1, conversationTitle: "通知", text: "提醒", status: "scheduled", at: 1800000000000, createdAt: 1 };
function Probe({ active = true }: { active?: boolean }) {
  const reads = useNotificationReads(active);
  return <><button onClick={() => reads.mark([item], !reads.isRead(item))}>{reads.isRead(item) ? "已读" : "未读"}</button><p role="status">{reads.error}</p></>;
}

test("阅读同步仅在页面激活且可见时运行，停用后不响应轮询或焦点", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let requests = 0;
  t.mock.method(apiClient, "request", async () => { requests++; return { keys: [] }; });
  const view = await mount(t, <Probe active={false} />), document = view.dom.window.document;
  assert.equal(requests, 0);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await view.render(<Probe active />);
  assert.equal(requests, 1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => { document.dispatchEvent(new view.dom.window.Event("visibilitychange")); t.mock.timers.tick(30000); });
  assert.equal(requests, 1);
  await view.render(<Probe active={false} />);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => { view.dom.window.dispatchEvent(new view.dom.window.Event("focus")); document.dispatchEvent(new view.dom.window.Event("visibilitychange")); t.mock.timers.tick(30000); });
  assert.equal(requests, 1);
  await view.render(<Probe active />);
  assert.equal(requests, 2);
});

test("重新激活立即同步且旧生命周期阅读回包不覆盖新状态", async t => {
  let requests = 0, finish!: (value: { keys: string[] }) => void;
  t.mock.method(apiClient, "request", async () => {
    if (++requests === 1) return new Promise<{ keys: string[] }>(resolve => { finish = resolve; });
    return { keys: [] };
  });
  const view = await mount(t, <Probe />), document = view.dom.window.document;
  await view.render(<Probe active={false} />);
  await view.render(<Probe active />);
  assert.equal(requests, 2);
  await act(async () => { finish({ keys: [notificationRevision(item)] }); });
  assert.equal(document.querySelector("button")!.textContent, "未读");
});

test("服务器已读进入新浏览器，标未读只提交当前版本增量并可轮询另一设备变化", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let keys = [notificationRevision(item)];
  const writes: unknown[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    assert.equal(path, "/api/notifications/reads");
    if (body) { writes.push(body); keys = []; }
    return { keys };
  });
  const view = await mount(t, <Probe />), document = view.dom.window.document;
  assert.equal(document.querySelector("button")!.textContent, "已读");
  await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); });
  assert.deepEqual(writes, [{ keys: [notificationRevision(item)], read: false }]);
  assert.equal(document.querySelector("button")!.textContent, "未读");
  keys = [notificationRevision(item)];
  await act(async () => { t.mock.timers.tick(30000); });
  assert.equal(document.querySelector("button")!.textContent, "已读");
});

test("服务器断线保留本地标记并明确同步失败，恢复后重试增量且不复活已清除版本", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let offline = true, keys: string[] = [];
  const writes: unknown[] = [];
  t.mock.method(apiClient, "request", async (_path: string, body?: unknown) => {
    if (offline) throw new Error("offline");
    if (body) { writes.push(body); const value = body as { keys: string[]; read: boolean }; keys = value.read ? value.keys : []; }
    return { keys };
  });
  const view = await mount(t, <Probe />), document = view.dom.window.document;
  await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); });
  assert.equal(document.querySelector("button")!.textContent, "已读");
  assert.match(document.querySelector('[role="status"]')!.textContent!, /同步.*失败|服务.*不可用/);
  offline = false;
  await act(async () => { t.mock.timers.tick(30000); });
  assert.deepEqual(writes, [{ keys: [notificationRevision(item)], read: true }]);
  assert.equal(document.querySelector('[role="status"]')!.textContent, "");
  await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); });
  assert.equal(document.querySelector("button")!.textContent, "未读");
});

test("同步途中切换已读时旧回包不覆盖新状态，最新增量立即续传", async t => {
  const writes: { keys: string[]; read: boolean }[] = [];
  let finish!: (value: { keys: string[] }) => void;
  t.mock.method(apiClient, "request", async (_path: string, body?: unknown) => {
    if (!body) return { keys: [] };
    const patch = body as { keys: string[]; read: boolean }; writes.push(patch);
    if (patch.read) return new Promise<{ keys: string[] }>(resolve => { finish = resolve; });
    return { keys: [] };
  });
  const view = await mount(t, <Probe />), document = view.dom.window.document;
  await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); });
  await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); });
  await act(async () => { finish({ keys: [notificationRevision(item)] }); });
  assert.equal(document.querySelector("button")!.textContent, "未读");
  assert.deepEqual(writes.map(value => value.read), [true, false]);
});

test("通知设置读取并保存免打扰HH:mm和时区，保存失败保留草稿且不伪造成功", async t => {
  const quietHours = { enabled: true, start: "22:00", end: "08:00", timeZone: "Asia/Shanghai" };
  const writes: unknown[] = [];
  let fails = false;
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    if (path.includes("preferences")) {
      if (body) { if (fails) throw new Error("offline"); writes.push(body); }
      return { quietHours };
    }
    return { enabled: true, mode: "all", kind: "generic", items: [] };
  });
  const view = await mount(t, <NotificationSettings />), document = view.dom.window.document;
  const details = document.querySelector<HTMLDetailsElement>('[data-notification-preferences]')!;
  assert.ok(details);
  await act(async () => { details.open = true; details.dispatchEvent(new view.dom.window.Event("toggle")); });
  assert.equal(document.querySelector<HTMLInputElement>('[name="quiet-start"]')!.value, "22:00");
  assert.equal(document.querySelector<HTMLInputElement>('[name="quiet-timezone"]')!.value, "Asia/Shanghai");
  const form = details.querySelector("form")!;
  await act(async () => { form.dispatchEvent(new view.dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.deepEqual(writes, [{ quietHours }]);
  assert.match(details.textContent!, /已保存/);
  fails = true;
  await act(async () => { form.dispatchEvent(new view.dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.match(details.querySelector('[role="alert"]')!.textContent!, /保存.*失败|未保存/);
  assert.equal(document.querySelector<HTMLInputElement>('[name="quiet-start"]')!.value, "22:00");
});
