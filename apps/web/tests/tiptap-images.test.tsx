import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { act, useState, type ReactNode } from "react";
import type { Editor, JSONContent, TiptapEditorHTMLElement } from "@tiptap/core";
import { MarkdownEditor, type MarkdownEditorProps } from "../dist/editor/MarkdownEditor.js";
import { parseDocument } from "../dist/editor/tiptap/parse-document.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWQAAAAASUVORK5CYII=";
type ImageReader = NonNullable<MarkdownEditorProps["imageFileReader"]>;

// JSDOM has no layout engine. Only geometry is supplied; React, Tiptap,
// selection, Markdown parsing and the source ledger run without mocks.
async function mounted(t: TestContext, component: ReactNode) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://editor.test/", pretendToBeVisual: true, runScripts: "dangerously",
  });
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
    // useEditor defers destruction to allow a StrictMode remount.
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

function Draft({ initial, changes, pending, reader, events, disabled = false, maxBytes, shown = true }: {
  initial: string; changes: string[]; pending: boolean[]; reader: ImageReader;
  events?: string[]; disabled?: boolean; maxBytes?: number; shown?: boolean;
}) {
  const [source, setSource] = useState(initial);
  return <>
    {shown && <MarkdownEditor label="图片测试正文" value={source} disabled={disabled} maxBytes={maxBytes}
      imageFileReader={reader}
      onPendingChange={next => { pending.push(next); events?.push(`pending:${next}`); }}
      onChange={next => { changes.push(next); events?.push("change"); setSource(next); }} />}
    <output aria-label="宿主 Markdown">{source}</output>
  </>;
}

function editorIn(document: Document): Editor {
  const element = document.querySelector<TiptapEditorHTMLElement>(".tiptap-document-content");
  assert.ok(element?.editor, "必须挂载真实 Tiptap Editor");
  return element.editor;
}

