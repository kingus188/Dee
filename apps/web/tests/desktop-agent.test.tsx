import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { DesktopAgentBridge, DesktopAgentSnapshot, DesktopAgentSelection } from "@assistant/contracts";
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
    snapshot: async () => structuredClone(state), saveModel: async () => ({ persistedKey: false }), send: async () => {},
    selectAgent: async () => {}, newSession: async () => {}, answerApproval: async () => {},
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
test("external Agent selection does not require Pi API settings and displays bound approval requests", async t => {
  const state = snapshot();
  state.agent = "codex"; state.agentConfig = { executable: "codex", args: [] }; state.busy = true;
  state.external = { status: "waiting", sessionId: "native-hidden", activities: [{ id: "command", title: "读取工作区", status: "running" }], approvals: [{ id: "approval", title: "Codex 请求执行命令", detail: "<script>secret()</script>" }] };
  const native = bridge(state);
  const answer = t.mock.method(native, "answerApproval", async () => { state.external!.approvals = []; state.external!.status = "running"; });
  const { dom, render } = await mount(t, <DesktopAgent />);
  Object.defineProperty(dom.window, "desktopAgent", { value: native });
  await render(<DesktopAgent />);
  const document = dom.window.document;
  assert.equal(document.querySelector('[name="apiKey"]'), null);
  assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="执行 Agent"]')!.disabled, true);
  assert.match(document.body.textContent!, /等待你处理/);
  assert.ok(!document.body.textContent!.includes("native-hidden"));
  assert.equal(document.querySelector(".desktop-agent-request script"), null);
  assert.equal(document.querySelector(".desktop-agent-request pre")!.textContent, "<script>secret()</script>");
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(".desktop-agent-request button")];
  await act(async () => { buttons[1]!.click(); buttons[1]!.click(); });
  assert.equal(answer.mock.callCount(), 1);
  assert.deepEqual(answer.mock.calls[0]!.arguments[0], { id: "approval", allow: false });
  assert.equal(document.querySelector(".desktop-agent-request"), null);
});

test("switching to Claude uses the Agent bridge and keeps Pi model form out of the external settings", async t => {
  const state = snapshot(), native = bridge(state);
  const select = t.mock.method(native, "selectAgent", async (input: DesktopAgentSelection) => { state.agent = input.kind; state.agentConfig = { executable: "claude", args: [] }; });
  const { dom, render } = await mount(t, <DesktopAgent />);
  Object.defineProperty(dom.window, "desktopAgent", { value: native }); await render(<DesktopAgent />);
  const document = dom.window.document, picker = document.querySelector<HTMLButtonElement>('[aria-label="执行 Agent"]')!;
  await act(async () => picker.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="选择 Claude Code"]')!.click());
  assert.equal(select.mock.calls[0]!.arguments[0]!.kind, "claude");
  assert.equal(picker.getAttribute("aria-expanded"), "false");
  assert.match(picker.textContent!, /Claude Code.*默认模型/);
  assert.equal(document.activeElement, picker);
  const settingsButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Agent 设置")!;
  await act(async () => settingsButton.click());
  assert.ok(document.querySelector('[aria-label="外部 Agent 设置"]'));
  assert.equal(document.querySelector('[name="apiKey"]'), null);
  assert.equal(document.querySelector<HTMLInputElement>('[name="executable"]')!.value, "claude");
});

