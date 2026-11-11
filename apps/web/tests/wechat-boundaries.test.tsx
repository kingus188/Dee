import test from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import type { ConversationView } from "@assistant/contracts";
import { Composer } from "../dist/chat/Composer.js";
import { ConversationHistory } from "../dist/ui/ConversationHistory.js";
import { App } from "../dist/ui/App.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const view = (id: number, channel = "web"): ConversationView => ({
  conversationId: id, channel, entries: [], live: {}, busy: false, inbox: 0,
  notes: { todos: [], memos: [] }, usage: null, tasks: [], reminders: [], subagents: [], parentId: null,
});

test("微信历史是 Dee 会话，保留固定链接与真实标题并说明回复去向", async t => {
  const calls: string[] = [], opened: number[] = [];
  t.mock.method(apiClient, "request", async (path: string) => {
    calls.push(path);
    return [{ id: 12, title: "产品方案跟进", channel: "wechat", createdAt: "2026-11-06", archivedAt: null }];
  });
  const { dom } = await mount(t, <ConversationHistory active currentId={12} onOpen={id => opened.push(id)} onClose={() => {}} />);
  const link = dom.window.document.querySelector<HTMLAnchorElement>(".history-list a")!;
  assert.equal(link.getAttribute("href"), "#chat/12");
  assert.equal(link.querySelector(".history-channel")!.textContent, "微信里的 Dee");
  assert.equal(link.querySelector(".history-row-title")!.textContent, "产品方案跟进");
  assert.match(link.title, /回复可能同步到此会话绑定的微信接收方/);
  await act(async () => link.click());
  assert.deepEqual(opened, [12]);
  assert.deepEqual(calls, ["/api/conversations"], "查看历史不能发送或触发微信同步");
});

test("微信会话在发送前持续提示同步边界，普通对话不误标且查看不发送", async t => {
  const calls: string[] = [];
  t.mock.method(apiClient, "request", async (path: string) => { calls.push(path); return {}; });
  function Harness({ current }: { current: ConversationView }) {
    const [draft, setDraft] = useState("继续讨论");
    return <Composer draft={draft} setDraft={setDraft} view={current} connect={async () => current.conversationId} onSent={() => {}} onNewConversation={async () => {}} />;
  }
  const { dom, render } = await mount(t, <Harness current={view(12, "wechat")} />);
  const doc = dom.window.document, input = doc.querySelector("textarea")!;
  assert.match(doc.querySelector(".wechat-conversation-notice")!.textContent!, /微信里的 Dee.*不是微信收件箱.*回复可能同步到此会话绑定的微信接收方/);
  assert.equal(input.getAttribute("aria-describedby"), "wechat-conversation-notice");
  assert.match(doc.getElementById("btn-send")!.getAttribute("aria-label")!, /回复可能同步到微信/);
  await render(<Harness current={view(12, "wechat")} />);
  assert.deepEqual(calls, []);
  await act(async () => doc.querySelector<HTMLButtonElement>("#btn-send")!.click());
  assert.deepEqual(calls, ["/api/conversations/12/messages"]);
  assert.ok(doc.querySelector(".wechat-conversation-notice"), "发送后提示仍可见");
  await render(<Harness current={view(19)} />);
  assert.equal(doc.querySelector(".wechat-conversation-notice"), null);
  assert.equal(input.getAttribute("aria-describedby"), null);
  assert.equal(input.getAttribute("aria-label"), "给小 D 发消息");
  await render(<Harness current={view(12, "wechat")} />);
  assert.ok(doc.querySelector(".wechat-conversation-notice"), "返回微信会话仍提示");
  assert.equal(calls.length, 1);
});

