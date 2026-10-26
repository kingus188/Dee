import test from "node:test";
import assert from "node:assert/strict";
import * as features from "@assistant/features";
import type { Tx } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

type RecordDoc = { items: Record<string, unknown>[]; applied?: Record<string, unknown> };
function fixture() {
  const docs = new Map<unknown, RecordDoc>();
  docs.set(features.Schedules, { items: [{ id: "plan", text: "交付结果", nextAt: 1000, everyMinutes: 0, runs: 0, status: "active", revision: 1, createdAt: 0, daylightTaskId: "todo-id" }] });
  const events: unknown[] = [];
  const task = { id: 5, input: { scheduleId: "plan", text: "交付结果", at: 1000, revision: 1 }, state: { checkpoint: { phase: "deliver" } } };
  const tx = {
    doc: async (token: unknown) => { if (!docs.has(token)) docs.set(token, { items: [] }); return docs.get(token)!; },
    entry: async () => ({ model: [{ content: [{ type: "text", text: "已完成，并附交付结果" }] }] }),
    createTask: async () => 99,
  } as unknown as Tx;
  const submission = { id: 11, status: async () => ({ id: 11, type: "input", status: "done", answer: 22 }), wait: async () => ({ id: 11, type: "input", status: "done", answer: 22 }) };
  const runtime = {
    conversationId: 7, signal: new AbortController().signal,
    conversation: async () => ({ submit: async () => submission }),
    commit: async (action: (tx: Tx) => Promise<unknown>) => { const next = await action(tx) as { checkpoint?: object } | undefined; if (next?.checkpoint) task.state.checkpoint = next.checkpoint as { phase: string }; },
  };
  const center = features.createTaskCenter(async event => { events.push(event); });
  return { docs, events, task, runtime, center };
}

test("schedule admission creates one queued execution linked to Daylight instead of a completed result", async () => {
  const { docs, task, runtime, center } = fixture();
  const handler = center.ScheduleTask.definition.phases.deliver!;
  await handler(task as unknown as Parameters<typeof handler>[0], runtime as unknown as Parameters<typeof handler>[1], context);
  const runs = docs.get(Reflect.get(features, "Executions"))?.items ?? [];
  assert.equal(runs.length, 1, "each trigger must persist an execution");
  assert.equal(runs[0].daylightTaskId, "todo-id");
  assert.equal(runs[0].finishedAt, null);
  assert.notEqual(runs[0].status, "done");
});

test("schedule waits for the actual answer and records its result and completion time", async () => {
  const { docs, task, runtime, center } = fixture();
  const deliver = center.ScheduleTask.definition.phases.deliver!;
  await deliver(task as unknown as Parameters<typeof deliver>[0], runtime as unknown as Parameters<typeof deliver>[1], context);
  const handler = center.ScheduleTask.definition.phases.wait;
  assert.ok(handler, "the durable task must wait for settlement");
  await handler(task as unknown as Parameters<typeof handler>[0], runtime as unknown as Parameters<typeof handler>[1], context);
  const runs = docs.get(Reflect.get(features, "Executions"))?.items ?? [];
  assert.equal(runs[0]?.status, "done");
  assert.equal(runs[0]?.answerId, 22);
  assert.match(String(runs[0]?.result), /交付结果/);
  assert.equal(typeof runs[0]?.finishedAt, "number");
});

async function schedulePhase(f: ReturnType<typeof fixture>, phase: "deliver" | "wait" | "abort", center = f.center) {
  const handler = phase === "abort" ? center.ScheduleTask.definition.abort : center.ScheduleTask.definition.phases[phase];
  assert.ok(handler);
  await handler(f.task as unknown as Parameters<typeof handler>[0], f.runtime as unknown as Parameters<typeof handler>[1], context);
}
const execution = (f: ReturnType<typeof fixture>) => f.docs.get(features.Executions)?.items[0];

function backgroundFixture() {
  const f = fixture();
  Object.assign(f.task, { input: { jobId: "worker", text: "交付结果" }, state: { checkpoint: { phase: "start" } } });
  f.docs.set(features.BackgroundJobs, { items: [{ id: "worker", text: "交付结果", status: "running", conversationId: 8, createdAt: 0, result: null }] });
  f.docs.set(features.Executions, { items: [{ id: "background:worker", kind: "background", taskId: "worker", text: "交付结果", conversationId: 7, status: "queued", queuedAt: 1, startedAt: null, finishedAt: null, result: null, error: null }] });
  return f;
}
async function backgroundPhase(f: ReturnType<typeof fixture>, phase: "start" | "wait" | "report" | "abort") {
  const handler = phase === "abort" ? f.center.BackgroundTask.definition.abort : f.center.BackgroundTask.definition.phases[phase];
  assert.ok(handler);
  await handler(f.task as unknown as Parameters<typeof handler>[0], f.runtime as unknown as Parameters<typeof handler>[1], context);
}

test("recovered schedule delivery neither counts another occurrence nor creates another execution", async () => {
  const f = fixture();
  await schedulePhase(f, "deliver");
  await schedulePhase(f, "deliver");
  assert.equal(f.docs.get(features.Executions)?.items.length, 1);
  assert.equal(f.docs.get(features.Schedules)?.items[0].runs, 1);
  assert.equal(execution(f)?.status, "queued");
});

