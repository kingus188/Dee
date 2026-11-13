import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { DesktopAgentBridge, DesktopAgentSnapshot, DesktopAgentSelection } from "@assistant/contracts";
import { App as DesktopAgent } from "../dist/ui/App.js";
import { apiClient } from "../dist/api/socket.js";
import { mount as mountDom } from "./dom.js";

async function mount(t: TestContext) {
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "onConnection", () => () => {});
  t.mock.method(apiClient, "onView", () => () => {});
  t.mock.method(apiClient, "subscribeConversation", async () => {});
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path === "/api/conversations") return [];
    if (path === "/api/personal") return { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
    if (path === "/api/workspace/activities") return { items: [], total: 0, truncated: false };
    if (path === "/api/notifications/reads") return { keys: [] };
    if (path === "/api/teams/conversations") return { available: false, items: [], nextCursor: null, fetchedAt: "2026-11-12T00:00:00Z" };
    if (path === "/api/daylight") return { projects: [], tasks: [] };
    throw new Error(`Unexpected test API request: ${path}`);
  });
  // Tests install the native bridge after creating the DOM. Do not initialize App's
  // execution preference until that bridge is present; later renders keep one shell.
  const mounted = await mountDom(t, null);
  mounted.dom.window.history.replaceState(null, "", "#chat/local");
  return mounted;
}

function snapshot(configured = true): DesktopAgentSnapshot {
  return {
    configured, model: { api: "openai-completions", baseUrl: "https://example.invalid/v1", model: "local-model", contextWindow: 64000, maxTokens: 4096, hasApiKey: false },
    workspace: null, nodeId: "desktop", busy: false, messages: [], jobs: [], serverConnected: false,
  };
}
function bridge(state: DesktopAgentSnapshot): DesktopAgentBridge {
  return {
    snapshot: async () => structuredClone(state), send: async () => {},
    selectAgent: async () => {}, newSession: async () => {}, answerApproval: async () => {},
    chooseWorkspace: async () => {}, approve: async () => {}, reject: async () => {}, abort: async () => {},
    openServer: async () => {}, openConnection: async () => {},
  };
}

test("明确目标的外部会话可在忙时批准排队，不要求 Pi 配置且不切换当前对话", async t => {
  const state = snapshot(); state.agent = "codex"; state.busy = true; state.piConfigured = false;
  state.messages = [{ id: "source", role: "user", text: "当前来源对话" }];
  state.jobs = [{ id: "job", source: "server", target: state.nodeId, targetSession: { agent: "claude", sessionId: "target-session" }, task: "已有会话任务", status: "queued", createdAt: "now", updatedAt: "now" }];
  const native = bridge(state);
  const approve = t.mock.method(native, "approve", async () => { state.jobs[0]!.approved = true; });
  const { dom, render } = await mount(t);
  Object.defineProperty(dom.window, "desktopAgent", { value: native }); await render(<DesktopAgent />);
  const document = dom.window.document;
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "批准 Claude Code 执行")!;
  assert.ok(button, document.body.textContent!);
  assert.equal(button.disabled, false);
  assert.ok(!document.body.textContent!.includes("委托任务"));
  await act(async () => button.click());
  assert.equal(approve.mock.callCount(), 1); assert.match(document.body.textContent!, /等待空闲/);
  assert.match(document.querySelector("#message-history")!.textContent!, /当前来源对话/);
  assert.ok(!document.body.textContent!.includes("批准 Pi 执行"));
});

test("历史协作任务不进入聊天布局，已有消息保持显示", async t => {
  const state = snapshot(); state.agent = "omp";
  state.messages = [{ id: "history", role: "user", text: "切换前的消息" }];
  state.jobs = [{ id: "old", source: "server", target: state.nodeId, task: "历史委托内容", status: "done", createdAt: "now", updatedAt: "now" }];
  const { dom, render } = await mount(t);
  Object.defineProperty(dom.window, "desktopAgent", { value: bridge(state) });
  await render(<DesktopAgent />);
  assert.match(dom.window.document.querySelector("#message-history")!.textContent!, /切换前的消息/);
  assert.equal(dom.window.document.querySelector(".desktop-agent-jobs"), null);
  assert.ok(!dom.window.document.body.textContent!.includes("历史委托内容"));
});

