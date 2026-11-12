import test from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { MarkdownEditor } from "../dist/editor/MarkdownEditor.js";
import { mount } from "./dom.js";
import { sourceEditor } from "./lane-source.js";

test("文档编辑以原始 Markdown 为底稿，即使有 CRLF、尾空格和 HTML 也默认原位即时编辑", async t => {
  const value = "# 标题\r\n\r\n**粗体** 与 `代码`  \r\n\r\n<div>字面内容</div>\r\n";
  const changes: string[] = [];
  const { dom } = await mount(t, <MarkdownEditor variant="document" value={value} onChange={text => changes.push(text)} label="笔记正文" />);
  const live = dom.window.document.querySelector<HTMLElement>(".lane-document-content[contenteditable=true]");
  assert.ok(live, "文档必须默认提供保留语法的即时 Markdown 编辑，而不是源码框或富文本转换");
  assert.equal(dom.window.document.querySelector("textarea"), null);
  assert.equal(live.querySelector("img, script, iframe"), null);
  assert.match(live.textContent!, /<div>字面内容<\/div>/);
  assert.deepEqual(changes, [], "打开文档不能规范化或写回原文");
});

test("Lane 源码事务保留未改行 EOL，返回文档不产生额外写回", async t => {
  const original = "# H\r\nfirst  \rsecond\nlast\r\n", changes: string[] = [];
  function Example() {
    const [value, setValue] = useState(original);
    return <MarkdownEditor variant="document" value={value} onChange={text => { changes.push(text); setValue(text); }} label="笔记正文" />;
  }
  const { dom } = await mount(t, <Example />);
  const document = dom.window.document;
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Markdown 源码")!.click(); });
  const view = sourceEditor(document);
  assert.equal(view.state.doc.toString(), original.replace(/\r\n?/g, "\n"));
  await act(async () => {
    view.dispatch({ changes: { from: view.state.doc.length, insert: "X" }, userEvent: "input.type" });
  });
  assert.deepEqual(changes, [original + "X"]);
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "返回文档")!.click(); });
  assert.ok(document.querySelector(".lane-document-content"));
  assert.deepEqual(changes, [original + "X"]);
});
