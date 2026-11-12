import assert from "node:assert/strict";
import { act } from "react";
import { EditorView } from "@codemirror/view";

export function sourceEditor(document: Document) {
  const content = document.querySelector<HTMLElement>(".lane-source .cm-content");
  assert.ok(content, "源码模式应使用 Lane 的 CodeMirror 编辑界面");
  const view = EditorView.findFromDOM(content);
  assert.ok(view);
  return view;
}

export async function replaceSource(document: Document, value: string) {
  if (!document.querySelector(".lane-source")) {
    const button = [...document.querySelectorAll<HTMLButtonElement>(".lane-toolbar button")].find(item => item.textContent === "Markdown 源码");
    assert.ok(button);
    await act(async () => button.click());
  }
  const view = sourceEditor(document);
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, userEvent: "input.paste" }));
}