test("来源未加载时点击与 Enter 均不发送，保留草稿和附件，加载后需主动发送", async t => {
  const calls: { path: string; body: unknown }[] = [];
  let connected = 0;
  t.mock.method(apiClient, "request", async (path: string, body: unknown) => { calls.push({ path, body }); return {}; });
  function Harness({ pending }: { pending: boolean }) {
    const [draft, setDraft] = useState("待发送的草稿");
    return <Composer draft={draft} setDraft={setDraft} view={pending ? null : view(12, "wechat")} conversationPending={pending} connect={async () => { connected++; return 12; }} onSent={() => {}} onNewConversation={async () => {}} />;
  }
  const { dom, render } = await mount(t, <Harness pending={false} />);
  const doc = dom.window.document, input = doc.querySelector("textarea")!;
  const file = doc.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(file, "files", { configurable: true, value: [new File(["hello"], "note.txt", { type: "text/plain" })] });
  await act(async () => file.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  await render(<Harness pending />);
  assert.equal(doc.querySelector<HTMLButtonElement>("#btn-send")!.disabled, true);
  await act(async () => {
    doc.querySelector<HTMLButtonElement>("#btn-send")!.click();
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  assert.equal(connected, 0); assert.equal(calls.length, 0);
  assert.equal(input.value, "待发送的草稿");
  assert.equal(doc.querySelector(".attachments-preview"), null, "来源未知时不展示其他会话的附件");
  await render(<Harness pending={false} />);
  assert.ok(doc.querySelector(".wechat-conversation-notice"));
  assert.match(doc.querySelector(".attachments-preview")!.textContent!, /note.txt/, "原会话附件在来源恢复后仍保留");
  assert.equal(calls.length, 0, "来源恢复后不能自动补发");
  await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/conversations/12/messages");
  assert.equal((calls[0].body as { text: string }).text, "待发送的草稿");
  assert.equal((calls[0].body as { attachments: unknown[] }).attachments.length, 1);
});

test("等待连接时切到微信会话不能把旧草稿隐式发送到新接收方", async t => {
  const calls: string[] = [];
  let complete!: (id: number) => void;
  t.mock.method(apiClient, "request", async (path: string) => { calls.push(path); return {}; });
  function Harness({ current }: { current: ConversationView }) {
    const [draft, setDraft] = useState("仅在原会话讨论");
    return <Composer draft={draft} setDraft={setDraft} view={current} connect={() => new Promise(resolve => { complete = resolve; })} onSent={() => {}} onNewConversation={async () => {}} />;
  }
  const { dom, render } = await mount(t, <Harness current={view(19)} />);
  await act(async () => dom.window.document.querySelector<HTMLButtonElement>("#btn-send")!.click());
  await render(<Harness current={view(12, "wechat")} />);
  await act(async () => complete(12));
  assert.deepEqual(calls, []);
  assert.equal(dom.window.document.querySelector("textarea")!.value, "仅在原会话讨论");
  assert.match(dom.window.document.getElementById("toast-container")!.textContent!, /会话来源已变化/);
});

test("默认聊天在尚无渲染来源时不能发送，加载微信来源后不会自动补发", async t => {
  const calls: string[] = []; let connected = 0;
  t.mock.method(apiClient, "request", async (path: string) => { calls.push(path); return {}; });
  function Harness({ current }: { current: ConversationView | null }) {
    const [draft, setDraft] = useState("来源未确定的草稿");
    return <Composer draft={draft} setDraft={setDraft} view={current} connect={async () => { connected++; return 12; }} onSent={() => {}} onNewConversation={async () => {}} />;
  }
  const { dom, render } = await mount(t, <Harness current={null} />);
  const doc = dom.window.document, input = doc.querySelector("textarea")!;
  assert.equal(doc.querySelector<HTMLButtonElement>("#btn-send")!.disabled, true);
  assert.equal(doc.querySelector<HTMLButtonElement>(".attach-button")!.disabled, true);
  await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  assert.equal(connected, 0); assert.equal(calls.length, 0);
  assert.equal(input.value, "来源未确定的草稿");
  await render(<Harness current={view(12, "wechat")} />);
  assert.ok(doc.querySelector(".wechat-conversation-notice"));
  assert.equal(calls.length, 0);
  await act(async () => doc.querySelector<HTMLButtonElement>("#btn-send")!.click());
  assert.deepEqual(calls, ["/api/conversations/12/messages"]);
});

test("附件草稿按会话保存，异步读取期间切换不会把附件带入微信", async t => {
  const calls: { path: string; body: { attachments: { name: string }[] } }[] = [];
  t.mock.method(apiClient, "request", async (path: string, body: { attachments: { name: string }[] }) => { calls.push({ path, body }); return {}; });
  function Harness({ current }: { current: ConversationView }) {
    const [draft, setDraft] = useState("");
    return <Composer draft={draft} setDraft={setDraft} view={current} connect={async () => current.conversationId} onSent={() => {}} onNewConversation={async () => {}} />;
  }
  const { dom, render } = await mount(t, <Harness current={view(19)} />);
  const doc = dom.window.document, input = doc.querySelector<HTMLInputElement>('input[type="file"]')!;
  async function upload(file: File) {
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  }
  let finish!: (buffer: ArrayBuffer) => void;
  const delayed = new File(["original"], "private-web.txt", { type: "text/plain" });
  t.mock.method(delayed, "arrayBuffer", () => new Promise<ArrayBuffer>(resolve => { finish = resolve; }));
  await upload(delayed);
  await render(<Harness current={view(12, "wechat")} />);
  assert.equal(doc.querySelector(".attachments-preview"), null);
  await upload(new File(["wechat"], "wechat-only.txt", { type: "text/plain" }));
  await act(async () => finish(new TextEncoder().encode("original").buffer));
  assert.match(doc.querySelector(".attachments-preview")!.textContent!, /wechat-only.txt/);
  assert.doesNotMatch(doc.querySelector(".attachments-preview")!.textContent!, /private-web/);
  await act(async () => doc.querySelector<HTMLButtonElement>("#btn-send")!.click());
  assert.equal(calls[0].path, "/api/conversations/12/messages");
  assert.deepEqual(calls[0].body.attachments.map(file => file.name), ["wechat-only.txt"]);
  await render(<Harness current={view(19)} />);
  assert.match(doc.querySelector(".attachments-preview")!.textContent!, /private-web.txt/);
  await render(<Harness current={view(12, "wechat")} />);
  assert.equal(doc.querySelector(".attachments-preview"), null, "微信已发送附件不被旧会话恢复");
  await render(<Harness current={view(19)} />);
  await act(async () => doc.querySelector<HTMLButtonElement>("#btn-send")!.click());
  assert.equal(calls[1].path, "/api/conversations/19/messages");
  assert.deepEqual(calls[1].body.attachments.map(file => file.name), ["private-web.txt"]);
});

test("文件选择器在切换后返回时，附件仍属于打开选择器的会话", async t => {
  function Harness({ current }: { current: ConversationView }) {
    return <Composer draft="" setDraft={() => {}} view={current} connect={async () => current.conversationId} onSent={() => {}} onNewConversation={async () => {}} />;
  }
  const { dom, render } = await mount(t, <Harness current={view(19)} />);
  const doc = dom.window.document, input = doc.querySelector<HTMLInputElement>('input[type="file"]')!;
  t.mock.method(input, "click", () => {});
  await act(async () => doc.querySelector<HTMLButtonElement>(".attach-button")!.click());
  await render(<Harness current={view(12, "wechat")} />);
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["local"], "picked-on-web.txt", { type: "text/plain" })] });
  await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  assert.equal(doc.querySelector(".attachments-preview"), null);
  assert.equal(doc.querySelector<HTMLButtonElement>("#btn-send")!.disabled, true);
  await render(<Harness current={view(19)} />);
  assert.match(doc.querySelector(".attachments-preview")!.textContent!, /picked-on-web.txt/);
});

