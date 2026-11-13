import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { apiClient } from "../dist/api/socket.js";
import { ConversationHistory } from "../dist/ui/ConversationHistory.js";
import type { DesktopAgentSnapshot } from "@assistant/contracts";
import { mount } from "./dom.js";

test("运行中的会话只出现在底部分组，完成后回到历史；搜索和更多记录保持可用", async t => {
  const items = Array.from({ length: 9 }, (_, index) => ({ id: index + 1, title: `方案 ${index + 1}`, channel: index === 0 ? "wechat" : "web", createdAt: "2026-11-11T08:00:00Z" }));
  t.mock.method(apiClient, "request", async () => items);
  const opened: number[] = [];
  const props = { active: true, currentId: 9, onOpen: (id: number) => opened.push(id), onClose: () => {} };
  const { dom, render } = await mount(t, <ConversationHistory {...props} workingId={9} />);
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('.history-list a[href="#chat/9"]').length, 0);
  const running = doc.querySelector<HTMLAnchorElement>('.history-bottom a[href="#chat/9"]')!;
  assert.equal(running.getAttribute("aria-current"), "true");
  assert.equal(running.querySelector(".history-row-status")?.textContent, "Running");
  assert.match(doc.querySelector('a[href="#chat/1"]')!.getAttribute("title")!, /微信接收方/);
  await act(async () => running.click());
  assert.deepEqual(opened, [9]);
  await act(async () => doc.querySelector<HTMLButtonElement>(".history-older")!.click());
  assert.equal(doc.querySelectorAll(".history-list a").length, 8);
  const input = doc.querySelector<HTMLInputElement>(".history-search input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "方案 9");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(doc.querySelectorAll(".history-row").length, 1);
  await render(<ConversationHistory {...props} />);
  assert.equal(doc.querySelector(".history-working"), null);
  assert.equal(doc.querySelector(".history-list .history-row-title")?.textContent, "方案 9");
  assert.equal(doc.querySelector(".history-row-status"), null, "历史记录没有状态时不能标为已完成");
});

test("本机侧栏使用真实 Agent 状态和目录，等待批准不误标为运行中", async t => {
  const state: DesktopAgentSnapshot = {
    agent: "codex", configured: true, busy: true, workspace: "/projects/dee-agent",
    nodeId: "desktop", serverConnected: false, jobs: [], messages: [{ id: "1", role: "user", text: "处理侧栏布局" }],
    model: { api: "", baseUrl: "", model: "", contextWindow: 0, maxTokens: 0, hasApiKey: false },
    external: { status: "waiting", activities: [], approvals: [] },
  };
  t.mock.method(apiClient, "request", async () => []);
  function Sidebar({ snapshot }: { snapshot: DesktopAgentSnapshot }) {
    return <ConversationHistory active currentId={null} onOpen={() => {}} onClose={() => {}} local={{ title: snapshot.messages[0]!.text, current: true, busy: snapshot.busy, detail: snapshot.workspace!.split("/").at(-1), status: snapshot.external?.status === "idle" ? undefined : snapshot.external?.status, open: () => {} }} />;
  }
  const { dom, render } = await mount(t, <Sidebar snapshot={state} />);
  const doc = dom.window.document;
  assert.equal(doc.querySelector(".history-bottom .history-row-title")?.textContent, "处理侧栏布局");
  assert.equal(doc.querySelector(".history-row-detail")?.textContent, "dee-agent");
  assert.equal(doc.querySelector(".history-row-status")?.textContent, "Awaiting confirmation");
  assert.equal(doc.querySelectorAll(".history-row").length, 1);
  await render(<Sidebar snapshot={{ ...state, busy: false, external: { status: "done", activities: [], approvals: [] } }} />);
  assert.equal(doc.querySelector(".history-working"), null);
  assert.equal(doc.querySelector(".history-list .history-row-status")?.textContent, "Completed");
});