function savedSource(document: Document) {
  const output = document.querySelector('[aria-label="宿主 Markdown"]');
  assert.ok(output, "受控宿主必须保留当前 Markdown");
  return output.textContent;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function pngFile(dom: JSDOM, name = "pixel.png") {
  const bytes = Uint8Array.from(Buffer.from(PNG.split(",")[1]!, "base64"));
  return new dom.window.File([bytes], name, { type: "image/png" });
}

async function chooseFiles(dom: JSDOM, files: File[]) {
  const input = dom.window.document.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(input, "必须通过真实隐藏 file input 选择图片");
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
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

function allNodes(node: JSONContent): JSONContent[] {
  return [node, ...(node.content ?? []).flatMap(allNodes)];
}

function largePNG() {
  return `data:image/png;base64,${Buffer.concat([Buffer.from(PNG.split(",")[1]!, "base64"), Buffer.alloc(2 * 1024 * 1024)]).toString("base64")}`;
}

test("异步 PNG 读取仅成功后写回受控 Markdown，pending true→false 且使用读取前的 DOM 选区", async t => {
  const initial = "# Preserve  \r\n\r\nBefore\r\n\r\nreplace me\r\n\r\nAfter  \r\n";
  const changes: string[] = [], pending: boolean[] = [], events: string[] = [], reads: File[] = [];
  const read = deferred<string>();
  const reader: ImageReader = file => { reads.push(file); return read.promise; };
  const { dom, document } = await mounted(t, <Draft initial={initial} changes={changes} pending={pending} events={events} reader={reader} />);
  const editor = editorIn(document);
  const from = textPosition(editor, "replace me"), to = from + "replace me".length;
  await selectDOM(dom, editor, from, to);
  assert.equal(dom.window.getSelection()?.toString(), "replace me");
  assert.deepEqual({ from: editor.state.selection.from, to: editor.state.selection.to }, { from, to });
  const before = editor.state.doc;
  const file = pngFile(dom);
  await chooseFiles(dom, [file]);
  assert.deepEqual(reads, [file]);
  assert.deepEqual(pending, [true]);
  assert.deepEqual(changes, [], "读取成功前必须保留受控原文");
  assert.equal(savedSource(document), initial);
  assert.ok(editor.state.doc.eq(before));
  assert.equal(editor.isEditable, false);
  assert.equal(document.querySelector(".markdown-editor")?.getAttribute("aria-busy"), "true");
  assert.deepEqual({ from: editor.state.selection.from, to: editor.state.selection.to }, { from, to });
  // A later selection transaction must not redirect the outstanding insertion.
  await act(async () => { editor.commands.setTextSelection(textPosition(editor, "After") + "After".length); });
  assert.notEqual(editor.state.selection.from, from);
  await act(async () => { read.resolve(PNG); await read.promise; });
  const expected = `# Preserve  \r\n\r\nBefore\r\n\r\n![图片](${PNG})\r\n\r\nAfter  \r\n`;
  assert.deepEqual(changes, [expected]);
  assert.equal(savedSource(document), expected);
  assert.deepEqual(pending, [true, false]);
  assert.deepEqual(events, ["pending:true", "change", "pending:false"]);
  assert.equal(editor.view.dom.querySelector('img[src]')?.getAttribute("src"), PNG);
  assert.equal(allNodes(editor.getJSON()).filter(node => node.type === "image").length, 1);
  assert.equal(editor.isEditable, true);
  assert.equal(document.querySelector(".markdown-editor")?.getAttribute("aria-busy"), "false");
  editor.state.doc.check();
});

test("pending 期间重复触发 file input 不重复读取或插入", async t => {
  const changes: string[] = [], pending: boolean[] = [], reads: File[] = [];
  const read = deferred<string>();
  const reader: ImageReader = file => { reads.push(file); return read.promise; };
  const { dom, document } = await mounted(t, <Draft initial="" changes={changes} pending={pending} reader={reader} />);
  const first = pngFile(dom, "first.png"), second = pngFile(dom, "second.png");
  await chooseFiles(dom, [first]);
  await chooseFiles(dom, [first]);
  await chooseFiles(dom, [second]);
  assert.deepEqual(reads, [first]);
  assert.deepEqual(pending, [true]);
  assert.deepEqual(changes, []);
  assert.equal(savedSource(document), "");
  await act(async () => { read.resolve(PNG); await read.promise; });
  assert.deepEqual(reads, [first]);
  assert.deepEqual(pending, [true, false]);
  assert.deepEqual(changes, [`![图片](${PNG})`]);
  assert.equal(savedSource(document), `![图片](${PNG})`);
  assert.equal(allNodes(editorIn(document).getJSON()).filter(node => node.type === "image").length, 1);
});

test("await 图片期间 disabled 变为 true 后不提交原文并释放 pending", async t => {
  const initial = "Keep raw  \r\n";
  const changes: string[] = [], pending: boolean[] = [];
  const read = deferred<string>();
  const reader: ImageReader = () => read.promise;
  const { dom, document, render } = await mounted(t, <Draft initial={initial} changes={changes} pending={pending} reader={reader} />);
  const editor = editorIn(document), before = editor.state.doc;
  await chooseFiles(dom, [pngFile(dom)]);
  assert.deepEqual(pending, [true]);
  await render(<Draft initial={initial} changes={changes} pending={pending} reader={reader} disabled />);
  assert.equal(editorIn(document), editor);
  await act(async () => { read.resolve(PNG); await read.promise; });
  assert.deepEqual(changes, []);
  assert.equal(savedSource(document), initial);
  assert.ok(editor.state.doc.eq(before));
  assert.equal(editor.view.dom.querySelector('img[src]'), null);
  assert.equal(editor.isEditable, false);
  assert.deepEqual(pending, [true, false]);
  assert.equal(document.querySelector('[role="status"]'), null);
  assert.equal(document.querySelector('[role="alert"]'), null);
});

test("await 图片期间卸载立即释放 pending，稍后 resolve 不提交也不重复回调", async t => {
  const initial = "Unmount keeps raw  \r\n";
  const changes: string[] = [], pending: boolean[] = [];
  const read = deferred<string>();
  const reader: ImageReader = () => read.promise;
  const { dom, document, render } = await mounted(t, <Draft initial={initial} changes={changes} pending={pending} reader={reader} />);
  await chooseFiles(dom, [pngFile(dom)]);
  assert.deepEqual(pending, [true]);
  await render(<Draft initial={initial} changes={changes} pending={pending} reader={reader} shown={false} />);
  assert.equal(document.querySelector(".markdown-editor"), null);
  assert.deepEqual(pending, [true, false], "卸载必须在 reader resolve 之前释放宿主 pending");
  assert.deepEqual(changes, []);
  assert.equal(savedSource(document), initial);
  await act(async () => { read.resolve(PNG); await read.promise; });
  assert.deepEqual(changes, []);
  assert.equal(savedSource(document), initial);
  assert.deepEqual(pending, [true, false]);
});

test("maxBytes 超限保留原文和错误，整批图片不部分提交", async t => {
  const initial = "容量  \r\n";
  const changes: string[] = [], pending: boolean[] = [], reads: File[] = [];
  const first = deferred<string>(), second = deferred<string>();
  const reader: ImageReader = file => { reads.push(file); return reads.length === 1 ? first.promise : second.promise; };
  const oneImage = initial + `\n\n![图片](${PNG})\n\n`;
  const maxBytes = new TextEncoder().encode(oneImage).length;
  const { dom, document } = await mounted(t, <Draft initial={initial} changes={changes} pending={pending} reader={reader} maxBytes={maxBytes} />);
  const editor = editorIn(document), before = editor.state.doc;
  const files = [pngFile(dom, "one.png"), pngFile(dom, "two.png")];
  await chooseFiles(dom, files);
  await act(async () => { first.resolve(PNG); await first.promise; });
  assert.deepEqual(reads, files, "第一张恰好达到字节上限，第二张应继续读取后统一校验");
  assert.deepEqual(changes, [], "批量读取中不得提前提交第一张");
  assert.deepEqual(pending, [true]);
  await act(async () => { second.resolve(PNG); await second.promise; });
  assert.deepEqual(changes, []);
  assert.equal(savedSource(document), initial);
  assert.ok(editor.state.doc.eq(before));
  assert.deepEqual(pending, [true, false]);
  assert.equal(document.querySelector('[role="alert"]')?.textContent, "备注含图片不能超过 8 MiB，请减少图片。");
  assert.equal(editor.view.dom.querySelector('img[src]'), null);
  assert.equal(editor.isEditable, true);
});

test("读取失败展示错误并释放 pending，同一文件可重试且仅成功后提交", async t => {
  const initial = "Keep\r\n\r\nreplace\r\n";
  const changes: string[] = [], pending: boolean[] = [], reads: File[] = [];
  const first = deferred<string>(), retry = deferred<string>();
  const reader: ImageReader = file => { reads.push(file); return reads.length === 1 ? first.promise : retry.promise; };
  const { dom, document } = await mounted(t, <Draft initial={initial} changes={changes} pending={pending} reader={reader} />);
  const editor = editorIn(document);
  const from = textPosition(editor, "replace");
  await selectDOM(dom, editor, from, from + "replace".length);
  const before = editor.state.doc, file = pngFile(dom);
  await chooseFiles(dom, [file]);
  await act(async () => { first.reject(new Error("读取测试 PNG 失败")); await first.promise.catch(() => undefined); });
  assert.deepEqual(changes, []);
  assert.equal(savedSource(document), initial);
  assert.ok(editor.state.doc.eq(before));
  assert.deepEqual(pending, [true, false]);
  assert.equal(document.querySelector('[role="alert"]')?.textContent, "读取测试 PNG 失败");
  assert.equal(editor.isEditable, true);
  await chooseFiles(dom, [file]);
  assert.deepEqual(reads, [file, file]);
  assert.deepEqual(pending, [true, false, true]);
  assert.equal(document.querySelector('[role="alert"]'), null, "重试开始后应清除旧错误");
  assert.deepEqual(changes, []);
  await act(async () => { retry.resolve(PNG); await retry.promise; });
  const expected = `Keep\r\n\r\n![图片](${PNG})\r\n`;
  assert.deepEqual(changes, [expected]);
  assert.equal(savedSource(document), expected);
  assert.deepEqual(pending, [true, false, true, false]);
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(editor.view.dom.querySelector('img[src]')?.getAttribute("src"), PNG);
});

test("粘贴图片只提交文件读取结果，clipboard HTML 的脚本和事件处理器不执行", async t => {
  const changes: string[] = [], pending: boolean[] = [], reads: File[] = [];
  const read = deferred<string>();
  const reader: ImageReader = file => { reads.push(file); return read.promise; };
  const { dom, document } = await mounted(t, <Draft initial="" changes={changes} pending={pending} reader={reader} />);
  const editor = editorIn(document), file = pngFile(dom);
  const html = '<script>window.__clipboardExecuted = true</script><img src=x onerror="window.__clipboardExecuted = true">';
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    files: [file], items: [{ kind: "file", getAsFile: () => file }],
    getData: (type: string) => type === "text/html" ? html : "clipboard plain text",
  } });
  await act(async () => { editor.view.dom.dispatchEvent(event); });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(reads, [file]);
  assert.deepEqual(pending, [true]);
  assert.deepEqual(changes, []);
  assert.equal(savedSource(document), "");
  await act(async () => { read.resolve(PNG); await read.promise; });
  assert.deepEqual(changes, [`![图片](${PNG})`]);
  assert.equal(savedSource(document), `![图片](${PNG})`);
  assert.deepEqual(pending, [true, false]);
  // ProseMirror also uses src-less img.ProseMirror-separator for inline atoms.
  assert.equal(editor.view.dom.querySelectorAll("img[src]").length, 1);
  assert.equal(editor.view.dom.querySelector('img[src]')?.getAttribute("src"), PNG);
  assert.equal(document.querySelector("script,[onerror],[onclick],iframe,object,embed"), null);
  await act(async () => { editor.view.dom.querySelector('img[src]')!.dispatchEvent(new dom.window.Event("error")); });
  assert.equal(Reflect.get(dom.window, "__clipboardExecuted"), undefined);
});

