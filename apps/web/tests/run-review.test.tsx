import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UnifiedRun } from "@assistant/contracts";
import type { CardAction } from "../dist/chat/cards.js";
import { RunDetails } from "../dist/tasks/RunDetails.js";
import { managementCards } from "../dist/tasks/management.js";
import { Card } from "../dist/tasks/CardPanel.js";
import { TasksPage } from "../dist/workspace/TasksPage.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const run: UnifiedRun = { id: "background:job", taskId: "job", conversationId: 8, workerConversationId: 12, source: "background", status: "succeeded", text: "核对交付", startedAt: 10, finishedAt: 20, result: "结果 [文档](https://example.com/report)", error: null, evidence: ["file.ts:42"], cancellation: "not_requested", delivery: { status: "unknown", detail: "尚未核实实际送达" }, review: { status: "pending" }, revision: "result-v1" };

test("执行成功、外部交付与人工验收分别展示，不把成功冒充验收", () => {
  const html = renderToStaticMarkup(<RunDetails run={run} pending={false} onAction={() => {}} />);
  assert.match(html, /执行成功/); assert.match(html, /交付结果未确认/);
  assert.match(html, /本次执行/); assert.match(html, /file.ts:42/);
  assert.match(html, /确认验收/); assert.doesNotMatch(html, /已人工验收/);
  assert.match(html, /href="https:\/\/example.com\/report"/);
});

test("验收携带当前会话、运行和结果版本，等待中禁止重复点击", async t => {
  const actions: CardAction[] = [];
  const { dom, render } = await mount(t, <RunDetails run={run} pending={false} onAction={action => actions.push(action)} />);
  const button = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === "确认验收")!;
  await act(async () => button.click());
  assert.deepEqual(actions[0], { kind: "request", label: "确认验收", path: "/api/conversations/8/runs/review", body: { runId: "background:job", revision: "result-v1", decision: "accepted" } });
  await render(<RunDetails run={run} pending={true} onAction={action => actions.push(action)} />);
  await act(async () => button.click()); assert.equal(actions.length, 1);
});

test("未结束、失败、取消的执行不提供成果验收；已验收记录保留备注", () => {
  for (const status of ["running", "queued", "failed", "cancelled", "interrupted"] as const) {
    const html = renderToStaticMarkup(<RunDetails run={{ ...run, status }} pending={false} onAction={() => {}} />);
    assert.doesNotMatch(html, /确认验收|需要修改/);
  }
  const html = renderToStaticMarkup(<RunDetails run={{ ...run, review: { status: "accepted", note: "核对文件通过", reviewedAt: 25 } }} pending={false} onAction={() => {}} />);
  assert.match(html, /已人工验收/); assert.match(html, /核对文件通过/); assert.doesNotMatch(html, /确认验收/);
});

test("执行记录附在原任务下，同步委派也有可检查的卡片", () => {
  const cards = managementCards({ schedules: [], reminders: [], background: [{ id: "job", text: "核对交付", status: "done", conversationId: 12, createdAt: 10, result: "旧摘要" }], runs: [run, { ...run, id: "delegate:13", source: "delegate", taskId: "13" }] }, "8");
  assert.equal(cards.length, 2); assert.equal(cards[0].runs?.[0].id, run.id);
  assert.equal(cards[1].key, "delegate:13");
  const html = renderToStaticMarkup(<Card card={cards[0]} pending={false} onAction={() => {}} />);
  assert.match(html, /成果验收/); assert.doesNotMatch(html, /旧摘要/);
});

test("成果与依据中的外部 HTML 不执行", () => {
  const html = renderToStaticMarkup(<RunDetails run={{ ...run, result: "<script>alert(1)</script>", evidence: ["<img src=x onerror=alert(1)>"] }} pending={false} onAction={() => {}} />);
  assert.doesNotMatch(html, /<script>|<img src=x/);
});

test("goal rounds use only the existing whole-goal acceptance control", () => {
  const html = renderToStaticMarkup(<RunDetails run={{ ...run, source: "goal", status: "review" }} pending={false} onAction={() => {}} />);
  assert.match(html, /请在任务卡确认完成/); assert.doesNotMatch(html, /<button/);
});


test("switching task owners ignores an older management response", async t => {
  let resolveOld!: (value: unknown) => void;
  t.mock.method(apiClient, "request", (path: string) => path.includes("/8/") ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve({ schedules: [], reminders: [], background: [] }));
  const { dom, render } = await mount(t, <TasksPage owner={8} active />);
  await render(<TasksPage owner={9} active />);
  await act(async () => resolveOld({ schedules: [], reminders: [], background: [{ id: "job", text: "旧会话私有成果", status: "done", conversationId: 8, createdAt: 10, result: "旧结果" }], runs: [run] }));
  assert.doesNotMatch(dom.window.document.body.textContent!, /旧会话私有成果|确认验收/);
});
