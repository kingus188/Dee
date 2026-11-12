import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { act } from "react";
import type { ConversationView, DesktopAgentBridge, DesktopAgentSnapshot } from "@assistant/contracts";
import { App } from "../dist/ui/App.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const serverView: ConversationView = { conversationId: 12, entries: [{ id: 1, kind: "user", text: "服务端记录" }], live: {}, busy: false, inbox: 0, notes: { todos: [], memos: [] }, usage: null, tasks: [], reminders: [], subagents: [], parentId: null };

test("网页与桌面入口始终挂载同一个 App，不按执行能力分叉 UI", async () => {
  const entry = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(entry, /\.render\(<App\s*\/>\)/);
  assert.doesNotMatch(entry, /<DesktopAgent/);
});

test("同一工作区切换执行目标，草稿和消息隔离，导航与新建不打开另一窗口", async t => {
  let onView: (view: ConversationView) => void = () => {};
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "onConnection", (listener: (state: "connected") => void) => { listener("connected"); return () => {}; });
  t.mock.method(apiClient, "onView", (listener: typeof onView) => { onView = listener; return () => {}; });
  t.mock.method(apiClient, "subscribeConversation", async () => { onView(serverView); });
  const requests = t.mock.method(apiClient, "request", async (path: string) => {
    if (path === "/api/info") return { configured: true, boots: 1 };
    if (path === "/api/conversations/direct") return { id: 12 };
    if (path === "/api/conversations") return [{ id: 12, title: "服务端记录", channel: "web", createdAt: "2026-11-12" }];
    if (path.endsWith("/notes")) return { todos: [], memos: [] };
    if (path === "/api/personal") return { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
    return { items: [], total: 0, schedules: [], reminders: [], background: [] };
  });
  const state: DesktopAgentSnapshot = { agent: "codex", configured: true, model: { api: "", baseUrl: "", model: "", contextWindow: 64000, maxTokens: 4096, hasApiKey: false }, workspace: null, nodeId: "desktop", busy: false, serverConnected: true, messages: [{ id: "one", role: "user", text: "本机记录" }], jobs: [] };
  const native: DesktopAgentBridge = { platform: "darwin", snapshot: async () => structuredClone(state), selectAgent: async () => {}, newSession: async () => { state.messages = []; }, answerApproval: async () => {}, send: async () => {}, chooseWorkspace: async () => {}, approve: async () => {}, reject: async () => {}, abort: async () => {}, openServer: async () => {}, openConnection: async () => {} };
  const send = t.mock.method(native, "send"), open = t.mock.method(native, "openServer"), fresh = t.mock.method(native, "newSession");
  const { dom, render } = await mount(t, null);
  Object.defineProperty(dom.window, "desktopAgent", { value: native });
  await render(<App />);
  const doc = dom.window.document, shell = doc.querySelector("#mascot-card"), sidebar = doc.querySelector(".sidebar");
  const target = () => doc.querySelector<HTMLSelectElement>('[aria-label="对话执行模式"]')!;
  assert.ok(target(), "执行目标必须在共用对话界面内选择");
  assert.equal(doc.querySelectorAll("#mascot-card").length, 1);
  assert.equal(doc.querySelectorAll(".conversation-sidebar").length, 1);
  assert.match(doc.querySelector("#message-history")!.textContent!, /本机记录/);
  async function type(text: string) {
    const input = doc.querySelector<HTMLTextAreaElement>("#chat-textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  }
  async function select(value: string) { await act(async () => { target().value = value; target().dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); }
  await type("本机草稿");
  await select("server");
  assert.match(doc.querySelector("#message-history")!.textContent!, /服务端记录/);
  assert.doesNotMatch(doc.querySelector("#message-history")!.textContent!, /本机记录/);
  await type("服务器草稿");
  await select("local");
  assert.equal(doc.querySelector<HTMLTextAreaElement>("#chat-textarea")!.value, "本机草稿");
  await act(async () => doc.querySelector<HTMLAnchorElement>('[aria-label="通知中心"]')!.click());
  assert.equal(doc.querySelector("#mascot-card"), shell);
  assert.equal(doc.querySelector(".sidebar"), sidebar);
  assert.equal(dom.window.location.hash, "#activity");
  await act(async () => doc.querySelector<HTMLAnchorElement>('[aria-label="继续对话"]')!.click());
  assert.equal(doc.querySelector<HTMLTextAreaElement>("#chat-textarea")!.value, "本机草稿");
  await act(async () => doc.querySelector<HTMLButtonElement>("#btn-send")!.click());
  assert.equal(send.mock.callCount(), 1);
  assert.equal(send.mock.calls[0]!.arguments[0]!.text, "本机草稿");
  assert.equal(requests.mock.calls.filter(call => /\/messages$/.test(String(call.arguments[0]))).length, 0);
  await select("server");
  assert.equal(doc.querySelector<HTMLTextAreaElement>("#chat-textarea")!.value, "服务器草稿");
  await select("local");
  await act(async () => doc.querySelector<HTMLButtonElement>(".conversation-new-button")!.click());
  assert.equal(fresh.mock.callCount(), 1);
  assert.equal(open.mock.callCount(), 0);
  assert.equal(dom.window.location.hash, "#chat/local");
  await act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="更多菜单"]')!.click());
  await act(async () => doc.querySelector<HTMLAnchorElement>('[aria-label="笔记"]')!.click());
  assert.equal(requests.mock.calls.some(call => String(call.arguments[0]).includes("/-1/")), false, "服务器数据页不能使用本机虚拟会话编号");
  await act(async () => doc.querySelector<HTMLAnchorElement>('[aria-label="继续对话"]')!.click());
  let finishNew!: () => void;
  fresh.mock.mockImplementation(() => new Promise<void>(resolve => { finishNew = resolve; }));
  await act(async () => doc.querySelector<HTMLButtonElement>(".conversation-new-button")!.click());
  await select("server");
  await type("新建本机对话期间的服务器草稿");
  await act(async () => finishNew());
  assert.equal(target().value, "server", "旧新建请求不能把切换后的工作区拉回本机");
  assert.equal(doc.querySelector<HTMLTextAreaElement>("#chat-textarea")!.value, "新建本机对话期间的服务器草稿");
});
