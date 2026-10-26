import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { JSDOM } from "jsdom";
import type { ConversationNotes, NotesEditRequest } from "@assistant/contracts";
import { NotesPage } from "../dist/workspace/NotesPage.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

function notesApi(t: TestContext, owner: number, original: ConversationNotes, save?: (body: NotesEditRequest) => Promise<ConversationNotes>) {
  const reads: string[] = [], writes: NotesEditRequest[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: NotesEditRequest) => {
    assert.equal(path, `/api/conversations/${owner}/notes`);
    if (!body) { reads.push(path); return structuredClone(original); }
    writes.push(structuredClone(body));
    return save ? save(body) : structuredClone(body.notes);
  });
  return { reads, writes };
}

function button(document: Document, label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label);
  assert.ok(found, `找不到按钮：${label}`);
  return found;
}

function noteButtons(document: Document) {
  return [...document.querySelectorAll<HTMLButtonElement>('[aria-label="笔记列表"] .notes-list-item')];
}

async function click(document: Document, label: string) {
  await act(async () => { button(document, label).click(); });
}

async function openLibrary(document: Document) {
  if (document.querySelector<HTMLElement>('[aria-label="笔记导航"]')!.hidden) await click(document, "显示笔记目录");
}

async function selectNote(document: Document, index: number) {
  await openLibrary(document);
  await act(async () => { noteButtons(document)[index]!.click(); });
}

