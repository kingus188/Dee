import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { act, StrictMode, useState } from "react";
import { EditorView } from "@codemirror/view";
import { MarkdownEditor, type MarkdownEditorProps } from "../dist/editor/MarkdownEditor.js";
const { MarkdownDocument } = await import(new URL("../dist/editor/lane/kernel.js", import.meta.url).href) as typeof import("../src/editor/lane/kernel.js");
import { mount } from "./dom.js";
import { sourceEditor } from "./lane-source.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWQAAAAASUVORK5CYII=";
const MODIFIER = /Mac/.test(navigator.platform) ? "metaKey" : "ctrlKey";
function Draft({ initial, changes, ...props }: Partial<MarkdownEditorProps> & { initial: string; changes: string[] }) {
  const [value, setValue] = useState(initial);
  return <MarkdownEditor label="测试正文" {...props} value={value} onChange={next => { changes.push(next); setValue(next); }} />;
}
function rich(document: Document) { return document.querySelector<HTMLElement>(".lane-document-content")!; }
function caret(document: Document, text: string, select = false) {
  const node = document.createTreeWalker(rich(document), 4);
  let found: Node | null;
  while ((found = node.nextNode())) if (found.textContent?.includes(text)) {
    const start = found.textContent.indexOf(text), range = document.createRange();
    range.setStart(found, select ? start : start + text.length); range.setEnd(found, start + text.length);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range); return found;
  }
  throw new Error(`找不到文本 ${text}`);
}
async function click(document: Document, label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label);
  assert.ok(button, label); await act(async () => button.click());
}
async function type(dom: Awaited<ReturnType<typeof mount>>["dom"], text: string, inputType = "insertText") {
  const event = new dom.window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data: text });
  await act(async () => rich(dom.window.document).dispatchEvent(event));
  return event;
}
async function paste(dom: Awaited<ReturnType<typeof mount>>["dom"], data: Partial<Pick<DataTransfer, "files" | "getData">>) {
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [], getData: () => "", ...data } });
  await act(async () => rich(dom.window.document).dispatchEvent(event));
  return event;
}

test("共享入口所有 variant 使用真实 Lane 内核，StrictMode 重挂及源码往返不改原文", async t => {
  const original = '# H\r\n\r\nA  \rB\n\n<div data-raw="yes">raw</div>\r\n', changes: string[] = [];
  const { dom, render } = await mount(t, <StrictMode><Draft initial={original} changes={changes} /></StrictMode>);
  const document = dom.window.document;
  for (const variant of [undefined, "default", "document"] as const) {
    await render(<StrictMode><Draft initial={original} changes={changes} variant={variant} /></StrictMode>);
    assert.equal(document.querySelector(".markdown-editor")?.getAttribute("data-editor-engine"), "open-markdown-lane");
    assert.equal(document.querySelector<HTMLDivElement>('.lane-toolbar')?.hidden, true);
    assert.equal(document.querySelectorAll(".table-tools").length, 1);
    assert.ok(rich(document).querySelector("h1"));
    await click(document, "Markdown 源码");
    assert.equal(sourceEditor(document).state.doc.toString(), original.replace(/\r\n?/g, "\n"));
    await click(document, "返回文档");
    assert.deepEqual(changes, []);
  }
});

test("源码往返逐行保留额外空行，不把相邻空行两两合并", async t => {
  const changes: string[] = [];
  const { dom, render } = await mount(t, <MarkdownEditor label="正文" value="" onChange={next => changes.push(next)} />);
  const document = dom.window.document;
  for (let extra = 0; extra <= 4; extra++) {
    const initial = `## 今日进展（11月10日）${"\n".repeat(extra + 2)}### 公司内部\n\n正文`;
    await render(<MarkdownEditor label="正文" value={initial} onChange={next => changes.push(next)} />);
    const blankLines = () => [...rich(document).querySelectorAll<HTMLElement>('[data-kind="empty"]')].map(node => Number(node.dataset.line));
    const expected = Array.from({ length: extra }, (_, index) => index + 3);
    assert.deepEqual(blankLines(), expected);
    await click(document, "Markdown 源码");
    assert.equal(sourceEditor(document).state.doc.toString(), initial);
    await click(document, "返回文档");
    assert.deepEqual(blankLines(), expected);
  }
  assert.deepEqual(changes, []);
});

