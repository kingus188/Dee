import test from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { MarkdownEditor } from "../dist/editor/MarkdownEditor.js";
import { readDocumentTimeline, appendDocumentVersion } from "../dist/editor/document-timeline.js";
import { mount } from "./dom.js";
import { replaceSource, sourceEditor } from "./lane-source.js";

function Draft({ id, initial }: { id: string; initial: string }) {
  const [value, setValue] = useState(initial);
  return <MarkdownEditor documentId={id} label="正文" value={value} onChange={setValue} />;
}
async function click(document: Document, text: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text);
  assert.ok(button, text);
  await act(async () => button.click());
}
async function open(document: Document) {
  const details = document.querySelector<HTMLDetailsElement>(".document-timeline");
  assert.ok(details);
  await act(async () => { details.open = true; details.dispatchEvent(new window.Event("toggle")); });
}

test("撤销后编辑仍保留被放弃的分支，重挂后可以预览并恢复原文", async t => {
  const initial = "原文\r\n\r\n内容  ", full = "原文\r\n\r\n内容  \r\n新增重要信息";
  const { dom, render } = await mount(t, <Draft id="report:2026-11-10" initial={initial} />);
  const document = dom.window.document;
  await replaceSource(document, full.replace(/\r\n/g, "\n"));
  await click(document, "返回文档");
  await click(document, "撤销");
  await click(document, "Markdown 源码");
  assert.equal(sourceEditor(document).state.doc.toString(), initial.replace(/\r\n/g, "\n"));
  await replaceSource(document, "撤销后新分支");
  assert.ok(readDocumentTimeline("report:2026-11-10").some(version => version.markdown === full));
  await render(<div />);
  await render(<Draft id="report:2026-11-10" initial="服务器版本" />);
  await open(document);
  const entries = readDocumentTimeline("report:2026-11-10"), version = entries.find(item => item.markdown === full)!;
  const index = [...entries].reverse().findIndex(item => item.id === version.id);
  await act(async () => document.querySelectorAll<HTMLButtonElement>(".document-timeline ol button")[index]!.click());
  assert.equal(document.querySelector('[aria-label="历史版本预览"]')?.textContent, full);
  await click(document, "恢复到草稿");
  await click(document, "Markdown 源码");
  assert.equal(sourceEditor(document).state.doc.toString(), full.replace(/\r\n/g, "\n"));
  assert.ok(readDocumentTimeline("report:2026-11-10").some(item => item.markdown === "服务器版本"));
});

test("时间线按文档隔离，缓存不可写时显式告警且不阻止编辑", async t => {
  const { dom, render } = await mount(t, <Draft id="note:1" initial="一" />);
  await replaceSource(dom.window.document, "一的修改");
  await render(<Draft key="two" id="note:2" initial="二" />);
  await replaceSource(dom.window.document, "二的修改");
  assert.ok(readDocumentTimeline("note:1").some(item => item.markdown === "一的修改"));
  assert.equal(readDocumentTimeline("note:2").some(item => item.markdown === "一的修改"), false);
  t.mock.method(dom.window.Storage.prototype, "setItem", () => { throw new Error("quota"); });
  await replaceSource(dom.window.document, "缓存失败仍可编辑");
  assert.equal(sourceEditor(dom.window.document).state.doc.toString(), "缓存失败仍可编辑");
  assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /写入失败/);
});

test("恢复遵守只读和大小限制，组合输入期间禁止替换草稿", async t => {
  const { dom, render } = await mount(t, <div />);
  const key = ["dee", "document-timeline", "v1"].join(".") + ":guarded";
  dom.window.localStorage.setItem(key, JSON.stringify([{ id: "old", markdown: "历史正文", createdAt: Date.now() }]));
  const editor = (disabled = false, maxBytes?: number) => <MarkdownEditor documentId="guarded" label="正文" value="当前" onChange={() => assert.fail("不应恢复")} disabled={disabled} maxBytes={maxBytes} />;
  await render(editor(true));
  await open(dom.window.document);
  const buttons = dom.window.document.querySelectorAll<HTMLButtonElement>(".document-timeline ol button");
  await act(async () => buttons[buttons.length - 1]!.click());
  const restore = () => [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "恢复到草稿")!;
  assert.equal(restore().disabled, true);
  await render(editor(false, 1));
  assert.equal(restore().disabled, true);
  await render(editor());
  assert.equal(restore().disabled, false);
  const root = dom.window.document.querySelector<HTMLElement>(".rich-document")!;
  await act(async () => root.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true })));
  assert.equal(restore().disabled, true);
  await act(async () => root.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true })));
});

test("损坏的时间线不覆盖，恢复前保留当前内容，快照有容量上限", async t => {
  const { dom, render } = await mount(t, <div />);
  const key = ["dee", "document-timeline", "v1"].join(".") + ":damaged";
  dom.window.localStorage.setItem(key, "broken");
  await render(<Draft id="damaged" initial="原文" />);
  await replaceSource(dom.window.document, "修改");
  assert.equal(dom.window.localStorage.getItem(key), "broken");
  assert.ok(dom.window.document.querySelector('[role="alert"]'));
  let versions = appendDocumentVersion([], "0");
  for (let i = 1; i <= 120; i++) versions = appendDocumentVersion(versions, String(i));
  assert.equal(versions.length, 100);
  assert.equal(versions.at(-1)!.markdown, "120");
  assert.equal(appendDocumentVersion(versions, "120"), versions);
});