test("composer picker filters real Agent options, supports keyboard navigation and dismisses without sending", async t => {
  const state = snapshot(), native = bridge(state);
  const send = t.mock.method(native, "send", async () => {});
  const select = t.mock.method(native, "selectAgent", async (input: DesktopAgentSelection) => { state.agent = input.kind; });
  const { dom, render } = await mount(t, <DesktopAgent />);
  Object.defineProperty(dom.window, "desktopAgent", { value: native }); await render(<DesktopAgent />);
  const document = dom.window.document, picker = document.querySelector<HTMLButtonElement>('[aria-label="执行 Agent"]')!;
  assert.ok(picker.closest("form.input-box-wrapper"));
  assert.equal(document.querySelector(".desktop-agent-workspace [aria-label='执行 Agent']"), null);
  await act(async () => picker.click());
  const search = document.querySelector<HTMLInputElement>('[aria-label="搜索 Agent 或模型"]')!;
  assert.equal(document.activeElement, search);
  assert.equal(document.querySelectorAll(".agent-picker-option").length, 4);
  assert.match(document.querySelector('[aria-label="选择 Pi"]')!.textContent!, /local-model/);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="筛选 Claude Code"]')!.click());
  assert.equal(document.querySelectorAll(".agent-picker-option").length, 1);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="全部 Agent"]')!.click());
  async function searchFor(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, value);
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  }
  await searchFor("missing");
  assert.match(document.querySelector(".agent-picker-empty")!.textContent!, /没有匹配/);
  await searchFor(" CODEX ");
  assert.equal(document.querySelectorAll(".agent-picker-option").length, 1);
  search.focus();
  await act(async () => search.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  assert.equal(document.activeElement?.getAttribute("aria-label"), "选择 Codex");
  await act(async () => document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(document.querySelector(".agent-picker-popover"), null);
  assert.equal(document.activeElement, picker);
  assert.equal(select.mock.callCount(), 0);
  await act(async () => picker.click());
  await act(async () => document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })));
  assert.equal(document.querySelector(".agent-picker-popover"), null);
  await act(async () => picker.click());
  const nextSearch = document.querySelector<HTMLInputElement>('[aria-label="搜索 Agent 或模型"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(nextSearch, "Claude");
    nextSearch.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  let prevented = false;
  await act(async () => { prevented = !nextSearch.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  assert.equal(prevented, true);
  assert.equal(select.mock.calls[0]!.arguments[0]!.kind, "claude");
  assert.equal(send.mock.callCount(), 0);
});

test("picker prevents duplicate switches and keeps the current selection after an IPC failure", async t => {
  const native = bridge(snapshot());
  let fail!: (error: Error) => void;
  const select = t.mock.method(native, "selectAgent", () => new Promise<void>((_, reject) => { fail = reject; }));
  const { dom, render } = await mount(t, <DesktopAgent />);
  Object.defineProperty(dom.window, "desktopAgent", { value: native }); await render(<DesktopAgent />);
  const document = dom.window.document, picker = document.querySelector<HTMLButtonElement>('[aria-label="执行 Agent"]')!;
  await act(async () => picker.click());
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="选择 Codex"]')!.click();
    document.querySelector<HTMLButtonElement>('[aria-label="选择 Claude Code"]')!.click();
  });
  assert.equal(select.mock.callCount(), 1);
  assert.equal(picker.disabled, true);
  assert.ok([...document.querySelectorAll<HTMLButtonElement>(".agent-picker-option")].every(button => button.disabled));
  await act(async () => fail(new Error("切换失败")));
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /切换失败/);
  assert.match(picker.textContent!, /Pi.*local-model/);
  assert.equal(picker.disabled, false);
  assert.equal(document.querySelector('[aria-label="选择 Pi"]')!.getAttribute("aria-pressed"), "true");
});

test("本机侧栏沿用原有展开和收起状态，切换不重建对话或丢失草稿", async t => {
  const state = snapshot();
  state.messages = [{ id: "local", role: "user", text: "正在继续的本机对话" }];
  const native = bridge(state);
  const { dom, render } = await mount(t, <DesktopAgent />);
  Object.defineProperty(dom.window, "desktopAgent", { value: native });
  await render(<DesktopAgent />);
  const document = dom.window.document, shell = document.querySelector("#mascot-card"), frame = document.querySelector("main"), chat = document.querySelector(".chat-column");
  const input = document.querySelector<HTMLTextAreaElement>(".chat-textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "还没发送");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(document.querySelector(".conversation-sidebar")!.getAttribute("data-expanded"), "true");
  assert.match(document.querySelector(".history-list")!.textContent!, /正在继续的本机对话/);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="收起历史对话"]')!.click());
  assert.equal(document.querySelector(".conversation-sidebar")!.getAttribute("data-expanded"), "false");
  assert.equal(dom.window.localStorage.getItem("dee.history.collapsed"), "true");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="搜索对话"]')!.click());
  assert.equal(document.querySelector(".conversation-sidebar")!.getAttribute("data-expanded"), "true");
  assert.equal(dom.window.localStorage.getItem("dee.history.collapsed"), "false");
  assert.equal(document.querySelector("#mascot-card"), shell); assert.equal(document.querySelector("main"), frame); assert.equal(document.querySelector(".chat-column"), chat);
  assert.equal(input.value, "还没发送");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="收起历史对话"]')!.click());
  await render(null); await render(<DesktopAgent />);
  assert.equal(document.querySelector(".conversation-sidebar")!.getAttribute("data-expanded"), "false");
});

