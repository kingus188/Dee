import test from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { act } from "react";
import type { DaylightSnapshot, PersonalData, WorkspaceActivities, WorkspaceMail } from "@assistant/contracts";
import { App } from "../dist/ui/App.js";
import { apiClient } from "../dist/api/socket.js";
import { localDate } from "../dist/daylight/domain/todo.js";
import { mount } from "./dom.js";

function resources() {
  const daylight: DaylightSnapshot = {
    projects: [{ id: "project", name: "保留的项目", description: "", color: "rose" }],
    tasks: [{ id: "task", title: "上次成功读取的待办", projectId: "project", description: "", status: "todo", priority: "medium", color: "rose", dueDate: localDate(), tags: [], checklist: [], createdAt: 1, position: 1 }],
  };
  const personal: PersonalData = { memory: [{ id: "memory", text: "待批准的背景", status: "pending", source: "agent", createdAt: 1, decidedAt: null }], skills: [], knowledge: { enabled: false, allow: [] } };
  const activities: WorkspaceActivities = {
    items: [
      { id: "pending", kind: "reminder", conversationId: 17, conversationTitle: "提醒来源", text: "仍待处理的提醒", status: "scheduled", at: 1_800_000_000_000, createdAt: 1 },
      { id: "finished", kind: "background", conversationId: 42, conversationTitle: "分析来源", text: "已完成的分析", status: "done", at: null, createdAt: 2, result: "上次成功读取的结果" },
    ],
    total: 2, truncated: false,
  };
  const mail: WorkspaceMail = {
    status: { enabled: true, connected: true, offline: false, syncing: false, lastSuccessAt: "2026-10-22T06:30:00Z", error: "" },
    messages: [{ id: "mail", subject: "上次成功读取的邮件", sender: "项目通知", address: "project@example.test", receivedAt: "2026-10-22T06:00:00Z", preview: "保留邮件摘要", isRead: false, hasAttachments: false }],
  };
  return { "/api/daylight": daylight, "/api/personal": personal, "/api/workspace/activities": activities, "/api/workspace/mail": mail };
}

function mockApi(t: TestContext) {
  const values = resources(), requests: string[] = [], subscriptions: number[] = [], failures = new Set<string>();
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "subscribeConversation", async (id: number) => { subscriptions.push(id); });
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path.startsWith("/api/mail/notices")) return { items: [], latest: 0 };
    if (!Object.hasOwn(values, path)) throw new Error(`Unexpected request: ${path}`);
    requests.push(path);
    if (failures.has(path)) throw new Error("刷新连接中断");
    return values[path as keyof typeof values];
  });
  return { values, requests, subscriptions, failures };
}

async function workspace(t: TestContext, hash: string) {
  const mounted = await mount(t, null), { dom } = mounted;
  const document = dom.window.document;
  let visibility: DocumentVisibilityState = "visible", nextTimer = 0;
  const intervals = new Map<number, () => void>();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  t.mock.method(dom.window, "setInterval", (handler: TimerHandler) => {
    const id = ++nextTimer;
    intervals.set(id, () => { if (typeof handler === "function") handler(); });
    return id;
  });
  t.mock.method(dom.window, "clearInterval", (id?: number) => { if (id !== undefined) intervals.delete(id); });
  dom.window.history.replaceState(null, "", hash);
  await mounted.render(<App />);
  return {
    dom, document,
    poll: async () => { await act(async () => { for (const callback of [...intervals.values()]) callback(); }); },
    visibility: async (state: DocumentVisibilityState) => {
      visibility = state;
      await act(async () => { document.dispatchEvent(new dom.window.Event("visibilitychange")); });
    },
    hash: async (next: string) => {
      await act(async () => {
        const changed = new Promise<void>(resolve => dom.window.addEventListener("hashchange", () => resolve(), { once: true }));
        dom.window.location.hash = next;
        await changed;
      });
    },
    back: async () => {
      await act(async () => {
        const restored = new Promise<void>(resolve => dom.window.addEventListener("popstate", () => resolve(), { once: true }));
        const changed = new Promise<void>(resolve => dom.window.addEventListener("hashchange", () => resolve(), { once: true }));
        dom.window.history.back();
        await Promise.all([restored, changed]);
      });
    },
  };
}

