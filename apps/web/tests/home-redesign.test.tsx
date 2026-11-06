import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { act, useState } from "react";
import type { ConversationView } from "@assistant/contracts";
import { WorkspaceNavigation } from "../dist/ui/WorkspaceNavigation.js";
import type { WorkspaceRoute } from "../dist/ui/navigation.js";
import { Composer } from "../dist/chat/Composer.js";
import { App } from "../dist/ui/App.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const preference = "dee.history.collapsed";
function Navigation() {
  const [route, setRoute] = useState<WorkspaceRoute>({ page: "chat", group: null });
  return <WorkspaceNavigation route={route} onNavigate={setRoute} onHelp={() => {}} />;
}

async function appHarness(t: TestContext) {
  const subscriptions: number[] = [];
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "subscribeConversation", async (id: number) => { subscriptions.push(id); });
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path === "/api/conversations") return [{ id: 12, title: "产品方案跟进", channel: "wechat", createdAt: "2026-10-21", archivedAt: null }];
    if (path === "/api/personal") return { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
    return { items: [], total: 0, schedules: [], reminders: [], background: [] };
  });
  const mounted = await mount(t, null);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const frames: FrameRequestCallback[] = [];
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => frames.push(callback) });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "requestAnimationFrame", descriptor);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  });
  const doc = mounted.dom.window.document;
  return { ...mounted, doc, subscriptions,
    toggle: () => doc.querySelector<HTMLButtonElement>(".sidebar-toggle")!,
    panel: () => doc.querySelector<HTMLElement>("#conversation-history")!,
    flushFrames: async () => { await act(async () => { for (const callback of frames.splice(0)) callback(0); }); },
  };
}

