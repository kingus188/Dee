import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttentionSection, isWorkspaceAttention } from "../dist/today/AttentionSection.js";
import { AgentContext } from "../dist/desktop/AgentContext.js";
import type { DesktopAgentSnapshot } from "@assistant/contracts";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";
const item = { id: "conversation:2", conversationId: 2, conversationTitle: "Review work", text: "Waiting for decision", reasons: ["Waiting"], target: "conversation", at: null };
test("attention rejects malformed destinations and unknown reason states", () => {
  assert.equal(isWorkspaceAttention({ items: [item], total: 1, truncated: false }), true);
  for (const patch of [{ conversationId: -1 }, { target: "send" }, { reasons: ["done"] }, { text: null }]) assert.equal(isWorkspaceAttention({ items: [{ ...item, ...patch }], total: 1, truncated: false }), false);
});
test("attention opens source conversation or task review without retrying external effects", async t => {
  const calls: string[] = [], opened: number[] = [], managed: number[] = [];
  const original = apiClient.request;
  apiClient.request = async path => { calls.push(path); return { items: [item, { ...item, id: "run:2:x", target: "tasks", reasons: ["Delivery unknown"] }], total: 2, truncated: false } as never; };
  t.after(() => { apiClient.request = original; });
  const ui = await mount(t, <AttentionSection active onConversation={id => opened.push(id)} onManage={id => managed.push(id)} />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const buttons = ui.dom.window.document.querySelectorAll<HTMLButtonElement>(".inbox-approval-link");
  assert.equal(buttons.length, 2);
  await act(async () => { buttons[0].click(); buttons[1].click(); });
  assert.deepEqual(opened, [2]); assert.deepEqual(managed, [2]);
  assert.ok(calls.every(path => path === "/api/workspace/attention"));
});
test("local execution boundary does not claim connection proves transcript synchronization", () => {
  const html = renderToStaticMarkup(<AgentContext snapshot={{ nodeId: "desktop-1", serverConnected: true, busy: true } as DesktopAgentSnapshot} />);
  assert.match(html, /Local · desktop-1/); assert.match(html, /Connected/); assert.match(html, /Unknown/);
  assert.match(html, /不代表当前历史已同步/); assert.match(html, /不受服务端归档控制/);
});