test("App 今日离开后暂停轮询，返回刷新失败仍保留四类成功快照", { timeout: 5000 }, async t => {
  const api = mockApi(t), view = await workspace(t, "#today"), { document } = view;
  const paths = Object.keys(api.values), initialRequests = [...api.requests];
  assert.equal(document.querySelector<HTMLElement>(".today-page")!.hidden, false);
  assert.match(document.querySelector(".today-task-list")!.textContent!, /上次成功读取的待办/);
  for (const path of paths) assert.ok(initialRequests.includes(path));
  await view.poll();
  const polledRequests = [...initialRequests, ...paths];
  assert.deepEqual(api.requests.toSorted(), polledRequests.toSorted());

  await view.visibility("hidden");
  await view.poll();
  assert.deepEqual(api.requests.toSorted(), polledRequests.toSorted());
  await view.visibility("visible");
  assert.deepEqual(api.requests.toSorted(), [...polledRequests, ...paths].toSorted());

  await view.hash("#chat");
  assert.equal(document.getElementById("workspace")!.dataset.view, "chat");
  assert.equal(document.querySelector<HTMLElement>(".today-page")?.hidden, true);
  const hiddenRequests = [...api.requests];
  await view.poll();
  await view.visibility("hidden");
  await view.visibility("visible");
  await view.poll();
  assert.deepEqual(api.requests, hiddenRequests);

  for (const path of paths) api.failures.add(path);
  await act(async () => { document.querySelector<HTMLAnchorElement>('[aria-label="首页"]')!.click(); });
  assert.equal(document.getElementById("workspace")!.dataset.view, "home");
  assert.equal(document.querySelector<HTMLElement>(".today-page")!.hidden, false);
  assert.deepEqual(api.requests.toSorted(), [...hiddenRequests, ...paths].toSorted());
  assert.match(document.querySelector(".today-task-list")!.textContent!, /上次成功读取的待办/);
  assert.match(document.querySelector(".today-progress-list")!.textContent!, /仍待处理的提醒/);
  assert.match(document.querySelector(".today-approval-links")!.textContent!, /1 条等待批准/);
  assert.match(document.querySelector(".today-mail-list")!.textContent!, /上次成功读取的邮件/);
  const errors = document.querySelectorAll('.today-page [role="alert"]');
  assert.equal(errors.length, 4);
  for (const error of errors) assert.match(error.textContent!, /刷新连接中断.*保留上次成功读取的内容/);
});

test("App 动态筛选进入来源会话后浏览器返回，保留筛选、展开结果与失败前快照", { timeout: 5000 }, async t => {
  const api = mockApi(t), view = await workspace(t, "#activity"), { dom, document } = view;
  const initialRequests = [...api.requests];
  assert.deepEqual(initialRequests.filter(path => path !== "/api/personal"), ["/api/workspace/activities"]);
  assert.equal(document.querySelectorAll(".activity-record-list .activity-record").length, 2);
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>(".activity-filter")].find(button => button.textContent!.startsWith("已结束"))!.click();
  });
  assert.equal(document.querySelectorAll(".activity-record-list .activity-record").length, 1);
  await act(async () => { document.querySelector<HTMLElement>(".activity-record-result summary")!.click(); });
  assert.equal(document.querySelector<HTMLDetailsElement>(".activity-record-result")!.open, true);
  await act(async () => { document.querySelector<HTMLButtonElement>(".activity-record-list .activity-source-button")!.click(); });
  assert.equal(dom.window.location.hash, "#chat/42");
  assert.equal(document.getElementById("workspace")!.dataset.view, "chat");
  assert.deepEqual(api.subscriptions, [42]);
  assert.equal(document.querySelector<HTMLElement>(".activity-page")?.hidden, true);
  await view.poll();
  await view.visibility("hidden");
  await view.visibility("visible");
  await view.poll();
  assert.deepEqual(api.requests, initialRequests);

  api.failures.add("/api/workspace/activities");
  await view.back();
  assert.equal(dom.window.location.hash, "#activity");
  assert.equal(document.getElementById("workspace")!.dataset.view, "activity");
  assert.equal(document.querySelector<HTMLElement>(".activity-page")!.hidden, false);
  assert.deepEqual(api.requests.toSorted(), [...initialRequests, "/api/workspace/activities"].toSorted());
  assert.match(document.querySelector('.activity-filter[aria-pressed="true"]')!.textContent!, /^已结束/);
  assert.equal(document.querySelectorAll(".activity-record-list .activity-record").length, 1);
  assert.match(document.querySelector(".activity-record-list")!.textContent!, /已完成的分析/);
  assert.doesNotMatch(document.querySelector(".activity-record-list")!.textContent!, /仍待处理的提醒/);
  assert.equal(document.querySelector<HTMLDetailsElement>(".activity-record-result")!.open, true);
  assert.equal(document.querySelector(".activity-record-result pre")!.textContent, "上次成功读取的结果");
  assert.match(document.querySelector('.activity-page [role="alert"]')!.textContent!, /刷新连接中断.*保留上次成功读取的内容/);
});
