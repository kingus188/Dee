import test from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import type { ConversationView } from "@assistant/contracts";
import { WorkspaceNavigation } from "../dist/ui/WorkspaceNavigation.js";
import { ConversationHistory } from "../dist/ui/ConversationHistory.js";
import { readWorkspaceRoute, workspaceHash, type WorkspaceRoute } from "../dist/ui/navigation.js";
import { ChatThread } from "../dist/chat/ChatThread.js";
import { LocalSkillsPage } from "../dist/workspace/LocalSkillsPage.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

test("默认从对话开始，今日和远程技能保留可恢复的固定链接", () => {
  for (const hash of ["", "#", "#/"]) assert.equal(readWorkspaceRoute(hash).page, "chat");
  assert.equal(readWorkspaceRoute("#today").page, "home");
  assert.deepEqual(readWorkspaceRoute("#skills/remote"), { page: "data", group: "skills", skillSource: "remote" });
  assert.equal(workspaceHash(readWorkspaceRoute("#skills/remote")), "#skills/remote");
  assert.equal(readWorkspaceRoute("#skills/remote/extra").skillSource, undefined);
  assert.equal(workspaceHash({ page: "chat", group: null, skillSource: "remote" }), "#chat");
});

test("常驻仅三个入口，更多展开后可导航，Escape 和外部焦点可收起", async t => {
  function Harness() { const [route, setRoute] = useState<WorkspaceRoute>({ page: "chat", group: null }); return <><WorkspaceNavigation route={route} onNavigate={setRoute} onHelp={() => {}} /><button id="outside">外部内容</button></>; }
  const { dom } = await mount(t, <Harness />), doc = dom.window.document;
  const more = doc.querySelector<HTMLButtonElement>(".workspace-more-button")!, panel = doc.querySelector<HTMLElement>("#workspace-personal-nav")!;
  assert.equal(doc.querySelectorAll(".workspace-primary-nav > a").length, 3);
  assert.equal(panel.hidden, true);
  await act(async () => { more.click(); });
  assert.equal(panel.hidden, false);
  assert.equal(more.getAttribute("aria-expanded"), "true");
  await act(async () => { doc.querySelector<HTMLAnchorElement>('[aria-label="长期记忆"]')!.click(); });
  assert.equal(panel.hidden, true);
  assert.equal(more.dataset.active, "true");
  assert.equal(doc.activeElement, more);
  await act(async () => { more.click(); doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  // Run Escape in its own event boundary after the open effect is installed.
  if (!panel.hidden) await act(async () => { doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(panel.hidden, true);
  assert.equal(doc.activeElement, more);
  await act(async () => { more.click(); });
  await act(async () => { doc.querySelector<HTMLButtonElement>("#outside")!.focus(); });
  assert.equal(panel.hidden, true);
});

test("空对话安静欢迎，进行中状态不会误显示空白欢迎", async t => {
  const view: ConversationView = { conversationId: 1, entries: [], live: {}, busy: false, inbox: 0, notes: { todos: [], memos: [] }, usage: null, tasks: [], reminders: [], subagents: [], parentId: null };
  const mounted = await mount(t, <ChatThread view={view} />);
  assert.match(mounted.dom.window.document.querySelector("h1")!.textContent!, /有什么想交给我/);
  assert.equal(mounted.dom.window.document.querySelector(".response-copy"), null);
  await mounted.render(<ChatThread view={{ ...view, busy: true }} />);
  assert.equal(mounted.dom.window.document.querySelector(".chat-welcome"), null);
  assert.ok(mounted.dom.window.document.querySelector('[aria-label="正在回复"]'));
});

test("历史面板只在打开时聚焦，不因父组件重绘抢走焦点", async t => {
  t.mock.method(apiClient, "request", async () => []);
  const mounted = await mount(t, <ConversationHistory active currentId={null} onOpen={() => {}} onClose={() => {}} />), doc = mounted.dom.window.document;
  assert.equal(doc.activeElement?.getAttribute("aria-label"), "搜索历史对话");
  const close = doc.querySelector<HTMLButtonElement>('[aria-label="关闭历史对话"]')!;
  close.focus();
  await mounted.render(<ConversationHistory active currentId={null} onOpen={() => {}} onClose={() => {}} />);
  assert.equal(doc.activeElement, close);
});

test("远程技能入口直接展示待确认记录，读取本身不会批准", async t => {
  const writes: string[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    if (body !== undefined) writes.push(path);
    return { memory: [], skills: [{ id: "candidate", name: "每周回顾", description: "每周整理", body: "逐项核对", status: "pending", source: "agent", createdAt: 1, decidedAt: null }], knowledge: { enabled: false, allow: [] } };
  });
  const { dom } = await mount(t, <LocalSkillsPage active remote />);
  const remotePage = dom.window.document.querySelector('[data-kind="skills"]')!;
  assert.match(remotePage.textContent!, /每周回顾/);
  assert.match(remotePage.textContent!, /待确认/);
  assert.deepEqual(writes, []);
});