test("Command/Ctrl + / 连续切换源码与文档，保持焦点和原文且不触发代码注释", async t => {
  const initial = "# 标题\r\n\r\n```js\nconst value = 1;\n```\r\n", changes: string[] = [];
  const { dom } = await mount(t, <Draft initial={initial} changes={changes} />);
  const document = dom.window.document;
  async function shortcut(modifier: "metaKey" | "ctrlKey") {
    const event = new dom.window.KeyboardEvent("keydown", { key: "/", code: "Slash", [modifier]: true, bubbles: true, cancelable: true });
    await act(async () => document.activeElement!.dispatchEvent(event));
    assert.equal(event.defaultPrevented, true);
  }
  await act(async () => rich(document).querySelector<HTMLElement>(".fence-body")!.click());
  assert.ok(document.activeElement?.closest(".cm-editor"));
  for (const modifier of ["metaKey", "ctrlKey"] as const) {
    await shortcut(modifier);
    const view = sourceEditor(document);
    assert.equal(document.querySelector(".lane-source textarea"), null);
    assert.equal(view.state.doc.toString(), initial.replace(/\r\n?/g, "\n"));
    assert.equal(document.activeElement, view.contentDOM);
    await shortcut(modifier);
    assert.equal(document.querySelector(".lane-source"), null);
    assert.ok(rich(document).contains(document.activeElement));
  }
  assert.deepEqual(changes, []);
});

test("源码快捷键忽略普通斜杠、其他组合键、长按、输入法和禁用状态", async t => {
  const changes: string[] = [];
  const { dom, render } = await mount(t, <Draft initial="正文" changes={changes} />);
  const document = dom.window.document;
  for (const keys of [{}, { metaKey: true, shiftKey: true }, { metaKey: true, altKey: true }, { metaKey: true, repeat: true }, { metaKey: true, isComposing: true }]) {
    const event = new dom.window.KeyboardEvent("keydown", { key: "/", code: "Slash", bubbles: true, cancelable: true, ...keys });
    await act(async () => rich(document).dispatchEvent(event));
    assert.equal(event.defaultPrevented, false);
    assert.equal(document.querySelector(".lane-source"), null);
  }
  await render(<Draft initial="正文" changes={changes} disabled />);
  await act(async () => rich(document).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "/", metaKey: true, bubbles: true, cancelable: true })));
  assert.equal(document.querySelector(".lane-source"), null);
  assert.deepEqual(changes, []);
});

test("Lane 源码编辑保留混合换行与光标，源码撤销重做及返回文档共用历史", async t => {
  const initial = "# 标题\r\n\r\n正文  \r\n\n尾行\r", changes: string[] = [];
  const { dom } = await mount(t, <Draft initial={initial} changes={changes} />);
  const document = dom.window.document;
  caret(document, "正文");
  await click(document, "Markdown 源码");
  const view = sourceEditor(document), from = view.state.doc.toString().indexOf("正文") + 2;
  assert.equal(view.state.selection.main.head, from);
  await act(async () => view.dispatch({ changes: { from, insert: "新增" }, selection: { anchor: from + 2 }, userEvent: "input.type" }));
  assert.equal(changes.at(-1), initial.replace("正文", "正文新增"));
  for (const shiftKey of [false, true]) {
    const event = new dom.window.KeyboardEvent("keydown", { key: shiftKey ? "Z" : "z", code: "KeyZ", keyCode: 90, [MODIFIER]: true, shiftKey, bubbles: true, cancelable: true });
    await act(async () => view.contentDOM.dispatchEvent(event));
    assert.equal(event.defaultPrevented, true);
    assert.equal(changes.at(-1), shiftKey ? initial.replace("正文", "正文新增") : initial);
  }
  await click(document, "返回文档");
  assert.match(rich(document).textContent!, /正文新增/);
  assert.equal(document.getSelection()?.anchorNode?.textContent?.slice(0, document.getSelection()!.anchorOffset), "正文新增");
  await click(document, "撤销");
  assert.equal(changes.at(-1), initial);
});

