import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { AgentPermissionParameter, DesktopAgentBridge, DesktopAgentSnapshot, ExternalAgentConfig } from "@assistant/contracts";
import { PermissionPicker } from "../dist/desktop/PermissionPicker.js";
import { mount } from "./dom.js";

for (const kind of ["codex", "claude"] as const) test(`${kind} permission levels map to native options and preserve model and effort`, async t => {
  const writes: ExternalAgentConfig[] = [];
  const parameters: AgentPermissionParameter[] = kind === "codex" ? [{ parameter: "sandbox", values: ["read-only", "workspace-write", "danger-full-access"] }, { parameter: "approvalPolicy", values: ["untrusted", "on-request", "never"] }] : [{ parameter: "permissionMode", values: ["plan", "default", "acceptEdits", "bypassPermissions"] }];
  let snapshot = { agent: kind, agentConfig: { executable: kind, args: [], model: "chosen", effort: "high" } } as unknown as DesktopAgentSnapshot;
  const bridge = { agentPermissions: async () => parameters } as DesktopAgentBridge;
  let success = true;
  const props = () => ({ snapshot, bridge, disabled: false, select: async (config: ExternalAgentConfig) => { writes.push(config); if (!success) return false; snapshot = { ...snapshot, agentConfig: config }; return true; } });
  const view = await mount(t, <PermissionPicker {...props()} />), doc = view.dom.window.document;
  await act(async () => doc.querySelector<HTMLButtonElement>('.permission-picker-trigger')!.click());
  await act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="权限：Full access"]')!.click());
  assert.equal(writes[0]!.model, "chosen"); assert.equal(writes[0]!.effort, "high");
  if (kind === "codex") { assert.equal(writes[0]!.sandbox, "danger-full-access"); assert.equal(writes[0]!.approvalPolicy, "never"); }
  else assert.equal(writes[0]!.permissionMode, "bypassPermissions");
  await view.render(<PermissionPicker {...props()} />);
  assert.equal(doc.querySelector('.permission-picker-trigger')!.getAttribute('aria-label'), "权限等级：Full access");
  success = false;
  await act(async () => doc.querySelector<HTMLButtonElement>('.permission-picker-trigger')!.click());
  await act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="权限：标准"]')!.click());
  assert.match(doc.querySelector('[role="alert"]')!.textContent!, /未保存/);
  assert.equal(doc.querySelector('.permission-picker-trigger')!.getAttribute('aria-label'), "权限等级：Full access");
  await act(async () => doc.querySelector('.permission-picker-popover')!.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(doc.querySelector('.permission-picker-popover'), null);
});

for (const agent of ["pi", "omp", "acp"] as const) test(`${agent} exposes Full access and can switch back to explicit confirmation`, async t => {
  const writes: unknown[] = [];
  const snapshot = { agent, piAccess: "full", agentConfig: { executable: agent, args: [], access: "full", model: "keep", effort: "high" } } as unknown as DesktopAgentSnapshot;
  const bridge = {} as DesktopAgentBridge;
  const view = await mount(t, <PermissionPicker snapshot={snapshot} bridge={bridge} disabled={false} select={async config => { writes.push(config); return true; }} selectPi={async access => { writes.push({ piAccess: access }); return true; }} />);
  const doc = view.dom.window.document;
  assert.equal(doc.querySelector('.permission-picker-trigger')!.getAttribute('aria-label'), "权限等级：Full access");
  await act(async () => doc.querySelector<HTMLButtonElement>('.permission-picker-trigger')!.click());
  await act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="权限：逐项确认"]')!.click());
  assert.deepEqual(writes, [agent === "pi" ? { piAccess: "ask" } : { executable: agent, args: [], access: "ask", permission: undefined, model: "keep", effort: "high" }]);
});

test("unsupported native values and older clients cannot claim Full access", async t => {
  const writes: ExternalAgentConfig[] = [];
  const bridge = { agentPermissions: async () => [{ parameter: "sandbox", values: ["read-only"] }] } as DesktopAgentBridge;
  let snapshot = { agent: "codex", agentConfig: { executable: "codex", args: [] } } as unknown as DesktopAgentSnapshot;
  const props = () => ({ snapshot, bridge, disabled: false, select: async (config: ExternalAgentConfig) => { writes.push(config); return true; } });
  const view = await mount(t, <PermissionPicker {...props()} />), doc = view.dom.window.document;
  await act(async () => doc.querySelector<HTMLButtonElement>('.permission-picker-trigger')!.click());
  assert.equal(doc.querySelector<HTMLButtonElement>('[aria-label="权限：Full access"]')!.disabled, true);
  for (const agent of ["pi", "omp"] as const) {
    snapshot = { ...snapshot, agent };
    await view.render(<PermissionPicker {...props()} />);
    await act(async () => doc.querySelector<HTMLButtonElement>('.permission-picker-trigger')!.click());
    assert.equal(doc.querySelector<HTMLButtonElement>('[aria-label="权限：Full access"]')!.disabled, true);
  }
  assert.equal(writes.length, 0);
});
