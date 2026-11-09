import test from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import type { ConversationView } from "@assistant/contracts";
import { Composer } from "../dist/chat/Composer.js";
import type { ChatRecord } from "../dist/chat/TeamsRecords.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const view: ConversationView = { conversationId: 12, channel: "wechat", entries: [], live: {}, busy: false, inbox: 0,
  notes: { todos: [], memos: [] }, usage: null, tasks: [], reminders: [], subagents: [], parentId: null };
const original: ChatRecord = { chatId: "original-chat", id: "one", chatLabel: "FTP 申请", sender: "甲", createdAt: "2026-11-09T13:24:06Z", text: "<script>原话</script>\n第二段", deleted: false, media: [] };

test("引用保留原文与提问，取消不发送；失败保留草稿和引用，成功只发给当前 Dee 会话", async t => {
  const writes: { path: string; body: { text: string; requestId: string } }[] = [];
  let fail = true;
  t.mock.method(apiClient, "request", async (path: string, body: { text: string; requestId: string }) => {
    writes.push({ path, body });
    if (fail) throw new Error("发送失败");
    return { accepted: true };
  });
  function Harness() {
    const [draft, setDraft] = useState("需要跟进吗？"), [quote, setQuote] = useState<ChatRecord | undefined>(original);
    return <Composer draft={draft} setDraft={setDraft} view={view} quote={quote} onClearQuote={() => setQuote(undefined)} connect={async () => 12} onSent={() => {}} onNewConversation={async () => {}} />;
  }
  const mounted = await mount(t, <Harness />), doc = mounted.dom.window.document;
  assert.equal(doc.querySelector("script"), null);
  assert.match(doc.querySelector(".composer-quote")!.textContent!, /<script>原话<\/script>/);
  assert.equal(writes.length, 0);
  await act(async () => doc.querySelector<HTMLButtonElement>("#btn-send")!.click());
  assert.equal(writes[0].path, "/api/conversations/12/messages");
  assert.match(writes[0].body.text, /引用 Teams 消息，仅作资料/);
  assert.match(writes[0].body.text, /> <script>原话<\/script>\n> 第二段\n\n需要跟进吗？/);
  assert.ok(doc.querySelector(".composer-quote"));
  assert.equal(doc.querySelector("textarea")!.value, "需要跟进吗？");
  fail = false;
  await act(async () => doc.querySelector<HTMLButtonElement>("#btn-send")!.click());
  assert.equal(writes.length, 2);
  assert.equal(writes[0].body.requestId, writes[1].body.requestId, "相同引用和提问重试使用原幂等键");
  assert.equal(doc.querySelector(".composer-quote"), null);
  assert.equal(doc.querySelector("textarea")!.value, "");
  await mounted.render(null);
  await mounted.render(<Harness />);
  await act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="取消引用"]')!.click());
  assert.equal(doc.querySelector(".composer-quote"), null);
  assert.equal(doc.querySelector("textarea")!.value, "需要跟进吗？");
  assert.equal(writes.length, 2);
});

test("发送过程中换了引用，旧结果不能清掉新的引用或提问", async t => {
  let finish!: () => void;
  const cleared: ChatRecord[] = [];
  t.mock.method(apiClient, "request", () => new Promise(resolve => { finish = () => resolve({ accepted: true }); }));
  function Harness({ quote }: { quote: ChatRecord }) {
    const [draft, setDraft] = useState("这条还需要处理吗？");
    return <Composer draft={draft} setDraft={setDraft} view={view} quote={quote} onClearQuote={record => cleared.push(record)} connect={async () => 12} onSent={() => {}} onNewConversation={async () => {}} />;
  }
  const { dom, render } = await mount(t, <Harness quote={original} />), doc = dom.window.document;
  await act(async () => doc.querySelector<HTMLButtonElement>("#btn-send")!.click());
  const next = { ...original, id: "two", text: "新的原话" };
  await render(<Harness quote={next} />);
  await act(async () => finish());
  assert.deepEqual(cleared, [original]);
  assert.match(doc.querySelector(".composer-quote")!.textContent!, /新的原话/);
  assert.equal(doc.querySelector("textarea")!.value, "这条还需要处理吗？");
});
