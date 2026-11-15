import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { ConversationSync } from "../dist/desktop/ConversationSync.js";
import { mount } from "./dom.js";
import type { DesktopAgentSnapshot } from "@assistant/contracts";
const state: NonNullable<DesktopAgentSnapshot["conversationSync"]> = { sessionId: "pi-1", mode: "local", summary: "Chosen result", revision: 0, sentRevision: 0, previouslyShared: true, status: "local" };

test("sync scope requires explicit save and carries the exact conversation identity", async t => {
  const calls: unknown[] = [];
  const { dom } = await mount(t, <ConversationSync sync={state} disabled={false} save={async input => { calls.push(input); }} />);
  const select = dom.window.document.querySelector("select")!;
  await act(async () => { select.value = "summary"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  assert.equal(calls.length, 0);
  assert.match(dom.window.document.body.textContent!, /Previously shared data remains/);
  assert.match(dom.window.document.body.textContent!, /Future replies are not added automatically/);
  await act(async () => dom.window.document.querySelector("button")!.click());
  assert.deepEqual(calls, [{ sessionId: "pi-1", mode: "summary", summary: "Chosen result" }]);
});

test("failed sync preferences remain editable and session changes reset unsaved scope", async t => {
  const save = async () => { throw new Error("Conversation changed"); };
  const { dom, render } = await mount(t, <ConversationSync key={state.sessionId} sync={state} disabled={false} save={save} />);
  const select = dom.window.document.querySelector("select")!;
  await act(async () => { select.value = "full"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await act(async () => dom.window.document.querySelector("button")!.click());
  assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /Conversation changed/);
  assert.equal(dom.window.document.querySelector("button")!.disabled, false);
  await render(<ConversationSync key="pi-2" sync={{ ...state, sessionId: "pi-2" }} disabled={false} save={save} />);
  assert.equal(dom.window.document.querySelector("select")!.value, "local");
  assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
});

test("generated draft remains local until separately selected and published", async t => {
  const calls: unknown[] = [];
  const { dom } = await mount(t, <ConversationSync sync={state} disabled={false} save={async input => { calls.push(input); }} generate={async () => ({ summary: "Reviewed result", sourceRevision: "version-1" })} />);
  const document = dom.window.document;
  await act(async () => document.querySelector<HTMLButtonElement>('button[type="button"]')!.click());
  assert.equal(document.querySelector("select")!.value, "local");
  assert.equal(document.querySelector("textarea")!.value, "Reviewed result");
  assert.deepEqual(calls, []);
  await act(async () => { const select = document.querySelector("select")!; select.value = "summary"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await act(async () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  assert.deepEqual(calls, [{ sessionId: "pi-1", mode: "summary", summary: "Reviewed result", sourceRevision: "version-1" }]);
});

test("cancelling a draft discards late completion without changing sharing", async t => {
  let finish!: (value: { summary: string; sourceRevision: string }) => void;
  const { dom } = await mount(t, <ConversationSync sync={state} disabled={false} save={async () => { throw new Error("must not publish"); }} generate={() => new Promise(resolve => { finish = resolve; })} cancel={async () => {}} />);
  const document = dom.window.document;
  await act(async () => document.querySelector<HTMLButtonElement>('button[type="button"]')!.click());
  await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "Cancel generation")!.click());
  await act(async () => finish({ summary: "late", sourceRevision: "old" }));
  assert.equal(document.querySelector("textarea"), null);
  assert.equal(document.querySelector("select")!.value, "local");
});
