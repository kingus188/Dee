import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { ConversationView } from "@assistant/contracts";
import { useConversation } from "../dist/chat/useConversation.js";
import { apiClient } from "../dist/api/socket.js";
import { ConversationHistory } from "../dist/ui/ConversationHistory.js";
import { readWorkspaceRoute, workspaceHash } from "../dist/ui/navigation.js";
import { historyGroups, historyTime } from "../dist/ui/history-groups.js";
import { mount } from "./dom.js";

function view(id: number): ConversationView {
  return { conversationId: id, entries: [], live: {}, busy: false, inbox: 0, notes: { todos: [], memos: [] }, usage: null, tasks: [], reminders: [], subagents: [], parentId: null };
}

test("固定链接保留聊天和任务所属会话，非法编号不成为可执行上下文", () => {
  for (const hash of ["#today", "#chat/17", "#schedules/31", "#notes", "#tasks", "#activity", "#memory", "#skills", "#reports", "#settings"]) {
    assert.equal(workspaceHash(readWorkspaceRoute(hash)), hash);
  }
  assert.equal(workspaceHash(readWorkspaceRoute("#notes/9")), "#notes", "旧笔记链接归一到个人笔记，不订阅旧会话");
  assert.equal(readWorkspaceRoute("#notes/9").conversationId, undefined);
  assert.equal(readWorkspaceRoute("#chat/9007199254740992").conversationId, undefined);
  assert.equal(readWorkspaceRoute("#chat/-2").conversationId, undefined);
  assert.equal(readWorkspaceRoute("#__proto__").page, "home");
  assert.equal(readWorkspaceRoute("#memory/8").conversationId, 8);
  assert.equal(workspaceHash(readWorkspaceRoute("#memory/8")), "#memory", "全局记忆不携带会话上下文");
});

test("默认会话晚到不覆盖用户已打开的历史，旧事件不回填，新订阅复用同一请求", async t => {
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "onConnection", () => () => {});
  let listener!: (data: ConversationView) => void;
  t.mock.method(apiClient, "onView", (callback: (data: ConversationView) => void) => { listener = callback; return () => {}; });
  let resolveDefault!: (value: { id: number }) => void;
  t.mock.method(apiClient, "request", async () => new Promise<{ id: number }>(resolve => { resolveDefault = resolve; }));
  const subscriptions: number[] = [];
  let finishSubscription!: () => void;
  t.mock.method(apiClient, "subscribeConversation", async (id: number) => {
    subscriptions.push(id);
    await new Promise<void>(resolve => { finishSubscription = resolve; });
    listener(view(id));
  });
  let current!: ReturnType<typeof useConversation>;
  function Harness() { current = useConversation(); return <p>{current.view?.conversationId ?? "读取中"}</p>; }
  const { dom } = await mount(t, <Harness />);
  let initial!: Promise<number>;
  await act(async () => {
    initial = current.connectDirectChat();
    const selecting = current.openConversation(12);
    assert.equal(current.openConversation(12), selecting);
    finishSubscription(); await selecting;
  });
  await act(async () => { resolveDefault({ id: 7 }); assert.equal(await initial, 12); listener(view(7)); });
  assert.deepEqual(subscriptions, [12]);
  assert.equal(dom.window.document.querySelector("p")!.textContent, "12");
  assert.equal(await current.connectDirectChat(), 12);
});

test("历史对话保留来源与固定链接，排除归档并返回所选会话", async t => {
  t.mock.method(apiClient, "request", async () => [
    { id: 12, title: "产品方案跟进", channel: "wechat", createdAt: "2026-10-21", archivedAt: null },
    { id: 9, title: "已归档的旧讨论", createdAt: "2026-10-20", archivedAt: "2026-10-21" },
  ]);
  const opened: number[] = []; let closed = 0;
  const { dom } = await mount(t, <ConversationHistory active currentId={12} onOpen={id => opened.push(id)} onClose={() => closed++} />);
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll(".history-list a").length, 1);
  const link = doc.querySelector<HTMLAnchorElement>(".history-list a")!;
  assert.equal(link.getAttribute("href"), "#chat/12");
  assert.match(link.textContent!, /微信/);
  assert.doesNotMatch(doc.body.textContent!, /已归档的旧讨论/);
  await act(async () => { link.click(); });
  assert.deepEqual(opened, [12]);
  await act(async () => { doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(closed, 1);
});


test("具体待办固定链接保留不透明编号，编码异常和非待办页面不携带目标", () => {
  const taskId = "project-b/task #设计";
  const route = { page: "daylight", group: null, taskId } as const;
  assert.equal(workspaceHash(route), "#tasks/project-b%2Ftask%20%23%E8%AE%BE%E8%AE%A1");
  assert.deepEqual(readWorkspaceRoute(workspaceHash(route)), route);
  assert.equal(readWorkspaceRoute("#tasks/%E0%A4%A").taskId, undefined);
  assert.equal(readWorkspaceRoute("#tasks/%00").taskId, undefined);
  assert.equal(readWorkspaceRoute("#tasks/one/extra").taskId, undefined);
  assert.equal(readWorkspaceRoute("#activity/task-id").taskId, undefined);
  assert.equal(workspaceHash({ ...route, page: "home" }), "#today");
});

test("Teams 固定链接使用独立的不透明编号，异常链接仅返回会话列表", () => {
  const chatId = "19:group/产品 #讨论@thread.v2";
  const route = { page: "teams", group: null, chatId } as const;
  assert.equal(workspaceHash(route), "#teams/19%3Agroup%2F%E4%BA%A7%E5%93%81%20%23%E8%AE%A8%E8%AE%BA%40thread.v2");
  assert.deepEqual(readWorkspaceRoute(workspaceHash(route)), route);
  assert.deepEqual(readWorkspaceRoute("#teams"), { page: "teams", group: null });
  for (const hash of ["#teams/%E0%A4%A", "#teams/%00", "#teams/one/extra", "#teams/%20", `#teams/${"a".repeat(2049)}`]) {
    assert.deepEqual(readWorkspaceRoute(hash), { page: "teams", group: null });
  }
  assert.equal(readWorkspaceRoute("#teams/12").conversationId, undefined, "Teams 编号不能订阅助手会话");
  assert.equal(workspaceHash({ ...route, page: "chat" }), "#chat");
  assert.equal(workspaceHash({ ...route, page: "teams", conversationId: 12 }), workspaceHash(route));
});

test("历史对话按本地日期分组，只有带时刻的今天条目显示时间", () => {
  const now = new Date(2026, 10, 7, 12);
  const at = (day: number, hour = 9) => new Date(2026, 10, day, hour, 8).toISOString();
  const item = (id: number, createdAt: string) => ({ id, title: String(id), createdAt });
  const groups = historyGroups([item(1, at(7)), item(2, at(6)), item(3, at(3)), item(4, at(-1))], undefined, now);
  assert.deepEqual(groups.map(group => [group.label, group.items.map(entry => entry.id)]), [["今天", [1]], ["昨天", [2]], ["本周", [3]], ["更早", [4]]]);
  assert.equal(historyTime(at(7), now), "09:08");
  assert.equal(historyTime("2026-11-07", now), "");
  assert.equal(historyTime("bad", now), "");
  assert.deepEqual(historyGroups([item(1, at(1))], "搜索结果", now).map(group => group.label), ["搜索结果"]);
});