test("空闲外部 Agent 与 Pi 一样只在滚动区保留消息，不增加占据间距的空容器", async t => {
  const state = snapshot(); state.agent = "omp";
  state.external = { status: "idle", activities: [], approvals: [] };
  state.messages = [{ id: "history", role: "user", text: "切换前的消息" }];
  const { dom, render } = await mount(t);
  Object.defineProperty(dom.window, "desktopAgent", { value: bridge(state) });
  await render(<DesktopAgent />);
  const history = dom.window.document.querySelector("#message-history")!;
  assert.deepEqual([...history.parentElement!.children].filter(element => !element.hasAttribute("hidden")), [history], "an empty flex item still consumes the scroll area's gap");
});

test("断线仅在 composer 显示警告图标，详情可访问且本机输入仍可用", async t => {
  const state = snapshot();
  state.error = "服务器连接中断，正在自动重连；本机对话已保留。";
  const { dom, render } = await mount(t);
  Object.defineProperty(dom.window, "desktopAgent", { value: bridge(state) });
  await render(<DesktopAgent />);
  const document = dom.window.document;
  const warning = document.querySelector<HTMLElement>(".composer-execution [role='alert']");
  assert.ok(warning);
  assert.equal(warning.title, state.error);
  assert.equal(warning.getAttribute("aria-label"), state.error);
  assert.equal(warning.tabIndex, 0);
  assert.ok(warning.querySelector("svg use"));
  assert.equal(warning.textContent, "");
  assert.equal(document.querySelector(".desktop-agent-error"), null);
  assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")!.disabled, false);
  await render(null);
  state.serverConnected = true; state.collaboration = "ready"; delete state.error;
  await render(<DesktopAgent />);
  assert.equal(document.querySelector("[role='alert']"), null);
  assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="对话执行模式"]')!.value, "local");
  assert.equal(document.querySelectorAll("#mascot-card").length, 1);
});

test("共用导航为 Pi 和外部 Agent 提供新对话，失败保留草稿且重复点击只提交一次", async t => {
  for (const agent of ["pi", "codex"] as const) await t.test(agent, async t => {
    const state = snapshot(); state.agent = agent;
    state.messages = [{ id: "old", role: "user", text: "旧对话" }];
    const native = bridge(state);
    const { dom, render } = await mount(t);
    Object.defineProperty(dom.window, "desktopAgent", { value: native });
    await render(<DesktopAgent />);
    const document = dom.window.document, input = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "未发送草稿");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const button = document.querySelector<HTMLButtonElement>('.workspace-compose');
    assert.ok(button); assert.ok(button.querySelector("svg use")); assert.equal(button.getAttribute("aria-label"), "新对话");
    const fresh = t.mock.method(native, "newSession", async () => { throw new Error("新建失败"); });
    await act(async () => button.click());
    assert.equal(input.value, "未发送草稿");
    assert.match(document.querySelector("#message-history")!.textContent!, /旧对话/);
    assert.match(document.querySelector('[role="alert"]')!.getAttribute("aria-label")!, /新建失败/);
    fresh.mock.mockImplementation(async () => { state.messages = []; });
    await act(async () => { button.click(); button.click(); });
    assert.equal(fresh.mock.callCount(), 2);
    assert.ok(document.querySelector("#message-history .chat-welcome"));
    assert.doesNotMatch(document.querySelector("#message-history")!.textContent!, /旧对话/);
    await act(async () => new Promise<void>(resolve => dom.window.requestAnimationFrame(() => resolve())));
    assert.equal(input.value, ""); assert.equal(document.activeElement, input);
    state.busy = true;
    await render(null); await render(<DesktopAgent />);
    assert.equal(document.querySelector<HTMLButtonElement>('.workspace-compose')!.disabled, true);
    await render(null);
  });
});

