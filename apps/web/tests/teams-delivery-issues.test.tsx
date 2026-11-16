import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { TeamsDeliveryIssues } from "../dist/teams/TeamsDeliveryIssues.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";
const item = { id: "teams-digest:" + "a".repeat(64), state: "unknown", createdAt: 1000, sourceCount: 2, sourceStatus: "current", receipt: "unavailable" };

test("delivery issues load only on open; double-click rechecks once and never offers resend", async t => {
  const calls: string[] = []; let finish!: (value: unknown) => void;
  t.mock.method(apiClient, "request", async (path: string) => {
    calls.push(path);
    return path.endsWith("recheck") ? new Promise(resolve => { finish = resolve; }) : { available: true, items: [item], truncated: false };
  });
  const view = await mount(t, <TeamsDeliveryIssues active />), doc = view.dom.window.document;
  assert.equal(calls.length, 0);
  await act(async () => { const details = doc.querySelector("details")!; details.open = true; details.dispatchEvent(new view.dom.window.Event("toggle")); });
  assert.match(doc.body.textContent!, /送达未确认/);
  const button = doc.querySelector("button")!;
  await act(async () => { button.click(); button.click(); });
  assert.equal(calls.filter(path => path.endsWith("recheck")).length, 1);
  assert.equal(button.disabled, true);
  await act(async () => { finish({ item, sourceCheck: "verified", deliveryCheck: "unconfirmed" }); });
  assert.match(doc.body.textContent!, /来源已核对。送达仍未确认，没有重发/);
  assert.deepEqual([...doc.querySelectorAll("button")].map(button => button.textContent), ["核对来源"]);
});

test("late source-check feedback is discarded when the view is removed", async t => {
  let finish!: (value: unknown) => void;
  t.mock.method(apiClient, "request", async (path: string) => path.endsWith("recheck")
    ? new Promise(resolve => { finish = resolve; }) : { available: true, items: [item], truncated: false });
  const view = await mount(t, <TeamsDeliveryIssues active />), doc = view.dom.window.document;
  await act(async () => { const details = doc.querySelector("details")!; details.open = true; details.dispatchEvent(new view.dom.window.Event("toggle")); });
  await act(async () => { doc.querySelector("button")!.click(); });
  await view.render(<p>other view</p>);
  await act(async () => { finish({ item, sourceCheck: "verified", deliveryCheck: "unconfirmed" }); });
  assert.equal(doc.body.textContent, "other view");
});

for (const transition of ["reopen", "inactive"] as const) test(`pending recheck remains visibly disabled across ${transition} until its old response settles`, async t => {
  let checks = 0, finish!: (value: unknown) => void;
  t.mock.method(apiClient, "request", async (path: string) => {
    if (!path.endsWith("recheck")) return { available: true, items: [item], truncated: false };
    checks++; return new Promise(resolve => { finish = resolve; });
  });
  const view = await mount(t, <TeamsDeliveryIssues active />), doc = view.dom.window.document;
  const toggle = async (open: boolean) => act(async () => { const details = doc.querySelector("details")!; details.open = open; details.dispatchEvent(new view.dom.window.Event("toggle")); });
  await toggle(true);
  await act(async () => { doc.querySelector("button")!.click(); });
  if (transition === "reopen") { await toggle(false); await toggle(true); }
  else { await view.render(<TeamsDeliveryIssues active={false} />); await view.render(<TeamsDeliveryIssues active />); }
  const button = doc.querySelector("button")!;
  assert.equal(button.disabled, true); assert.equal(button.textContent, "正在核对…");
  await act(async () => { button.click(); }); assert.equal(checks, 1);
  await act(async () => { finish({ item, sourceCheck: "verified", deliveryCheck: "unconfirmed" }); });
  assert.equal(button.disabled, false); assert.equal(button.textContent, "核对来源");
  assert.doesNotMatch(doc.body.textContent!, /来源已核对/);
});

test("an old GET completing after reopen cannot replace the latest evidence list", async t => {
  let calls = 0, old!: (value: unknown) => void;
  const latest = { ...item, id: "teams-digest:" + "b".repeat(64), sourceCount: 7 };
  t.mock.method(apiClient, "request", async () => ++calls === 1
    ? new Promise(resolve => { old = resolve; }) : { available: true, items: [latest], truncated: false });
  const view = await mount(t, <TeamsDeliveryIssues active />), doc = view.dom.window.document;
  const toggle = async (open: boolean) => act(async () => { const details = doc.querySelector("details")!; details.open = open; details.dispatchEvent(new view.dom.window.Event("toggle")); });
  await toggle(true); await toggle(false); await toggle(true);
  assert.match(doc.body.textContent!, /7 条来源/);
  await act(async () => { old({ available: true, items: [item], truncated: false }); });
  assert.match(doc.body.textContent!, /7 条来源/);
  assert.doesNotMatch(doc.body.textContent!, /2 条来源/);
});
