import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationView } from "@assistant/contracts";
import { ChatThread, ResponseCard } from "../dist/chat/ChatThread.js";
import { chatTimestamp } from "../dist/chat/timestamps.js";
import { mount } from "./dom.js";

function conversation(entries: ConversationView["entries"], live: ConversationView["live"] = {}): ConversationView {
  return { conversationId: 12, entries, live, busy: Object.keys(live).length > 0, inbox: 0, usage: null, notes: { todos: [], memos: [] }, tasks: [], reminders: [], subagents: [], parentId: null };
}

test("消息日期按本地日历分组，时分来自原始记录而非当前时间", async t => {
  const first = new Date(2026, 9, 21, 10, 2).getTime(), second = new Date(2026, 9, 22, 8, 30).getTime();
  const view = conversation([
    { id: 1, kind: "user", text: "本周怎么安排？", timestamp: first },
    { id: 2, kind: "assistant", text: "- 周一：整理需求\n- 周二：完成初稿", timestamp: first + 180_000 },
    { id: 3, kind: "user", text: "邮件呢？", timestamp: first + 600_000 },
    { id: 4, kind: "assistant", text: "每天安排半小时。", timestamp: first + 720_000 },
    { id: 5, kind: "user", text: "继续昨天的安排", timestamp: second },
    { id: 6, kind: "assistant", text: "接下来准备汇报。", timestamp: second + 60_000 },
  ]);
  const { dom } = await mount(t, <ChatThread view={view} />), doc = dom.window.document;
  assert.deepEqual([...doc.querySelectorAll(".chat-day-separator time")].map(time => time.getAttribute("datetime")), ["2026-10-21", "2026-10-22"]);
  assert.deepEqual([...doc.querySelectorAll(".user-row > .message-time")].map(time => time.textContent), ["10:02", "10:12", "08:30"]);
  assert.deepEqual([...doc.querySelectorAll(".assistant-identity .message-time")].map(time => time.textContent), ["10:05", "10:14", "08:31"]);
  assert.equal(doc.querySelector(".message-time")!.getAttribute("datetime"), new Date(first).toISOString());
  assert.equal(doc.querySelectorAll(".assistant-identity strong").length, 3);
  assert.equal(doc.querySelector(".assistant-identity strong")!.textContent, "Dee");
  assert.equal(doc.querySelectorAll(".assistant-bubble li").length, 2);
});

test("旧记录、无效时间和流式回复不伪造时间，助手身份和流式内容保留", async t => {
  const view = conversation([
    { id: 1, kind: "user", text: "继续计划" },
    { id: 2, kind: "assistant", text: "已有回复", timestamp: Number.NaN },
  ], { text: "正在 **整理** <script>unsafe</script>" });
  const { dom } = await mount(t, <ChatThread view={view} />), doc = dom.window.document;
  assert.equal(doc.querySelector("time"), null);
  assert.equal(doc.querySelector(".chat-day-separator"), null);
  assert.equal(doc.querySelectorAll(".assistant-identity").length, 2);
  assert.equal(doc.querySelectorAll('[aria-label="正在回复"]').length, 1);
  assert.equal(doc.querySelectorAll('[aria-label="复制回复"]').length, 1, "流式回复不能出现可复制的已完成状态");
  assert.equal(doc.querySelector(".assistant-bubble strong")!.textContent, "整理");
  assert.equal(doc.querySelector("script"), null);
});

test("日期标签正确区分今天、昨天与跨年旧记录，非法值安静省略", () => {
  const now = new Date(2026, 0, 1, 12);
  assert.equal(chatTimestamp(new Date(2026, 0, 1, 0).getTime(), now)?.dayLabel, "今天");
  assert.equal(chatTimestamp(new Date(2025, 11, 31, 23, 59).getTime(), now)?.dayLabel, "昨天");
  assert.match(chatTimestamp(new Date(2025, 11, 30, 12).getTime(), now)!.dayLabel, /2025.*12.*30/);
  assert.equal(chatTimestamp(new Date(2026, 0, 1, 0).getTime(), now)?.time, "00:00");
  assert.equal(chatTimestamp(0)?.iso, "1970-01-01T00:00:00.000Z");
  for (const invalid of [undefined, Number.NaN, Infinity, -Infinity, 9e15]) assert.equal(chatTimestamp(invalid), null);
});

test("回复复制保留原始 Markdown，键盘按钮和附件仍然可访问", async t => {
  let copied = "";
  const text = "**计划**\n- 第一项\n\n```ts\nconst x = 1;\n```";
  const { dom } = await mount(t, <ChatThread view={conversation([
    { id: 1, kind: "user", text: "查看文件", attachments: [
      { kind: "image", name: "方案.png", mimeType: "image/png", size: 20, url: "/image.png" },
      { kind: "text", name: "说明.txt", mimeType: "text/plain", size: 30 },
    ] },
    { id: 2, kind: "assistant", text },
  ])} />), doc = dom.window.document;
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
  const button = doc.querySelector<HTMLButtonElement>('[aria-label="复制回复"]')!;
  await act(async () => { button.focus(); button.click(); });
  assert.equal(doc.activeElement, button);
  assert.equal(copied, text);
  assert.equal(button.textContent, "已复制");
  assert.equal(doc.querySelector(".msg-image-thumb")!.getAttribute("alt"), "方案.png");
  assert.equal(doc.querySelector(".msg-image-link")!.getAttribute("rel"), "noopener noreferrer");
  assert.match(doc.querySelector(".msg-file-card")!.textContent!, /说明.txt/);
  assert.equal(doc.querySelector(".assistant-bubble pre code")!.textContent, "const x = 1;");
});

test("工具过程仍默认折叠，等待状态包含身份且不显示虚假回复时间", async t => {
  const { dom } = await mount(t, <ChatThread view={conversation([
    { id: 1, kind: "user", text: "查找资料" },
    { id: 2, kind: "assistant", text: "", toolCalls: [{ id: "a", name: "fetch_page", args: {} }] },
  ], { tools: [{ name: "fetch_page", callId: "a", status: "running" }] })} />), doc = dom.window.document;
  assert.equal(doc.querySelector<HTMLDetailsElement>(".turn-activities")!.open, false);
  assert.match(doc.querySelector('[role="status"]')!.textContent!, /正在执行/);
  assert.equal(doc.querySelector(".assistant-identity strong")!.textContent, "Dee");
  assert.equal(doc.querySelector("time"), null);
  assert.equal(doc.querySelector('[aria-label="正在执行"]')!.className, "activity-status activity-running");
});

test("助手独立历史仍显示日期，空对话保持欢迎页，流式卡片忽略传入旧时间", () => {
  const timestamp = new Date(2026, 9, 21, 10, 5).getTime();
  const html = renderToStaticMarkup(<ChatThread view={conversation([{ id: 1, kind: "assistant", text: "提醒你回顾项目。", timestamp }])} />);
  assert.match(html, /class="chat-day-separator"/);
  assert.match(html, /<strong>Dee<\/strong>/);
  assert.doesNotMatch(html, /class="user-row"/);
  assert.match(renderToStaticMarkup(<ChatThread view={null} />), /有什么想交给我？/);
  assert.doesNotMatch(renderToStaticMarkup(<ResponseCard text="继续" streaming timestamp={timestamp} />), /<time/);
});
