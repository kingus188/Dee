import assert from "node:assert/strict";
import test from "node:test";
import type { DaylightPort, DaylightStatus, DaylightTask, ExecutionRun } from "@assistant/contracts";
import { applyExecutionResult, createDaylightExecution } from "../dist/application/daylight-execution.js";

const taskId = "22222222-2222-4222-8222-222222222222";
const run = (patch: Partial<ExecutionRun> = {}): ExecutionRun => ({
  id: "background:worker", kind: "background", taskId: "worker", conversationId: 7,
  text: "交付结果", status: "done", queuedAt: 1, startedAt: 2, finishedAt: 3,
  result: "已交付", error: null, daylightTaskId: taskId, ...patch,
});
function fixture(status: DaylightStatus | null = "doing") {
  const task: DaylightTask = { id: taskId, projectId: "11111111-1111-4111-8111-111111111111", title: "任务", description: "备注", status: status ?? "doing", priority: "medium", color: "mint", dueDate: null, tags: [], checklist: [], createdAt: 0, position: 0 };
  const moves: string[] = [], keys: string[] = [];
  const cache = new Map<string, unknown>();
  let serial = Promise.resolve();
  const port = {
    snapshot: async () => ({ projects: [], tasks: status === null ? [] : [task] }),
    moveTask: async (id: string, next: DaylightStatus) => { assert.equal(id, taskId); task.status = next; moves.push(next); },
  } as unknown as DaylightPort;
  const store = {
    async replayAction<T>(key: string, action: (port: DaylightPort) => Promise<T>): Promise<T> {
      keys.push(key);
      const result = serial.then(async () => {
        if (cache.has(key)) return structuredClone(cache.get(key)) as T;
        const value = await action(port);
        cache.set(key, structuredClone(value));
        return value;
      });
      serial = result.then(() => undefined, () => undefined);
      return result;
    },
  } as Parameters<typeof applyExecutionResult>[0];
  return { store, task, moves, keys };
}

test("execution result callback moves a successful linked task only to review and replays once", async () => {
  const f = fixture();
  await Promise.all([applyExecutionResult(f.store, run()), applyExecutionResult(f.store, run())]);
  assert.equal(f.task.status, "review", "执行完成仍需用户确认，不直接done");
  assert.deepEqual(f.moves, ["review"]);
  assert.deepEqual(new Set(f.keys), new Set(["execution-review:background:worker"]));
  f.task.status = "todo";
  await applyExecutionResult(f.store, run());
  assert.equal(f.task.status, "todo", "用户后续改动不被旧结果重放覆盖");
  assert.deepEqual(f.moves, ["review"]);
});

test("failed, cancelled, unfinished and unlinked execution callbacks do not mutate Daylight", async () => {
  const f = fixture();
  for (const status of ["queued", "running", "failed", "cancelled"] as const) await applyExecutionResult(f.store, run({ status }));
  await applyExecutionResult(f.store, run({ daylightTaskId: undefined }));
  assert.equal(f.task.status, "doing");
  assert.deepEqual(f.keys, []);
  assert.deepEqual(f.moves, []);
});

test("deleted linked tasks are ignored and already reviewed or done tasks do not regress", async () => {
  for (const status of [null, "review", "done"] as const) {
    const f = fixture(status);
    await applyExecutionResult(f.store, run());
    assert.deepEqual(f.moves, []);
    assert.equal(f.keys.length, 1);
    if (status !== null) assert.equal(f.task.status, status);
  }
});

test("starting execution for a missing Daylight task creates neither a conversation nor a worker", async () => {
  let workers = 0, opened = 0;
  const context = {
    modelConfigured: true,
    daylight: { getTask: async () => { throw new Error("任务已不存在，请刷新后重试。"); } },
    root: { commit: async () => { opened += 1; throw new Error("unexpected chat creation"); } },
  } as unknown as Parameters<typeof createDaylightExecution>[0];
  const conversations = { getConversation: async () => { throw new Error("unexpected conversation lookup"); } } as unknown as Parameters<typeof createDaylightExecution>[1];
  const management = { background: async () => { workers += 1; throw new Error("unexpected worker"); } } as unknown as Parameters<typeof createDaylightExecution>[2];
  const service = createDaylightExecution(context, conversations, management);
  await assert.rejects(service.start(taskId, { requestId: "missing-task" }), /任务已不存在/);
  assert.equal(workers, 0);
  assert.equal(opened, 0);
});
