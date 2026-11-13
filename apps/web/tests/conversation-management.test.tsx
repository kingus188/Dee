import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { ConversationItem } from "@assistant/contracts";
import { apiClient } from "../dist/api/socket.js";
import { ConversationHistory } from "../dist/ui/ConversationHistory.js";
import { mount } from "./dom.js";

const initial = (): ConversationItem[] => [
  { id: 1, title: "方案", createdAt: "2026-11-13", status: "waiting" },
  { id: 2, title: "旧方案", createdAt: "2026-11-12", status: "completed", archivedAt: "2026-11-13" },
];

test("历史列表显示独立对话状态，归档可查看恢复且保留当前标题", async t => {
  let items = initial();
  const writes: string[] = [], reported: ConversationItem[][] = [], opened: number[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: { status?: ConversationItem["status"] }) => {
    if (body === undefined) return items;
    writes.push(path);
    const id = Number(path.split("/")[3]);
    items = items.map(item => item.id !== id ? item : path.endsWith("status") ? { ...item, status: body.status } : { ...item, archivedAt: path.endsWith("archive") ? "2026-11-13" : null });
    return {};
  });
  const onItems = (values: ConversationItem[]) => reported.push(values);
  const mounted = await mount(t, <ConversationHistory active currentId={1} onItems={onItems} onOpen={id => opened.push(id)} onClose={() => {}} />);
  const doc = mounted.dom.window.document;
  t.mock.method(mounted.dom.window, "confirm", () => true);
  assert.match(doc.querySelector('[href="#chat/1"]')!.textContent!, /Waiting/);
  assert.equal(doc.querySelector('[href="#chat/2"]'), null);
  assert.equal(reported.at(-1)?.length, 2, "上层仍知道归档会话标题和状态");
  assert.deepEqual([...doc.querySelectorAll("select option")].map(option => option.textContent), ["Active", "Waiting", "Completed"]);
  const status = doc.querySelector<HTMLSelectElement>('[aria-label="对话状态：方案"]')!;
  await act(async () => { status.value = "completed"; status.dispatchEvent(new mounted.dom.window.Event("change", { bubbles: true })); });
  assert.match(doc.querySelector('[href="#chat/1"]')!.textContent!, /Completed/);
  await act(async () => [...doc.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Archive")!.click());
  assert.equal(doc.querySelector('[href="#chat/1"]'), null);
  await act(async () => [...doc.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Archived")!.click());
  assert.equal(doc.querySelectorAll(".history-row").length, 2);
  await act(async () => doc.querySelector<HTMLAnchorElement>('[href="#chat/1"]')!.click());
  assert.deepEqual(opened, [1]);
  assert.match(doc.querySelector('[href="#chat/1"]')!.textContent!, /Archived/);
  await act(async () => doc.querySelector<HTMLButtonElement>('[data-conversation-id="1"] button')!.click());
  assert.equal(doc.querySelector('[href="#chat/1"]'), null);
  assert.deepEqual(writes, ["/api/conversations/1/status", "/api/conversations/1/archive", "/api/conversations/1/restore"]);
});

test("归档失败保留对话，停止待确认提供重试及取消；重复点击只发一次", async t => {
  let items = initial(), reject!: (error: Error) => void, writes = 0;
  t.mock.method(apiClient, "request", async (_path: string, body?: unknown) => {
    if (body === undefined) return items;
    writes++; return new Promise((_resolve, fail) => { reject = fail; });
  });
  const { dom } = await mount(t, <ConversationHistory active currentId={1} onOpen={() => {}} onClose={() => {}} />);
  t.mock.method(dom.window, "confirm", () => true);
  const doc = dom.window.document, archive = doc.querySelector<HTMLButtonElement>('[data-conversation-id="1"] button')!;
  await act(async () => { archive.click(); archive.click(); });
  assert.equal(writes, 1);
  assert.equal(archive.disabled, true);
  items = items.map(item => item.id === 1 ? { ...item, archivingAt: "2026-11-13" } : item);
  await act(async () => reject(new Error("停止执行尚未确认")));
  assert.ok(doc.querySelector('[href="#chat/1"]'));
  assert.match(doc.querySelector('[role="alert"]')!.textContent!, /停止执行尚未确认/);
  assert.match(doc.querySelector('[data-conversation-id="1"]')!.textContent!, /Archive pending.*Retry archive.*Cancel archive/);
});

test("取消归档确认不写入，切换当前对话关闭管理菜单，Escape 不关闭侧栏", async t => {
  let writes = 0, closes = 0;
  t.mock.method(apiClient, "request", async (_path: string, body?: unknown) => { if (body !== undefined) writes++; return initial(); });
  const props = { active: true, onOpen: () => {}, onClose: () => { closes++; } };
  const { dom, render } = await mount(t, <ConversationHistory {...props} currentId={1} />);
  const doc = dom.window.document;
  t.mock.method(dom.window, "confirm", () => false);
  await act(async () => doc.querySelector<HTMLButtonElement>('[data-conversation-id="1"] button')!.click());
  assert.equal(writes, 0);
  const menu = doc.querySelector<HTMLDetailsElement>(".history-conversation-actions")!;
  menu.open = true;
  await act(async () => menu.querySelector("select")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(menu.open, false);
  assert.equal(closes, 0);
  menu.open = true;
  await render(<ConversationHistory {...props} currentId={2} />);
  assert.equal(menu.open, false);
});

test("历史列表响应格式错误显示错误而不破坏整个工作区，重试可恢复", async t => {
  let valid = false;
  t.mock.method(apiClient, "request", async () => valid ? initial() : { items: [] });
  const { dom } = await mount(t, <ConversationHistory active currentId={1} onOpen={() => {}} onClose={() => {}} />);
  assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /响应格式不正确/);
  valid = true;
  await act(async () => dom.window.document.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
  assert.ok(dom.window.document.querySelector('[href="#chat/1"]'));
  assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
});
