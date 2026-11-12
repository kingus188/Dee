import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { TeamsConversationReply, TeamsConversationReplyResult } from "@assistant/contracts";
import { TeamsReplyComposer } from "../dist/teams/TeamsReplyComposer.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const props = { chatId: "chat", active: true, available: true, readable: true, onSent: () => {} };
type View = Awaited<ReturnType<typeof mount>>;
async function type(view: View, value: string) {
  const input = view.dom.window.document.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(view.dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
  });
}
function submit(view: View) { view.dom.window.document.querySelector("form")!.dispatchEvent(new view.dom.window.Event("submit", { bubbles: true, cancelable: true })); }
const result = (body: TeamsConversationReply, state: TeamsConversationReplyResult["state"]): TeamsConversationReplyResult => ({ requestId: body.requestId, chatId: body.chatId, state });

test("direct Teams reply sends exact text to the selected chat once, then clears and refreshes", async t => {
  const writes: TeamsConversationReply[] = []; let finish!: (value: unknown) => void, refreshed = 0;
  t.mock.method(apiClient, "request", async (path: string, body: TeamsConversationReply) => { assert.equal(path, "/api/teams/conversations/reply"); writes.push(body); return new Promise(resolve => { finish = resolve; }); });
  const view = await mount(t, <TeamsReplyComposer {...props} onSent={() => { refreshed++; }} />), doc = view.dom.window.document;
  assert.equal(doc.querySelector<HTMLButtonElement>("[type=submit]")!.disabled, true);
  await type(view, "收到\n<script>literal</script>");
  await act(async () => { submit(view); submit(view); });
  assert.equal(writes.length, 1); assert.equal(writes[0].chatId, "chat"); assert.equal(writes[0].text, "收到\n<script>literal</script>");
  assert.equal(doc.querySelector("textarea")!.disabled, true); assert.match(doc.body.textContent!, /正在发送/);
  await act(async () => { finish(result(writes[0], "sent")); });
  assert.equal(doc.querySelector("textarea")!.value, ""); assert.equal(refreshed, 1);
  assert.match(doc.querySelector('[role="status"]')!.textContent!, /已发送到 Teams/);
  assert.equal(view.dom.window.sessionStorage.getItem("dee.teams.reply:chat"), null);
});

test("rejected replies retain editable text, while unknown replies keep their request across remounts", async t => {
  const writes: TeamsConversationReply[] = []; let mode: "rejected" | "disconnect" | "sent" = "rejected";
  t.mock.method(apiClient, "request", async (_path: string, body: TeamsConversationReply) => {
    writes.push(body); if (mode === "disconnect") throw new Error("连接中断");
    return { ...result(body, mode), ...(mode === "rejected" ? { error: "需要 ChatMessage.Send 授权" } : {}) };
  });
  const view = await mount(t, <TeamsReplyComposer {...props} />), doc = view.dom.window.document;
  await type(view, "保留的回复"); await act(async () => { submit(view); });
  assert.equal(doc.querySelector("textarea")!.value, "保留的回复"); assert.equal(doc.querySelector("textarea")!.disabled, false);
  assert.match(doc.querySelector('[role="alert"]')!.textContent!, /ChatMessage.Send/);
  mode = "disconnect"; await act(async () => { submit(view); });
  assert.notEqual(writes[0].requestId, writes[1].requestId);
  assert.equal(doc.querySelector("textarea")!.disabled, true);
  await view.render(null); await view.render(<TeamsReplyComposer {...props} />);
  assert.equal(doc.querySelector("textarea")!.value, "保留的回复"); assert.match(doc.body.textContent!, /结果未确认/);
  assert.equal(writes.length, 2, "remounts must not send automatically");
  mode = "sent"; await act(async () => { submit(view); });
  assert.equal(writes[2].requestId, writes[1].requestId); assert.equal(doc.querySelector("textarea")!.value, "");
});