async function input(dom: JSDOM, element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

async function typeMarkdown(dom: JSDOM, value: string) {
  const document = dom.window.document;
  if (!document.querySelector(".markdown-editor textarea")) await click(document, "Markdown 源码");
  const source = document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea");
  assert.ok(source);
  await input(dom, source, value);
  assert.equal(source.value, value);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("笔记默认阅读首篇，目录按需展开并在选择后收起", async t => {
  const original: ConversationNotes = { todos: [], memos: ["# 第一篇\n\n正文一", "## 第二篇\n\n正文二", "第三篇"] };
  const api = notesApi(t, 17, original);
  const { dom } = await mount(t, <NotesPage owner={17} active headerActions={<button type="button">服务状态</button>} />);
  const document = dom.window.document;
  const navigation = document.querySelector<HTMLElement>('[aria-label="笔记导航"]');
  assert.ok(navigation);
  assert.equal(navigation.hidden, true);
  assert.equal(document.querySelectorAll(".notes-header").length, 1);
  assert.ok(document.querySelector(".notes-header-actions .notes-service-actions button"));
  assert.equal(document.querySelector('[aria-label="笔记详情"] h1')?.textContent, "第一篇");
  assert.equal(document.querySelector(".markdown-editor, textarea, [contenteditable=true]"), null);
  await openLibrary(document);
  assert.equal(navigation.hidden, false);
  assert.equal(document.activeElement, document.querySelector('[aria-label="搜索笔记"]'));
  assert.deepEqual(noteButtons(document).map(item => item.querySelector("strong")?.textContent), ["第一篇", "第二篇", "第三篇"]);
  assert.equal(noteButtons(document)[0]!.getAttribute("aria-current"), "true");

  await selectNote(document, 1);
  assert.equal(document.querySelector('[aria-label="笔记详情"] h2')?.textContent, "第二篇");
  assert.equal(noteButtons(document)[1]!.getAttribute("aria-current"), "true");
  assert.equal(navigation.hidden, true);
  assert.equal(document.activeElement, button(document, "显示笔记目录"));
  assert.equal(noteButtons(document).length, 3);
  assert.equal(document.querySelector(".markdown-editor"), null);
  assert.equal(api.reads.length, 1);
  assert.deepEqual(api.writes, []);
});

test("笔记库按 Escape、点击正文和切页收起，重新打开保留编辑草稿", async t => {
  notesApi(t, 24, { todos: [], memos: ["# 原笔记\n\n原正文"] });
  const { dom, render } = await mount(t, <NotesPage owner={24} active />);
  const document = dom.window.document;
  const navigation = document.querySelector<HTMLElement>('[aria-label="笔记导航"]')!;
  await click(document, "编辑笔记");
  await typeMarkdown(dom, "# 未保存\n\n编辑中的草稿");
  const source = document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!;
  await openLibrary(document);
  await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(navigation.hidden, true);
  assert.equal(document.activeElement, button(document, "显示笔记目录"));
  await openLibrary(document);
  await act(async () => { source.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); });
  assert.equal(navigation.hidden, true);
  assert.equal(document.querySelector(".markdown-editor textarea"), source);
  assert.equal(source.value, "# 未保存\n\n编辑中的草稿");
  await openLibrary(document);
  await render(<NotesPage owner={24} active={false} />);
  assert.equal(navigation.hidden, true);
  await render(<NotesPage owner={24} active />);
  await openLibrary(document);
  assert.equal(source.value, "# 未保存\n\n编辑中的草稿");
  assert.equal(button(document, "保存笔记").disabled, false);
});

test("正文搜索选中原笔记，大纲排除代码块标题并保留原生标题级别和安全 HTML", async t => {
  const markdown = '# 检索结果\n\nNeedle in body\n\n## **章节**\n\n```md\n# 代码中的伪标题\n## 另一个伪标题\n```\n\n###### 末级标题\n\n<img src=x onerror="alert(1)">\n<script>alert(2)</script>\n\n[危险链接](javascript:alert(3))\n\n[参考](https://example.test/notes)';
  const original: ConversationNotes = { todos: [], memos: ["# 首篇\n\n没有关键词", "中间笔记", markdown] };
  const api = notesApi(t, 18, original);
  const { dom } = await mount(t, <NotesPage owner={18} active />);
  const document = dom.window.document;
  await openLibrary(document);
  await input(dom, document.querySelector<HTMLInputElement>('[aria-label="搜索笔记"]')!, "  NEEDLE  ");
  assert.equal(noteButtons(document).length, 1);
  assert.equal(noteButtons(document)[0]!.querySelector("strong")?.textContent, "检索结果");
  await selectNote(document, 0);
  const article = document.querySelector<HTMLElement>('[aria-label="笔记详情"] article');
  assert.ok(article);
  assert.deepEqual([...article.querySelectorAll("h1,h2,h3,h4,h5,h6")].map(heading => [heading.tagName, heading.textContent]), [["H1", "检索结果"], ["H2", "章节"], ["H6", "末级标题"]]);
  assert.equal(article.querySelector("pre code")?.textContent, "# 代码中的伪标题\n## 另一个伪标题");
  assert.equal(article.querySelector("img,script,[onerror],[onclick],iframe"), null);
  assert.equal(article.querySelector('a[href^="javascript:"]'), null);
  assert.ok(article.textContent?.includes('<img src=x onerror="alert(1)">'));
  const link = article.querySelector<HTMLAnchorElement>('a[href="https://example.test/notes"]');
  assert.ok(link);
  assert.match(link.rel, /noopener/);

  await openLibrary(document);
  await click(document, "大纲");
  const outline = document.querySelector<HTMLElement>('[role="tabpanel"][aria-labelledby="notes-tab-outline-18"]');
  assert.ok(outline);
  assert.equal(outline.hidden, false);
  const headings = [...outline.querySelectorAll<HTMLButtonElement>("button")];
  assert.deepEqual(headings.map(heading => [heading.textContent, heading.dataset.level]), [["检索结果", "1"], ["章节", "2"], ["末级标题", "6"]]);
  await act(async () => { headings[1]!.click(); });
  assert.equal(document.activeElement, article.querySelector("h2"));
  await openLibrary(document);
  await click(document, "笔记列表");
  await input(dom, document.querySelector<HTMLInputElement>('[aria-label="搜索笔记"]')!, "不存在的关键词");
  assert.equal(noteButtons(document).length, 0);
  assert.match(document.querySelector(".notes-navigation-empty")!.textContent!, /没有匹配的笔记/);
  await click(document, "清除搜索");
  assert.equal(noteButtons(document).length, 3);
  assert.equal(noteButtons(document)[2]!.getAttribute("aria-current"), "true");
  assert.equal(api.reads.length, 1);
  assert.deepEqual(api.writes, []);
});

test("编辑多篇笔记中的一篇仅替换目标，提交原 base 并保留兄弟原文和顺序", async t => {
  const original: ConversationNotes = { todos: [], memos: ["# 首篇\r\n\r\n保留两个尾空格  \r\n", "## 中篇\n\n原正文", "# 尾篇\n\n- [x] 原样保留\n"] };
  const api = notesApi(t, 19, original);
  const { dom } = await mount(t, <NotesPage owner={19} active />);
  const document = dom.window.document;
  await selectNote(document, 1);
  await click(document, "编辑笔记");
  const replacement = "## 更新中篇\n\n只替换这一篇\n";
  await typeMarkdown(dom, replacement);
  await click(document, "保存笔记");
  assert.deepEqual(api.writes, [{ base: original, notes: { todos: [], memos: [original.memos[0], replacement, original.memos[2]] } }]);
  assert.equal(document.querySelector(".markdown-editor"), null);
  assert.equal(document.querySelector('[aria-label="笔记详情"] h2')?.textContent, "更新中篇");
  assert.deepEqual(noteButtons(document).map(item => item.querySelector("strong")?.textContent), ["首篇", "更新中篇", "尾篇"]);
  assert.equal(noteButtons(document)[1]!.getAttribute("aria-current"), "true");
});

test("Ctrl/Meta+S 均可保存，同步双击和 pending 重复快捷键只提交一次", async t => {
  const original: ConversationNotes = { todos: [], memos: ["原始正文"] };
  const replies: ReturnType<typeof deferred<ConversationNotes>>[] = [];
  const api = notesApi(t, 20, original, () => {
    const reply = deferred<ConversationNotes>();
    replies.push(reply);
    return reply.promise;
  });
  const { dom } = await mount(t, <NotesPage owner={20} active />);
  const document = dom.window.document;
  for (const [index, trigger] of ["ctrl", "meta", "double-click"].entries()) {
    await click(document, "编辑笔记");
    const text = `保存正文 ${index + 1}`;
    await typeMarkdown(dom, text);
    const source = document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!;
    const save = button(document, "保存笔记");
    const shortcut = (metaKey: boolean, isComposing = false) => new dom.window.KeyboardEvent("keydown", { key: metaKey ? "S" : "s", ctrlKey: !metaKey, metaKey, isComposing, bubbles: true, cancelable: true });
    await act(async () => { source.dispatchEvent(shortcut(false, true)); });
    assert.equal(api.writes.length, index, "输入法组合期间不保存");
    const event = shortcut(trigger === "meta");
    await act(async () => {
      if (trigger !== "double-click") source.dispatchEvent(event);
      save.click(); save.click();
      source.dispatchEvent(shortcut(false)); source.dispatchEvent(shortcut(true));
    });
    if (trigger !== "double-click") assert.equal(event.defaultPrevented, true);
    assert.equal(api.writes.length, index + 1);
    assert.equal(api.writes[index]!.notes.memos[0], text);
    assert.equal(save.disabled, true);
    assert.equal(source.disabled, true);
    assert.equal(document.querySelector('[aria-label="笔记编辑"]')?.getAttribute("aria-busy"), "true");
    await act(async () => {
      save.click();
      source.dispatchEvent(shortcut(true));
    });
    assert.equal(api.writes.length, index + 1);
    await act(async () => { replies[index]!.resolve(structuredClone(api.writes[index]!.notes)); });
    assert.equal(document.querySelector(".markdown-editor"), null);
    assert.equal(document.querySelector('[aria-label="笔记详情"] article')?.textContent, text);
  }
});

test("冲突后保留草稿及原 base，同 owner 的 active 切页后重试仍提交原基线", async t => {
  const original: ConversationNotes = { todos: [], memos: ["# 首篇", "原始中篇", "尾篇原文\n"] };
  let conflict = true;
  const api = notesApi(t, 21, original, async body => {
    if (conflict) throw new Error("笔记已被其他页面更新");
    return structuredClone(body.notes);
  });
  const { dom, render } = await mount(t, <NotesPage owner={21} active />);
  const document = dom.window.document;
  await selectNote(document, 1);
  await click(document, "编辑笔记");
  const draft = "## 尚未保存\n\n冲突后保留的草稿";
  await typeMarkdown(dom, draft);
  await click(document, "保存笔记");
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /其他页面更新.*草稿已保留/);
  assert.equal(document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!.value, draft);
  assert.equal(button(document, "保存笔记").disabled, false);

  await render(<NotesPage owner={21} active={false} />);
  await act(async () => {
    document.querySelector(".markdown-editor textarea")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
  });
  assert.equal(api.writes.length, 1, "隐藏页面不处理保存快捷键");
  await render(<NotesPage owner={21} active />);
  assert.equal(document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!.value, draft);
  assert.equal(api.reads.length, 1, "切回页面不重新读取并覆盖冲突草稿");
  const revised = `${draft}\n\n继续编辑`;
  await typeMarkdown(dom, revised);
  conflict = false;
  await click(document, "保存笔记");
  assert.deepEqual(api.writes, [
    { base: original, notes: { todos: [], memos: [original.memos[0], draft, original.memos[2]] } },
    { base: original, notes: { todos: [], memos: [original.memos[0], revised, original.memos[2]] } },
  ]);
  assert.equal(document.querySelector(".markdown-editor"), null);
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(noteButtons(document)[1]!.getAttribute("aria-current"), "true");
});