test("主导航常驻精简图标栏，名称提示与更多菜单可访问", async t => {
  const { dom } = await mount(t, <Navigation />), doc = dom.window.document;
  assert.equal(doc.querySelector(".sidebar-toggle"), null, "主导航自身不再折叠");
  assert.equal(doc.querySelectorAll(".workspace-primary-nav > a").length, 3);
  for (const item of doc.querySelectorAll<HTMLElement>(".workspace-primary-nav > a, .workspace-more-button")) {
    assert.ok(item.getAttribute("aria-label"));
    assert.ok(item.title);
    assert.equal(item.dataset.tooltip, item.title);
  }
  const more = doc.querySelector<HTMLButtonElement>(".workspace-more-button")!;
  const panel = doc.querySelector<HTMLElement>("#workspace-personal-nav")!;
  assert.equal(more.getAttribute("aria-controls"), panel.id);
  await act(async () => { more.click(); });
  assert.equal(panel.hidden, false);
  assert.equal(more.getAttribute("aria-expanded"), "true");
  await act(async () => { doc.querySelector<HTMLAnchorElement>('[aria-label="长期记忆"]')!.click(); });
  assert.equal(panel.hidden, true);
  assert.equal(more.dataset.active, "true");
  assert.equal(doc.activeElement, more);
  await act(async () => { more.click(); });
  await act(async () => { doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(panel.hidden, true);
  assert.equal(doc.activeElement, more);
  await act(async () => { doc.querySelector<HTMLAnchorElement>('[aria-label="通知中心"]')!.click(); });
  assert.equal(doc.querySelector('[aria-current="page"]')!.getAttribute("href"), "#activity");
});

test("历史默认展开且不抢焦点，主导航与历史面板相邻独立", async t => {
  const view = await appHarness(t), { doc } = view;
  await view.render(<App />);
  assert.equal(view.panel().hidden, false);
  assert.equal(view.toggle().getAttribute("aria-expanded"), "true");
  assert.equal(view.toggle().getAttribute("aria-controls"), "conversation-history");
  assert.equal(view.toggle().getAttribute("aria-label"), "收起历史对话");
  assert.equal(doc.activeElement, doc.body, "初次展开不能自动聚焦历史搜索");
  const rail = doc.querySelector(".sidebar")!, history = doc.querySelector(".conversation-sidebar")!;
  assert.equal(rail.nextElementSibling, history);
  assert.equal(history.nextElementSibling?.id, "workspace");
  assert.equal(doc.querySelector(".conversation-new-button")!.textContent, "新对话");
  assert.equal(doc.querySelector(".chat-welcome h1")!.textContent, "有什么想交给我？");
  assert.equal(doc.querySelector(".conversation-title"), null);
  await act(async () => { doc.querySelector<HTMLTextAreaElement>("#chat-textarea")!.focus(); });
  await view.render(<App />);
  assert.equal(doc.activeElement?.id, "chat-textarea", "重绘不抢走输入焦点");
});

test("历史折叠与重新展开保存偏好，路由和常驻导航保持不变", async t => {
  const view = await appHarness(t), { doc, dom } = view;
  await view.render(<App />);
  const rail = doc.querySelector(".sidebar");
  const hash = dom.window.location.hash;
  await act(async () => { view.toggle().focus(); view.toggle().click(); });
  assert.equal(view.panel().hidden, true);
  assert.equal(view.toggle().getAttribute("aria-expanded"), "false");
  assert.equal(view.toggle().getAttribute("aria-label"), "展开历史对话");
  assert.equal(doc.activeElement, view.toggle());
  assert.equal(dom.window.localStorage.getItem(preference), "true");
  assert.equal(doc.querySelector(".sidebar"), rail);
  assert.equal(dom.window.location.hash, hash);
  assert.equal(doc.querySelector(".conversation-toolbar .conversation-new-button")!.textContent, "新对话");
  await view.render(null);
  await view.render(<App />);
  assert.equal(view.panel().hidden, true, "重新挂载恢复折叠偏好");
  await act(async () => { view.toggle().click(); });
  await view.flushFrames();
  assert.equal(view.panel().hidden, false);
  assert.equal(dom.window.localStorage.getItem(preference), "false");
  assert.equal(doc.activeElement?.getAttribute("aria-label"), "搜索历史对话");
  await act(async () => { doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(view.panel().hidden, true);
  assert.equal(doc.activeElement, view.toggle());
  await act(async () => { view.toggle().click(); });
  await view.flushFrames();
  await act(async () => { doc.querySelector<HTMLButtonElement>('[aria-label="关闭历史对话"]')!.click(); });
  assert.equal(view.panel().hidden, true);
  assert.equal(doc.activeElement, view.toggle());
  await act(async () => { view.toggle().click(); });
  await view.flushFrames();
  await view.render(null);
  await view.render(<App />);
  assert.equal(view.panel().hidden, false, "重新挂载恢复展开偏好");
});

test("旧侧栏偏好可迁移，异常值和不可用存储不阻断历史与导航", async t => {
  const view = await appHarness(t), { doc, dom } = view;
  dom.window.localStorage.setItem("dee.sidebar.collapsed", "true");
  await view.render(<App />);
  assert.equal(view.panel().hidden, true);
  await view.render(null);
  dom.window.localStorage.setItem(preference, "invalid");
  await view.render(<App />);
  assert.equal(view.panel().hidden, false, "新偏好优先，异常值按默认展开处理");
  await view.render(null);
  t.mock.method(dom.window.Storage.prototype, "getItem", () => { throw new Error("Storage blocked"); });
  t.mock.method(dom.window.Storage.prototype, "setItem", () => { throw new Error("Quota exceeded"); });
  await view.render(<App />);
  assert.equal(view.panel().hidden, false);
  await act(async () => { view.toggle().click(); });
  assert.equal(view.panel().hidden, true);
  await act(async () => { view.toggle().click(); });
  await view.flushFrames();
  assert.equal(view.panel().hidden, false);
  await act(async () => { doc.querySelector<HTMLAnchorElement>('[aria-label="通知中心"]')!.click(); });
  assert.equal(doc.querySelector('[aria-current="page"]')!.getAttribute("href"), "#activity");
  assert.equal(doc.querySelector<HTMLElement>(".conversation-sidebar")!.hidden, true);
  assert.ok(doc.querySelector(".sidebar"));
});

test("桌面选择历史保留展开面板与固定链接，输入区 Escape 不误关历史", async t => {
  const view = await appHarness(t), { doc, dom } = view;
  await view.render(<App />);
  const link = doc.querySelector<HTMLAnchorElement>('.history-list a[href="#chat/12"]')!;
  await act(async () => { link.click(); });
  assert.deepEqual(view.subscriptions, [12]);
  assert.equal(dom.window.location.hash, "#chat/12");
  assert.equal(view.panel().hidden, false);
  assert.equal(view.toggle().getAttribute("aria-expanded"), "true");
  assert.equal(doc.querySelector('.history-list a[aria-current="true"]')!.getAttribute("href"), "#chat/12");
  const input = doc.querySelector<HTMLTextAreaElement>("#chat-textarea")!;
  await act(async () => { input.focus(); input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(view.panel().hidden, false);
  assert.equal(doc.activeElement, input);
});

test("发送成功后同一会话标题刷新，保留历史搜索与选中编号", async t => {
  const view = await appHarness(t), { doc, dom } = view;
  let title = "新对话", reads = 0;
  const sent: string[] = [];
  let onView!: (value: ConversationView) => void;
  t.mock.method(apiClient, "onView", (callback: (value: ConversationView) => void) => { onView = callback; return () => {}; });
  t.mock.method(apiClient, "subscribeConversation", async (id: number) => {
    view.subscriptions.push(id);
    onView({ conversationId: id, entries: [], live: {}, busy: false, inbox: 0, usage: null, notes: { todos: [], memos: [] }, tasks: [], reminders: [], subagents: [], parentId: null });
  });
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path === "/api/conversations") { reads++; return [{ id: 12, title, channel: "web", createdAt: "2026-10-21", archivedAt: null }]; }
    if (path === "/api/conversations/12/messages") { sent.push(path); title = "产品方案跟进"; return { submissionId: 1 }; }
    if (path === "/api/personal") return { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
    return { items: [], total: 0, schedules: [], reminders: [], background: [] };
  });
  dom.window.history.replaceState(null, "", "#chat/12");
  await view.render(<App />);
  const search = doc.querySelector<HTMLInputElement>(".history-search input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "产品");
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(doc.querySelectorAll(".history-list a").length, 0);
  assert.match(doc.querySelector(".history-list")!.textContent!, /没有匹配的对话/);
  const before = reads;
  const textarea = doc.querySelector<HTMLTextAreaElement>("#chat-textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "请跟进产品方案");
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => { doc.querySelector<HTMLButtonElement>("#btn-send")!.click(); });
  assert.deepEqual(sent, ["/api/conversations/12/messages"]);
  assert.equal(reads, before + 1, "发送成功触发一次历史刷新，而不是依赖会话编号变化");
  assert.equal(search.value, "产品");
  assert.match(doc.querySelector(".history-list a > span")!.textContent!, /产品方案跟进/);
  assert.equal(doc.querySelector('.history-list a[aria-current="true"]')!.getAttribute("href"), "#chat/12");
  assert.equal(dom.window.location.hash, "#chat/12");
  assert.deepEqual(view.subscriptions, [12]);
  assert.equal(view.panel().hidden, false);
});

test("窄屏历史为模态侧栏，隔离背景、循环 Tab、Escape 与选择后恢复可见焦点", async t => {
  const view = await appHarness(t), { doc, dom } = view;
  Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: (media: string) => ({ matches: true, media, addEventListener() {}, removeEventListener() {} }) });
  await view.render(<App />);
  const sidebar = doc.querySelector<HTMLElement>(".conversation-sidebar")!;
  const rail = doc.querySelector<HTMLElement>(".sidebar")!;
  const main = doc.querySelector<HTMLElement>("#workspace")!;
  assert.equal(view.panel().hidden, true);
  assert.equal(sidebar.hasAttribute("role"), false);
  assert.equal(rail.hasAttribute("inert"), false);
  assert.equal(main.hasAttribute("inert"), false);
  await act(async () => { view.toggle().focus(); view.toggle().click(); });
  await view.flushFrames();
  assert.equal(view.panel().hidden, false);
  assert.equal(sidebar.getAttribute("role"), "dialog");
  assert.equal(sidebar.getAttribute("aria-modal"), "true");
  assert.ok(sidebar.getAttribute("aria-label"));
  assert.equal(rail.hasAttribute("inert"), true);
  assert.equal(main.hasAttribute("inert"), true);
  assert.ok(doc.querySelector(".history-backdrop"));
  assert.equal(doc.activeElement?.getAttribute("aria-label"), "搜索历史对话");
  const controls = [...sidebar.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input')].filter(element => !element.closest("[hidden]"));
  const first = controls[0], last = controls.at(-1)!;
  const tab = (shiftKey = false) => new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  const forward = tab();
  await act(async () => { last.focus(); last.dispatchEvent(forward); });
  assert.equal(forward.defaultPrevented, true);
  assert.equal(doc.activeElement, first);
  const backward = tab(true);
  await act(async () => { first.dispatchEvent(backward); });
  assert.equal(backward.defaultPrevented, true);
  assert.equal(doc.activeElement, last);
  await act(async () => { last.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  assert.equal(view.panel().hidden, true);
  assert.equal(doc.activeElement, view.toggle());
  assert.equal(rail.hasAttribute("inert"), false);
  assert.equal(main.hasAttribute("inert"), false);
  assert.equal(sidebar.hasAttribute("aria-modal"), false);
  assert.equal(doc.querySelector(".history-backdrop"), null);
  await act(async () => { view.toggle().click(); });
  await view.flushFrames();
  const link = doc.querySelector<HTMLAnchorElement>('.history-list a[href="#chat/12"]')!;
  await act(async () => { link.focus(); link.click(); });
  await view.flushFrames();
  assert.equal(dom.window.location.hash, "#chat/12");
  assert.deepEqual(view.subscriptions, [12]);
  assert.equal(view.panel().hidden, true);
  assert.equal(rail.hasAttribute("inert"), false);
  assert.equal(main.hasAttribute("inert"), false);
  assert.equal(doc.activeElement?.id, "chat-textarea");
  assert.equal(dom.window.localStorage.getItem(preference), null, "移动端开关不覆盖桌面展开偏好");
});

test("单行输入区保持附件、输入、发送的可访问顺序", async t => {
  const { dom } = await mount(t, <Composer draft="" setDraft={() => {}} view={{ conversationId: 1, channel: "web", entries: [], live: {}, busy: false, inbox: 0, notes: { todos: [], memos: [] }, usage: null, tasks: [], reminders: [], subagents: [], parentId: null }} connect={async () => 1} onSent={() => {}} onNewConversation={async () => {}} />);
  const doc = dom.window.document, main = doc.querySelector(".composer-main")!;
  assert.equal(main.children[0].getAttribute("aria-label"), "添加附件（图片或文件）");
  assert.equal(main.children[1].id, "chat-textarea");
  const send = doc.querySelector<HTMLButtonElement>("#btn-send")!;
  assert.ok(send.disabled);
  assert.equal(send.querySelector("use")!.getAttribute("href"), "/assets/icons.svg#send");
  let opened = 0;
  t.mock.method(doc.querySelector<HTMLInputElement>('input[type="file"]')!, "click", () => { opened++; });
  await act(async () => { doc.querySelector<HTMLButtonElement>(".attach-button")!.click(); });
  assert.equal(opened, 1);
});

test("更多菜单打开后 Tab 顺序直接进入菜单，不被折叠按钮打断", async t => {
  const { dom } = await mount(t, <Navigation />), doc = dom.window.document;
  const more = doc.querySelector<HTMLButtonElement>(".workspace-more-button")!;
  const panel = doc.querySelector<HTMLElement>("#workspace-personal-nav")!;
  await act(async () => { more.focus(); more.click(); });
  const tabbable = [...doc.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input')].filter(element => !element.closest("[hidden]"));
  const next = tabbable[tabbable.indexOf(more) + 1];
  assert.equal(next, panel.querySelector("a"), "更多后的第一个 Tab 必须进入已展开的菜单");
  await act(async () => { next.focus(); });
  assert.equal(panel.hidden, false);
  assert.equal(doc.activeElement, next);
  await act(async () => { doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(panel.hidden, true);
  assert.equal(doc.activeElement, more);
});


test("发送按钮在浅色和暗色模式的悬停状态都保留图标对比度", async () => {
  const css = await readFile(new URL("../public/chat.css", import.meta.url), "utf8");
  const hover = css.match(/\.btn-send:hover:not\(:disabled\) \{([^}]+)\}/)?.[1];
  assert.ok(hover);
  const background = hover.match(/background: (#[0-9a-f]{6})/i)?.[1];
  assert.ok(background, "悬停背景不能引用暗色模式中用于文字的浅色强调色");
  assert.match(hover, /color: #fff;/);
  const channels = background.slice(1).match(/../g)!.map(hex => {
    const value = parseInt(hex, 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  assert.ok(1.05 / (luminance + .05) >= 3, "白色发送图标与背景至少保持 3:1 对比度");
});