test("an old chat's late acknowledgement never clears or refreshes the newly selected chat", async t => {
  let finish!: (value: unknown) => void, oldBody!: TeamsConversationReply, refreshed = 0;
  t.mock.method(apiClient, "request", async (_path: string, body: TeamsConversationReply) => { oldBody = body; return new Promise(resolve => { finish = resolve; }); });
  const view = await mount(t, <TeamsReplyComposer key="chat" {...props} onSent={() => { refreshed++; }} />);
  await type(view, "旧会话回复"); await act(async () => { submit(view); });
  await view.render(<TeamsReplyComposer key="other" {...props} chatId="other" onSent={() => { refreshed++; }} />);
  await type(view, "新会话草稿"); await act(async () => { finish(result(oldBody, "sent")); });
  assert.equal(view.dom.window.document.querySelector("textarea")!.value, "新会话草稿"); assert.equal(refreshed, 0);
});

test("unreadable, hidden, empty or oversized replies cannot send; read-only connections have no composer", async t => {
  let writes = 0; t.mock.method(apiClient, "request", async () => { writes++; });
  const view = await mount(t, <TeamsReplyComposer {...props} />);
  for (const text of [" \n", "中".repeat(5334)]) {
    await type(view, text); await act(async () => { submit(view); });
    assert.equal(view.dom.window.document.querySelector<HTMLButtonElement>("[type=submit]")!.disabled, true);
  }
  await type(view, "允许的正文");
  await view.render(<TeamsReplyComposer {...props} readable={false} />); await act(async () => { submit(view); });
  await view.render(<TeamsReplyComposer {...props} active={false} />); await act(async () => { submit(view); });
  await view.render(<TeamsReplyComposer {...props} available={false} />);
  assert.equal(view.dom.window.document.querySelector("textarea"), null); assert.equal(writes, 0);
});

test("unknown result is never treated as success and requires an explicit acknowledgement before editing", async t => {
  t.mock.method(apiClient, "request", async (_path: string, body: TeamsConversationReply) => result(body, "unknown"));
  const view = await mount(t, <TeamsReplyComposer {...props} />), doc = view.dom.window.document;
  await type(view, "尚未确认的回复"); await act(async () => { submit(view); });
  assert.equal(doc.querySelector('[role="status"]'), null); assert.equal(doc.querySelector("textarea")!.disabled, true);
  await act(async () => { doc.querySelector<HTMLButtonElement>("button[type=button]")!.click(); });
  assert.equal(doc.querySelector("textarea")!.value, ""); assert.equal(doc.querySelector("textarea")!.disabled, false);
  assert.equal(view.dom.window.sessionStorage.getItem("dee.teams.reply:chat"), null);
});

test("unavailable browser storage prevents sending rather than losing the duplicate guard", async t => {
  let writes = 0; t.mock.method(apiClient, "request", async () => { writes++; });
  const view = await mount(t, <TeamsReplyComposer {...props} />);
  t.mock.method(view.dom.window.Storage.prototype, "setItem", () => { throw new Error("unavailable"); });
  await type(view, "安全的回复"); await act(async () => { submit(view); });
  assert.equal(writes, 0); assert.match(view.dom.window.document.body.textContent!, /尚未发送/);
});

test("a late acknowledgement cannot erase a newer pending reply in the same chat", async t => {
  const writes: TeamsConversationReply[] = [], finishes: ((value: unknown) => void)[] = [];
  t.mock.method(apiClient, "request", async (_path: string, body: TeamsConversationReply) => { writes.push(body); return new Promise(resolve => { finishes.push(resolve); }); });
  const view = await mount(t, <TeamsReplyComposer {...props} />), doc = view.dom.window.document;
  await type(view, "第一份回复"); await act(async () => { submit(view); });
  await view.render(null); await view.render(<TeamsReplyComposer {...props} />);
  await act(async () => { doc.querySelector<HTMLButtonElement>("button[type=button]")!.click(); });
  await type(view, "核对后发送第二份回复"); await act(async () => { submit(view); });
  await act(async () => { finishes[0](result(writes[0], "sent")); });
  assert.equal(JSON.parse(view.dom.window.sessionStorage.getItem("dee.teams.reply:chat")!).requestId, writes[1].requestId);
  assert.equal(doc.querySelector("textarea")!.value, "核对后发送第二份回复");
  await act(async () => { finishes[1](result(writes[1], "sent")); });
  assert.equal(view.dom.window.sessionStorage.getItem("dee.teams.reply:chat"), null);
});