test("本机助手使用原生平台避让标题栏，不显示目录选择", async t => {
  const native = { ...bridge(snapshot()), platform: "darwin" };
  const { dom, render } = await mount(t);
  Object.defineProperty(dom.window, "desktopAgent", { value: native });
  await render(<DesktopAgent />);
  const document = dom.window.document;
  assert.equal(document.querySelector("#mascot-card")!.getAttribute("data-desktop"), "darwin");
  assert.equal(document.querySelector(".desktop-agent-workspace"), null);
  assert.ok(!document.body.textContent!.includes("选择工作目录"));
  assert.ok(!document.body.textContent!.includes("服务器工作区"));
  const openServer = t.mock.method(native, "openServer", async () => {});
  const server = document.querySelector<HTMLSelectElement>('[aria-label="对话执行模式"]')!;
  await act(async () => { server.value = "server"; server.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="对话执行模式"]')!.value, "server");
  assert.equal(dom.window.location.hash, "#chat");
  assert.equal(document.querySelectorAll("#mascot-card").length, 1);
  assert.equal(openServer.mock.callCount(), 0);
});

test("本机导航保留对话与草稿，服务器内容按路由打开，轮询不关闭更多菜单", async t => {
  const state = snapshot();
  state.serverConnected = true; state.collaboration = "ready";
  state.messages = [{ id: "local", role: "user", text: "本机会话" }];
  const native = bridge(state);
  const { dom, render } = await mount(t);
  Object.defineProperty(dom.window, "desktopAgent", { value: native });
  await render(<DesktopAgent />);
  const document = dom.window.document;
  const frame = document.querySelector(".workspace-frame"), chat = document.querySelector(".chat-column");
  const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "尚未发送");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const open = t.mock.method(native, "openServer", async (_hash?: string) => {});
  const send = t.mock.method(native, "send", async () => {});
  const fresh = t.mock.method(native, "newSession", async () => {});
  await act(async () => document.querySelector<HTMLAnchorElement>('[aria-label="继续对话"]')!.click());
  assert.equal(open.mock.callCount(), 0);
  for (const [label, hash] of [["Daylight 待办", "#tasks"], ["通知中心", "#activity"]]) {
    await act(async () => document.querySelector<HTMLAnchorElement>(`[aria-label="${label}"]`)!.click());
    assert.equal(dom.window.location.hash, hash);
    assert.equal(open.mock.callCount(), 0);
  }
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="更多菜单"]')!.click());
  await render(<DesktopAgent />);
  assert.equal(document.querySelector('[aria-label="更多菜单"]')!.getAttribute("aria-expanded"), "true");
  await act(async () => document.querySelector<HTMLAnchorElement>('[aria-label="笔记"]')!.click());
  assert.equal(dom.window.location.hash, "#notes");
  assert.equal(open.mock.callCount(), 0);
  assert.equal(document.querySelector('[aria-label="更多菜单"]')!.getAttribute("aria-expanded"), "false");
  assert.equal(document.querySelector(".workspace-frame"), frame);
  assert.equal(document.querySelector(".chat-column"), chat);
  assert.equal(input.value, "尚未发送");
  await act(async () => document.querySelector<HTMLAnchorElement>('[aria-label="继续对话"]')!.click());
  assert.equal(dom.window.location.hash, "#chat/local");
  assert.equal(document.querySelector<HTMLTextAreaElement>("textarea"), input);
  assert.match(document.querySelector("#message-history")!.textContent!, /本机会话/);
  assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="对话执行模式"]')!.value, "local");
  assert.equal(document.querySelectorAll("#mascot-card").length, 1);
  assert.equal(send.mock.callCount(), 0); assert.equal(fresh.mock.callCount(), 0);
  await act(async () => document.querySelector<HTMLAnchorElement>('[aria-label="继续对话"]')!.click());
  assert.equal(dom.window.location.hash, "#chat/local");
  state.serverConnected = false; state.error = "服务器未连接";
  await render(null); await render(<DesktopAgent />);
  assert.match(document.querySelector('.composer-execution [role="alert"]')!.getAttribute("aria-label")!, /服务器未连接/);
  assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")!.disabled, false);
});

