import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineExtension } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModelCatalog, openRuntime } from "@assistant/runtime";
import { Executions } from "@assistant/features";
import { createScheduleResults, ScheduleResults } from "../dist/tasks/schedule-results.js";

for (const failures of [1, 3]) test(`one-shot result resumes after ${failures} failed notifications without a schedule tick or repeated Daylight`, { timeout: 20000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-schedule-result-"));
  const model = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, () => { throw new Error("result delivery must not call model"); });
  let callbacks = 0, attempts = 0;
  const errors: unknown[] = [];
  const accepted = new Set<string>();
  const results = createScheduleResults(async event => { attempts++; accepted.add(event.id); if (attempts <= failures) throw new Error("receipt lost after enqueue"); return { status: "queued" }; }, async () => { callbacks++; return "delivered"; });
  const open = () => openRuntime({ onReport: error => errors.push(error), dataDir, models: model.models, agentModel: model.agentModel, extensions: [defineExtension({ name: "schedule-results-test", tasks: [results.ScheduleResultTask] })] }, context);
  let runtime = await open();
  try {
    const conversation = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: model.agentModel } }, context);
    const id = "schedule:plan:0";
    await conversation.commit(async tx => {
      (await tx.doc(Executions, conversation.id)).items.push({ id, conversationId: conversation.id, kind: "schedule", taskId: "plan", text: "结果", status: "done", queuedAt: 1, startedAt: 2, finishedAt: 3, result: "实际结果", error: null, daylightTaskId: "todo", deliveryStatus: "pending" });
      await results.enqueueResult(tx, conversation.id, id);
    }, context);
    for (let i = 0; i < 1000; i++) {
      const journal = await runtime.harness.snapshot(ScheduleResults, conversation.id, context);
      if (attempts === failures && journal?.progress?.[id]?.attempts === failures % 3 && (journal.rebuilds[id] ?? 0) === Math.floor(failures / 3)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(attempts, failures);
    await runtime.harness.close(context);
    runtime = await open();
    const restored = await runtime.harness.conversation(conversation.id, context);
    assert.ok(restored);
    const jobs = await runtime.harness.snapshot(ScheduleResults, conversation.id, context);
    await runtime.harness.waitForTask(jobs!.jobs[id], context);
    const journal = (await runtime.harness.snapshot(ScheduleResults, conversation.id, context))!;
    assert.equal(journal.completed[id], true);
    assert.equal(journal.progress?.[id].status, "completed");
    assert.equal(journal.progress?.[id].notification, "queued");
    assert.equal(journal.progress?.[id].attempts, failures % 3);
    assert.equal(journal.rebuilds[id] ?? 0, Math.floor(failures / 3));
    const jobId = journal.jobs[id];
    await restored.commit(tx => results.enqueueResult(tx, conversation.id, id), context);
    assert.deepEqual(errors, []);
    assert.equal(callbacks, 1);
    assert.equal(attempts, failures + 1);
    await restored.commit(tx => results.recoverResults(tx, conversation.id), context);
    const afterReplay = (await runtime.harness.snapshot(ScheduleResults, conversation.id, context))!;
    assert.equal(afterReplay.jobs[id], jobId);
    assert.equal(afterReplay.rebuilds[id] ?? 0, Math.floor(failures / 3));
    assert.deepEqual([...accepted], [id + ":result"]);
  } finally { await runtime.harness.close(context); await rm(dataDir, { recursive: true, force: true }); }
});


