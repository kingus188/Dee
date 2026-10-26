import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { TiptapEditorHTMLElement } from "@tiptap/core";
import { MarkdownEditor } from "../dist/editor/MarkdownEditor.js";
import { MarkdownDocument } from "../dist/editor/MarkdownDocument.js";
import { mount } from "./dom.js";

const original = "正文[^b] 与重复引用[^b]，后一个[^a]。\r\n\r\n[^a]: 后出现的 **内容**\r\n\r\n[^b]: 第一个脚注与 <script>bad()</script>\r\n";

test("脚注按引用顺序编号，安全预览且打开不改写原文", async t => {
  const writes: string[] = [];
  const { dom } = await mount(t, <MarkdownEditor label="脚注正文" value={original} onChange={value => writes.push(value)} />);
  const document = dom.window.document;
  assert.deepEqual([...document.querySelectorAll(".tiptap-footnote-link")].map(item => item.textContent), ["1", "1", "2"]);
  assert.equal(document.querySelectorAll(".tiptap-footnote-preview").length, 2);
  assert.equal(document.querySelectorAll(".tiptap-footnote-preview script").length, 0);
  assert.match(document.querySelector('[data-footnote-number="1"]')!.textContent!, /第一个脚注与 <script>/);
  assert.equal(document.querySelector('[data-footnote-number="2"] strong')!.textContent, "内容");
  assert.deepEqual(writes, []);
  const editor = document.querySelector<TiptapEditorHTMLElement>(".tiptap-document-content")!.editor!;
  await act(async () => {
    const first = [...document.querySelectorAll<HTMLButtonElement>(".tiptap-footnote-edit")][0]!;
    first.click();
  });
  assert.equal(editor.state.selection.$from.parent.type.name, "markdownLiteralBlock");
  assert.match(editor.state.selection.$from.parent.textContent, /\[\^a\]:/);
  assert.deepEqual(writes, [], "进入脚注原位编辑没有修改正文");
});

test("只读脚注可定位，禁止出现编辑入口和可编辑 DOM", async t => {
  const { dom } = await mount(t, <MarkdownDocument value={original} />), document = dom.window.document;
  assert.equal(document.querySelectorAll(".tiptap-footnote-link").length, 3);
  assert.equal(document.querySelectorAll(".tiptap-footnote-edit,[contenteditable='true']").length, 0);
  await act(async () => document.querySelector<HTMLButtonElement>(".tiptap-footnote-link")!.click());
  assert.equal(document.activeElement?.getAttribute("data-footnote-number"), "1");
});

test("未定义的脚注保持可见原文，编辑定义不会遗留旧预览", async t => {
  const writes: string[] = [];
  const { dom } = await mount(t, <MarkdownEditor label="脚注正文" value="保留[^missing]\n\n[^unused]: 没有被引用" onChange={value => writes.push(value)} />);
  assert.match(dom.window.document.querySelector(".tiptap-document-content")!.textContent!, /\[\^missing\]/);
  assert.equal(dom.window.document.querySelectorAll(".tiptap-footnote-preview").length, 0);
  assert.deepEqual(writes, []);
});
