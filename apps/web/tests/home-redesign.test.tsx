import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { act, useState } from "react";
import { WorkspaceNavigation } from "../dist/ui/WorkspaceNavigation.js";
import type { WorkspaceRoute } from "../dist/ui/navigation.js";
import { Composer } from "../dist/chat/Composer.js";
import { App } from "../dist/ui/App.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const preference = "dee.sidebar.collapsed";
function Navigation() {
  const [route, setRoute] = useState<WorkspaceRoute>({ page: "chat", group: null });
  return <WorkspaceNavigation route={route} onNavigate={setRoute} onHelp={() => {}} />;
}

test("侧栏默认展示文字，折叠后保留名称与提示，刷新后恢复偏好", async t => {
  const mounted = await mount(t, <Navigation />), doc = mounted.dom.window.document;
  const sidebar = () => doc.querySelector<HTMLElement>(".sidebar")!;
  const toggle = () => doc.querySelector<HTMLButtonElement>(".sidebar-toggle")!;
  assert.equal(sidebar().dataset.collapsed, "false");
  assert.equal(toggle().getAttribute("aria-label"), "收起侧边栏");
  assert.equal(toggle().getAttribute("aria-expanded"), "true");
  assert.equal(toggle().getAttribute("aria-controls"), "workspace-primary-nav");
  assert.deepEqual([...doc.querySelectorAll(".workspace-primary-nav > a > span:not(.workspace-nav-current)")].map(node => node.textContent), ["对话", "待办", "通知"]);
  await act(async () => { toggle().focus(); toggle().click(); });
  assert.equal(sidebar().dataset.collapsed, "true");
  assert.equal(toggle().getAttribute("aria-expanded"), "false");
  assert.equal(toggle().getAttribute("aria-label"), "展开侧边栏");
  assert.equal(doc.activeElement, toggle());
  assert.equal(mounted.dom.window.localStorage.getItem(preference), "true");
  for (const item of doc.querySelectorAll<HTMLElement>(".workspace-primary-nav > a, .workspace-more-button")) {
    assert.ok(item.getAttribute("aria-label"));
    assert.ok(item.title);
    assert.equal(item.dataset.tooltip, item.title);
  }
  await mounted.render(null);
  await mounted.render(<Navigation />);
  assert.equal(sidebar().dataset.collapsed, "true", "重新挂载从浏览器偏好恢复");
  await act(async () => { toggle().click(); });
  assert.equal(sidebar().dataset.collapsed, "false");
  assert.equal(mounted.dom.window.localStorage.getItem(preference), "false");
  await act(async () => { toggle().click(); });
  await act(async () => { toggle().click(); });
  assert.equal(sidebar().dataset.collapsed, "false", "重复展开收起不会卡住");
});

test("折叠不改变路由，更多菜单导航和 Escape 恢复焦点仍可用", async t => {
  const { dom } = await mount(t, <Navigation />), doc = dom.window.document;
  const toggle = doc.querySelector<HTMLButtonElement>(".sidebar-toggle")!;
  const more = doc.querySelector<HTMLButtonElement>(".workspace-more-button")!;
  const panel = doc.querySelector<HTMLElement>("#workspace-personal-nav")!;
  await act(async () => { more.click(); });
  assert.equal(panel.hidden, false);
  await act(async () => { toggle.click(); });
  assert.equal(panel.hidden, true);
  assert.equal(doc.querySelector('[aria-current="page"]')!.getAttribute("href"), "#chat");
  await act(async () => { more.click(); });
  await act(async () => { doc.querySelector<HTMLAnchorElement>('[aria-label="长期记忆"]')!.click(); });
  assert.equal(panel.hidden, true);
  assert.equal(more.dataset.active, "true");
  assert.equal(doc.querySelector<HTMLElement>(".sidebar")!.dataset.collapsed, "true");
  await act(async () => { more.click(); });
  await act(async () => { doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(panel.hidden, true);
  assert.equal(doc.activeElement, more);
  await act(async () => { doc.querySelector<HTMLAnchorElement>('[aria-label="通知中心"]')!.click(); });
  assert.equal(doc.querySelector('[aria-current="page"]')!.getAttribute("href"), "#activity");
});

test("不可用或异常浏览器存储不会阻断导航和折叠", async t => {
  const mounted = await mount(t, null), doc = mounted.dom.window.document;
  mounted.dom.window.localStorage.setItem(preference, "invalid");
  await mounted.render(<Navigation />);
  assert.equal(doc.querySelector<HTMLElement>(".sidebar")!.dataset.collapsed, "false");
  await mounted.render(null);
  t.mock.method(mounted.dom.window.Storage.prototype, "getItem", () => { throw new Error("Storage blocked"); });
  t.mock.method(mounted.dom.window.Storage.prototype, "setItem", () => { throw new Error("Quota exceeded"); });
  await mounted.render(<Navigation />);
  assert.equal(doc.querySelector<HTMLElement>(".sidebar")!.dataset.collapsed, "false");
  await act(async () => { doc.querySelector<HTMLButtonElement>(".sidebar-toggle")!.click(); });
  assert.equal(doc.querySelector<HTMLElement>(".sidebar")!.dataset.collapsed, "true");
  await act(async () => { doc.querySelector<HTMLAnchorElement>('[aria-label="Daylight 待办"]')!.click(); });
  assert.equal(doc.querySelector('[aria-current="page"]')!.getAttribute("href"), "#tasks");
});

test("单行输入区保持附件、输入、发送的可访问顺序", async t => {
  const { dom } = await mount(t, <Composer draft="" setDraft={() => {}} view={null} connect={async () => 1} onSent={() => {}} onNewConversation={async () => {}} />);
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

test("主页保留有文字的历史、新对话入口与安静的欢迎标题", async t => {
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path === "/api/conversations") return [];
    if (path === "/api/personal") return { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
    return { items: [], total: 0, schedules: [], reminders: [], background: [] };
  });
  const { dom } = await mount(t, <App />), doc = dom.window.document;
  assert.equal(doc.querySelector(".conversation-history-button")!.textContent, "历史对话");
  assert.equal(doc.querySelector(".conversation-new-button")!.textContent, "新对话");
  assert.equal(doc.querySelector(".chat-welcome")!.textContent, "有什么想交给我？");
  assert.equal(doc.querySelector(".conversation-title"), null);
  const history = doc.querySelector<HTMLButtonElement>(".conversation-history-button")!;
  await act(async () => { history.click(); });
  assert.equal(history.getAttribute("aria-expanded"), "true");
  await act(async () => { doc.querySelector<HTMLButtonElement>('[aria-label="关闭历史对话"]')!.click(); });
  assert.equal(history.getAttribute("aria-expanded"), "false");
  assert.equal(doc.activeElement, history);
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