test("Lane 源码组合输入完成后只发布一次，图片插入使用源码选区并保留正文", async t => {
  const changes: string[] = [], pending: boolean[] = [];
  const { dom } = await mount(t, <Draft initial="开始" changes={changes} imageFileReader={async () => PNG} onPendingChange={value => pending.push(value)} />);
  const document = dom.window.document;
  await click(document, "Markdown 源码");
  const view = sourceEditor(document);
  await act(async () => {
    view.contentDOM.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
    view.dispatch({ changes: { from: 2, insert: "中文" }, selection: { anchor: 4 }, userEvent: "input.type.compose" });
  });
  assert.deepEqual(changes, []);
  await act(async () => {
    view.contentDOM.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
    await setTimeout(10);
  });
  assert.deepEqual(changes, ["开始中文"]);
  await act(async () => view.dispatch({ selection: { anchor: 0, head: 2 } }));
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [new dom.window.File(["image"], "a.png", { type: "image/png" })], getData: () => "" } });
  await act(async () => view.contentDOM.dispatchEvent(event));
  assert.deepEqual(pending, [true, false]);
  assert.equal(view.state.doc.toString(), `![a.png](${PNG})中文`);
  assert.equal(changes.at(-1), `![a.png](${PNG})中文`);
});

test("原位输入、不同块连续编辑、撤销重做保留其他行混合 EOL 与尾空格", async t => {
  const original = "# H\r\n\r\nFirst  \r\n\r\nSecond\n\nTail\r", changes: string[] = [];
  const { dom } = await mount(t, <Draft initial={original} changes={changes} />);
  caret(dom.window.document, "First"); await type(dom, "!");
  assert.equal(changes.at(-1), original.replace("First", "First!"));
  caret(dom.window.document, "Second"); await type(dom, "?");
  assert.equal(changes.at(-1), original.replace("First", "First!").replace("Second", "Second?"));
  await click(dom.window.document, "撤销");
  assert.equal(changes.at(-1), original.replace("First", "First!"));
  await click(dom.window.document, "重做");
  assert.equal(changes.at(-1), original.replace("First", "First!").replace("Second", "Second?"));
});

test("工具栏格式与表格命令直接使用 Lane 原文模型", async t => {
  const changes: string[] = [];
  const { dom } = await mount(t, <Draft initial="正文" changes={changes} />);
  caret(dom.window.document, "正文", true); await click(dom.window.document, "粗体");
  assert.equal(changes.at(-1), "**正文**");
  await click(dom.window.document, "撤销");
  caret(dom.window.document, "正文"); await click(dom.window.document, "表格");
  assert.ok(rich(dom.window.document).querySelector("table"));
  assert.match(changes.at(-1)!, /\| --- \| --- \|/);
});

test("原位粘贴 HTML 保留格式、HTML 与 Markdown 媒体统一阻止脚本和桌面协议", async t => {
  const original = '# H\n\n![bad](file:///secret)\n\n<img src="https://example.test/a.png" onerror="alert(1)"><iframe src="https://same.test"></iframe><script>alert(1)</script>\n\nText';
  const changes: string[] = [];
  const { dom } = await mount(t, <Draft initial={original} changes={changes} />);
  const document = dom.window.document;
  assert.equal(rich(document).querySelector("script,iframe,object,embed,[onerror]"), null);
  assert.equal(rich(document).querySelector('img[src^="file:"],img[src^="open-typora"],img[src^="javascript:"]'), null);
  assert.deepEqual(changes, []);
  caret(document, "Text");
  const event = await paste(dom, { getData: format => format === "text/html" ? '<strong>粗体</strong><script>alert(1)</script>' : "" });
  assert.equal(event.defaultPrevented, true);
  assert.match(changes.at(-1)!, /Text\*\*粗体\*\*/);
  assert.equal(rich(document).querySelector("script"), null);
});

