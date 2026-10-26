import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { ModelSettings as Settings, NotificationOverview } from "@assistant/contracts";
import { ModelSettings } from "../dist/settings/ModelSettings.js";
import { App } from "../dist/ui/App.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const saved: Settings = { models: [{ id: "primary", name: "主模型" }, { id: "backup", name: "备用模型" }], selectedModel: "primary", activeModel: "primary", restartRequired: false };
const notifications: NotificationOverview = { enabled: false, mode: "off", kind: "generic", items: [] };
function otherSettings(path: string) {
  if (path.startsWith("/api/notifications")) return notifications;
  if (path === "/api/personal") return { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
  return { enabled: false, configured: false, schedules: [], reminders: [], background: [] };
}
function modelForm(document: Document) { return document.querySelector<HTMLSelectElement>("#server-model")!.closest("form")!; }

test("设置可从导航打开并返回，保留草稿，模型只显示服务器目录", async t => {
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "request", async (path: string) => path === "/api/settings/model" ? saved : otherSettings(path));
  const { dom } = await mount(t, <App />);
  const document = dom.window.document;
  await act(async () => { document.querySelector<HTMLButtonElement>(".today-shortcut")!.click(); });
  const draft = document.querySelector("textarea")!.value;
  await act(async () => { document.querySelector<HTMLAnchorElement>('[aria-label="连接与设置"]')!.click(); });
  assert.equal(document.getElementById("workspace")!.dataset.view, "settings");
  assert.equal(document.activeElement?.id, "settings-title");
  for (const id of ["model-provider", "model-base-url", "model-id", "model-api-key"]) assert.equal(document.getElementById(id), null);
  assert.deepEqual([...document.querySelector<HTMLSelectElement>("#server-model")!.options].map(option => [option.value, option.textContent]), [["primary", "主模型"], ["backup", "备用模型"]]);
  assert.ok(document.querySelector('input[type="url"]'), "后台地址可配置");
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click(); });
  assert.equal(document.getElementById("workspace")!.dataset.view, "chat");
  assert.equal(document.querySelector("textarea")!.value, draft);
});

test("选择只发送服务器模型标识，重复提交一次，失败可重试", async t => {
  const calls: unknown[] = [];
  let resolve!: (value: Settings) => void;
  let failed = false;
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    if (path !== "/api/settings/model") return otherSettings(path);
    if (body === undefined) return saved;
    calls.push(body);
    if (failed) throw new Error("模型目录已更新，请重新选择");
    return new Promise<Settings>(done => { resolve = done; });
  });
  const { dom } = await mount(t, <ModelSettings onBack={() => {}} />);
  const document = dom.window.document, form = modelForm(document), select = document.querySelector<HTMLSelectElement>("#server-model")!;
  await act(async () => { select.value = "backup"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await act(async () => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(calls, [{ modelId: "backup" }]);
  assert.equal(form.getAttribute("aria-busy"), "true");
  assert.equal(form.querySelector("fieldset")!.disabled, true);
  await act(async () => { resolve({ ...saved, selectedModel: "backup", restartRequired: true }); });
  assert.match(form.querySelector(".settings-feedback")!.textContent!, /重启后台服务后生效/);
  failed = true;
  await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.match(form.querySelector('[role="alert"]')!.textContent!, /模型目录已更新/);
  assert.equal(select.value, "backup");
  assert.equal(form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled, false);
  assert.equal(form.querySelector(".settings-feedback")!.textContent, "");
  failed = false;
  await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => { resolve({ ...saved, selectedModel: "backup", activeModel: "backup" }); });
  assert.match(form.querySelector(".settings-feedback")!.textContent!, /当前模型已生效/);
  assert.deepEqual(calls, Array(3).fill({ modelId: "backup" }));
});

test("目录读取失败仍可修改后台地址，重试后恢复模型选择", async t => {
  let failed = true;
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path !== "/api/settings/model") return otherSettings(path);
    if (failed) throw new Error("disconnected");
    return saved;
  });
  const { dom } = await mount(t, <ModelSettings onBack={() => {}} />);
  const document = dom.window.document;
  assert.match(document.querySelector(".settings-load-error")!.textContent!, /未能读取服务器模型列表/);
  assert.equal(document.querySelector("#server-model"), null);
  assert.ok(document.querySelector('input[type="url"]'));
  failed = false;
  await act(async () => { document.querySelector<HTMLButtonElement>(".settings-load-error button")!.click(); });
  assert.ok(document.querySelector("#server-model"));
});

test("未配置模型时保留今日工作台，不显示模型编辑或选择输入", async t => {
  const paths: string[] = [];
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "onConnection", (listener: (state: "connected") => void) => { listener("connected"); return () => {}; });
  t.mock.method(apiClient, "request", async (path: string) => {
    paths.push(path);
    if (path === "/api/info") return { configured: false, model: "未配置模型", api: "openai-completions", boots: 1, pid: 1, startedAt: "2026-10-13" };
    if (path === "/api/settings/model") return { models: [], selectedModel: "", activeModel: "", restartRequired: false };
    return otherSettings(path);
  });
  const { dom } = await mount(t, <App />);
  assert.equal(dom.window.document.getElementById("workspace")!.dataset.view, "home");
  assert.ok(dom.window.document.querySelector(".today-page"));
  await act(async () => { dom.window.document.querySelector<HTMLAnchorElement>('[aria-label="连接与设置"]')!.click(); });
  assert.match(dom.window.document.querySelector(".settings-status")!.textContent!, /服务器尚未配置模型/);
  assert.equal(dom.window.document.querySelector("#model-api-key"), null);
  assert.equal(dom.window.document.querySelector("#server-model"), null);
  assert.equal(paths.includes("/api/conversations/direct"), false);
});
