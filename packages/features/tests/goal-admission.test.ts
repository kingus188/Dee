import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { UsageDoc } from "@earendil-works/pi-durable";
import { GoalTask } from "../dist/goals/runner.js";
import { Goals, GoalWorker, GOAL_TOKEN_LIMIT } from "../dist/goals/documents.js";
import { normalizeGoal } from "../dist/goals/state.js";

for (const reason of ["cancelled", "revision", "tokens", "deadline", "checkpoint", "aborted"] as const) {
  test(`goal admission makes zero model submissions for an already ${reason} round`, async () => {
    const goal = { ...normalizeGoal({ text: "核对资料", criteria: "引用证据" }), id: "goal", conversationId: 1, round: 1, workers: [2], workerConversationId: 2 };
    const watched = structuredClone(goal);
    if (reason === "cancelled") watched.status = "cancelled";
    if (reason === "revision") watched.revision++;
    if (reason === "deadline") goal.deadlineAt = Date.now() - 1;
    const checkpoint = reason === "checkpoint" ? { action: "complete", summary: "已有交付", evidence: ["file:1"] } : null;
    const usage = { models: { fixture: { totalTokens: reason === "tokens" ? GOAL_TOKEN_LIMIT : 0 } } };
    const worker = { checkpoint };
    let submissions = 0, stopped = 0;
    const controller = new AbortController();
    if (reason === "aborted") controller.abort();
    const runtime = {
      signal: controller.signal,
      snapshot: async () => ({ items: [goal] }),
      watchDoc: async (token: unknown) => ({ value: token === Goals ? { items: [watched] } : token === UsageDoc ? usage : worker, start: () => {}, stop: async () => { stopped++; } }),
      conversation: async () => ({ submit: async () => { submissions++; return { wait: async () => {} }; }, abort: async () => {} }),
      commit: async (action: (tx: unknown) => Promise<unknown>) => action({ doc: async (token: unknown) => token === Goals ? { items: [goal] } : token === GoalWorker ? worker : usage }),
    };
    const run = () => GoalTask.definition.phases.run!({ input: { goalId: goal.id, revision: 1 }, state: { checkpoint: { phase: "run", workerId: 2, round: 1 } } } as never, runtime as never, context);
    if (reason === "aborted") await assert.rejects(run); else await run();
    assert.equal(submissions, 0);
    assert.equal(stopped, 3);
  });
}