test("recovered schedule settlement keeps the first durable completion timestamp", async t => {
  const f = fixture();
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  await schedulePhase(f, "deliver");
  await schedulePhase(f, "wait");
  const settled = structuredClone(execution(f));
  now = 20000;
  await schedulePhase(f, "wait");
  assert.deepEqual(execution(f), settled, "重放同一已回答submission不得改写终态完成时间或结果");
});

test("unanswered schedule input records a failure and emits no successful completion", async () => {
  const f = fixture();
  const failed = { id: 11, type: "input", status: "unanswered", reason: "provider failed", answer: 0 };
  f.runtime.conversation = async () => ({ submit: async () => ({ id: 11, status: async () => failed, wait: async () => failed }) });
  await schedulePhase(f, "deliver");
  await schedulePhase(f, "wait");
  assert.equal(execution(f)?.status, "failed");
  assert.equal(execution(f)?.error, "provider failed");
  assert.equal(execution(f)?.result, null);
  assert.equal((f.events[0] as { failed: boolean }).failed, true);
});

test("schedule abort closes an admitted queued execution without producing a result", async () => {
  const f = fixture();
  await schedulePhase(f, "deliver");
  await schedulePhase(f, "abort");
  assert.equal(execution(f)?.status, "cancelled");
  assert.equal(typeof execution(f)?.finishedAt, "number");
  assert.equal(execution(f)?.result, null);
  assert.equal(f.events.length, 0);
});

test("a background task cancelled before start closes its already queued execution", async () => {
  const f = backgroundFixture();
  f.docs.get(features.BackgroundJobs)!.items[0].status = "cancelled";
  await backgroundPhase(f, "start");
  assert.equal(execution(f)?.status, "cancelled", "已取消的启动分支不能把新执行记录永久留在queued");
  assert.equal(typeof execution(f)?.finishedAt, "number");
  assert.equal(f.events.length, 0);
});

test("background abort closes queued execution without marking the job done", async () => {
  const f = backgroundFixture();
  await backgroundPhase(f, "abort");
  assert.equal(execution(f)?.status, "cancelled");
  assert.equal(f.docs.get(features.BackgroundJobs)!.items[0].status, "cancelled");
  assert.equal(f.events.length, 0);
});

test("failed background answer remains failed through result reporting", async () => {
  const f = backgroundFixture();
  Object.assign(f.task.state, { checkpoint: { phase: "wait", childId: 8 } });
  const failed = { id: 11, type: "input", status: "unanswered", reason: "model unavailable", answer: 0 };
  f.runtime.conversation = async () => ({ submit: async () => ({ id: 11, status: async () => failed, wait: async () => failed }) });
  await backgroundPhase(f, "wait");
  await backgroundPhase(f, "report");
  assert.equal(execution(f)?.status, "failed");
  assert.equal(execution(f)?.error, "model unavailable");
  assert.equal(f.docs.get(features.BackgroundJobs)!.items[0].status, "failed");
  assert.equal((f.events[0] as { failed: boolean }).failed, true);
});

test("a transient schedule result callback failure is retried before delivering completion", async () => {
  const f = fixture();
  let attempts = 0;
  f.center = features.createTaskCenter(async event => { f.events.push(event); }, async settled => {
    attempts += 1;
    assert.equal(settled.status, "done");
    if (attempts === 1) throw new Error("Daylight service temporarily unavailable");
  });
  await schedulePhase(f, "deliver");
  await schedulePhase(f, "wait");
  assert.equal(attempts, 2, "同一结果瞬态失败后应重试成功，不让任务永久faulted");
  assert.equal(execution(f)?.status, "done");
  assert.match(String(execution(f)?.result), /交付结果/);
  assert.equal(execution(f)?.error, null);
  assert.ok(!execution(f)?.deliveryError, "成功交付不遗留deliveryError");
  assert.equal(f.events.length, 1);
  assert.equal((f.events[0] as { failed: boolean }).failed, false);
});

test("a transient background result callback failure is retried and the job still completes", async () => {
  const f = backgroundFixture();
  Object.assign(f.task.state, { checkpoint: { phase: "wait", childId: 8 } });
  let attempts = 0;
  f.center = features.createTaskCenter(async event => { f.events.push(event); }, async settled => {
    attempts += 1;
    assert.equal(settled.status, "done");
    if (attempts === 1) throw new Error("Daylight service temporarily unavailable");
  });
  await backgroundPhase(f, "wait");
  await backgroundPhase(f, "report");
  assert.equal(attempts, 2);
  assert.equal(execution(f)?.status, "done");
  assert.ok(!execution(f)?.deliveryError);
  assert.equal(f.docs.get(features.BackgroundJobs)!.items[0].status, "done");
  assert.match(String(f.docs.get(features.BackgroundJobs)!.items[0].result), /交付结果/);
  assert.equal(f.events.length, 1);
  assert.equal((f.events[0] as { failed: boolean }).failed, false);
});
