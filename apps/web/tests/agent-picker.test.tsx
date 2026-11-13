import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { AgentPicker } from "../dist/desktop/AgentPicker.js";
import type { DesktopAgentBridge, DesktopAgentSnapshot } from "@assistant/contracts";
import { mount } from "./dom.js";

test("模型、强度与权限立即保存，切换模型清除旧强度，失败保留已保存配置", async t => {
  let state = { agent: "codex", agentConfig: { executable: "custom-codex", args: [], model: "sol", effort: "low" }, model: { model: "pi" } } as unknown as DesktopAgentSnapshot;
  let fail = false;
  const writes: unknown[] = [];
  const bridge = {
    agentModels: async () => [{ id: "sol", name: "Sol", efforts: ["low", "high"] }, { id: "astra", name: "Astra", efforts: ["medium"] }],
    agentPermissions: async () => [{ parameter: "sandbox", values: ["read-only", "workspace-write"] }],
    selectAgent: async input => { writes.push(input); if (fail) throw new Error("failure"); state = { ...state, agentConfig: input.config }; },
  } as DesktopAgentBridge;
  const props = () => ({ snapshot: state, bridge, disabled: false, select: async () => true, settings() {}, saved: async () => {} });
  const view = await mount(t, <AgentPicker {...props()} />);
  const doc = view.dom.window.document;
  await act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="执行 Agent"]')!.click());
  assert.ok(doc.querySelector('[data-model-view="true"]'));
  assert.equal(doc.querySelectorAll('.agent-picker-reasoning button').length, 3);
  await act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="选择模型 Astra"]')!.click());
  await view.render(<AgentPicker {...props()} />);
  assert.equal(state.agentConfig!.model, "astra");
  assert.equal(state.agentConfig!.effort, undefined);
  assert.equal(state.agentConfig!.executable, "custom-codex");
  assert.equal(doc.querySelectorAll('.agent-picker-reasoning button').length, 2);
  await act(async () => [...doc.querySelectorAll<HTMLButtonElement>('.agent-picker-reasoning button')].find(button => button.textContent === "medium")!.click());
  assert.equal(state.agentConfig!.effort, "medium");
  await view.render(<AgentPicker {...props()} />);
  const permission = doc.querySelector<HTMLSelectElement>('[aria-label="sandbox"]')!;
  await act(async () => { permission.value = "read-only"; permission.dispatchEvent(new view.dom.window.Event("change", { bubbles: true })); });
  assert.equal(state.agentConfig!.sandbox, "read-only");
  await view.render(<AgentPicker {...props()} />);
  await act(async () => { permission.value = ""; permission.dispatchEvent(new view.dom.window.Event("change", { bubbles: true })); });
  assert.equal(state.agentConfig!.sandbox, undefined, "可以撤销权限覆盖，不传自定义默认值");
  await view.render(<AgentPicker {...props()} />);
  fail = true;
  await act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="选择模型 Sol"]')!.click());
  assert.equal(state.agentConfig!.model, "astra");
  assert.match(doc.querySelector('[role="alert"]')!.textContent!, /未保存/);
  assert.equal(writes.length, 5);
  fail = false;
  const search = doc.querySelector<HTMLInputElement>('[aria-label="搜索 Agent 或模型"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(view.dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "Sol");
    search.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => search.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  assert.equal(state.agentConfig!.model, "sol", "搜索结果回车选择匹配模型，不重置为 Agent 默认");
});
