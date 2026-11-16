import test from "node:test";
import assert from "node:assert/strict";
import { Executions, ScheduleResults } from "@assistant/features";
import { createManagement } from "../dist/application/management.js";

test("repeated and concurrent management refreshes never retry failed Daylight delivery or mutate durable state", async () => {
  let writes = 0;
  const runs = ["schedule", "background"].map(kind => ({ id: kind + ":old", kind, taskId: "old", conversationId: 1, text: "result", status: "done", daylightTaskId: "todo", deliveryStatus: "failed", deliveryError: "database unavailable", result: "evidence", queuedAt: 1, startedAt: 1, finishedAt: 2, error: null }));
  const journal = { jobs: {}, completed: {}, rebuilds: { "schedule:old": 2 }, errors: { "schedule:old": "budget exhausted" }, progress: { "schedule:old": { status: "failed", phase: "deliver", attempts: 3, rebuilds: 2 } } };
  const context = { harness: { snapshot: async (token: unknown) => token === Executions ? { items: runs } : token === ScheduleResults ? journal : undefined, getTask: async () => undefined },
    daylight: { replayAction: async () => { writes++; throw new Error("read must not write"); } } };
  const conversation = { id: 1, commit: async () => { writes++; throw new Error("read must not commit"); } };
  const management = createManagement(context as never, {} as never);
  const before = structuredClone({ runs, journal });
  const views = await Promise.all(Array.from({ length: 10 }, () => management.get(conversation as never)));
  assert.equal(writes, 0);
  assert.deepEqual({ runs, journal }, before);
  for (const view of views) {
    assert.equal(view.executions?.length, 2);
    assert.equal(view.executions?.[1].deliveryError, "database unavailable");
    assert.equal(view.runs?.find(run => run.id === "schedule:old")?.resultDelivery?.status, "failed");
  }
});
