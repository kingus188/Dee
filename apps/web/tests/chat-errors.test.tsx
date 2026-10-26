import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationView, ViewEntry } from "@assistant/contracts";
import { ChatThread } from "../dist/chat/ChatThread.js";
import { describeModelError } from "../dist/chat/model-errors.js";
import { mount } from "./dom.js";
const overloaded = "Our servers are currently overloaded. Please try again later.";
const failed: ViewEntry[] = [{ id: 1, kind: "user", text: "who are you?" }, { id: 2, kind: "assistant", text: "", error: overloaded }];
function view(entries = failed, busy = false): ConversationView {
  return { conversationId: 7, entries, busy, live: {}, inbox: 0, usage: null, notes: { todos: [], memos: [] }, tasks: [], reminders: [], subagents: [], parentId: null };
}

test("模型错误使用中文摘要，原文折叠且重试只交回草稿", async t => {
  const drafts: string[] = [];
  const { dom } = await mount(t, <ChatThread view={view()} onRetry={text => drafts.push(text)} />);
  const card = dom.window.document.querySelector('[role="alert"]')!;
  assert.match(card.querySelector(".model-error-title")!.textContent!, /服务有点忙/);
  const detail = card.querySelector("details")!;
  assert.equal(detail.open, false); assert.equal(detail.querySelector("pre")!.textContent, overloaded);
  await act(async () => { card.querySelector<HTMLButtonElement>("button")!.click(); });
  assert.deepEqual(drafts, ["who are you?"]);
});

test("重试成功收起旧错误，失败记录仍保留在处理过程", () => {
  const html = renderToStaticMarkup(<ChatThread view={view([...failed, { id: 3, kind: "assistant", text: "我是小 D" }])} />);
  assert.doesNotMatch(html, /role="alert"/);
  assert.match(html, /我是小 D/); assert.match(html, /turn-activities/); assert.match(html, /overloaded/);
});
test("重试过程中不残留失败警告，后续再次失败只显示最新错误", () => {
  assert.doesNotMatch(renderToStaticMarkup(<ChatThread view={view(failed, true)} />), /role="alert"/);
  const html = renderToStaticMarkup(<ChatThread view={view([...failed, { id: 3, kind: "assistant", text: "早先回复" }, { id: 4, kind: "assistant", text: "", error: "429 rate limit" }])} />);
  assert.equal(html.match(/role="alert"/g)?.length, 1); assert.match(html, /请求有点频繁/);
});

test("额度、鉴权、限流、超时和上下文错误各有具体指引", () => {
  for (const [error, title] of [["429 insufficient_quota", "模型服务的可用额度不足"], ["401 invalid_api_key", "模型服务暂未连接好"], ["429 rate limit", "请求有点频繁，稍等一下"], ["ETIMEDOUT", "这次连接没有完成"], ["maximum context length", "这段对话有点长了"], ["unexpected failure", "这次回复没有完成"]]) assert.equal(describeModelError(error).title, title);
});
test("错误详情转义，不把服务返回当作 HTML", () => {
  const html = renderToStaticMarkup(<ChatThread view={view([failed[0]!, { id: 2, kind: "assistant", text: "", error: "<script>alert(1)</script>" }])} />);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
});

test("配置错误直达设置，草稿占用时不提供覆盖入口", async t => {
  let opened = 0;
  const entries = [failed[0]!, { id: 2, kind: "assistant" as const, text: "", error: "401 invalid_api_key" }];
  const { dom } = await mount(t, <ChatThread view={view(entries)} onSettings={() => opened++} />);
  const button = dom.window.document.querySelector<HTMLButtonElement>('[role="alert"] button')!;
  assert.equal(button.textContent, "查看服务器模型");
  await act(async () => { button.click(); }); assert.equal(opened, 1);
  const html = renderToStaticMarkup(<ChatThread view={view()} />);
  assert.doesNotMatch(html, /编辑后重试/);
});