test("制表符粘贴生成真实可编辑表格，公式使用宿主 KaTeX", async t => {
  const changes: string[] = [];
  const { dom } = await mount(t, <Draft initial={"$x^2$\n\n正文"} changes={changes} />);
  assert.ok(rich(dom.window.document).querySelector(".katex"));
  caret(dom.window.document, "正文");
  await paste(dom, { getData: format => format === "text/plain" ? "A\tB\n1\t2" : "" });
  assert.ok(rich(dom.window.document).querySelector("table"));
  assert.match(changes.at(-1)!, /\| A \| B \|/);
});

test("中文组合输入只在结束时发布一次，撤销恢复原文", async t => {
  const changes: string[] = [];
  const { dom } = await mount(t, <Draft initial="开始" changes={changes} />);
  const document = dom.window.document, node = caret(document, "开始") as Text;
  await act(async () => rich(document).dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true })));
  node.data = "开始中文"; caret(document, "开始中文");
  await act(async () => rich(document).dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, isComposing: true, data: "中文" })));
  assert.deepEqual(changes, []);
  await act(async () => {
    rich(document).dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
    await setTimeout(5);
  });
  assert.deepEqual(changes, ["开始中文"]);
  await click(document, "撤销"); assert.equal(changes.at(-1), "开始");
});

test("组合输入期间外部 value 更新排队，结束后不覆盖服务器新值", async t => {
  const changes: string[] = [];
  const element = (value: string) => <MarkdownEditor label="正文" value={value} onChange={next => changes.push(next)} />;
  const { dom, render } = await mount(t, element("旧正文"));
  const document = dom.window.document, node = caret(document, "旧正文") as Text;
  await act(async () => rich(document).dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true })));
  await render(element("外部新正文"));
  node.data = "旧正文中文"; caret(document, "旧正文中文");
  await act(async () => {
    rich(document).dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
    await setTimeout(5);
  });
  assert.deepEqual(changes, []);
  assert.match(rich(document).textContent!, /外部新正文/);
});

test("只读阻止输入和工具栏，外部 value 更新可显示", async t => {
  const changes: string[] = [];
  const element = (value: string) => <MarkdownEditor label="正文" value={value} disabled onChange={next => changes.push(next)} />;
  const { dom, render } = await mount(t, element("只读"));
  const document = dom.window.document;
  assert.equal(rich(document).getAttribute("contenteditable"), "false");
  caret(document, "只读"); assert.equal((await type(dom, "!" )).defaultPrevented, true);
  assert.deepEqual(changes, []);
  assert.ok([...document.querySelectorAll<HTMLButtonElement>(".lane-toolbar button")].every(button => button.disabled));
  await render(element("外部值")); assert.match(rich(document).textContent!, /外部值/);
});

test("图片读取 pending 防重复，成功保留选区；大小限制与读取失败明确报错", async t => {
  let resolve!: (value: string) => void, reads = 0;
  const changes: string[] = [], pending: boolean[] = [];
  const reader = () => { reads++; return new Promise<string>(done => { resolve = done; }); };
  const { dom } = await mount(t, <Draft initial="图片位置" changes={changes} imageFileReader={reader} onPendingChange={value => pending.push(value)} />);
  const document = dom.window.document, file = new dom.window.File(["image"], "a.png", { type: "image/png" });
  caret(document, "图片位置");
  await paste(dom, { files: [file] as unknown as FileList });
  assert.equal(reads, 1); assert.deepEqual(pending, [true]);
  assert.equal(rich(document).getAttribute("contenteditable"), "false");
  await paste(dom, { files: [file] as unknown as FileList }); assert.equal(reads, 1);
  await act(async () => resolve(PNG));
  assert.deepEqual(pending, [true, false]);
  assert.equal(changes.at(-1), `图片位置![a.png](${PNG})`);
  assert.equal(rich(document).querySelector("img")?.getAttribute("src"), PNG);
});

