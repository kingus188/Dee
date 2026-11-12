import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { act } from "react";
import { CommandMenu } from "../dist/chat/CommandMenu.js";
import { slashCommands } from "../dist/chat/commands.js";
import { Composer } from "../dist/chat/Composer.js";
import { mount } from "./dom.js";

const props = {
  draft: "一段会随窗口和侧栏宽度重新换行的草稿", setDraft: () => {},
  view: { conversationId: 1, channel: "web" as const, entries: [], live: {}, busy: false, inbox: 0, notes: { todos: [], memos: [] }, usage: null, tasks: [], reminders: [], subagents: [], parentId: null },
  connect: async () => 1, onSent: () => {}, onNewConversation: async () => {},
};

test("草稿随输入区宽度变化重新测量；高度回调和隐藏面板不造成测量循环", async t => {
  let notify!: ResizeObserverCallback, disconnected = false, observed: Element | undefined;
  class Observer {
    constructor(callback: ResizeObserverCallback) { notify = callback; }
    observe(target: Element) { observed = target; }
    disconnect() { disconnected = true; }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: Observer });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "ResizeObserver", descriptor);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  });
  const { dom, render } = await mount(t, <Composer {...props} />);
  const input = dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!;
  assert.equal(observed, input);
  let measured = 0, height = 96;
  Object.defineProperty(input, "scrollHeight", { configurable: true, get: () => { measured++; return height; } });
  function resize(width: number) { notify([{ target: input, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver); }
  await act(async () => { resize(320); });
  assert.equal(input.style.height, "96px");
  assert.equal(measured, 1);
  height = 144;
  await act(async () => { resize(320); resize(0); });
  assert.equal(measured, 1, "自身高度变化和隐藏状态不应触发循环测量");
  await act(async () => { resize(320); });
  assert.equal(measured, 2, "隐藏后恢复到相同宽度仍需恢复草稿高度");
  assert.equal(input.style.height, "144px");
  await act(async () => { resize(200); });
  assert.equal(input.style.height, "144px");
  height = 48;
  await act(async () => { resize(520); });
  assert.equal(input.style.height, "48px", "窗口变宽后也应收回空白高度");
  assert.equal(input.value, props.draft, "重新排版不能更改草稿");
  await render(null);
  assert.equal(disconnected, true);
});

test("窗口尺寸变化和草稿替换均会重新排版；移除组件后清理监听", async t => {
  const { dom, render } = await mount(t, <Composer {...props} />);
  const input = dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!;
  let height = 120, measured = 0;
  Object.defineProperty(input, "scrollHeight", { configurable: true, get: () => { measured++; return height; } });
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event("resize")); });
  assert.equal(input.style.height, "120px");
  height = 40;
  await render(<Composer {...props} draft="短草稿" />);
  assert.equal(input.style.height, "40px");
  assert.equal(input.value, "短草稿");
  await render(null);
  const before = measured;
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event("resize")); });
  assert.equal(measured, before);
});