test("本机侧栏沿用原有展开和收起状态，切换不重建对话或丢失草稿", async t => {
  const state = snapshot();
  state.messages = [{ id: "local", role: "user", text: "正在继续的本机对话" }];
  const native = bridge(state);
  const { dom, render } = await mount(t);
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
  const { dom, render } = await mount(t);
  Object.defineProperty(dom.window, "desktopAgent", { value: bridge(snapshot()) });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  await render(<DesktopAgent />);
  const document = dom.window.document;
  assert.equal(document.querySelector(".conversation-sidebar")!.getAttribute("data-expanded"), "false");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="展开历史对话"]')!.click());
  assert.equal(document.querySelector('[aria-label="历史对话侧栏"]')!.getAttribute("aria-modal"), "true");
  assert.ok(document.querySelector("#workspace")!.hasAttribute("inert"));
  await act(async () => document.querySelector<HTMLButtonElement>(".history-backdrop")!.click());
  assert.equal(document.querySelector(".history-backdrop"), null);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="展开历史对话"]')!.click());
  await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(document.querySelector(".conversation-sidebar")!.getAttribute("data-expanded"), "false");
  assert.equal(document.activeElement, document.querySelector(".sidebar-toggle"));
  assert.equal(document.querySelector("#workspace")!.hasAttribute("inert"), false);
});

test("本机侧栏与服务模式共用来源、搜索和分组布局，来源跳转不丢失本机对话", async t => {
  const state = snapshot();
  state.messages = [{ id: "local", role: "user", text: "本机待处理事项" }];
  const native = bridge(state);
  const openServer = t.mock.method(native, "openServer", async (_hash?: string) => {});
  const { dom, render } = await mount(t);
  Object.defineProperty(dom.window, "desktopAgent", { value: native });
  await render(<DesktopAgent />);
  const document = dom.window.document, chat = document.querySelector(".chat-column");
  const panel = document.querySelector(".conversation-history")!;
  assert.match(panel.querySelector(".history-search kbd")!.textContent!, /^(⌘K|Ctrl K)$/);
  assert.equal(panel.querySelector(".history-heading")!.textContent, "本机");
  assert.equal(panel.querySelector(".history-row-title")!.textContent, "本机待处理事项");
  assert.ok(panel.querySelector(".conversation-new-button"), "Pi 和外部 Agent 共用新对话入口");
  const source = panel.querySelector<HTMLSelectElement>('[aria-label="切换对话来源"]')!;
  assert.equal(source.value, "assistant");
  await act(async () => {
    source.value = "teams";
    source.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  assert.equal(openServer.mock.callCount(), 0);
  assert.equal(dom.window.location.hash, "#teams");
  await act(async () => document.querySelector<HTMLAnchorElement>('[aria-label="继续对话"]')!.click());
  assert.equal(dom.window.location.hash, "#chat/local");
  assert.match(document.querySelector("#message-history")!.textContent!, /本机待处理事项/);
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
  assert.match(panel.querySelector(".history-list")!.textContent!, /没有匹配的对话/);
  await act(async () => document.querySelector<HTMLButtonElement>(".sidebar-toggle")!.click());
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    await new Promise<void>(resolve => dom.window.requestAnimationFrame(() => resolve()));
  });
  assert.equal(document.querySelector(".conversation-sidebar")!.getAttribute("data-expanded"), "true");
  assert.equal(document.activeElement, search);
  assert.equal(document.querySelector(".chat-column"), chat);
});

test("外部 Agent 的新会话沿用服务模式导航和侧栏入口，执行时禁用", async t => {
  const state = snapshot();
  state.agent = "codex";
  const native = bridge(state), fresh = t.mock.method(native, "newSession", async () => {});
  const { dom, render } = await mount(t);
  Object.defineProperty(dom.window, "desktopAgent", { value: native });
  await render(<DesktopAgent />);
  const document = dom.window.document;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(".workspace-compose, .conversation-new-button")];
  assert.equal(buttons.length, 2);
  for (const button of buttons) await act(async () => button.click());
  assert.equal(fresh.mock.callCount(), 2);
  await render(null);
  state.busy = true;
  await render(<DesktopAgent />);
  assert.ok([...document.querySelectorAll<HTMLButtonElement>(".workspace-compose, .conversation-new-button")].every(button => button.disabled));
});