test("旧会话发送完成只清理原附件，不清空新会话草稿或改变所选会话", async t => {
  let finish!: () => void, sent = 0;
  t.mock.method(apiClient, "request", () => new Promise<void>(resolve => { finish = resolve; }));
  function Harness({ current }: { current: ConversationView }) {
    const [draft, setDraft] = useState("相同但独立的文字");
    return <Composer draft={draft} setDraft={setDraft} view={current} connect={async () => current.conversationId} onSent={() => { sent++; }} onNewConversation={async () => {}} />;
  }
  const { dom, render } = await mount(t, <Harness current={view(19)} />);
  const doc = dom.window.document, input = doc.querySelector<HTMLInputElement>('input[type="file"]')!;
  async function upload(name: string) {
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["text"], name, { type: "text/plain" })] });
    await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  }
  await upload("sent-web.txt");
  await act(async () => doc.querySelector<HTMLButtonElement>("#btn-send")!.click());
  await render(<Harness current={view(12, "wechat")} />);
  await upload("unsent-wechat.txt");
  await act(async () => finish());
  assert.equal(sent, 0, "旧发送完成不得触发当前会话导航");
  assert.equal(doc.querySelector("textarea")!.value, "相同但独立的文字");
  assert.match(doc.querySelector(".attachments-preview")!.textContent!, /unsent-wechat.txt/);
  await render(<Harness current={view(19)} />);
  assert.equal(doc.querySelector(".attachments-preview"), null);
  await render(<Harness current={view(12, "wechat")} />);
  assert.match(doc.querySelector(".attachments-preview")!.textContent!, /unsent-wechat.txt/);
});

