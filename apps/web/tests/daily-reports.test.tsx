import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { DailyReport } from "@assistant/contracts";
import { DailyReports } from "../dist/daily-reports/DailyReports.js";
import { App } from "../dist/ui/App.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

async function input(dom: Awaited<ReturnType<typeof mount>>["dom"], selector: string, value: string) {
  if (selector === ".markdown-editor textarea" && !dom.window.document.querySelector(selector)) {
    await act(async () => { [...dom.window.document.querySelectorAll<HTMLButtonElement>(".markdown-editor-toolbar button")].find(button => button.textContent === "Markdown 源码")!.click(); });
  }
  const element = dom.window.document.querySelector(selector)!;
  const prototype = element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

test("编辑、预览转义、保存去重、切换日期保护和隐藏后草稿保留", async t => {
  const writes: unknown[] = [];
  let resolve!: (data: DailyReport) => void;
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    if (path === "/api/daily-reports") return [];
    if (body !== undefined) { writes.push(body); return new Promise<DailyReport>(done => { resolve = done; }); }
    return null;
  });
  const mounted = await mount(t, <DailyReports active />), { dom } = mounted;
  const document = dom.window.document;
  const date = document.querySelector<HTMLInputElement>("#report-date")!.value;
  const markdown = '# 今日完成\n- 进展\n<script>evil()</script>\n[bad](javascript:alert(1))';
  await input(dom, ".markdown-editor textarea", markdown);
  assert.match(document.querySelector(".reports-footer")!.textContent!, /未保存/);
  const leave = new dom.window.Event("beforeunload", { cancelable: true });
  dom.window.dispatchEvent(leave); assert.ok(leave.defaultPrevented);
  await act(async () => { document.querySelector<HTMLButtonElement>(".reports-tools .header-button")!.click(); });
  assert.match(document.querySelector(".reports-preview")!.textContent!, /今日完成/);
  assert.equal(document.querySelector(".reports-preview script"), null);
  assert.equal(document.querySelector('.reports-preview a[href^="javascript:"]'), null);
  await act(async () => { document.querySelector<HTMLButtonElement>(".reports-tools .header-button")!.click(); });
  t.mock.method(dom.window, "confirm", () => false);
  await input(dom, "#report-date", "2024-02-29");
  assert.equal(document.querySelector<HTMLInputElement>("#report-date")!.value, date);
  assert.equal(document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!.value, markdown);
  await mounted.render(<DailyReports active={false} />);
  await mounted.render(<DailyReports active />);
  assert.equal(document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!.value, markdown);
  await act(async () => {
    document.querySelector<HTMLButtonElement>(".settings-save")!.click();
    document.querySelector<HTMLButtonElement>(".settings-save")!.click();
  });
  assert.deepEqual(writes, [{ markdown, revision: null }]);
  assert.equal(document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!.disabled, true);
  await act(async () => { resolve({ date, markdown, revision: 1, updatedAt: new Date().toISOString() }); });
  assert.match(document.querySelector(".reports-footer")!.textContent!, /已保存/);
  assert.equal(document.querySelector(".reports-history nav button")!.textContent, date);
  const savedLeave = new dom.window.Event("beforeunload", { cancelable: true });
  dom.window.dispatchEvent(savedLeave); assert.equal(savedLeave.defaultPrevented, false);
});

test("加载失败不能覆盖日报，重试后保存冲突保留正文", async t => {
  let failedLoad = true;
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    if (path === "/api/daily-reports") return [];
    if (body !== undefined) throw new Error("日报已在其他页面更新");
    if (failedLoad) throw new Error("连接中断");
    return { date: path.split("/").at(-1), markdown: "旧内容", revision: 2, updatedAt: new Date().toISOString() };
  });
  const { dom } = await mount(t, <DailyReports active />);
  const document = dom.window.document;
  assert.equal(document.querySelector(".markdown-editor"), null);
  assert.equal(document.querySelector<HTMLButtonElement>(".settings-save")!.disabled, true);
  failedLoad = false;
  await act(async () => { document.querySelector<HTMLButtonElement>(".reports-error button")!.click(); });
  await input(dom, ".markdown-editor textarea", "不能丢的内容");
  await act(async () => { document.querySelector<HTMLButtonElement>(".settings-save")!.click(); });
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /其他页面更新/);
  assert.equal(document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!.value, "不能丢的内容");
  assert.equal(document.querySelector<HTMLButtonElement>(".settings-save")!.disabled, false);
});

test("快速切换日期不会被较早请求覆盖", async t => {
  const reads = new Map<string, (data: DailyReport | null) => void>();
  t.mock.method(apiClient, "request", async (path: string) => path === "/api/daily-reports" ? [] : new Promise(done => reads.set(path, done)));
  const { dom } = await mount(t, <DailyReports active />);
  await input(dom, "#report-date", "2024-02-28");
  await input(dom, "#report-date", "2024-02-29");
  await act(async () => { reads.get("/api/daily-reports/2024-02-29")!({ date: "2024-02-29", markdown: "正确日报", revision: 1, updatedAt: new Date().toISOString() }); });
  await act(async () => { reads.get("/api/daily-reports/2024-02-28")!(null); });
  assert.equal(dom.window.document.querySelector<HTMLElement>('[role="textbox"][aria-label="日报正文"]')!.textContent, "正确日报");
});

test("导航可打开日报，离开返回保留日报与聊天草稿", async t => {
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path === "/api/daily-reports") return [];
    if (path.startsWith("/api/daily-reports/")) return null;
    if (path === "/api/personal") return { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
    return { schedules: [], reminders: [], background: [] };
  });
  const { dom } = await mount(t, <App />);
  const document = dom.window.document;
  await input(dom, "#chat-textarea", "聊天草稿");
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="每日日报"]')!.click(); });
  assert.equal(document.getElementById("workspace")!.dataset.view, "reports");
  await input(dom, ".markdown-editor textarea", "日报草稿");
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="继续对话"]')!.click(); });
  assert.equal(document.querySelector<HTMLTextAreaElement>("#chat-textarea")!.value, "聊天草稿");
  assert.equal(document.querySelector<HTMLElement>(".daily-reports")!.hidden, true);
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="每日日报"]')!.click(); });
  assert.equal(document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!.value, "日报草稿");
});
