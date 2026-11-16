import test from "node:test";
import assert from "node:assert/strict";
import type { Tx } from "@earendil-works/pi-durable";
import { independentTaskAdmitted, Goals } from "@assistant/features";
import type { IndependentTaskOrigin } from "@assistant/runtime";

const origin = { taskId: 9, conversationId: 1, workerConversationId: 2, inputEntryId: 5 } as IndependentTaskOrigin;
function fixture() {
  const task = { id: 9, conversationId: 1, kind: "app.v3.background-agent", input: { jobId: "job" }, state: { status: "running" }, abortRequested: false };
  const job = { id: "job", taskId: 9, conversationId: 2, status: "running" };
  const tx = { task: async () => task, conversation: async () => ({ owner: { taskId: 9, conversationId: 1 } }), doc: async () => ({ items: [job] }), submissionByRequest: async () => ({ type: "input", entry: 5 }) } as unknown as Tx;
  return { task, job, tx };
}
test("independent background admission requires live matching task, worker, record and submission", async () => {
  const f = fixture(); assert.equal(await independentTaskAdmitted(f.tx, origin), true);
  f.job.taskId = 10; assert.equal(await independentTaskAdmitted(f.tx, origin), false); f.job.taskId = 9;
  f.job.status = "cancelled"; assert.equal(await independentTaskAdmitted(f.tx, origin), false); f.job.status = "running";
  f.task.abortRequested = true; assert.equal(await independentTaskAdmitted(f.tx, origin), false);
  assert.equal(await independentTaskAdmitted({ ...f.tx, task: async () => undefined } as Tx, origin), false);
  assert.equal(await independentTaskAdmitted({ ...fixture().tx, doc: async () => ({ items: [] }) } as unknown as Tx, origin), false);
  assert.equal(await independentTaskAdmitted({ ...fixture().tx, submissionByRequest: async () => undefined } as Tx, origin), false);
});

test("goal admission is tied to its current task, revision, round, worker and live state", async () => {
  const task = { id: 9, conversationId: 1, kind: "app.goal-loop", input: { goalId: "goal", revision: 2 }, state: { status: "running" }, abortRequested: false };
  const goal = { id: "goal", taskId: 9, conversationId: 1, workerConversationId: 2, status: "running", deadlineAt: Date.now() + 60000, revision: 2, round: 3 };
  const worker = { goalId: "goal", revision: 2, round: 3 };
  const tx = { task: async () => task, conversation: async () => ({ owner: { taskId: 9, conversationId: 1 } }),
    doc: async (token: unknown) => token === Goals ? { items: [goal] } : worker,
    submissionByRequest: async (_id: unknown, request: string) => request === "goal:goal:2:3" ? { type: "input", entry: 5 } : undefined,
  } as unknown as Tx;
  assert.equal(await independentTaskAdmitted(tx, origin), true);
  for (const [field, value] of [["revision", 3], ["round", 4], ["taskId", 10], ["workerConversationId", 3], ["status", "cancelled"], ["deadlineAt", 0]] as const) {
    const previous = goal[field]; Object.assign(goal, { [field]: value });
    assert.equal(await independentTaskAdmitted(tx, origin), false, field);
    Object.assign(goal, { [field]: previous });
  }
  worker.round = 4; assert.equal(await independentTaskAdmitted(tx, origin), false);
});
