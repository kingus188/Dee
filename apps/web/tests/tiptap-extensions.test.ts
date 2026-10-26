import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Editor, type EditorOptions, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { createDocumentExtensions } from "../dist/editor/tiptap/extensions.js";
import { imageSourceKind } from "../dist/editor/tiptap/markdown-nodes.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWQAAAAASUVORK5CYII=";

function allNodes(node: JSONContent): JSONContent[] {
  return [node, ...(node.content ?? []).flatMap(allNodes)];
}

function model(source: string) {
  return new Editor({ element: null, extensions: createDocumentExtensions(), content: source, contentType: "markdown" });
}

function mounted(t: TestContext) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://editor.test/", pretendToBeVisual: true });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLAnchorElement: dom.window.HTMLAnchorElement,
    Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const editors: Editor[] = [];
  t.after(() => {
    for (const editor of editors) editor.destroy();
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    dom,
    create(source: string, options: Partial<EditorOptions> = {}) {
      const element = dom.window.document.createElement("div");
      dom.window.document.body.append(element);
      const editor = new Editor({ element, extensions: createDocumentExtensions(), content: source, contentType: "markdown", injectCSS: false, ...options });
      editors.push(editor);
      return editor;
    },
  };
}

function typeText(editor: Editor, text: string) {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", handler => handler(editor.view, from, to, character, () => editor.state.tr.insertText(character, from, to)));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(character, from, to));
  }
}