test("无图片文件的剪贴板只采用 plain text，HTML 脚本和事件属性保持不执行", async t => {
  const changes: string[] = [], pending: boolean[] = [], reads: File[] = [];
  const reader: ImageReader = async file => { reads.push(file); return PNG; };
  const { dom, document } = await mounted(t, <Draft initial="" changes={changes} pending={pending} reader={reader} />);
  const editor = editorIn(document);
  const text = 'literal <img src=x onerror="window.__clipboardExecuted = true">';
  const html = '<script>window.__clipboardExecuted = true</script><img src=x onerror="window.__clipboardExecuted = true">';
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    files: [], items: [], getData: (type: string) => type === "text/html" ? html : type === "text/plain" ? text : "",
  } });
  await act(async () => { editor.view.dom.dispatchEvent(event); });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(changes, [text]);
  assert.equal(savedSource(document), text);
  assert.equal(editor.view.dom.textContent, text);
  assert.equal(document.querySelector("img,script,[onerror],[onclick],iframe,object,embed"), null);
  assert.equal(Reflect.get(dom.window, "__clipboardExecuted"), undefined);
  assert.deepEqual(reads, []);
  assert.deepEqual(pending, []);
});

test("parseDocument 解析超过 2 MiB dataURI 不抛 RangeError，image attrs 精确恢复原数据", async t => {
  const changes: string[] = [], pending: boolean[] = [];
  const { document } = await mounted(t, <Draft initial="" changes={changes} pending={pending} reader={async () => PNG} />);
  const editor = editorIn(document), payload = largePNG();
  assert.ok(new TextEncoder().encode(payload).length > 2 * 1024 * 1024);
  let parsed: JSONContent | undefined;
  assert.doesNotThrow(() => { parsed = parseDocument(editor, `![large PNG](${payload} "retained title")`); });
  assert.ok(parsed);
  const images = allNodes(parsed).filter(node => node.type === "image");
  assert.equal(images.length, 1);
  assert.equal(images[0]!.attrs?.src, payload);
  assert.equal(images[0]!.attrs?.alt, "large PNG");
  assert.equal(images[0]!.attrs?.title, "retained title");
  editor.schema.nodeFromJSON(parsed).check();
  assert.deepEqual(changes, [], "纯解析不得写回受控编辑器");
  assert.deepEqual(pending, []);
  assert.equal(savedSource(document), "");
});

