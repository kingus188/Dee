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

test("schedule result persists across SDK shutdown during notification retry without replaying Daylight", { timeout: 20000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-schedule-result-"));
  const model = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, () => { throw new Error("result delivery must not call model"); });
  let callbacks = 0, attempts = 0;
  const errors: unknown[] = [];
  const accepted = new Set<string>();
  const results = createScheduleResults(async event => { attempts++; accepted.add(event.id); if (attempts === 1) throw new Error("receipt lost after enqueue"); return { status: "queued" }; }, async () => { callbacks++; return "delivered"; });
  const open = () => openRuntime({ onReport: error => errors.push(error), dataDir, models: model.models, agentModel: model.agentModel, extensions: [defineExtension({ name: "schedule-results-test", tasks: [results.ScheduleResultTask] })] }, context);
  let runtime = await open();
  try {
    const conversation = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: model.agentModel } }, context);
    const id = "schedule:plan:0";
    await conversation.commit(async tx => {
      (await tx.doc(Executions, conversation.id)).items.push({ id, conversationId: conversation.id, kind: "schedule", taskId: "plan", text: "结果", status: "done", queuedAt: 1, startedAt: 2, finishedAt: 3, result: "实际结果", error: null, daylightTaskId: "todo", deliveryStatus: "pending" });
      await results.enqueueResult(tx, conversation.id, id);
    }, context);
    for (let i = 0; i < 200 && attempts === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(attempts, 1);
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
    assert.equal(journal.progress?.[id].attempts, 1);
    await restored.commit(tx => results.enqueueResult(tx, conversation.id, id), context);
    assert.deepEqual(errors, []);
    assert.equal(callbacks, 1);
    assert.equal(attempts, 2);
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