test("扩展在无 window 的真实 Editor 与 MarkdownManager 中解析完整正文且 schema 有效", () => {
  assert.equal(typeof window, "undefined");
  for (const input of ["", " ", "\n"]) {
    const empty = model(input);
    try { empty.state.doc.check(); assert.equal(empty.getMarkdown(), ""); }
    finally { empty.destroy(); }
  }
  const source = [
    "# Heading", "", "**bold** and *italic* and ~~gone~~ and `code` [link](https://example.test)", "",
    "- [ ] first", "  - [x] second", "    - [ ] third", "", "3. third", "4. fourth", "",
    "| Name | Value |", "| :--- | ---: |", "| a | $x^2$ |", "",
    "```typescript", "const x: number = 1", "```", "", "$E=mc^2$", "", "$$", "\\frac{a}{b}", "$$",
  ].join("\n");
  const editor = model(source);
  try {
    editor.state.doc.check();
    const nodes = allNodes(editor.getJSON());
    for (const type of ["heading", "taskList", "taskItem", "orderedList", "table", "tableHeader", "tableCell", "codeBlock", "inlineMath", "blockMath"]) assert.ok(nodes.some(node => node.type === type), type);
    assert.equal(nodes.filter(node => node.type === "taskList").length, 3);
    assert.equal(nodes.find(node => node.type === "orderedList")?.attrs?.start, 3);
    assert.equal(nodes.find(node => node.type === "codeBlock")?.attrs?.language, "typescript");
    assert.equal(nodes.find(node => node.type === "tableHeader")?.attrs?.align, "left");
    const serialized = editor.getMarkdown();
    assert.match(serialized, /- \[ \] first\n  - \[x\] second\n    - \[ \] third/);
    assert.match(serialized, /```typescript/);
    assert.match(serialized, /\$\$\n\\frac\{a\}\{b\}\n\$\$/);
    const manager = new MarkdownManager({ extensions: createDocumentExtensions() });
    const reparsed = editor.schema.nodeFromJSON(manager.parse(serialized));
    reparsed.check();
    assert.ok(reparsed.eq(editor.state.doc));
    assert.equal(editor.extensionManager.extensions.filter(extension => extension.name === "codeBlock").length, 1);
  } finally { editor.destroy(); }
});

test("frontmatter、脚注定义与 HTML 各自保留为可编辑局部 literal，前后正文保持富文本", () => {
  const source = '---\ntitle: "<title>"\n---\n\n# Heading\n\ntext[^note] <em>literal</em> tail\n\n[^note]: note text\n    continuation\n\n<script>globalThis.executed = true</script>\n\n**after**';
  const manager = new MarkdownManager({ extensions: createDocumentExtensions() });
  const json = manager.parse(source);
  const nodes = allNodes(json);
  for (const kind of ["frontmatter", "footnote", "footnoteDefinition", "html"]) assert.ok(nodes.some(node => node.attrs?.kind === kind), kind);
  assert.equal(nodes.some(node => node.marks?.some(mark => mark.type === "italic")), false);
  assert.equal(manager.serialize(json), source);
  const editor = model(source);
  try {
    editor.state.doc.check();
    const titlePosition = editor.state.doc.textContent.indexOf("title");
    assert.ok(titlePosition >= 0);
    editor.commands.insertContentAt(5, { type: "text", text: "updated " });
    assert.match(editor.getMarkdown(), /updated/);
    assert.ok(allNodes(editor.getJSON()).some(node => node.type === "heading"));
  } finally { editor.destroy(); }
});

test("JSDOM 中所有 Markdown HTML token 均显示原文，不创建 HTML 图像、脚本或框架", t => {
  const { create, dom } = mounted(t);
  const htmlProperty = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, "innerHTML")!;
  const htmlWrites: string[] = [];
  Object.defineProperty(dom.window.Element.prototype, "innerHTML", {
    ...htmlProperty,
    set(value: string) { htmlWrites.push(String(value)); htmlProperty.set!.call(this, value); },
  });
  const source = '# before\n\ntext <img src="https://tracker.test/inline.png" onerror="globalThis.pwned=1"> <iframe src="https://tracker.test/frame"></iframe> <em>tag</em>\n\n<script>globalThis.pwned=1</script>\n\n<div><img src="https://tracker.test/block.png"></div>\n\n# after';
  const editor = create(source);
  editor.state.doc.check();
  assert.equal(editor.view.dom.querySelectorAll("img,iframe,script,object,embed").length, 0);
  assert.ok(editor.view.dom.textContent?.includes('<img src="https://tracker.test/inline.png"'));
  assert.ok(editor.view.dom.textContent?.includes("<script>globalThis.pwned=1</script>"));
  assert.equal(Reflect.get(dom.window, "pwned"), undefined);
  assert.match(editor.getHTML(), /&lt;script&gt;/);
  assert.match(editor.getMarkdown(), /<iframe src="https:\/\/tracker.test\/frame"><\/iframe>/);
  assert.equal(editor.view.dom.querySelectorAll("h1").length, 2);
  editor.commands.setContent(source, { contentType: "markdown" });
  assert.equal(htmlWrites.some(value => value.includes("<script>") || value.includes("<img src=") || value.includes("<iframe")), false);
});

test("图片验证拒绝 script/file/SVG 与 MIME 伪装，https 图片默认占位且显式点击后才设置 src", t => {
  const { create } = mounted(t);
  const calls: Array<[string, number]> = [];
  const remote = "https://images.test/photo.png";
  const editor = create(`![remote](${remote})\n\n![embedded](${PNG})\n\n![bad](javascript:alert%281%29)\n\n![svg](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)`, {
    extensions: createDocumentExtensions({ onEditNode: (kind, pos) => calls.push([kind, pos]) }),
  });
  editor.state.doc.check();
  for (const value of ["javascript:alert(1)", "file:///tmp/test.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:text/html;base64,PGltZz4=", "data:image/png;base64,PGh0bWw+", "https://user:pass@images.test/a.png", "https://images.test/\nfile.png"]) assert.equal(imageSourceKind(value), undefined, value);
  assert.equal(imageSourceKind(PNG), "data");
  assert.equal(editor.view.dom.querySelectorAll("img[src]").length, 1);
  assert.equal(editor.view.dom.querySelector("img[src]")?.getAttribute("src"), PNG);
  assert.equal(editor.getHTML().includes(remote), false);
  const load = Array.from(editor.view.dom.querySelectorAll("button")).find(button => button.textContent === "加载外部图片");
  assert.ok(load);
  const original = editor.getJSON();
  load.click();
  assert.ok(editor.view.dom.querySelector(`img[src="${remote}"]`));
  assert.deepEqual(editor.getJSON(), original);
  assert.deepEqual(calls, []);
  const image = editor.view.dom.querySelector<HTMLImageElement>(`img[src="${remote}"]`)!;
  image.click();
  assert.equal(calls[0]?.[0], "image");
  assert.equal(editor.state.doc.nodeAt(calls[0]![1])?.type.name, "image");
  editor.commands.setNodeSelection(calls[0]![1]);
  assert.equal(editor.commands.updateAttributes("image", { src: "https://images.test/changed.png" }), true);
  assert.equal(editor.view.dom.querySelector(`img[src="${remote}"]`), null);
  assert.equal(editor.view.dom.querySelector('img[src="https://images.test/changed.png"]'), null);
  editor.commands.setNodeSelection(calls[0]![1]);
  assert.equal(editor.commands.updateAttributes("image", { src: "javascript:alert(1)" }), true);
  assert.equal(editor.view.dom.querySelector('img[src^="javascript:"]'), null);
  editor.setEditable(false);
  const readOnly = editor.getJSON();
  editor.view.dom.querySelector<HTMLElement>('[data-type="document-image"] > span')!.click();
  assert.equal(calls.length, 1);
  assert.deepEqual(editor.getJSON(), readOnly);
  assert.match(editor.getMarkdown(), /!\[svg\]\(data:image\/svg\+xml/);
});

test("真实 KaTeX 节点使用 trust:false，点击传 kind/pos，切换只读后停止编辑回调", t => {
  const { create } = mounted(t);
  const calls: Array<[string, number]> = [];
  const editor = create('$x^2$ and $\\href{javascript:alert(1)}{bad}$\n\n$$\n\\includegraphics{https://tracker.test/math.png}\n$$', {
    extensions: createDocumentExtensions({ onEditNode: (kind, pos) => calls.push([kind, pos]) }),
  });
  assert.ok(editor.view.dom.querySelector(".katex"));
  assert.equal(editor.view.dom.querySelectorAll("img[src], a[href]").length, 0);
  const inline = editor.view.dom.querySelector<HTMLElement>('[data-type="inline-math"]')!;
  const block = editor.view.dom.querySelector<HTMLElement>('[data-type="block-math"]')!;
  inline.click();
  block.click();
  assert.deepEqual(calls.map(call => call[0]), ["inlineMath", "blockMath"]);
  for (const [kind, pos] of calls) assert.equal(editor.state.doc.nodeAt(pos)?.type.name, kind);
  const pos = calls[0]![1];
  assert.equal(editor.commands.updateInlineMath({ pos, latex: "z+1" }), true);
  assert.match(editor.getMarkdown(), /\$z\+1\$/);
  assert.equal(editor.commands.updateBlockMath({ pos: calls[1]![1], latex: "a+b" }), true);
  assert.match(editor.getMarkdown(), /\$\$\na\+b\n\$\$/);
  editor.setEditable(false);
  editor.view.dom.querySelector<HTMLElement>('[data-type="inline-math"]')!.click();
  editor.view.dom.querySelector<HTMLElement>('[data-type="block-math"]')!.click();
  assert.equal(calls.length, 2);
});

test("Markdown 输入规则转换 $inline$ 与 $$block$$，保留代码块中的字面文本", t => {
  const { create } = mounted(t);
  const inline = create("text ");
  inline.commands.setTextSelection(inline.state.doc.content.size - 1);
  typeText(inline, "$x+1$");
  assert.ok(allNodes(inline.getJSON()).some(node => node.type === "inlineMath" && node.attrs?.latex === "x+1"));
  const block = create("");
  typeText(block, "$$x+1$$");
  assert.equal(block.state.doc.firstChild?.type.name, "blockMath");
  assert.equal(block.state.doc.firstChild?.attrs.latex, "x+1");
  const code = create("```latex\ntext\n```");
  code.commands.setTextSelection(code.state.doc.content.size - 1);
  typeText(code, "$x$");
  assert.equal(allNodes(code.getJSON()).some(node => node.type === "inlineMath"), false);
});

test("真实表格视图包裹渲染、支持列宽和单元格编辑；任务只读时不修改 checked", t => {
  const { create, dom } = mounted(t);
  const editor = create("| A | B |\n| --- | --- |\n| a | b |\n\n- [ ] task");
  assert.ok(editor.view.dom.querySelector(".tableWrapper table"));
  let cellPosition = 0;
  editor.state.doc.descendants((node, pos) => { if (!cellPosition && node.type.name === "tableCell") cellPosition = pos; });
  editor.commands.setTextSelection(cellPosition + 2);
  assert.equal(editor.commands.setCellAttribute("colwidth", [160]), true);
  assert.deepEqual(editor.state.doc.nodeAt(cellPosition)?.attrs.colwidth, [160]);
  assert.equal(editor.commands.addColumnAfter(), true);
  editor.state.doc.check();
  assert.equal(editor.state.doc.firstChild?.firstChild?.childCount, 3);
  editor.setEditable(false);
  const original = editor.getJSON();
  const checkbox = editor.view.dom.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.deepEqual(editor.getJSON(), original);
  assert.equal(checkbox.checked, false);
});

test("链接禁用自动打开且仅保留明确安全协议，危险目标作为局部字面保留", t => {
  const { create } = mounted(t);
  const editor = create("[safe](https://example.test) [bad](javascript:alert%281%29) [file](file:///tmp/x) [anchor](#here)");
  const links = Array.from(editor.view.dom.querySelectorAll("a"));
  assert.equal(links.length, 2);
  assert.equal(links[0].getAttribute("href"), "https://example.test");
  assert.equal(editor.commands.setLink({ href: "javascript:alert(1)" }), false);
  assert.equal(editor.commands.setLink({ href: "file:///tmp/x" }), false);
  assert.equal(editor.extensionManager.extensions.find(extension => extension.name === "link")?.options.openOnClick, false);
  assert.match(editor.getMarkdown(), /\[bad\]\(javascript:alert%281%29\)/);
});
