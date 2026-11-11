import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { DesktopAgentBridge, DesktopAgentSnapshot } from "@assistant/contracts";
import { DesktopAgent } from "../dist/desktop/DesktopAgent.js";
import { mount } from "./dom.js";

function snapshot(configured = true): DesktopAgentSnapshot {
  return {
    configured, model: { api: "openai-completions", baseUrl: "https://example.invalid/v1", model: "local-model", contextWindow: 64000, maxTokens: 4096, hasApiKey: false },
    workspace: null, nodeId: "desktop", busy: false, messages: [], jobs: [], serverConnected: false,
  };
}
function bridge(state: DesktopAgentSnapshot): DesktopAgentBridge {
  return {
    snapshot: async () => state, saveModel: async () => ({ persistedKey: false }), send: async () => {},
    chooseWorkspace: async () => {}, approve: async () => {}, reject: async () => {}, abort: async () => {},
    openServer: async () => {}, openConnection: async () => {},
  };
}

test("未配置模型禁止发送，密钥只经 IPC 提交且不回显", async t => {
  const native = bridge(snapshot(false));
  const { dom, render } = await mount(t, <DesktopAgent />);
  Object.defineProperty(dom.window, "desktopAgent", { value: native });
  await render(<DesktopAgent />);
  const document = dom.window.document;
  assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.disabled, true);
  assert.ok(document.querySelector('[aria-label="本机模型设置"]'));
  const secret = document.querySelector<HTMLInputElement>('[name="apiKey"]')!;
  assert.equal(secret.type, "password"); assert.equal(secret.value, "");
  const entered = String.fromCharCode(100, 117, 109, 109, 121);
  secret.value = entered;
  const save = t.mock.method(native, "saveModel", async () => ({ persistedKey: true }));
  const original = globalThis.FormData, originalInput = globalThis.HTMLInputElement;
  globalThis.FormData = dom.window.FormData;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  t.after(() => { globalThis.FormData = original; globalThis.HTMLInputElement = originalInput; });
  await act(async () => { document.querySelector('[aria-label="本机模型设置"]')!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.equal(save.mock.calls[0]!.arguments[0]!.apiKey, entered);
  assert.equal(secret.value, "");
  assert.ok(!document.body.textContent!.includes(entered));
  assert.equal(dom.window.localStorage.length, 0);
  save.mock.restore();
  t.mock.method(native, "saveModel", async () => { throw new Error(entered); });
  secret.value = entered;
  await act(async () => { document.querySelector('[aria-label="本机模型设置"]')!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /模型保存失败/);
  assert.ok(!document.body.textContent!.includes(entered));
  assert.equal(secret.value, "");
});

test("发送防重复，未确认重试使用同一 UUID，服务端任务逐项批准或拒绝", async t => {
  const state = snapshot();
  state.jobs = [{ id: "job-1", source: "server", target: "desktop", task: "**请检查工作目录**", status: "queued", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }];
  state.jobs.push(
    { ...state.jobs[0]!, id: "outbound", source: "desktop", target: "server", task: "服务器任务" },
    { ...state.jobs[0]!, id: "other-node", target: "other-desktop", task: "其他本机任务" },
    { ...state.jobs[0]!, id: "other-source", source: "other-desktop", task: "其他来源任务" },
  );
  state.messages = [{ id: "assistant-1", role: "assistant", text: "**本机回复** <script>alert(1)</script>" }];
  const native = bridge(state);
  const { dom, render } = await mount(t, <DesktopAgent />);
  Object.defineProperty(dom.window, "desktopAgent", { value: native });
  let reject!: (error: Error) => void;
  const send = t.mock.method(native, "send", () => new Promise<void>((_, fail) => { reject = fail; }));
  const approve = t.mock.method(native, "approve", async () => {}), deny = t.mock.method(native, "reject", async () => {});
  await render(<DesktopAgent />);
  const document = dom.window.document;
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "检查文件");
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const form = document.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(send.mock.callCount(), 1);
  await act(async () => reject(new Error("发送结果未确认")));
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /发送结果未确认/);
  assert.equal(textarea.value, "检查文件");
  await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  assert.equal(send.mock.callCount(), 2);
  assert.equal(send.mock.calls[0]!.arguments[0]!.id, send.mock.calls[1]!.arguments[0]!.id);
  assert.match(send.mock.calls[0]!.arguments[0]!.id, /^[\da-f-]{36}$/i);
  await act(async () => reject(new Error("发送未完成")));
  assert.match(document.querySelector(".desktop-agent-job")!.textContent!, /等待批准/);
  assert.equal(document.querySelector(".desktop-agent-job .md strong")!.textContent, "请检查工作目录");
  const jobs = [...document.querySelectorAll(".desktop-agent-job")];
  assert.match(jobs[1]!.textContent!, /等待服务器/);
  for (const job of jobs.slice(1)) assert.equal(job.querySelector(".desktop-agent-job-actions"), null);
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(".desktop-agent-job-actions button")];
  assert.equal(buttons.length, 2);
  await act(async () => buttons[0]!.click()); assert.equal(approve.mock.calls[0]!.arguments[0], "job-1");
  await act(async () => buttons[1]!.click()); assert.equal(deny.mock.calls[0]!.arguments[0], "job-1");
  assert.equal(document.querySelector("#message-history strong")!.textContent, "小 D");
  assert.equal(document.querySelector("#message-history script"), null);
});

test("轮询不重叠，卸载后未完成的 snapshot 不再安排下一轮", async t => {
  const native = bridge(snapshot());
  let resolve!: (state: DesktopAgentSnapshot) => void;
  const read = t.mock.method(native, "snapshot", () => new Promise<DesktopAgentSnapshot>(done => { resolve = done; }));
  const { dom, render } = await mount(t, <DesktopAgent />);
  Object.defineProperty(dom.window, "desktopAgent", { value: native });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await render(<DesktopAgent />);
  await act(async () => t.mock.timers.tick(3000));
  assert.equal(read.mock.callCount(), 1);
  await render(<div />);
  await act(async () => { resolve(snapshot()); });
  await act(async () => t.mock.timers.tick(3000));
  assert.equal(read.mock.callCount(), 1);
  t.mock.timers.reset();
});