test("阅读、即时与源码模式切换保留原文，非无损内容也可原位编辑", async t => {
  const canonical = "# 可切换\n\n原正文";
  const exact = "## 原样保留\r\n\r\n段落尾空格  \r\n下一行\r\n\r\n- [x] 已办\r\n\r\n<div>literal</div>\r\n";
  const original: ConversationNotes = { todos: [], memos: [canonical, exact] };
  const api = notesApi(t, 22, original);
  const { dom } = await mount(t, <NotesPage owner={22} active />);
  const document = dom.window.document;
  await click(document, "专注阅读");
  await click(document, "退出专注阅读");
  await click(document, "编辑笔记");
  assert.ok(document.querySelector('[role="textbox"][contenteditable="true"]'));
  for (let index = 0; index < 2; index++) {
    await click(document, "Markdown 源码");
    assert.equal(document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!.value, canonical);
    assert.equal(button(document, "保存笔记").disabled, true);
    await click(document, "返回文档");
    assert.equal(document.querySelector(".markdown-editor textarea"), null);
    assert.equal(button(document, "保存笔记").disabled, true);
  }
  await click(document, "取消编辑");
  await selectNote(document, 1);
  await click(document, "编辑笔记");
  assert.ok(document.querySelector(".tiptap-document-content[contenteditable=true]"));
  assert.equal(document.querySelector('.tiptap-document-content script, .tiptap-document-content iframe, .tiptap-document-content img[src]'), null);
  await click(document, "Markdown 源码");
  const source = document.querySelector<HTMLTextAreaElement>(".markdown-editor textarea")!;
  // The textarea normalizes its DOM value; the source model and dirty state preserve the original CRLF.
  assert.equal(source.value, exact.replace(/\r\n/g, "\n"));
  await click(document, "返回文档");
  assert.equal(document.querySelector(".markdown-editor textarea"), null);
  assert.ok(document.querySelector('.tiptap-document-content'));
  assert.equal(button(document, "保存笔记").disabled, true);
  await click(document, "取消编辑");
  assert.equal(api.reads.length, 1);
  assert.deepEqual(api.writes, []);
  assert.equal(original.memos[1], exact);
});