test("异步图片在正文外部更新后拒绝插入，且重置 pending", async t => {
  let resolve!: (value: string) => void;
  const changes: string[] = [], pending: boolean[] = [];
  const reader = () => new Promise<string>(done => { resolve = done; });
  const element = (value: string) => <MarkdownEditor label="正文" value={value} onChange={next => changes.push(next)} imageFileReader={reader} onPendingChange={value => pending.push(value)} />;
  const { dom, render } = await mount(t, element("旧正文"));
  caret(dom.window.document, "旧正文");
  await paste(dom, { files: [new dom.window.File(["image"], "a.png", { type: "image/png" })] as unknown as FileList });
  await render(element("服务器新正文"));
  await act(async () => resolve(PNG));
  assert.deepEqual(changes, []); assert.deepEqual(pending, [true, false]);
  assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /正文已变化/);
  assert.match(rich(dom.window.document).textContent!, /服务器新正文/);
});

test("超限图片和读取失败不改正文，源码模式也遵循同样的字节限制", async t => {
  const changes: string[] = [], pending: boolean[] = [];
  const { dom, render } = await mount(t, <Draft initial="正文\r\n" changes={changes} imageFileReader={async () => PNG} maxBytes={10} onPendingChange={value => pending.push(value)} />);
  await click(dom.window.document, "Markdown 源码");
  const file = new dom.window.File(["image"], "a.png", { type: "image/png" });
  await paste(dom, { files: [file] as unknown as FileList });
  assert.deepEqual(changes, []); assert.deepEqual(pending, [true, false]);
  assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /大小限制/);
  await render(<Draft initial="正文\r\n" changes={changes} imageFileReader={async () => { throw new Error("读取失败"); }} />);
  await paste(dom, { files: [file] as unknown as FileList });
  assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /读取失败/);
  assert.deepEqual(changes, []);
});

test("Lane 原文模型支持长文档局部编辑和历史恢复", () => {
  const original = "# Long\n\n" + "正文 **bold**\n\n".repeat(25_000);
  const model = new MarkdownDocument(original);
  const at = original.length - 10;
  model.replace(at, at, "新增", "command");
  assert.equal(model.text, original.slice(0, at) + "新增" + original.slice(at));
  assert.ok(model.canUndo);
  assert.equal(model.undo(), true); assert.equal(model.text, original);
  assert.equal(model.redo(), true); assert.equal(model.text, original.slice(0, at) + "新增" + original.slice(at));
});

test("只读刷新后的任务框和已打开表情建议均不能修改模型", async t => {
  const changes: string[] = [];
  const element = (value: string, disabled = false) => <MarkdownEditor label="正文" value={value} disabled={disabled} onChange={next => changes.push(next)} />;
  const { dom, render } = await mount(t, element("hello :smi"));
  const document = dom.window.document;
  caret(document, "hello :smi"); await type(dom, "l");
  const choice = document.querySelector<HTMLButtonElement>(".emoji-completion button")!;
  assert.ok(choice);
  await render(element("hello :smil", true));
  assert.equal(document.querySelector<HTMLElement>(".emoji-completion")!.hidden, true);
  await act(async () => choice.click());
  assert.deepEqual(changes, ["hello :smil"]);
  await render(element("- [ ] 外部任务", true));
  const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  assert.equal(checkbox.disabled, true);
  await act(async () => checkbox.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })));
  await render(element("- [ ] 外部任务"));
  caret(document, "外部任务"); await type(dom, "!");
  assert.equal(changes.at(-1), "- [ ] 外部任务!");
});

test("活跃代码块收到外部更新后销毁旧 CodeMirror 内容", async t => {
  const changes: string[] = [];
  const element = (value: string) => <MarkdownEditor label="正文" value={value} onChange={next => changes.push(next)} />;
  const { dom, render } = await mount(t, element("```js\nold\n```"));
  await act(async () => rich(dom.window.document).querySelector<HTMLElement>(".fence-body")!.click());
  assert.match(rich(dom.window.document).querySelector(".cm-content")!.textContent!, /old/);
  await render(element("```js\nSERVER\n```"));
  assert.doesNotMatch(rich(dom.window.document).textContent!, /old/);
  assert.match(rich(dom.window.document).textContent!, /SERVER/);
  assert.deepEqual(changes, []);
});

