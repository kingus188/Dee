import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { act, useState, type ReactNode } from "react";
import type { Editor, TiptapEditorHTMLElement } from "@tiptap/core";
import type {} from "@tiptap/starter-kit";
import { MarkdownEditor, type MarkdownEditorProps } from "../dist/editor/MarkdownEditor.js";

// JSDOM supplies real DOM selection/mutation APIs but has no layout engine.
// Only geometry is filled in; Tiptap, input rules, history and onChange are real.
async function mounted(t: TestContext, component: ReactNode) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://editor.test/", pretendToBeVisual: true });
  Object.defineProperties(dom.window.Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new dom.window.DOMRect() },
  });
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLAnchorElement: dom.window.HTMLAnchorElement,
    Element: dom.window.Element, Node: dom.window.Node, Text: dom.window.Text,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => {
    await act(async () => root.unmount());
    // useEditor defers disposal so StrictMode can reuse an editor instance.
    await setTimeout(10);
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const render = async (next: ReactNode) => { await act(async () => root.render(next)); };
  await render(component);
  return { dom, document: dom.window.document, render };
}

function editorIn(document: Document): Editor {
  // Tiptap intentionally exposes this typed test API on its mounted DOM root.
  const element = document.querySelector<TiptapEditorHTMLElement>(".tiptap-document-content");
  assert.ok(element?.editor, "必须挂载真实 Tiptap Editor");
  return element.editor;
}

function button(document: Document, label: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label);
  assert.ok(element, `找不到按钮：${label}`);
  return element;
}

async function click(document: Document, label: string) {
  await act(async () => button(document, label).click());
}

async function typeText(editor: Editor, text: string) {
  await act(async () => {
    for (const character of text) {
      const { from, to } = editor.state.selection;
      const handled = editor.view.someProp("handleTextInput", handler => handler(editor.view, from, to, character, () => editor.state.tr.insertText(character, from, to)));
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(character, from, to));
    }
  });
}

function textPosition(editor: Editor, text: string) {
  let found: number | undefined;
  editor.state.doc.descendants((node, position) => {
    if (found === undefined && node.isText && node.text?.includes(text)) found = position + node.text.indexOf(text);
  });
  assert.notEqual(found, undefined, `找不到文档文本：${text}`);
  return found!;
}

async function caretAfter(editor: Editor, text: string) {
  await act(async () => { editor.commands.setTextSelection(textPosition(editor, text) + text.length); });
}

async function key(dom: JSDOM, editor: Editor, name: string, modifiers: KeyboardEventInit = {}) {
  const code = name === "Enter" ? 13 : name === "Escape" ? 27 : name === "z" || name === "Z" ? 90 : 0;
  const event = new dom.window.KeyboardEvent("keydown", { key: name, code: name === "Enter" ? "Enter" : name, keyCode: code, which: code, bubbles: true, cancelable: true, ...modifiers });
  await act(async () => { editor.view.dom.dispatchEvent(event); });
  return event;
}

