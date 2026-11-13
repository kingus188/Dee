import test from "node:test";
import assert from "node:assert/strict";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { Goal } from "@assistant/contracts";
import { createGoalInTx } from "../dist/goals/index.js";
import { normalizeGoal } from "../dist/goals/state.js";

const input = { text: "核对资料", criteria: "提供依据" };
function fixture(status: Goal["status"], count: number) {
  const doc = { items: Array.from({ length: count }, (_, index) => ({ id: String(index), conversationId: 7, ...normalizeGoal(input), status })), applied: {} as Record<string, string> };
  let created = 0;
  const tx = { doc: async () => doc, createTask: async () => ++created } as unknown as Tx;
  return { doc, tx, created: () => created };
}
for (const status of ["completed", "cancelled"] as const) test(`${status} history does not consume unfinished goal capacity and remains replayable`, async () => {
  const f = fixture(status, 200);
  f.doc.applied["create:old"] = "0";
  const goal = await createGoalInTx(f.tx, 7 as ConversationId, input, "new");
  assert.equal(f.doc.items.length, 201);
  assert.equal((await createGoalInTx(f.tx, 7 as ConversationId, input, "new")).id, goal.id);
  assert.equal((await createGoalInTx(f.tx, 7 as ConversationId, input, "old")).id, "0");
  assert.equal(f.created(), 1);
});
test("unfinished and concurrently running limits are still enforced", async () => {
  for (const status of ["waiting_user", "blocked", "review"] as const) {
    const f = fixture(status, 200);
    await assert.rejects(createGoalInTx(f.tx, 7 as ConversationId, input, "new"), /未结束委托/);
    assert.equal(f.created(), 0);
  }
  for (const status of ["running", "waiting_time"] as const) {
    const f = fixture(status, 3);
    await assert.rejects(createGoalInTx(f.tx, 7 as ConversationId, input, "new"), /同时执行/);
    assert.equal(f.created(), 0);
  }
});