test("代码块中文组合输入仅结束后发布，撤销恢复完整代码", async t => {
  const changes: string[] = [];
  const initial = "```js\r\nold\n```";
  const { dom } = await mount(t, <Draft initial={initial} changes={changes} />);
  const document = dom.window.document;
  await act(async () => rich(document).querySelector<HTMLElement>(".fence-body")!.click());
  const content = rich(document).querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  await act(async () => {
    content.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
    view.dispatch({ changes: { from: 0, to: 3, insert: "中" }, userEvent: "input.type.compose" });
  });
  assert.deepEqual(changes, []);
  await act(async () => {
    view.dispatch({ changes: { from: 0, to: 1, insert: "中文" }, userEvent: "input.type.compose" });
    content.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
    await setTimeout(10);
  });
  assert.deepEqual(changes, ["```js\r\n中文\n```"]);
  await click(document, "撤销"); assert.equal(changes.at(-1), initial);
});

test("代码块组合输入期间外部更新优先，临时内容不进入父草稿", async t => {
  const changes: string[] = [];
  const element = (value: string) => <MarkdownEditor label="正文" value={value} onChange={next => changes.push(next)} />;
  const { dom, render } = await mount(t, element("```js\nold\n```"));
  const document = dom.window.document;
  await act(async () => rich(document).querySelector<HTMLElement>(".fence-body")!.click());
  const content = rich(document).querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  await act(async () => {
    content.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
    view.dispatch({ changes: { from: 0, to: 3, insert: "中" }, userEvent: "input.type.compose" });
  });
  await render(element("```js\nSERVER\n```"));
  await act(async () => {
    content.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true, data: "中" }));
    await setTimeout(10);
  });
  assert.deepEqual(changes, []);
  assert.match(rich(document).textContent!, /SERVER/);
  assert.doesNotMatch(rich(document).textContent!, /old|中/);
});

test("脚注按引用顺序显示且源码往返保留定义与非标准空白", async t => {
  const initial = "先看[^b] 再看[^a]\r\n\r\n[^a]:  A\n[^b]: B\r\n";
  const changes: string[] = [];
  const { dom } = await mount(t, <Draft initial={initial} changes={changes} />);
  const document = dom.window.document;
  assert.deepEqual([...rich(document).querySelectorAll("[data-footnote]")].map(link => link.textContent), ["1", "2"]);
  await click(document, "Markdown 源码");
  assert.equal(sourceEditor(document).state.doc.toString(), initial.replace(/\r\n?/g, "\n"));
  await click(document, "返回文档");
  assert.deepEqual(changes, []);
});

test("源码组合输入期间阻止模式切换并在结束时应用外部值", async t => {
  const changes: string[] = [];
  const element = (value: string) => <MarkdownEditor label="正文" value={value} onChange={next => changes.push(next)} />;
  const { dom, render } = await mount(t, element("旧正文"));
  const document = dom.window.document;
  await click(document, "Markdown 源码");
  const view = sourceEditor(document), area = view.contentDOM;
  await act(async () => area.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true })));
  await render(element("SERVER"));
  await click(document, "返回文档");
  assert.equal(sourceEditor(document), view);
  assert.equal(view.state.doc.toString(), "旧正文");
  await act(async () => {
    view.dispatch({ changes: { from: view.state.doc.length, insert: "中文" }, userEvent: "input.type.compose" });
    area.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
    await setTimeout(10);
  });
  assert.deepEqual(changes, []); assert.equal(view.state.doc.toString(), "SERVER");
  await click(document, "返回文档"); assert.match(rich(document).textContent!, /SERVER/);
});

test("Office HTML 表格附带图片 fallback 时优先粘贴表格", async t => {
  const changes: string[] = []; let reads = 0;
  const { dom } = await mount(t, <Draft initial="正文" changes={changes} imageFileReader={async () => { reads++; return PNG; }} />);
  caret(dom.window.document, "正文");
  await paste(dom, { files: [new dom.window.File(["png"], "table.png", { type: "image/png" })] as unknown as FileList, getData: format => format === "text/html" ? "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>" : format === "text/plain" ? "A\tB\n1\t2" : "" });
  assert.equal(reads, 0);
  assert.ok(rich(dom.window.document).querySelector("table"));
  assert.match(changes.at(-1)!, /\| A \| B \|/);
});