test("result progress distinguishes policy skip, legacy unknown and exhausted enqueue", async () => {
  for (const receipt of ["skipped", "legacy", "failure"] as const) {
    const results = createScheduleResults(async () => {
      if (receipt === "failure") throw new Error("outbox unavailable");
      if (receipt === "skipped") return { status: "skipped" };
    }, async () => "delivered");
    const journal = { jobs: {}, completed: {}, rebuilds: {}, errors: {} } as { jobs: Record<string, never>; completed: Record<string, boolean>; rebuilds: Record<string, number>; errors: Record<string, string>; progress?: Record<string, import("@assistant/contracts").RunResultDelivery> };
    if (receipt === "failure") journal.rebuilds.run = 2;
    const run = { id: "run", status: "done", text: "result" };
    const runtime = {
      conversationId: 1, signal: new AbortController().signal,
      snapshot: async () => ({ items: [run] }),
      commit: async (work: (tx: unknown) => unknown) => work({ doc: async () => journal }),
    };
    const task = { input: { runId: "run" }, state: { checkpoint: { phase: "notify", attempts: 2 } } };
    const action = () => results.ScheduleResultTask.definition.phases.notify!(task as never, runtime as never, context);
    if (receipt === "failure") {
      await assert.rejects(action(), /outbox unavailable/);
      assert.equal(journal.progress?.run.status, "failed");
      assert.equal(journal.progress?.run.attempts, 3);
      assert.equal(journal.completed.run, undefined);
    } else {
      await action();
      assert.equal(journal.progress?.run.status, "completed");
      assert.equal(journal.progress?.run.notification, receipt === "skipped" ? "skipped" : "unknown");
    }
  }
});

for (const phase of ["deliver", "notify"] as const) test(`persisted exhausted ${phase} checkpoint cannot send again after failure receipt but before terminal commit`, async () => {
  let calls = 0;
  const results = createScheduleResults(async () => { calls++; throw new Error("unavailable"); }, async () => { calls++; throw new Error("unavailable"); });
  const journal = { jobs: {}, completed: {}, rebuilds: { run: 2 }, errors: {} };
  const run = { id: "run", status: "done", text: "result", deliveryStatus: "failed" };
  const task = { input: { runId: "run" }, state: { checkpoint: { phase, attempts: 2 } } };
  const runtime = {
    conversationId: 1, signal: new AbortController().signal,
    snapshot: async () => ({ items: [run] }),
    commit: async (work: (tx: unknown) => Promise<unknown>) => {
      const next = await work({ doc: async (token: unknown) => token === Executions ? { items: [run] } : journal }) as { checkpoint?: typeof task.state.checkpoint } | undefined;
      if (next?.checkpoint) task.state.checkpoint = next.checkpoint;
    },
  };
  const invoke = () => results.ScheduleResultTask.definition.phases[phase]!(task as never, runtime as never, context);
  await assert.rejects(invoke, /unavailable/);
  assert.equal(task.state.checkpoint.attempts, 3);
  const beforeRestart = calls;
  await assert.rejects(invoke, /上限/);
  assert.equal(calls, beforeRestart, "restart at persisted running checkpoint must not renew exhausted budget");
  Object.assign(journal, { completed: { run: true }, progress: { run: { status: "completed" } } });
  await invoke();
  assert.equal(calls, beforeRestart);
  assert.equal(Reflect.get(journal, "progress").run.status, "completed", "an older exhausted task cannot overwrite durable success");
});

