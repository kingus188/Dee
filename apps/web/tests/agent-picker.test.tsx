import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { AgentPicker } from "../dist/desktop/AgentPicker.js";
import type { DesktopAgentBridge, DesktopAgentSnapshot } from "@assistant/contracts";
import { mount } from "./dom.js";
import { useDesktopConversation } from "../dist/desktop/useDesktopConversation.js";

test("an older poll cannot overwrite the snapshot returned after a model change", async t => {
  let resolveOld!: (value: DesktopAgentSnapshot) => void;
  let calls = 0;
  const state = (model: string) => ({ agent: "omp", agentConfig: { executable: "omp", args: [], model }, messages: [], busy: false, model: { model } }) as unknown as DesktopAgentSnapshot;
  const bridge = { snapshot: () => ++calls === 1 ? new Promise<DesktopAgentSnapshot>(resolve => { resolveOld = resolve; }) : Promise.resolve(state("new-model")) } as DesktopAgentBridge;
  function Probe() {
    const local = useDesktopConversation();
    return <button onClick={() => void local.refresh()}>{local.snapshot?.agentConfig?.model ?? "loading"}</button>;
  }
  const view = await mount(t, null);
  Object.defineProperty(view.dom.window, "desktopAgent", { value: bridge });
  await view.render(<Probe />);
  await act(async () => view.dom.window.document.querySelector('button')!.click());
  assert.equal(view.dom.window.document.querySelector('button')!.textContent, "new-model");
  await act(async () => resolveOld(state("old-model")));
  assert.equal(view.dom.window.document.querySelector('button')!.textContent, "new-model");
});

for (const kind of ["pi", "omp"] as const) test(`${kind} lists models and saves the selected model`, async t => {
  const writes: unknown[] = [];
  const modelId = kind === "pi" ? JSON.stringify(["provider", "model"]) : "provider/model";
  const snapshot = { agent: kind, agentConfig: kind === "omp" ? { executable: "omp", args: [] } : undefined, model: { model: "old" } } as DesktopAgentSnapshot;
  const bridge = { agentModels: async () => [{ id: modelId, name: "New model", efforts: [] }], selectAgent: async (input: Parameters<DesktopAgentBridge["selectAgent"]>[0]) => { writes.push(input); } } as unknown as DesktopAgentBridge;
  const view = await mount(t, <AgentPicker snapshot={snapshot} bridge={bridge} disabled={false} select={async () => true} settings={() => {}} saved={async () => {}} />);
  const doc = view.dom.window.document;
  await act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="执行 Agent"]')!.click());
  await act(async () => doc.querySelector<HTMLButtonElement>(`[aria-label="筛选 ${kind === "pi" ? "Pi" : "OMP"}"]`)!.click());
  await act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="选择模型 New model"]')!.click());
  assert.deepEqual(writes, [kind === "pi" ? { kind, piModel: { provider: "provider", modelId: "model" }, piEffort: null } : { kind, config: { executable: "omp", args: [], model: modelId, effort: undefined } }]);
  assert.ok(doc.querySelector('.agent-picker-reasoning'));
});

for (const kind of ["pi", "omp"] as const) test(`${kind} saves reasoning without replacing the selected model`, async t => {
  const writes: unknown[] = [];
  const id = kind === "pi" ? JSON.stringify(["provider", "model"]) : "provider/model";
  const snapshot = { agent: kind, configured: true, piModel: { provider: "provider", modelId: "model" }, agentConfig: { executable: "omp", args: [], model: id }, model: { model: "model" } } as unknown as DesktopAgentSnapshot;
  const bridge = { agentModels: async () => [{ id, name: "Model", efforts: ["high"] }], selectAgent: async (input: Parameters<DesktopAgentBridge["selectAgent"]>[0]) => { writes.push(input); } } as unknown as DesktopAgentBridge;
  const view = await mount(t, <AgentPicker snapshot={snapshot} bridge={bridge} disabled={false} select={async () => true} settings={() => {}} saved={async () => {}} />);
  await act(async () => view.dom.window.document.querySelector<HTMLButtonElement>('[aria-label="执行 Agent"]')!.click());
  await act(async () => [...view.dom.window.document.querySelectorAll<HTMLButtonElement>('.agent-picker-reasoning button')].find(button => button.textContent === "high")!.click());
  assert.deepEqual(writes, [kind === "pi" ? { kind, piModel: { provider: "provider", modelId: "model" }, piEffort: "high" } : { kind, config: { executable: "omp", args: [], model: id, effort: "high" } }]);
});

test("模型与强度立即保存，切换模型清除旧强度，失败保留已保存配置", async t => {
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
  fail = true;
  await act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="选择模型 Sol"]')!.click());
  assert.equal(state.agentConfig!.model, "astra");
  assert.match(doc.querySelector('[role="alert"]')!.textContent!, /未保存/);
  assert.equal(writes.length, 3);
  fail = false;
  const search = doc.querySelector<HTMLInputElement>('[aria-label="搜索 Agent 或模型"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(view.dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "Sol");
    search.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => search.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  assert.equal(state.agentConfig!.model, "sol", "搜索结果回车选择匹配模型，不重置为 Agent 默认");
});