test("未配置 Pi 禁止发送，不再弹出或提供模型和密钥表单", async t => {
  const state = snapshot(false);
  state.error = "请先在 Pi 中选择默认模型，然后重新选择 Pi。";
  const native = bridge(state);
  const { dom, render } = await mount(t);
  Object.defineProperty(dom.window, "desktopAgent", { value: native });
  await render(<DesktopAgent />);
  const document = dom.window.document;
  assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.disabled, true);
  assert.equal(document.querySelector('[aria-label="本机模型设置"]'), null);
  assert.equal(document.querySelector('[name="apiKey"]'), null);
  assert.equal(document.querySelector(".desktop-agent-panel"), null);
  assert.match(document.querySelector('.composer-execution [role="alert"]')!.getAttribute("aria-label")!, /在 Pi 中选择默认模型/);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="执行 Agent"]')!.click());
  assert.equal(document.querySelector(".agent-picker-footer button"), null);
  const select = t.mock.method(native, "selectAgent", async () => {});
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="选择 Pi"]')!.click());
  assert.deepEqual(select.mock.calls[0]!.arguments, [{ kind: "pi" }]);
  for (let i = 0; i < dom.window.localStorage.length; i++) {
    const key = dom.window.localStorage.key(i)!;
    assert.doesNotMatch(key, /api.?key|secret|token|credential/i);
    assert.doesNotMatch(dom.window.localStorage.getItem(key)!, /api.?key|secret|token|credential|example\.invalid|local-model/i);
  }
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
  const { dom, render } = await mount(t);
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
  const sendButton = document.querySelector<HTMLButtonElement>("#btn-send")!;
  await act(async () => { sendButton.click(); sendButton.click(); });
  assert.equal(send.mock.callCount(), 1);
  await act(async () => reject(new Error("发送结果未确认")));
  assert.match(document.querySelector('.composer-execution [role="alert"]')!.getAttribute("aria-label")!, /发送结果未确认/);
  assert.equal(textarea.value, "检查文件");
  await act(async () => sendButton.click());
  assert.equal(send.mock.callCount(), 2);
  assert.equal(send.mock.calls[0]!.arguments[0]!.id, send.mock.calls[1]!.arguments[0]!.id);
  assert.match(send.mock.calls[0]!.arguments[0]!.id, /^[\da-f-]{36}$/i);
  await act(async () => reject(new Error("发送未完成")));
  assert.match(document.querySelector(".desktop-agent-job")!.textContent!, /等待批准/);
  assert.equal(document.querySelector(".desktop-agent-job .md strong")!.textContent, "请检查工作目录");
  const jobs = [...document.querySelectorAll(".desktop-agent-job")];
  assert.equal(jobs.length, 1, "其他会话及已结束的协作任务不进入当前聊天");
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(".desktop-agent-job-actions button")];
  assert.equal(buttons.length, 2);
  await act(async () => buttons[0]!.click()); assert.equal(approve.mock.calls[0]!.arguments[0], "job-1");
  await act(async () => buttons[1]!.click()); assert.equal(deny.mock.calls[0]!.arguments[0], "job-1");
  assert.equal(document.querySelector("#message-history .assistant-identity strong")!.textContent, "Dee");
  assert.equal(document.querySelector("#message-history script"), null);
});

test("轮询不重叠，卸载后未完成的 snapshot 不再安排下一轮", async t => {
  const native = bridge(snapshot());
  let resolve!: (state: DesktopAgentSnapshot) => void;
  const read = t.mock.method(native, "snapshot", () => new Promise<DesktopAgentSnapshot>(done => { resolve = done; }));
  const { dom, render } = await mount(t);
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
  const { dom, render } = await mount(t);
  Object.defineProperty(dom.window, "desktopAgent", { value: native });
  await render(<DesktopAgent />);
  const document = dom.window.document;
  assert.equal(document.querySelector('[name="apiKey"]'), null);
  assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="执行 Agent"]')!.disabled, true);
  const waiting = document.body.textContent!;
  assert.ok(!document.body.textContent!.includes("native-hidden"));
  assert.equal(document.querySelector(".desktop-agent-request script"), null);
  assert.equal(document.querySelector(".desktop-agent-request pre")!.textContent, "<script>secret()</script>");
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(".desktop-agent-request button")];
  await act(async () => { buttons[1]!.click(); buttons[1]!.click(); });
  assert.equal(answer.mock.callCount(), 1);
  assert.deepEqual(answer.mock.calls[0]!.arguments[0], { id: "approval", allow: false });
  assert.equal(document.querySelector(".desktop-agent-request"), null);
  assert.match(waiting, /等待你处理/);
});