async function input(dom: JSDOM, area: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

function Draft({ initial, changes, saves = [], disabled = false, variant }: {
  initial: string; changes: string[]; saves?: string[]; disabled?: boolean; variant?: MarkdownEditorProps["variant"];
}) {
  const [value, setValue] = useState(initial);
  return <><MarkdownEditor label="测试正文" value={value} disabled={disabled} variant={variant} onChange={next => { changes.push(next); setValue(next); }} /><button type="button" onClick={() => saves.push(value)}>保存测试原文</button><output aria-label="保存原文">{value}</output></>;
}

test("所有默认 variant 都挂载 Tiptap；CRLF、尾空格和 HTML 打开及源码往返不写回", async t => {
  const original = '# 标题\r\n\r\n正文尾空格  \r\n下一行\r\n\r\n<div data-raw="yes">字面 HTML</div>\r\n';
  const changes: string[] = [], saves: string[] = [];
  const { document, render } = await mounted(t, <Draft initial={original} changes={changes} saves={saves} />);
  for (const variant of [undefined, "default", "document"] as const) {
    await render(<Draft initial={original} changes={changes} saves={saves} variant={variant} />);
    assert.equal(document.querySelector(".markdown-editor")?.getAttribute("data-editor-engine"), "tiptap");
    assert.equal(document.querySelector(".markdown-editor")?.getAttribute("data-variant"), variant ?? "default");
    assert.equal(editorIn(document).isEditable, true);
    assert.ok(document.querySelector('.tiptap-document-content[contenteditable="true"] h1'));
    assert.equal(document.querySelector("textarea"), null);
    await click(document, "Markdown 源码");
    assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")?.value, original.replace(/\r\n/g, "\n"));
    await click(document, "返回文档");
    assert.equal(document.querySelector("textarea"), null);
    assert.deepEqual(changes, [], "只打开或切换模式必须保留原始字节");
  }
  await click(document, "保存测试原文");
  assert.deepEqual(saves, [original]);
});

test("真实文档编辑经受控 onChange 保存 raw；连续修改不同块保留其余原始字节", async t => {
  const original = '# Preserve  \r\n\r\nFirst editable\r\n\r\nSecond editable\r\n\r\n<div data-keep="yes">literal untouched</div>\r\n\r\nTail  \r\n';
  const changes: string[] = [], saves: string[] = [];
  const { document } = await mounted(t, <Draft initial={original} changes={changes} saves={saves} variant="document" />);
  const editor = editorIn(document);
  await caretAfter(editor, "First editable");
  await typeText(editor, "!");
  const firstEdit = '# Preserve  \r\n\r\nFirst editable!\r\n\r\nSecond editable\r\n\r\n<div data-keep="yes">literal untouched</div>\r\n\r\nTail  \r\n';
  assert.equal(changes.at(-1), firstEdit);
  assert.equal(document.querySelector('[aria-label="保存原文"]')?.textContent, firstEdit);
  await click(document, "保存测试原文");
  await caretAfter(editor, "Second editable");
  await typeText(editor, "?");
  const secondEdit = '# Preserve  \r\n\r\nFirst editable!\r\n\r\nSecond editable?\r\n\r\n<div data-keep="yes">literal untouched</div>\r\n\r\nTail  \r\n';
  assert.equal(changes.at(-1), secondEdit);
  await click(document, "保存测试原文");
  assert.deepEqual(saves, [firstEdit, secondEdit]);
  assert.equal(editor.view.dom.querySelector("script,img,iframe,[data-keep]"), null);
});

async function selectDOM(dom: JSDOM, editor: Editor, from: number, to: number) {
  await act(async () => {
    editor.view.focus();
    const start = editor.view.domAtPos(from), end = editor.view.domAtPos(to);
    const range = dom.window.document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = dom.window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    dom.window.document.dispatchEvent(new dom.window.Event("selectionchange"));
    await setTimeout(0);
  });
}

test("真实 DOM 选区经只读再启用仍可替换，禁用时任务点击和格式控件不修改原文", async t => {
  const original = "Keep selected words\r\n\r\n- [ ] task\r\n";
  const changes: string[] = [];
  const { dom, document, render } = await mounted(t, <Draft initial={original} changes={changes} />);
  const editor = editorIn(document);
  const from = textPosition(editor, "selected"), to = from + "selected".length;
  await selectDOM(dom, editor, from, to);
  assert.equal(dom.window.getSelection()?.toString(), "selected");
  assert.deepEqual({ from: editor.state.selection.from, to: editor.state.selection.to }, { from, to });
  const docBefore = editor.state.doc;
  await render(<Draft initial={original} changes={changes} disabled />);
  assert.equal(editorIn(document), editor, "只读切换应保留编辑实例和选区");
  assert.equal(editor.view.dom.getAttribute("contenteditable"), "false");
  assert.equal(editor.view.dom.getAttribute("aria-disabled"), "true");
  assert.equal(button(document, "Markdown 源码").disabled, true);
  assert.equal(button(document, "粗体").disabled, true);
  assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="段落格式"]')?.disabled, true);
  const checkbox = editor.view.dom.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(checkbox);
  await act(async () => {
    checkbox.checked = true;
    checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  assert.equal(checkbox.checked, false);
  assert.ok(editor.state.doc.eq(docBefore));
  assert.deepEqual(changes, []);
  assert.deepEqual({ from: editor.state.selection.from, to: editor.state.selection.to }, { from, to });
  await render(<Draft initial={original} changes={changes} />);
  assert.equal(editor.view.dom.getAttribute("contenteditable"), "true");
  await typeText(editor, "替换");
  assert.equal(changes.at(-1), "Keep 替换 words\r\n\r\n- [ ] task\r\n");
  assert.equal(editor.view.dom.querySelector("p")?.textContent, "Keep 替换 words");
});

test("真实逐字符输入把 heading、bullet、ordered、task 和数学语法转换为结构节点", async t => {
  const changes: string[] = [];
  const { document, render } = await mounted(t, <Draft initial="" changes={changes} />);
  const cases = [
    { name: "heading", prefix: "## ", body: "标题", type: "heading", selector: "h2", attr: "level", expected: 2 },
    { name: "bullet", prefix: "- ", body: "列表", type: "bulletList", selector: "ul:not([data-type]) li" },
    { name: "ordered", prefix: "3. ", body: "第三项", type: "orderedList", selector: 'ol[start="3"] li', attr: "start", expected: 3 },
    { name: "inline math", prefix: "$x^2$", body: "", type: "inlineMath", selector: '[data-type="inline-math"] .katex', attr: "latex", expected: "x^2" },
    { name: "block math", prefix: "$$x+1$$", body: "", type: "blockMath", selector: '[data-type="block-math"] .katex', attr: "latex", expected: "x+1" },
    { name: "task", prefix: "- [ ] ", body: "待办", type: "taskList", selector: 'ul[data-type="taskList"] input[type="checkbox"]' },
  ];
  for (const item of cases) {
    await render(<Draft key={item.name} initial="" changes={changes} />);
    const editor = editorIn(document);
    await typeText(editor, item.prefix);
    let found = false;
    editor.state.doc.descendants(node => { if (node.type.name === item.type) { found = true; if (item.attr) assert.equal(node.attrs[item.attr], item.expected, item.name); } });
    assert.ok(found, `${item.name} 的键入应生成 ${item.type}；实际 ${JSON.stringify(editor.getJSON())}`);
    await typeText(editor, item.body);
    assert.ok(editor.view.dom.querySelector(item.selector), `${item.name} 应显示真实结构`);
    if (item.body) assert.ok(editor.view.dom.textContent?.includes(item.body));
    editor.state.doc.check();
  }
});

test("逐字键入 Markdown 表头与分隔行并回车，原位生成可编辑表格结构", async t => {
  const changes: string[] = [];
  const { dom, document } = await mounted(t, <Draft initial="" changes={changes} />);
  const editor = editorIn(document);
  await typeText(editor, "| Name | Value |");
  assert.equal((await key(dom, editor, "Enter")).defaultPrevented, true);
  await typeText(editor, "| --- | --- |");
  assert.equal((await key(dom, editor, "Enter")).defaultPrevented, true);
  assert.equal(editor.state.doc.firstChild?.type.name, "table", `表格语法应直接转换；实际 ${JSON.stringify(editor.getJSON())}`);
  assert.deepEqual([...editor.view.dom.querySelectorAll("table th")].map(cell => cell.textContent), ["Name", "Value"]);
  assert.ok(editor.view.dom.querySelector(".tableWrapper table"));
  assert.ok(editor.isActive("table"), "回车后光标应进入表格继续编辑");
  await typeText(editor, "row");
  assert.match(changes.at(-1) ?? "", /row/);
  assert.equal(editor.state.doc.firstChild?.type.name, "table");
  editor.state.doc.check();
});

test("原位块语法通过键盘打开并将 h1 改成 h2，保留兄弟块原文", async t => {
  const original = "# Original\r\n\r\nKeep raw  \r\n\r\nLast\r\n";
  const changes: string[] = [];
  const { dom, document } = await mounted(t, <Draft initial={original} changes={changes} />);
  const editor = editorIn(document);
  await caretAfter(editor, "Original");
  const open = await key(dom, editor, "m", { ctrlKey: true, shiftKey: true });
  assert.equal(open.defaultPrevented, true);
  const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="当前块 Markdown"]');
  assert.ok(area);
  assert.ok(editor.view.dom.contains(area), "块语法应在当前块原位显示");
  assert.equal(area.value, "# Original");
  assert.deepEqual(changes, [], "只打开块语法不改动原文");
  await input(dom, area, "## Original");
  assert.equal(changes.at(-1), "## Original\r\n\r\nKeep raw  \r\n\r\nLast\r\n");
  await act(async () => { area.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  assert.equal(document.querySelector('textarea[aria-label="当前块 Markdown"]'), null);
  assert.equal(editor.view.dom.querySelector("h1"), null);
  assert.equal(editor.view.dom.querySelector("h2")?.textContent, "Original");
  assert.equal(editor.isEditable, true);
  await typeText(editor, "新");
  assert.match(changes.at(-1) ?? "", /^## 新Original\r\n/);
});

test("source 模式纯空白修改进入真实历史，撤销重做精确恢复 CRLF 和尾空格", async t => {
  const original = "# Heading\r\n\r\nbody  \r\n";
  const changed = "# Heading \r\n\r\nbody  \r\n";
  const changes: string[] = [], saves: string[] = [];
  const { dom, document } = await mounted(t, <Draft initial={original} changes={changes} saves={saves} />);
  const editor = editorIn(document);
  const before = editor.state.doc.content;
  await click(document, "Markdown 源码");
  const area = document.querySelector<HTMLTextAreaElement>("textarea");
  assert.ok(area);
  area.setSelectionRange("# Heading".length, "# Heading".length);
  await act(async () => { area.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: " ", bubbles: true })); });
  await input(dom, area, "# Heading \n\nbody  \n");
  assert.equal(changes.at(-1), changed);
  assert.ok(editor.state.doc.content.eq(before), "空白修改的语义结构应保持相同");
  await act(async () => { assert.equal(editor.commands.undo(), true, "源码空白修改必须可撤销"); });
  assert.equal(changes.at(-1), original);
  assert.equal(area.value, "# Heading\n\nbody  \n");
  await act(async () => { assert.equal(editor.commands.redo(), true, "源码空白修改必须可重做"); });
  assert.equal(changes.at(-1), changed);
  assert.equal(area.value, "# Heading \n\nbody  \n");
  await click(document, "返回文档");
  await click(document, "保存测试原文");
  assert.deepEqual(saves, [changed]);
});

test("中文 composition 经 DOM mutation 正常提交，组合期间快捷键不打断且脚注 HTML 始终为字面内容", async t => {
  const original = '中文正文 \r\n\r\n脚注[^n] 与 <img src=x onerror="window.__executed=1"> 标签\r\n\r\n[^n]: 原文 <script>window.__executed=1</script>\r\n\r\n<script>window.__executed=1</script>\r\n';
  const changes: string[] = [];
  const { dom, document } = await mounted(t, <Draft initial={original} changes={changes} />);
  const editor = editorIn(document);
  const assertLiteral = () => {
    assert.equal(editor.view.dom.querySelector("img,script,iframe,object,embed,[onerror],[onclick]"), null);
    assert.ok(editor.view.dom.textContent?.includes('[^n]: 原文 <script>window.__executed=1</script>'));
    assert.ok(editor.view.dom.textContent?.includes('<img src=x onerror="window.__executed=1">'));
    assert.ok(editor.view.dom.querySelector('[data-literal-kind="footnote"]'));
    assert.ok(editor.view.dom.querySelector('[data-literal-kind="footnoteDefinition"]'));
    assert.equal(Reflect.get(dom.window, "__executed"), undefined);
  };
  assertLiteral();
  const position = textPosition(editor, "中文正文 ") + "中文正文 ".length;
  await selectDOM(dom, editor, position, position);
  const paragraph = editor.view.dom.querySelector("p")!;
  const text = paragraph.firstChild;
  assert.ok(text instanceof dom.window.Text);
  const base = text.data;
  await act(async () => { editor.view.dom.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true })); });
  assert.equal(editor.view.composing, true);
  const shortcut = await key(dom, editor, "m", { ctrlKey: true, shiftKey: true, isComposing: true });
  assert.equal(shortcut.defaultPrevented, false);
  assert.equal(document.querySelector("textarea"), null);
  for (const data of ["中", "中文输入"]) {
    await act(async () => {
      await new Promise<void>((resolve, reject) => {
        const updated = () => { globalThis.clearTimeout(timeout); resolve(); };
        const timeout = globalThis.setTimeout(() => { editor.off("update", updated); reject(new Error("composition 的真实 DOM mutation 未进入 Tiptap")); }, 500);
        editor.once("update", updated);
        editor.view.dom.dispatchEvent(new dom.window.InputEvent("beforeinput", { bubbles: true, inputType: "insertCompositionText", data, isComposing: true }));
        editor.view.dom.dispatchEvent(new dom.window.CompositionEvent("compositionupdate", { bubbles: true, data }));
        text.data = base + data;
        dom.window.getSelection()!.collapse(text, text.length);
        editor.view.dom.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data, isComposing: true }));
      });
    });
    assert.equal(text.isConnected, true, "组合期间应保留当前输入的 DOM 文本节点");
    assert.equal(editor.state.doc.firstChild?.textContent, base + data);
    assert.equal(editor.view.composing, true);
    assert.equal(paragraph.textContent, base + data);
    assert.equal(document.querySelector("textarea"), null);
  }
  await act(async () => {
    editor.view.dom.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true, data: "中文输入" }));
    // ProseMirror ends composition and input rules on the following tasks.
    await setTimeout(30);
  });
  assert.equal(editor.view.composing, false);
  assert.equal(changes.at(-1), '中文正文 中文输入\r\n\r\n脚注[^n] 与 <img src=x onerror="window.__executed=1"> 标签\r\n\r\n[^n]: 原文 <script>window.__executed=1</script>\r\n\r\n<script>window.__executed=1</script>\r\n');
  assertLiteral();
  editor.state.doc.check();
});