test("parseDocument 恢复 HTML、fenced code 和 inline code 中超过 2 MiB dataURI 的原字面", async t => {
  const changes: string[] = [], pending: boolean[] = [];
  const { dom, document } = await mounted(t, <Draft initial="" changes={changes} pending={pending} reader={async () => PNG} />);
  const editor = editorIn(document), payload = largePNG();
  const html = `<img src="${payload}" onerror="window.__parseExecuted = true">`;
  const code = `const image = "${payload}";`;
  const source = `${html}\n\n\`\`\`text\n${code}\n\`\`\`\n\nInline \`${payload}\`.`;
  let parsed: JSONContent | undefined;
  assert.doesNotThrow(() => { parsed = parseDocument(editor, source); });
  assert.ok(parsed);
  const doc = editor.schema.nodeFromJSON(parsed);
  doc.check();
  assert.equal(doc.child(0).type.name, "markdownLiteralBlock");
  assert.equal(doc.child(0).textContent, html, "HTML 中的原始 dataURI 必须完整还原");
  assert.equal(doc.child(1).type.name, "codeBlock");
  assert.equal(doc.child(1).textContent, code, "围栏代码中的 dataURI 必须保持字面");
  const inlineCode = allNodes(parsed).filter(node => node.marks?.some(mark => mark.type === "code"));
  assert.equal(inlineCode.length, 1);
  assert.equal(inlineCode[0]!.text, payload);
  assert.equal(allNodes(parsed).filter(node => node.type === "image").length, 0, "HTML 和代码不得转成图片节点");
  assert.equal(editor.markdown!.serialize(parsed), source);
  await act(async () => { editor.commands.setContent(parsed!, { emitUpdate: false }); });
  assert.equal(editor.view.dom.querySelector("img,script,[onerror],iframe,object,embed"), null);
  assert.equal(editor.view.dom.querySelector('[data-literal-kind="html"]')?.textContent, html);
  assert.equal(Reflect.get(dom.window, "__parseExecuted"), undefined);
  assert.deepEqual(changes, []);
  assert.deepEqual(pending, []);
  assert.equal(savedSource(document), "");
});

