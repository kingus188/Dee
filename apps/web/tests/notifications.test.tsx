import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { MailNotices, NotificationOverview, NotificationRecord } from "@assistant/contracts";
import { NotificationSettings } from "../dist/settings/NotificationSettings.js";
import { MailNotifications } from "../dist/mail/MailNotifications.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const record: NotificationRecord = { id: "event-private-id", status: "failed", attempts: 5, createdAt: 1792936800000, nextAt: 1792936805000, finishedAt: 1792936810000, lastError: "HTTP 503: endpoint unavailable" };
const overview: NotificationOverview = { enabled: true, mode: "errors", kind: "generic", items: [record] };

function filterButton(document: Document, label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>(".notification-filters button")].find(button => button.textContent === label)!;
}

test("通知按服务端筛选读取，不将最近100条当作历史总量，技术ID仅在折叠详情中", async t => {
  const paths: string[] = [];
  const failed = Array.from({ length: 100 }, (_, index) => ({ ...record, id: `failed-${index}` }));
  t.mock.method(apiClient, "request", async (path: string) => {
    paths.push(path);
    return { ...overview, items: path.endsWith("status=failed") ? failed : [record, { ...record, id: "sent", status: "sent", lastError: null }, { ...record, id: "pending", status: "pending", attempts: 0, finishedAt: null, lastError: null }] };
  });
  const { dom } = await mount(t, <NotificationSettings />), document = dom.window.document;
  assert.deepEqual(paths, ["/api/notifications?status=failed"]);
  assert.equal(filterButton(document, "失败").getAttribute("aria-pressed"), "true");
  assert.match(document.querySelector(".notification-list-caption")!.textContent!, /已显示 100 条失败记录/);
  assert.equal(document.querySelectorAll(".notification-record").length, 100);
  assert.equal(document.querySelector<HTMLDetailsElement>(".notification-record-details")!.open, false);
  assert.equal(document.querySelector("code")!.closest("details")?.className, "notification-record-details");
  assert.match(document.querySelector(".notification-error-preview")!.textContent!, /HTTP 503/);
  assert.match(document.querySelector(".notification-channel")!.textContent!, /Webhook 通知.*仅错误事件.*已启用/);
  assert.match(document.querySelector(".notification-policy")!.textContent!, /数量不代表全部历史/);
  assert.deepEqual([...document.querySelectorAll(".notification-filters button")].map(button => button.textContent), ["全部", "待发送", "已送达", "失败"]);
  await act(async () => { filterButton(document, "全部").click(); });
  assert.deepEqual(paths, ["/api/notifications?status=failed", "/api/notifications"]);
  assert.equal(document.querySelectorAll(".notification-record").length, 3);
  assert.match(document.querySelector(".notification-list-caption")!.textContent!, /已显示 3 条记录/);
  assert.equal(document.querySelectorAll(".notification-retry").length, 1);
  await act(async () => { filterButton(document, "待发送").click(); });
  assert.equal(paths.at(-1), "/api/notifications?status=pending");
});

test("通知刷新失败保留记录并在5秒轮询恢复，切换筛选不把旧结果作为新结果", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let fails = false;
  let resolve!: (value: NotificationOverview) => void;
  t.mock.method(apiClient, "request", async (path: string) => {
    if (fails) throw new Error("disconnected");
    if (path.endsWith("status=sent")) return new Promise<NotificationOverview>(done => { resolve = done; });
    return overview;
  });
  const { dom } = await mount(t, <NotificationSettings />), document = dom.window.document;
  fails = true;
  await act(async () => { document.querySelector<HTMLButtonElement>(".notification-refresh")!.click(); });
  assert.equal(document.querySelectorAll(".notification-record").length, 1);
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /已有记录仍保留/);
  fails = false;
  await act(async () => { t.mock.timers.tick(5000); });
  assert.equal(document.querySelector('[role="alert"]'), null);
  await act(async () => { filterButton(document, "已送达").click(); });
  assert.equal(document.querySelector(".notification-record"), null);
  assert.equal(document.querySelector(".notification-results")!.getAttribute("aria-busy"), "true");
  assert.match(document.querySelector(".notification-channel")!.textContent!, /已启用/);
  await act(async () => { resolve({ ...overview, items: [] }); });
  assert.match(document.querySelector(".notification-empty")!.textContent!, /暂无已送达记录/);
  assert.match(document.querySelector(".notification-list-caption")!.textContent!, /已显示 0 条已送达记录/);
});

