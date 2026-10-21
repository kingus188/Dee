import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { JSDOM } from "jsdom";
import { NotesPage } from "../dist/workspace/NotesPage.js";
import { PersonalPage } from "../dist/workspace/PersonalPage.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

async function typeMarkdown(dom: JSDOM, text: string) {
  const document = dom.window.document;
  if (!document.querySelector(".markdown-editor textarea")) await act(async () => { [...document.querySelectorAll<HTMLButtonElement>(".markdown-editor-toolbar button")].find(button => button.textContent === "Markdown 源码")!.click(); });
  const textarea = document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("笔记直接保存 Markdown，冲突后仍保留草稿", async t => {
  const original = { todos: [], memos: ["旧笔记"] };
  const writes: unknown[] = [];
  let conflict = false;
  t.mock.method(apiClient, "request", async (_path: string, body?: { notes: typeof original }) => {
    if (!body) return original;
    writes.push(body);
    if (conflict) throw new Error("笔记已被其他页面更新");
    return body.notes;
  });
  const { dom, render } = await mount(t, <NotesPage owner={7} active />);
  const document = dom.window.document;
  await typeMarkdown(dom, "## 新笔记\n\n- 完整保存");
  await act(async () => { document.querySelector<HTMLButtonElement>(".settings-save")!.click(); });
  assert.deepEqual(writes[0], { base: original, notes: { ...original, memos: [...original.memos, "## 新笔记\n\n- 完整保存"] } });
  assert.equal(document.querySelector('input[type="checkbox"]'), null);
  conflict = true;
  await typeMarkdown(dom, "尚未保存的修改");
  await act(async () => { document.querySelector<HTMLButtonElement>(".settings-save")!.click(); });
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /其他页面更新/);
  assert.equal(document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!.value, "尚未保存的修改");
  await render(<NotesPage owner={7} active={false} />);
  await render(<NotesPage owner={7} active />);
  assert.equal(document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!.value, "尚未保存的修改");
});

test("记忆页面直接新增与编辑，不调用聊天接口，发送原记录防止覆盖", async t => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let memory: { id: string; text: string; status: "approved"; source: "user"; createdAt: number; decidedAt: number }[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: Record<string, unknown>) => {
    if (!body) return { memory, skills: [], knowledge: { enabled: false, allow: [] } };
    writes.push({ path, body });
    const item = { id: "note", text: String(body.text), status: "approved" as const, source: "user" as const, createdAt: 1, decidedAt: 1 };
    memory = [item]; return { item };
  });
  const { dom } = await mount(t, <PersonalPage kind="memory" active />);
  await typeMarkdown(dom, "**偏好**\n\n保持简洁");
  await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".settings-save")!.click(); });
  assert.equal(writes[0].path, "/api/personal/memory");
  assert.equal(writes[0].body.text, "**偏好**\n\n保持简洁");
  assert.equal(typeof writes[0].body.requestId, "string");
  await typeMarkdown(dom, "**偏好**\n\n回答附上证据");
  await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".settings-save")!.click(); });
  assert.equal(writes[1].path, "/api/personal/memory/note/edit");
  const original = writes[1].body.base;
  assert.ok(original && typeof original === "object" && "text" in original);
  assert.equal(original.text, "**偏好**\n\n保持简洁");
  assert.equal(dom.window.document.querySelector("#chat-textarea"), null);
});
