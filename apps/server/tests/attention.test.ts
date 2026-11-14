import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationItem, Management, UnifiedRun } from "@assistant/contracts";
import { attentionItems } from "../dist/application/attention.js";
const owner: ConversationItem = { id: 12, title: "Private work", createdAt: "2026-01-01" };
const run: UnifiedRun = { id: "run-1", taskId: "job-1", conversationId: 12, source: "background", status: "succeeded", text: "Deliver work", startedAt: 10, finishedAt: 20, result: "Done", error: null, evidence: [], cancellation: "not_requested", delivery: { status: "not_applicable" }, review: { status: "accepted" }, revision: "v1" };
const data = (runs: UnifiedRun[] = []): Management => ({ schedules: [], reminders: [], background: [], runs });

test("attention distinguishes manual waiting and archive intent, excludes archived records", () => {
  assert.deepEqual(attentionItems(owner, data()), []);
  assert.deepEqual(attentionItems({ ...owner, status: "waiting" }, data())[0].reasons, ["Waiting"]);
  assert.deepEqual(attentionItems({ ...owner, status: "waiting", archivingAt: "2026-01-02" }, data())[0].reasons, ["Archive pending"]);
  assert.deepEqual(attentionItems({ ...owner, status: "waiting", archivedAt: "2026-01-02" }, data([run])), []);
});

test("attention does not infer delivery or review from successful completion", () => {
  assert.deepEqual(attentionItems(owner, data([run])), []);
  const items = attentionItems(owner, data([{ ...run, review: { status: "pending" }, delivery: { status: "unknown" }, cancellation: "requested" }]));
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].reasons, ["Review pending", "Delivery unknown", "Stop pending"]);
  assert.equal(items[0].target, "tasks"); assert.equal(items[0].conversationId, 12);
  assert.equal(items[0].runId, "run-1");
});

test("legacy failure is included once and attention projection does not mutate source", () => {
  const failed = { ...run, status: "failed" as const, review: { status: "not_applicable" as const } };
  const source: Management = { ...data([failed]), background: [{ id: "job-1", text: "legacy", status: "failed", conversationId: 15, createdAt: 1, finishedAt: 2, result: null }] };
  const before = JSON.stringify(source);
  assert.equal(attentionItems(owner, source).length, 1);
  assert.equal(JSON.stringify(source), before);
  assert.equal(attentionItems(owner, { ...source, runs: [] })[0].conversationId, 12);
});


test("attention only surfaces the current actionable Goal round", () => {
  const old = { ...run, source: "goal" as const, id: "goal:g:1", taskId: "g", status: "review" as const, review: { status: "pending" as const } };
  const current = { ...old, id: "goal:g:2" };
  const goal = { id: "g", round: 2, status: "completed" } as NonNullable<Management["goals"]>[number];
  assert.deepEqual(attentionItems(owner, { ...data([old, current]), goals: [goal] }), []);
  const pending = attentionItems(owner, { ...data([old, current]), goals: [{ ...goal, status: "review" }] });
  assert.equal(pending.length, 1); assert.equal(pending[0].runId, current.id);
});