test("卸载时释放各会话的图片预览，卸载后完成的异步图片也被释放", async t => {
  const created: string[] = [], revoked: string[] = [];
  t.mock.method(URL, "createObjectURL", () => { const url = `blob:test-${created.length}`; created.push(url); return url; });
  t.mock.method(URL, "revokeObjectURL", (url: string) => { revoked.push(url); });
  function Harness({ current }: { current: ConversationView }) {
    return <Composer draft="" setDraft={() => {}} view={current} connect={async () => current.conversationId} onSent={() => {}} onNewConversation={async () => {}} />;
  }
  const { dom, render } = await mount(t, <Harness current={view(19)} />);
  const input = dom.window.document.querySelector<HTMLInputElement>('input[type="file"]')!;
  async function upload(file: File) {
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  }
  await upload(new File(["GIF89a"], "web.gif", { type: "image/gif" }));
  await render(<Harness current={view(12, "wechat")} />);
  await upload(new File(["GIF89a"], "wechat.gif", { type: "image/gif" }));
  let finish!: (buffer: ArrayBuffer) => void;
  const delayed = new File(["GIF89a"], "late.gif", { type: "image/gif" });
  t.mock.method(delayed, "arrayBuffer", () => new Promise<ArrayBuffer>(resolve => { finish = resolve; }));
  await upload(delayed);
  assert.equal(revoked.length, 0, "切换会话不得销毁未发送预览");
  await render(null);
  await act(async () => finish(new TextEncoder().encode("GIF89a").buffer));
  assert.deepEqual(revoked.sort(), created.sort());
  assert.equal(revoked.length, 3);
});

test("微信发送未确认后切换会话发送，返回重试仍使用原会话的 requestId", async t => {
  const calls: { path: string; body: { requestId: string; text: string; attachments: { name: string }[] } }[] = [];
  t.mock.method(apiClient, "request", async (path: string, body: typeof calls[number]["body"]) => {
    calls.push({ path, body });
    if (calls.length === 1) throw new Error("发送结果未知");
    return {};
  });
  function Harness({ current }: { current: ConversationView }) {
    return <Composer draft={current.conversationId === 12 ? "需要可靠重试" : "另一段讨论"} setDraft={() => {}} view={current} connect={async () => current.conversationId} onSent={() => {}} onNewConversation={async () => {}} />;
  }
  const { dom, render } = await mount(t, <Harness current={view(12, "wechat")} />);
  const doc = dom.window.document, input = doc.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["text"], "retry.txt", { type: "text/plain" })] });
  await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  await act(async () => doc.querySelector<HTMLButtonElement>("#btn-send")!.click());
  await render(<Harness current={view(19)} />);
  await act(async () => doc.querySelector<HTMLButtonElement>("#btn-send")!.click());
  await render(<Harness current={view(12, "wechat")} />);
  assert.match(doc.querySelector(".attachments-preview")!.textContent!, /retry.txt/);
  await act(async () => doc.querySelector<HTMLButtonElement>("#btn-send")!.click());
  assert.deepEqual(calls.map(call => call.path), ["/api/conversations/12/messages", "/api/conversations/19/messages", "/api/conversations/12/messages"]);
  assert.deepEqual(calls[2].body, calls[0].body, "正文、附件和幂等键必须保持原样");
  assert.notEqual(calls[1].body.requestId, calls[0].body.requestId);
});

for (const destination of ["#teams", "#settings"]) test(`Web 发送未完成时转到 ${destination}，旧响应不能把用户拉回聊天`, async t => {
  t.mock.method(apiClient, "connect", async () => {});
  t.mock.method(apiClient, "onConnection", () => () => {});
  let receive!: (current: ConversationView) => void;
  t.mock.method(apiClient, "onView", (callback: (current: ConversationView) => void) => { receive = callback; return () => {}; });
  t.mock.method(apiClient, "subscribeConversation", async (id: number) => { receive(view(id)); });
  let finish!: () => void;
  const sends: string[] = [];
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path.endsWith("/messages") && path.startsWith("/api/conversations/")) { sends.push(path); return new Promise<void>(resolve => { finish = resolve; }); }
    if (path === "/api/conversations") return [{ id: 19, title: "网页讨论", channel: "web", createdAt: "2026-11-06", archivedAt: null }];
    if (path === "/api/teams/conversations") return { available: true, items: [], nextCursor: null, fetchedAt: "2026-11-06T10:00:00Z" };
    if (path === "/api/personal") return { memory: [], skills: [], knowledge: { enabled: false, allow: [] } };
    if (path.startsWith("/api/settings/")) throw new Error("测试中不读取设置");
    return { items: [], total: 0, latest: 0, schedules: [], reminders: [], background: [] };
  });
  const { dom, render } = await mount(t, null), doc = dom.window.document;
  dom.window.history.replaceState(null, "", "#chat/19");
  await render(<App />);
  const input = doc.querySelector("textarea")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(input, "发出后继续处理其他页面");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => doc.querySelector<HTMLButtonElement>("#btn-send")!.click());
  assert.deepEqual(sends, ["/api/conversations/19/messages"]);
  await act(async () => {
    dom.window.history.pushState(null, "", destination);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
  });
  assert.equal(doc.querySelector<HTMLElement>(".input-container")!.hidden, true);
  await act(async () => finish());
  assert.equal(dom.window.location.hash, destination);
  assert.equal(doc.querySelector<HTMLElement>(".input-container")!.hidden, true);
});