test("密度使用有上下限的宽高规则，移动断点与交互一致，不引入全局缩放", async () => {
  const [shell, chat, app, html] = await Promise.all([
    readFile(new URL("../public/workspace.css", import.meta.url), "utf8"),
    readFile(new URL("../public/chat.css", import.meta.url), "utf8"),
    readFile(new URL("../src/ui/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(shell, /--rail-width: clamp\(56px, 4\.7vw, 64px\)/);
  assert.match(shell, /--history-width: clamp\(220px, 18vw, 240px\)/);
  assert.match(shell, /--shell-top-space: clamp\(20px, 4dvh, 36px\)/);
  assert.match(shell, /@media \(max-height: 720px\)/);
  assert.match(shell, /@media \(max-width: 900px\)/);
  assert.equal(app.match(/matchMedia\?\.\("\(max-width: 900px\)"\)/g)?.length, 2);
  assert.doesNotMatch(shell + chat, /(?:^|[;{])\s*zoom\s*:/);
  assert.doesNotMatch(shell + chat, /(?:html|body|\.app-layout)[^{]*\{[^}]*transform:\s*scale/);
  assert.match(html, /maximum-scale=5\.0/, "不限制用户放大页面");
  assert.match(shell, /max-height: calc\(100dvh - var\(--shell-top-space\) - 12px\)/, "更多菜单的可滚动高度随窗口变化");
});

test("桌面历史收起为 76px 图标栏，展开时导航横排在历史栏顶部", async () => {
  const css = await readFile(new URL("../public/prototype.css", import.meta.url), "utf8");
  assert.match(css, /\.workspace-primary-nav \{ flex-direction: row;/);
  const expanded = css.match(/@media \(min-width: 901px\) \{\n  #mascot-card\.app-layout \{([\s\S]+?)\n  \}/)?.[1];
  assert.ok(expanded);
  assert.match(expanded, /> \.sidebar \{[^}]*inset: 0 auto auto 0;/, "展开时导航固定在顶部而不是底部");
  assert.match(expanded, /\.conversation-history \{ padding-top: var\(--header-height\); \}/, "历史列表为顶部导航留出空间，不再预留底部空白");
  assert.match(expanded, /\.workspace-personal-nav \{ top: calc\(100% \+ 4px\); bottom: auto;/, "更多菜单从顶部导航向下展开");
  assert.match(css, /\[data-desktop="darwin"\]:has\(\.conversation-sidebar\[data-expanded="true"\]\) > \.sidebar \{ padding-left: 96px; \}/, "macOS 顶部导航避开原生窗口按钮");
  const folded = css.match(/:has\(\.conversation-sidebar\[data-expanded="false"\]\) \{([\s\S]+?)\n  \}/)?.[1];
  assert.ok(folded);
  assert.match(folded, /--rail-width: 76px;/);
  assert.match(folded, /\.workspace-primary-nav \{ flex-direction: column;/);
  assert.match(folded, /\.workspace-search \{ order: 2; display: flex; \}/, "收起时提供搜索入口");
});

test("正文保持可读字号、触控目标至少44px，长草稿和短窗口仍可滚动", async () => {
  const [shell, chat] = await Promise.all([
    readFile(new URL("../public/workspace.css", import.meta.url), "utf8"),
    readFile(new URL("../public/chat.css", import.meta.url), "utf8"),
  ]);
  assert.match(chat, /\.user-text-body \{[^}]*font-size: 15px;[^}]*line-height: 1\.7;/);
  assert.match(chat, /\.response-card \.assistant-bubble \{[^}]*font-size: 15px;[^}]*line-height: 1\.75;/);
  assert.match(shell, /max-height: min\(240px, 30dvh\)/);
  assert.match(chat, /@media \(pointer: coarse\) \{[\s\S]*\.chat-textarea \{[^}]*min-height: 44px; font-size: 16px;/);
  assert.match(chat, /@media \(pointer: coarse\) \{[\s\S]*\.btn-send \{ width: 44px; height: 44px;/);
  assert.match(shell, /@media \(pointer: coarse\) \{[\s\S]*\.history-list a, \.history-older, \.conversation-new-button \{ min-height: 44px;/);
  const composer = chat.match(/#workspace\[data-view="chat"\] \.input-container \{([^}]+)\}/)?.[1];
  assert.ok(composer);
  assert.doesNotMatch(composer, /overflow/, "正常高度不能裁剪向上展开的快捷指令菜单");
  assert.match(chat, /@media \(max-height: 520px\) \{[\s\S]*\.input-container \{[^}]*max-height: 70%; \}/);
  assert.match(chat, /\.composer-context \{[^}]*max-height: 18dvh; overflow-y: auto;/);
  assert.match(chat, /\.composer-main \{ flex-shrink: 0; \}/);
  assert.doesNotMatch(chat, /\.command-menu \{[^}]*position: static;/);
});


test("短窗口的指令选择只滚动菜单，不移动页面或已聚焦的输入区", async t => {
  const menuProps = { commands: slashCommands, selected: 0, busy: false, help: false, onSelect: () => {}, onClose: () => {} };
  const { dom, render } = await mount(t, <><textarea id="focused-draft" /><CommandMenu {...menuProps} /></>);
  const doc = dom.window.document, menu = doc.querySelector<HTMLElement>(".command-menu")!;
  const draft = doc.querySelector<HTMLTextAreaElement>("textarea")!;
  draft.focus();
  t.mock.method(menu, "getBoundingClientRect", () => ({ top: 100, bottom: 210, height: 110 } as DOMRect));
  const options = [...doc.querySelectorAll<HTMLElement>('[role="option"]')];
  t.mock.method(options[2], "getBoundingClientRect", () => ({ top: 216, bottom: 260, height: 44 } as DOMRect));
  await render(<><textarea id="focused-draft" /><CommandMenu {...menuProps} selected={2} /></>);
  assert.equal(menu.scrollTop, 50);
  assert.equal(doc.activeElement, draft);
  assert.equal(doc.documentElement.scrollTop, 0);
  t.mock.method(options[0], "getBoundingClientRect", () => ({ top: 80, bottom: 124, height: 44 } as DOMRect));
  await render(<><textarea id="focused-draft" /><CommandMenu {...menuProps} selected={0} /></>);
  assert.equal(menu.scrollTop, 30);
  assert.equal(doc.activeElement, draft);
});

test("执行目标和模型与发送按钮共用工具栏，不额外占据输入框底部一行", async t => {
  const { dom } = await mount(t, <Composer {...props} execution={<button type="button">本机 · Pi</button>} />);
  const doc = dom.window.document, actions = doc.querySelector(".composer-actions")!;
  assert.ok(actions.contains(doc.querySelector(".composer-execution")), "执行控件必须在发送工具栏内");
  assert.equal(doc.querySelector(".composer-main")?.lastElementChild, actions);
  assert.equal(actions.lastElementChild?.id, "btn-send", "发送按钮保持在工具栏末尾");
});

test("微信提示与附件有独立容器，快捷菜单和输入不在该滚动区域内", async t => {
  const { dom } = await mount(t, <Composer {...props} draft="/" view={{ ...props.view, channel: "wechat" }} />);
  const doc = dom.window.document, context = doc.querySelector(".composer-context")!;
  assert.ok(context.contains(doc.querySelector(".wechat-conversation-notice")));
  assert.equal(context.contains(doc.querySelector(".command-menu")), false);
  assert.equal(context.contains(doc.querySelector(".composer-main")), false);
  assert.equal(doc.querySelector("#chat-textarea")?.getAttribute("aria-describedby"), "wechat-conversation-notice");
});
