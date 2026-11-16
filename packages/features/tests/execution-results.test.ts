import test from "node:test";
import assert from "node:assert/strict";
import * as features from "@assistant/features";
import { ScheduleResults, createScheduleResults } from "../dist/tasks/schedule-results.js";
import { ConversationBusy } from "@earendil-works/pi-durable";
import type { Tx } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

type RecordDoc = { items: Record<string, unknown>[]; applied?: Record<string, unknown> };
function fixture() {
  const docs = new Map<unknown, RecordDoc>();
  docs.set(features.Schedules, { items: [{ id: "plan", text: "交付结果", nextAt: 1000, everyMinutes: 0, runs: 0, status: "active", revision: 1, createdAt: 0, daylightTaskId: "todo-id" }] });
  docs.set(ScheduleResults, { items: [], jobs: {}, completed: {}, rebuilds: {}, errors: {} } as RecordDoc);
  const events: unknown[] = [];
  const task = { id: 5, input: { scheduleId: "plan", text: "交付结果", at: 1000, revision: 1 }, state: { checkpoint: { phase: "deliver" } } };
  const tx = {
    doc: async (token: unknown) => { if (!docs.has(token)) docs.set(token, { items: [] }); return docs.get(token)!; },
    entry: async () => ({ model: [{ content: [{ type: "text", text: "已完成，并附交付结果" }] }] }),
    createTask: async () => 99,
    submissionByRequest: async () => undefined,
    task: async () => ({ state: { status: "running" } }),
  } as unknown as Tx;
  const submission = { id: 11, status: async () => ({ id: 11, type: "input", status: "done", answer: 22 }), wait: async () => ({ id: 11, type: "input", status: "done", answer: 22 }) };
  const runtime = {
    conversationId: 7, signal: new AbortController().signal,
    conversation: async () => ({ submit: async () => submission }),
    commit: async (action: (tx: Tx) => Promise<unknown>) => { const next = await action(tx) as { checkpoint?: object } | undefined; if (next?.checkpoint) task.state.checkpoint = next.checkpoint as { phase: string }; },
  };
  const center = features.createTaskCenter(async event => { events.push(event); });
  return { docs, events, task, runtime, center, tx };
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
  if (phase === "wait") {
    const run = f.docs.get(features.Executions)?.items[0];
    if (run?.status === "done" || run?.status === "failed") {
      const task = { input: { runId: run.id }, state: { checkpoint: { phase: "deliver" } } };
      const runtime = { ...f.runtime, snapshot: async () => f.docs.get(features.Executions) };
      await center.ScheduleResultTask.definition.phases.deliver!(task as never, runtime as never, context);
      await center.ScheduleResultTask.definition.phases.notify!(task as never, runtime as never, context);
    }
  }
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
  if (phase === "report") {
    const run = execution(f);
    if (run?.status === "done" || run?.status === "failed") {
      const runtime = { ...f.runtime, snapshot: async () => f.docs.get(features.Executions) };
      await f.center.ScheduleResultTask.definition.phases.deliver!({ input: { runId: run.id }, state: { checkpoint: { phase: "deliver" } } } as never, runtime as never, context);
    }
  }
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

test("a void callback never proves delivery to a linked task", async () => {
  const f = fixture();
  await schedulePhase(f, "deliver"); await schedulePhase(f, "wait");
  assert.equal(execution(f)?.deliveryStatus, "unknown");
});
test("an explicit skipped callback does not claim a linked task transition", async () => {
  const f = fixture();
  f.center = features.createTaskCenter(async () => {}, async () => "not_applicable");
  await schedulePhase(f, "deliver"); await schedulePhase(f, "wait");
  assert.equal(execution(f)?.deliveryStatus, "not_applicable");
});

for (const status of ["queued", "running"]) {
  test(`recurring schedule coalesces an overlapping ${status} occurrence without model admission`, async t => {
    const f = fixture();
    t.mock.method(Date, "now", () => 1000);
    const schedule = f.docs.get(features.Schedules)!.items[0];
    schedule.everyMinutes = 1;
    const prior = { id: "schedule:plan:0", kind: "schedule", taskId: "plan", status };
    f.docs.set(features.Executions, { items: [prior] });
    let submissions = 0;
    const conversation = f.runtime.conversation;
    f.runtime.conversation = async () => { submissions++; return conversation(); };
    await schedulePhase(f, "deliver");
    assert.equal(submissions, 0);
    assert.deepEqual(f.docs.get(features.Executions)!.items, [prior]);
    assert.equal(schedule.runs, 0);
    assert.equal(schedule.nextAt, 61000);
    assert.equal(schedule.revision, 2);
    assert.equal(schedule.jobId, 99);
    await schedulePhase(f, "deliver");
    assert.equal(schedule.revision, 2, "replaying the skipped occurrence must not advance again");
    assert.equal(submissions, 0);
  });
}

test("coalescing does not suppress one-shot reminders, unrelated schedules or settled occurrences", async () => {
  for (const variant of ["one-shot", "unrelated", "done", "failed", "cancelled"]) {
    const f = fixture();
    const schedule = f.docs.get(features.Schedules)!.items[0];
    if (variant !== "one-shot") schedule.everyMinutes = 1;
    f.docs.set(features.Executions, { items: [{ id: "older", kind: "schedule", taskId: variant === "unrelated" ? "other-plan" : "plan", status: ["one-shot", "unrelated"].includes(variant) ? "running" : variant }] });
    await schedulePhase(f, "deliver");
    assert.equal(f.docs.get(features.Executions)!.items.length, 2, variant);
    assert.equal(schedule.runs, 1, variant);
  }
});

test("cancelled recurring schedule neither admits a model call nor schedules another tick", async () => {
  const f = fixture();
  const schedule = f.docs.get(features.Schedules)!.items[0];
  Object.assign(schedule, { everyMinutes: 1, status: "cancelled", revision: 2 });
  f.runtime.conversation = async () => { throw new Error("cancelled schedule must not submit"); };
  await schedulePhase(f, "deliver");
  assert.equal(schedule.jobId, undefined);
  assert.equal(schedule.runs, 0);
  assert.equal(f.docs.get(features.Executions)!.items.length, 0);
});

for (const status of ["queued", "placed", "done", "unanswered"] as const) {
  test(`overlap recovery follows the actual ${status} submission, not a terminal observer`, async t => {
    const f = fixture();
    t.mock.method(Date, "now", () => 1000);
    f.docs.get(features.Schedules)!.items[0].everyMinutes = 1;
    const prior: Record<string, unknown> = { id: "schedule:plan:0", kind: "schedule", taskId: "plan", status: "running", runtimeTaskId: 123 };
    f.docs.set(features.Executions, { items: [prior] });
    // Deliberately omit submissionId, as after admission succeeds but its receipt is lost.
    f.tx.task = async () => ({ state: { status: "terminal" } }) as never;
    f.tx.submissionByRequest = async (conversationId, requestId) => {
      assert.equal(conversationId, 7);
      assert.equal(requestId, prior.id);
      return { id: 44, conversationId: 7, requestId, type: "input", status, entry: 21, answer: 22, reason: "interrupted" } as never;
    };
    await schedulePhase(f, "deliver");
    const terminal = status === "done" || status === "unanswered";
    assert.equal(f.docs.get(features.Executions)!.items.length, terminal ? 2 : 1);
    assert.equal(prior.submissionId, 44);
    assert.equal(prior.status, status === "done" ? "done" : status === "unanswered" ? "failed" : "running");
    assert.equal(f.docs.get(features.Schedules)!.items[0].runs, terminal ? 1 : 0);
  });
}

test("unknown prior submission remains blocked with a visible explanation and no new admission", async () => {
  const f = fixture();
  f.docs.get(features.Schedules)!.items[0].everyMinutes = 1;
  const prior: Record<string, unknown> = { id: "schedule:plan:0", kind: "schedule", taskId: "plan", status: "queued" };
  f.docs.set(features.Executions, { items: [prior] });
  f.runtime.conversation = async () => { throw new Error("unknown must not submit"); };
  await schedulePhase(f, "deliver");
  assert.equal(prior.status, "queued");
  assert.match(String(prior.error), /无法核实/);
  assert.equal(f.docs.get(features.Executions)!.items.length, 1);
});

test("recovered terminal submission atomically schedules durable result delivery without resubmitting it", async t => {
  const f = fixture();
  t.mock.method(Date, "now", () => 1000);
  f.docs.get(features.Schedules)!.items[0].everyMinutes = 1;
  const prior: Record<string, unknown> = { id: "schedule:plan:0", conversationId: 7, kind: "schedule", taskId: "plan", text: "旧轮结果", status: "running", runtimeTaskId: 123, daylightTaskId: "todo-id", deliveryStatus: "pending" };
  f.docs.set(features.Executions, { items: [prior] });
  f.tx.task = async () => ({ state: { status: "terminal" } }) as never;
  f.tx.submissionByRequest = async () => ({ id: 44, conversationId: 7, requestId: prior.id, type: "input", status: "done", entry: 21, answer: 22 }) as never;
  const jobs: { name: string; input: unknown }[] = [];
  f.tx.createTask = async (definition, input) => { jobs.push({ name: definition.definition.name, input }); return 99 as never; };
  const delivered = new Set<string>(), events = new Set<string>();
  let callbackCount = 0;
  f.center = features.createTaskCenter(async event => { events.add(event.id); }, async run => { callbackCount++; delivered.add(run.id); return "delivered"; });
  await schedulePhase(f, "deliver");
  await schedulePhase(f, "deliver");
  assert.equal(jobs.filter(job => job.name === "app.schedule-result").length, 1);
  assert.equal(prior.status, "done");
  const resultTask = { input: { runId: prior.id }, state: { checkpoint: { phase: "deliver" } } };
  const runtime = { ...f.runtime, snapshot: async () => f.docs.get(features.Executions), commit: async (action: (tx: Tx) => Promise<unknown>) => action(f.tx) };
  // A fresh task-center represents reopening the registry after a process restart.
  const restarted = features.createTaskCenter(async event => { events.add(event.id); }, async run => { callbackCount++; delivered.add(run.id); return "delivered"; });
  for (const center of [f.center, restarted]) {
    const deliver = center.ScheduleResultTask.definition.phases.deliver!;
    await deliver(resultTask as never, runtime as never, context);
    const notify = center.ScheduleResultTask.definition.phases.notify!;
    await notify(resultTask as never, runtime as never, context);
  }
  assert.equal(callbackCount, 1, "durable delivered receipt prevents a second Daylight callback");
  assert.deepEqual([...delivered], [prior.id]);
  assert.deepEqual([...events], [prior.id + ":result"], "notification enqueue deduplicates its stable ID after replay");
});

test("durable result recovery preserves explicit unknown delivery without replaying the callback", async () => {
  const f = fixture();
  const run = { id: "schedule:plan:0", conversationId: 7, kind: "schedule", taskId: "plan", text: "结果", status: "done", daylightTaskId: "todo-id", deliveryStatus: "unknown" };
  f.docs.set(features.Executions, { items: [run] });
  let calls = 0;
  const center = features.createTaskCenter(async () => {}, async () => { calls++; return "delivered"; });
  const runtime = { ...f.runtime, snapshot: async () => f.docs.get(features.Executions) };
  await center.ScheduleResultTask.definition.phases.deliver!({ input: { runId: run.id }, state: { checkpoint: { phase: "deliver" } } } as never, runtime as never, context);
  assert.equal(calls, 0);
  assert.equal(run.deliveryStatus, "unknown");
});

test("faulted result jobs have a bounded persisted readmission budget", async () => {
  const f = fixture();
  const results = createScheduleResults(async () => {}, async () => "delivered");
  let created = 0;
  f.tx.createTask = async () => (++created) as never;
  f.tx.task = async () => ({ state: { status: "terminal", outcome: { status: "faulted" } } }) as never;
  for (let i = 0; i < 10; i++) await results.enqueueResult(f.tx, 7 as never, "schedule:plan:0");
  assert.equal(created, 3, "initial job plus two bounded readmissions");
  const journal = f.docs.get(ScheduleResults) as unknown as { errors: Record<string, string> };
  assert.match(journal.errors["schedule:plan:0"], /恢复次数上限/);
});

test("busy recurring input is rejected atomically instead of joining the followUp queue", async t => {
  const f = fixture();
  t.mock.method(Date, "now", () => 1000);
  const schedule = f.docs.get(features.Schedules)!.items[0];
  schedule.everyMinutes = 1;
  let attempts = 0;
  f.runtime.conversation = (async () => ({ submit: async (input: { whenBusy: string }) => {
    attempts++;
    assert.equal(input.whenBusy, "reject");
    throw new ConversationBusy(7 as never);
  } })) as unknown as typeof f.runtime.conversation;
  await schedulePhase(f, "deliver");
  assert.equal(execution(f)?.status, "failed");
  assert.match(String(execution(f)?.error), /未入队/);
  assert.equal(execution(f)?.deliveryStatus, "not_applicable");
  assert.equal(schedule.runs, 0);
  assert.equal(schedule.nextAt, 61000);
  await schedulePhase(f, "deliver");
  assert.equal(attempts, 1, "replaying the skipped tick must not resubmit");
  assert.equal(f.events.length, 0);
});

test("one-shot deadline schedule keeps followUp admission rather than idle skipping", async () => {
  const f = fixture();
  const original = f.runtime.conversation;
  f.runtime.conversation = (async () => {
    const parent = await original();
    return { submit: async (input: { whenBusy: string }) => { assert.equal(input.whenBusy, "followUp"); return parent.submit(); } };
  }) as unknown as typeof f.runtime.conversation;
  await schedulePhase(f, "deliver");
  assert.equal(execution(f)?.submissionId, 11);
});

test("recovered recurring admission preserves the existing receipt even when the conversation is now busy", async () => {
  const f = fixture();
  const schedule = f.docs.get(features.Schedules)!.items[0];
  schedule.everyMinutes = 1;
  const parent = await f.runtime.conversation();
  await schedulePhase(f, "deliver");
  const prior = structuredClone(execution(f));
  f.runtime.conversation = (async () => ({ submit: async (input: { requestId: string; whenBusy: string }) => {
    assert.equal(input.requestId, "schedule:plan:1000");
    assert.equal(input.whenBusy, "reject");
    // SDK request-id deduplication precedes busy rejection: replay returns the receipt.
    return parent.submit();
  } })) as unknown as typeof f.runtime.conversation;
  await schedulePhase(f, "deliver");
  assert.deepEqual(execution(f), prior);
  assert.equal(schedule.runs, 1);
  assert.equal(execution(f)?.status, "queued");
});

test("background settlement reads its answer before creating a result-delivery task", async () => {
  const f = backgroundFixture();
  Object.assign(f.task.state, { checkpoint: { phase: "wait", childId: 8 } });
  let wroteTable = false;
  const entry = f.tx.entry;
  f.tx.entry = (async (...args: unknown[]) => { assert.equal(wroteTable, false, "Tx.entry cannot follow createTask"); return (entry as (...args: unknown[]) => unknown)(...args); }) as typeof f.tx.entry;
  f.tx.createTask = async () => { wroteTable = true; return 99 as never; };
  await backgroundPhase(f, "wait");
  assert.equal(wroteTable, true);
  assert.equal(execution(f)?.status, "done");
  assert.equal(f.task.state.checkpoint.phase, "report");
});

test("multiple recovered schedule results finish all table reads before admitting delivery jobs", async () => {
  const f = fixture();
  f.docs.get(features.Schedules)!.items[0].everyMinutes = 1;
  f.docs.set(features.Executions, { items: ["older-a", "older-b"].map(id => ({ id, kind: "schedule", taskId: "plan", status: "running" })) });
  let wroteTable = false, reads = 0;
  f.tx.submissionByRequest = async (_owner, id) => { assert.equal(wroteTable, false); reads++; return { id: reads, type: "input", status: "done", requestId: id, answer: 22 } as never; };
  const entry = f.tx.entry;
  f.tx.entry = (async (...args: unknown[]) => { assert.equal(wroteTable, false); return (entry as (...args: unknown[]) => unknown)(...args); }) as typeof f.tx.entry;
  f.tx.createTask = async () => { wroteTable = true; return 99 as never; };
  await schedulePhase(f, "deliver");
  assert.equal(reads, 2);
  assert.equal(f.docs.get(features.Executions)!.items.filter(run => run.status === "done").length, 2);
});