test("富文本正文通过真实粘贴事件编辑，保存正文变化而非仅编辑源码", async t => {
  const original: ConversationNotes = { todos: [], memos: ["原始正文"] };
  const api = notesApi(t, 23, original);
  const { dom } = await mount(t, <NotesPage owner={23} active />);
  const document = dom.window.document;
  await click(document, "编辑笔记");
  const editor = document.querySelector<HTMLElement>('[role="textbox"][aria-label="笔记正文"][contenteditable="true"]');
  assert.ok(editor, "可无损往返的正文应提供富文本输入");
  assert.equal(document.querySelector(".markdown-editor textarea"), null);
  const paste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { getData: (format: string) => format === "text/plain" ? "新增段落" : "<img src=x onerror=alert(1)>" } });
  await act(async () => { editor.dispatchEvent(paste); });
  assert.equal(paste.defaultPrevented, true);
  assert.equal(editor.textContent, "原始正文新增段落");
  assert.equal(editor.querySelector("img"), null);
  assert.equal(document.querySelector(".markdown-editor textarea"), null);
  assert.equal(button(document, "保存笔记").disabled, false);
  await click(document, "保存笔记");
  assert.deepEqual(api.writes, [{ base: original, notes: { todos: [], memos: ["原始正文新增段落"] } }]);
  assert.equal(document.querySelector('[aria-label="笔记详情"] article')?.textContent, "原始正文新增段落");
});