test("窄窗口侧栏使用原有覆盖布局，可用遮罩和 Escape 关闭并恢复焦点", async t => {
  const { dom, render } = await mount(t, null);
  Object.defineProperty(dom.window, "desktopAgent", { value: bridge(snapshot()) });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  await render(<DesktopAgent />);
  const document = dom.window.document;
  assert.equal(document.querySelector(".conversation-sidebar")!.getAttribute("data-expanded"), "false");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="展开历史对话"]')!.click());
  assert.equal(document.querySelector('[aria-label="本机对话侧栏"]')!.getAttribute("aria-modal"), "true");
  assert.ok(document.querySelector(".desktop-agent-content")!.hasAttribute("inert"));
  await act(async () => document.querySelector<HTMLButtonElement>(".history-backdrop")!.click());
  assert.equal(document.querySelector(".history-backdrop"), null);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="展开历史对话"]')!.click());
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(document.querySelector(".conversation-sidebar")!.getAttribute("data-expanded"), "false");
  assert.equal(document.activeElement, document.querySelector(".sidebar-toggle"));
  assert.equal(document.querySelector(".desktop-agent-content")!.hasAttribute("inert"), false);
});

test("本机侧栏与服务模式共用来源、搜索和分组布局，来源跳转不丢失本机对话", async t => {
  const state = snapshot();
  state.messages = [{ id: "local", role: "user", text: "本机待处理事项" }];
  const native = bridge(state);
  const openServer = t.mock.method(native, "openServer", async (_hash?: string) => {});
  const { dom, render } = await mount(t, null);
  Object.defineProperty(dom.window, "desktopAgent", { value: native });
  await render(<DesktopAgent />);
  const document = dom.window.document, chat = document.querySelector(".chat-column");
  const panel = document.querySelector(".conversation-history")!;
  assert.match(panel.querySelector(".history-search kbd")!.textContent!, /^(⌘K|Ctrl K)$/);
  assert.equal(panel.querySelector(".history-heading")!.textContent, "当前对话");
  assert.equal(panel.querySelector(".history-row-title")!.textContent, "本机待处理事项");
  assert.equal(panel.querySelector(".conversation-new-button"), null, "Pi 不提供不支持的新会话操作");
  const source = panel.querySelector<HTMLSelectElement>('[aria-label="切换对话来源"]')!;
  assert.equal(source.value, "assistant");
  await act(async () => {
    source.value = "teams";
    source.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  assert.deepEqual(openServer.mock.calls[0]!.arguments, ["#teams"]);
  assert.equal(source.value, "assistant");
  assert.equal(document.querySelector(".chat-column"), chat);
  document.querySelector<HTMLTextAreaElement>("textarea")!.focus();
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })));
  const search = panel.querySelector<HTMLInputElement>(".history-search input")!;
  assert.equal(document.activeElement, search);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "不存在");
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(panel.querySelector(".history-list a"), null);
  assert.match(panel.querySelector(".history-list")!.textContent!, /没有匹配的本机会话/);
  await act(async () => document.querySelector<HTMLButtonElement>(".sidebar-toggle")!.click());
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    await new Promise<void>(resolve => dom.window.requestAnimationFrame(() => resolve()));
  });
  assert.equal(document.querySelector(".conversation-sidebar")!.getAttribute("data-expanded"), "true");
  assert.equal(document.activeElement, search);
  assert.equal(document.querySelector(".chat-column"), chat);
});