test("重新投递防重复，成功入队与后续读取失败分别反馈，停用渠道禁用重试", async t => {
  const writes: unknown[] = [];
  let failRead = false, disabled = false;
  let resolve!: (value: { ok: true }) => void;
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    if (body !== undefined) {
      writes.push({ path, body });
      return new Promise<{ ok: true }>(done => { resolve = done; });
    }
    if (failRead) throw new Error("disconnected");
    return { ...overview, enabled: !disabled, mode: disabled ? "off" : "errors" };
  });
  const { dom } = await mount(t, <NotificationSettings />), document = dom.window.document;
  const retry = document.querySelector<HTMLButtonElement>(".notification-retry")!;
  assert.equal(retry.getAttribute("aria-describedby"), "notifications-retry-hint");
  await act(async () => { retry.click(); retry.click(); });
  assert.deepEqual(writes, [{ path: "/api/notifications/retry", body: { id: record.id } }]);
  assert.equal(retry.disabled, true);
  failRead = true;
  await act(async () => { resolve({ ok: true }); });
  assert.match(document.querySelector(".settings-feedback")!.textContent!, /已入队/);
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /读取通知记录/);
  assert.doesNotMatch(document.querySelector('[role="alert"]')!.textContent!, /重新投递未能确认/);
  failRead = false; disabled = true;
  await act(async () => { document.querySelector<HTMLButtonElement>(".notification-refresh")!.click(); });
  assert.equal(document.querySelector<HTMLButtonElement>(".notification-retry")!.disabled, true);
  assert.match(document.querySelector(".notification-channel")!.textContent!, /未启用/);
});

test("重新投递失败不伪造入队成功，首次读取失败不显示空记录结论", async t => {
  let initial = true;
  t.mock.method(apiClient, "request", async (_path: string, body?: unknown) => {
    if (initial || body !== undefined) throw new Error("disconnected");
    return overview;
  });
  const { dom } = await mount(t, <NotificationSettings />), document = dom.window.document;
  assert.equal(document.querySelector(".notification-empty"), null);
  assert.match(document.querySelector(".notification-channel")!.textContent!, /待确认/);
  initial = false;
  await act(async () => { document.querySelector<HTMLButtonElement>(".notification-refresh")!.click(); });
  await act(async () => { document.querySelector<HTMLButtonElement>(".notification-retry")!.click(); });
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /重新投递未能确认/);
  assert.equal(document.querySelector(".settings-feedback")!.textContent, "");
});

test("邮件轻提示只展示元数据，15秒读取且不新增写入，缺少主题和姓名使用既有元数据回退", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const calls: { path: string; body: unknown }[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: unknown): Promise<MailNotices> => {
    calls.push({ path, body });
    return { latest: path.includes("after") ? 3 : 2, items: path.includes("after") ? [{ sequence: 3, message: { id: "mail-metadata", subject: "", sender: "", address: "sender@example.test", receivedAt: "2026-10-26T00:00:00Z", preview: "BODY_MUST_NOT_BE_RENDERED", isRead: false, hasAttachments: true } }] : [] };
  });
  const { dom } = await mount(t, <MailNotifications />), document = dom.window.document;
  await act(async () => { t.mock.timers.tick(14999); });
  assert.equal(calls.length, 1);
  assert.equal(document.querySelector(".mail-notice"), null);
  await act(async () => { t.mock.timers.tick(1); });
  const notice = document.querySelector(".mail-notice.mail-notice-toast")!;
  assert.equal(notice.getAttribute("role"), "status");
  assert.equal(document.querySelector(".mail-notice-subject")!.textContent, "（无主题）");
  assert.equal(document.querySelector(".mail-notice-sender")!.textContent, "sender@example.test");
  assert.doesNotMatch(notice.textContent!, /BODY_MUST_NOT_BE_RENDERED/);
  assert.deepEqual(calls, [{ path: "/api/mail/notices", body: undefined }, { path: "/api/mail/notices?after=2", body: undefined }]);
  assert.ok(document.querySelector('[aria-label="关闭新邮件提醒"]'));
  await act(async () => { t.mock.timers.tick(5000); });
  assert.equal(document.querySelector(".mail-notice"), null);
});
