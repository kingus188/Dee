import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeReader from "../dist/chat/CodeReader.js";
import { indentationFold } from "../dist/chat/code-reader-editor.js";
import { mount } from "./dom.js";

test("reader stays readonly, preserves selection on streaming and responds to wrap/search", async t => {
  const mounted = await mount(t, <CodeReader source={'function f() {\n  return 1\n}'} language="javascript" onClose={() => {}} />);
  const doc = mounted.dom.window.document;
  const view = EditorView.findFromDOM(doc.querySelector<HTMLElement>(".cm-editor")!)!;
  assert.equal(view.state.readOnly, true);
  assert.equal(view.contentDOM.getAttribute("contenteditable"), "false");
  view.dispatch({ selection: { anchor: 2, head: 5 } });
  await mounted.render(<CodeReader source={'function f() {\n  return 1\n}\nconst next = 2'} language="javascript" onClose={() => {}} />);
  assert.equal(view.state.selection.main.from, 2); assert.equal(view.state.selection.main.to, 5);
  assert.equal(doc.querySelectorAll(".cm-editor").length, 1);
  await act(async () => [...doc.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Wrap")!.click());
  assert.ok(doc.querySelector(".cm-lineWrapping"));
  await act(async () => doc.dispatchEvent(new mounted.dom.window.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true })));
  assert.equal(doc.activeElement?.getAttribute("aria-label"), "Find in code");
  const input = doc.querySelector<HTMLInputElement>('[aria-label="Find in code"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(mounted.dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "return"); input.dispatchEvent(new mounted.dom.window.Event("input", { bubbles: true })); });
  await act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click());
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), "return");
  assert.equal((doc.querySelector("#root") as HTMLElement).inert, true);
});

test("reader traps focus and restores triggering control on close", async t => {
  const mounted = await mount(t, <><button>Trigger</button></>);
  const doc = mounted.dom.window.document;
  const trigger = doc.querySelector<HTMLButtonElement>("button")!;
  trigger.focus();
  let closes = 0;
  await mounted.render(<><button>Trigger</button><CodeReader source="hello" language="text" onClose={() => { closes++; }} /></>);
  const close = doc.querySelector<HTMLButtonElement>('[aria-label="Close code reader"]')!;
  assert.equal(doc.activeElement, close);
  await act(async () => close.dispatchEvent(new mounted.dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  assert.equal(doc.activeElement?.getAttribute("aria-label"), "Read-only code");
  await act(async () => doc.dispatchEvent(new mounted.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(closes, 1);
  await mounted.render(<><button>Trigger</button></>);
  assert.equal(doc.activeElement, trigger);
  assert.equal(doc.querySelector('[role="dialog"]'), null);
  assert.notEqual((doc.querySelector("#root") as HTMLElement).inert, true);
});

test("indentation folds complete or streaming nested blocks without folding plain lines", () => {
  const state = EditorState.create({ doc: 'function f() {\n  return 1\n}\nplain' });
  const line = state.doc.line(1);
  assert.deepEqual(indentationFold(state, line.from, line.to), { from: line.to, to: state.doc.line(2).to });
  const last = state.doc.line(4); assert.equal(indentationFold(state, last.from, last.to), null);
});

test("reader stylesheet keeps narrow layouts bounded and reserves native window controls", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../public/code-reader.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 900px\).*?\.code-reader \{ width: 100%;/s);
  assert.match(css, /body:has\(\[data-desktop\]\) \.code-reader \{ margin-top: 52px; height: calc\(100% - 52px\); \}/);
  assert.match(css, /\.code-reader-editor \{[^}]*min-height: 0;[^}]*min-width: 0;[^}]*overflow: hidden;/);
});