for (const [kind, name] of [["claude", "Claude Code"], ["omp", "OMP"]] as const) test(`switching to ${name} uses the Agent bridge and keeps Pi model form out of the external settings`, async t => {
  const state = snapshot(), native = bridge(state);
  const select = t.mock.method(native, "selectAgent", async (input: DesktopAgentSelection) => { state.agent = input.kind; state.agentConfig = { executable: kind, args: [] }; });
  const { dom, render } = await mount(t);
  Object.defineProperty(dom.window, "desktopAgent", { value: native }); await render(<DesktopAgent />);
  const document = dom.window.document, picker = document.querySelector<HTMLButtonElement>('[aria-label="执行 Agent"]')!;
  await act(async () => picker.click());
  await act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="选择 ${name}"]`)!.click());
  assert.equal(select.mock.calls[0]!.arguments[0]!.kind, kind);
  assert.equal(picker.getAttribute("aria-expanded"), "false");
  assert.match(picker.textContent!, new RegExp(`${name}.*默认模型`));
  assert.equal(document.activeElement, picker);
  if (kind === "claude") {
    assert.equal(document.querySelector('[aria-label="Agent 设置"]'), null);
    assert.equal(document.querySelector('[aria-label="外部 Agent 设置"]'), null);
    return;
  }
  const settingsButton = document.querySelector<HTMLButtonElement>('[aria-label="Agent 设置"]')!;
  await act(async () => settingsButton.click());
  assert.ok(document.querySelector('[aria-label="外部 Agent 设置"]'));
  assert.equal(document.querySelector('[name="apiKey"]'), null);
  assert.equal(document.querySelector<HTMLInputElement>('[name="executable"]')!.value, kind);
});

test("composer picker filters real Agent options, supports keyboard navigation and dismisses without sending", async t => {
  const state = snapshot(), native = bridge(state);
  const send = t.mock.method(native, "send", async () => {});
  const select = t.mock.method(native, "selectAgent", async (input: DesktopAgentSelection) => { state.agent = input.kind; });
  const { dom, render } = await mount(t);
  Object.defineProperty(dom.window, "desktopAgent", { value: native }); await render(<DesktopAgent />);
  const document = dom.window.document, picker = document.querySelector<HTMLButtonElement>('[aria-label="执行 Agent"]')!;
  assert.ok(picker.closest(".input-box-wrapper .composer-execution"));
  assert.equal(document.querySelector(".desktop-agent-workspace [aria-label='执行 Agent']"), null);
  await act(async () => picker.click());
  const search = document.querySelector<HTMLInputElement>('[aria-label="搜索 Agent 或模型"]')!;
  assert.equal(document.activeElement, search);
  assert.deepEqual([...document.querySelectorAll(".agent-picker-option")].map(option => option.getAttribute("aria-label")), ["选择 Pi", "选择 Codex", "选择 Claude Code", "选择 OMP", "选择 ACP Agent"]);
  assert.match(document.querySelector('[aria-label="选择 Pi"]')!.textContent!, /local-model/);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="筛选 OMP"]')!.click());
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
  const { dom, render } = await mount(t);
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
  assert.match(document.querySelector('.composer-execution [role="alert"]')!.getAttribute("aria-label")!, /切换失败/);
  assert.match(picker.textContent!, /Pi.*local-model/);
  assert.equal(picker.disabled, false);
  assert.equal(document.querySelector('[aria-label="选择 Pi"]')!.getAttribute("aria-pressed"), "true");
});