for (const mode of ["document", "block"] as const) {
  test(`${mode} 源码粘贴图片使用 textarea 光标，不覆盖隐藏富文本旧选区`, async t => {
    const changes: string[] = [], pending: boolean[] = [], image = deferred<string>();
    const original = "KEEP\r\n\r\nEND";
    const { dom, document } = await mounted(t, <Draft initial={original} changes={changes} pending={pending} reader={() => image.promise} />);
    const editor = editorIn(document);
    await selectDOM(dom, editor, 1, 5);
    await act(async () => {
      if (mode === "document") [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Markdown 源码")!.click();
      else editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "m", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    const area = document.querySelector<HTMLTextAreaElement>("textarea")!;
    assert.ok(area);
    area.setSelectionRange(area.value.length, area.value.length);
    await act(async () => {
      const paste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", { value: { files: [pngFile(dom)], items: [], getData: () => "" } });
      area.dispatchEvent(paste);
    });
    assert.deepEqual(changes, []);
    assert.deepEqual(pending, [true]);
    await act(async () => { image.resolve(PNG); await setTimeout(0); });
    assert.equal(savedSource(document), mode === "document" ? `${original}![图片](${PNG})` : `KEEP![图片](${PNG})\r\n\r\nEND`);
    assert.deepEqual(pending, [true, false]);
    assert.equal(changes.length, 1);
  });
}