test("legacy background compensation is durably admitted once across concurrent recovery and restart", { timeout: 20000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-background-result-"));
  const model = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, () => { throw new Error("no model during compensation"); });
  let calls = 0, notifications = 0;
  const transitions = new Set<string>(), errors: unknown[] = [];
  const results = createScheduleResults(async () => { notifications++; return { status: "queued" }; }, async run => {
    calls++;
    if (calls <= 3) throw new Error("Daylight unavailable");
    transitions.add(run.id);
    return "delivered";
  });
  const open = () => openRuntime({ onReport: error => errors.push(error), dataDir, models: model.models, agentModel: model.agentModel, extensions: [defineExtension({ name: "result-recovery-test", tasks: [results.ScheduleResultTask] })] }, context);
  let runtime = await open();
  try {
    const owner = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: model.agentModel } }, context);
    const id = "background:legacy";
    await owner.commit(async tx => {
      (await tx.doc(Executions, owner.id)).items.push({ id, conversationId: owner.id, kind: "background", taskId: "legacy", text: "旧后台结果", status: "done", queuedAt: 1, startedAt: 2, finishedAt: 3, result: "真实结果", error: null, daylightTaskId: "todo", deliveryStatus: "failed", deliveryError: "previous failure" });
    }, context);
    await runtime.harness.close(context);
    runtime = await open();
    const restored = (await runtime.harness.conversation(owner.id, context))!;
    await Promise.all(Array.from({ length: 5 }, () => restored.commit(async tx => { await results.recoverResults(tx, owner.id); }, context)));
    for (let i = 0; i < 500; i++) {
      const state = await runtime.harness.snapshot(ScheduleResults, owner.id, context);
      if (state?.progress?.[id]?.attempts === 1) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(calls, 3);
    const before = (await runtime.harness.snapshot(ScheduleResults, owner.id, context))!;
    assert.equal(Object.keys(before.jobs).length, 1);
    await runtime.harness.close(context);
    runtime = await open();
    const reopened = (await runtime.harness.conversation(owner.id, context))!;
    await reopened.commit(async tx => { await results.recoverResults(tx, owner.id); }, context);
    await runtime.harness.waitForTask(before.jobs[id], context);
    const after = (await runtime.harness.snapshot(ScheduleResults, owner.id, context))!;
    assert.equal(after.jobs[id], before.jobs[id]);
    assert.equal(after.completed[id], true);
    assert.equal(after.progress?.[id]?.phase, "deliver");
    assert.equal(after.progress?.[id]?.attempts, 1);
    assert.equal(calls, 4);
    assert.deepEqual([...transitions], [id]);
    assert.equal(notifications, 0, "background keeps its own report/notification path");
    assert.deepEqual(errors, []);
  } finally { await runtime.harness.close(context); await rm(dataDir, { recursive: true, force: true }); }
});

test("startup compensation cannot bypass exhausted budgets, completed receipts or unknown outcomes", async () => {
  const results = createScheduleResults(async () => { throw new Error("no notification during admission"); }, async () => { throw new Error("no external call during admission"); });
  const runs = ["exhausted", "completed", "unknown"].map(id => ({ id, kind: "background", status: "done", daylightTaskId: "todo", deliveryError: "legacy failure", deliveryStatus: id === "unknown" ? "unknown" : "failed" }));
  const journal = { jobs: { exhausted: 1, completed: 2 }, completed: { completed: true }, rebuilds: { exhausted: 2 }, errors: {}, progress: {} };
  let creates = 0;
  const tx = { doc: async (token: unknown) => token === Executions ? { items: runs } : journal,
    task: async () => ({ state: { status: "terminal" } }), createTask: async () => { creates++; return 3; } };
  for (let i = 0; i < 10; i++) await results.recoverResults(tx as never, 1 as never);
  assert.equal(creates, 0);
  assert.equal(journal.rebuilds.exhausted, 2);
  assert.equal(journal.completed.completed, true);
  assert.equal(Object.hasOwn(journal.jobs, "unknown"), false);
});

test("mixed new and faulted legacy compensation reads previous tasks before any task creation", async () => {
  const results = createScheduleResults(async () => {}, async () => "delivered");
  const runs = ["new", "faulted"].map(id => ({ id, kind: "background", status: "done", daylightTaskId: "todo", deliveryError: "old failure", deliveryStatus: "failed" }));
  const journal = { jobs: { faulted: 7 }, completed: {}, rebuilds: {}, errors: {}, progress: {} };
  let writes = 0, reads = 0;
  const tx = { doc: async (token: unknown) => token === Executions ? { items: runs } : journal,
    task: async () => { assert.equal(writes, 0, "Tx.task cannot follow createTask"); reads++; return { state: { status: "terminal" } }; },
    createTask: async () => { writes++; return 100 + writes; } };
  await results.recoverResults(tx as never, 1 as never);
  assert.equal(reads, 1);
  assert.equal(writes, 2);
});