test("富文本与源码连续撤销保留初始 Setext、CRLF 与尾空格", async t => {
  const original = "Original  \r\n=======\r\n\r\nbody\r\n";
  const changes: string[] = [];
  const { dom, document } = await mounted(t, <Draft initial={original} changes={changes} />);
  const editor = editorIn(document);
  await caretAfter(editor, "Original");
  await typeText(editor, "!");
  await click(document, "Markdown 源码");
  const area = document.querySelector<HTMLTextAreaElement>("textarea")!;
  area.setSelectionRange(area.value.length, area.value.length);
  await input(dom, area, area.value + "\n");
  await act(async () => { assert.equal(editor.commands.undo(), true); assert.equal(editor.commands.undo(), true); });
  assert.equal(changes.at(-1), original);
});

test("当前块源码只改标记或尾空格仍精确回写外围原文", async t => {
  const original = "Heading\r\n=======\r\n\r\nKEEP  \r\n";
  const changes: string[] = [];
  const { dom, document } = await mounted(t, <Draft initial={original} changes={changes} />);
  const editor = editorIn(document);
  await caretAfter(editor, "Heading");
  await key(dom, editor, "m", { ctrlKey: true, shiftKey: true });
  const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="当前块 Markdown"]')!;
  assert.equal(area.value, "Heading\n=======");
  area.setSelectionRange(0, area.value.length);
  await input(dom, area, "# Heading ");
  assert.equal(changes.at(-1), "# Heading \r\n\r\nKEEP  \r\n");
});
