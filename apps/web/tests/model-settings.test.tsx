import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { ModelSettings as Settings } from "@assistant/contracts";
import { ModelSettings } from "../dist/settings/ModelSettings.js";
import { App } from "../dist/ui/App.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const saved: Settings = { provider: "openai-completions", baseUrl: "https://provider.example/v1", model: "model-a", hasKey: true, activeModel: "model-a", restartRequired: false };

test("设置可从导航打开并返回，保留对话草稿和密码输入语义", async t => {
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "request", async (path: string) => path === "/api/settings/model" ? saved : path === "/api/personal" ? { memory: [], skills: [], knowledge: { enabled: false, allow: [] } } : { schedules: [], reminders: [], background: [] });
  const { dom } = await mount(t, <App />);
  const document = dom.window.document;
  await act(async () => { document.querySelector<HTMLButtonElement>(".prompt-chip")!.click(); });
  const draft = document.querySelector("textarea")!.value;
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="模型设置"]')!.click(); });
  assert.equal(document.getElementById("workspace")!.dataset.view, "settings");
  assert.equal(document.activeElement?.id, "settings-title");
  const key = document.querySelector<HTMLInputElement>("#model-api-key")!;
  assert.equal(key.type, "password"); assert.equal(key.value, ""); assert.equal(key.required, false);
  assert.equal(key.autocomplete, "new-password");
  assert.equal(document.querySelector<HTMLSelectElement>("#model-provider")!.options.length, 3);
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click(); });
  assert.equal(document.getElementById("workspace")!.dataset.view, "chat");
  assert.equal(document.querySelector("textarea")!.value, draft);
});

test("保存保留空 Key、重复提交一次，更换协议需新 Key，失败允许重试", async t => {
  const calls: unknown[] = [];
  let resolve!: (value: Settings) => void;
  let failed = false;
  t.mock.method(apiClient, "request", async (_path: string, body?: unknown) => {
    if (body === undefined) return saved;
    calls.push(body);
    if (failed) throw new Error("更换 Provider 或 Base URL 时，请重新填写 API Key");
    return new Promise<Settings>(done => { resolve = done; });
  });
  const { dom } = await mount(t, <ModelSettings onBack={() => {}} />);
  const document = dom.window.document, form = document.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(calls, [{ provider: saved.provider, baseUrl: saved.baseUrl, model: saved.model }]);
  assert.equal(form.getAttribute("aria-busy"), "true");
  assert.equal(document.querySelector("fieldset")!.disabled, true);
  await act(async () => { resolve({ ...saved, restartRequired: true }); });
  assert.match(document.querySelector(".settings-feedback")!.textContent!, /已保存，重启服务后生效/);
  const provider = document.querySelector<HTMLSelectElement>("#model-provider")!;
  await act(async () => { provider.value = "anthropic-messages"; provider.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  assert.equal(document.querySelector<HTMLInputElement>("#model-api-key")!.required, true);
  assert.equal(document.querySelector(".settings-key-state"), null);
  failed = true;
  await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /重新填写 API Key/);
  assert.equal(document.querySelector<HTMLSelectElement>("#model-provider")!.value, "anthropic-messages");
  assert.equal(document.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled, false);
  assert.equal(document.querySelector(".settings-feedback")!.textContent, "");
  const key = document.querySelector<HTMLInputElement>("#model-api-key")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(key, "replacement-ui-test-key");
    key.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  failed = false;
  await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.equal((calls.at(-1) as { apiKey?: string }).apiKey, "replacement-ui-test-key");
  await act(async () => { resolve({ ...saved, provider: "anthropic-messages", restartRequired: true }); });
  assert.equal(key.value, "");
});

test("读取失败显示重试入口，未加载配置时不能提交", async t => {
  let failed = true;
  t.mock.method(apiClient, "request", async () => { if (failed) throw new Error("disconnected"); return saved; });
  const { dom } = await mount(t, <ModelSettings onBack={() => {}} />);
  assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /无法读取配置/);
  assert.equal(dom.window.document.querySelector("form"), null);
  failed = false;
  await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".settings-load-error button")!.click(); });
  assert.ok(dom.window.document.querySelector("form"));
});

test("未配置模型时直接进入设置页，不创建聊天或启动生成", async t => {
  const paths: string[] = [];
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "onConnection", (listener: (state: "connected") => void) => { listener("connected"); return () => {}; });
  t.mock.method(apiClient, "request", async (path: string) => {
    paths.push(path);
    if (path === "/api/info") return { configured: false, model: "未配置模型", api: "openai-completions", boots: 1, pid: 1, startedAt: "2026-10-13" };
    if (path === "/api/settings/model") return { ...saved, baseUrl: "", model: "", hasKey: false, activeModel: "" };
    if (path === "/api/personal") return { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
    throw new Error("Unexpected request: " + path);
  });
  const { dom } = await mount(t, <App />);
  assert.equal(dom.window.document.getElementById("workspace")!.dataset.view, "settings");
  assert.match(dom.window.document.querySelector(".settings-status")!.textContent!, /请配置模型/);
  assert.equal(dom.window.document.querySelector<HTMLInputElement>("#model-api-key")!.required, true);
  assert.equal(paths.includes("/api/conversations/direct"), false);
});
