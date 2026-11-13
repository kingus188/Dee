import test from "node:test";
import assert from "node:assert/strict";
import { advanceGoal, normalizeGoal, normalizeGoalCheckpoint } from "../dist/goals/state.js";

const now = 100_000;
const input = { text: "整理项目资料", criteria: "列出结论、来源和缺失信息" };
const checkpoint = { action: "continue" as const, summary: "找到项目说明", evidence: ["notes/project.md:12"], nextAction: "核对排期" };

test("goal admission validates the objective and bounds its lifetime and work", () => {
  const goal = normalizeGoal(input, now);
  assert.equal(goal.maxRounds, 12);
  assert.ok(goal.deadlineAt > now);
  for (const invalid of [{ ...input, text: "" }, { ...input, criteria: "" }, { ...input, maxRounds: 25 }, { ...input, maxMinutes: Infinity }]) {
    assert.throws(() => normalizeGoal(invalid, now), /委托/);
  }
});

test("completion requires evidence and enters review rather than silently completing the user's task", () => {
  const goal = { ...normalizeGoal(input, now), round: 1 };
  assert.throws(() => normalizeGoalCheckpoint({ action: "complete", summary: "已完成", evidence: [] }, now, goal.deadlineAt), /依据/);
  const result = advanceGoal(goal, { action: "complete", summary: "结论已交付", evidence: ["notes/project.md:12"] }, now);
  assert.equal(result.status, "review");
  assert.equal(goal.status, "running");
  assert.equal(result.history.length, 1);
});

test("asking the user and timed waiting suspend work without consuming extra rounds", () => {
  const goal = { ...normalizeGoal(input, now), round: 1 };
  const ask = advanceGoal(goal, { action: "ask", summary: "请提供项目代号", evidence: [] }, now);
  assert.equal(ask.status, "waiting_user");
  const wait = advanceGoal(goal, { action: "wait", summary: "等待资料更新", evidence: [], nextAction: "重新读取资料", wakeAt: now + 500 }, now);
  assert.equal(wait.status, "waiting_time");
  assert.equal(wait.wakeAt, now + 500);
  assert.equal(wait.round, 1);
  assert.throws(() => normalizeGoalCheckpoint({ ...checkpoint, action: "wait", wakeAt: now - 1 }, now, goal.deadlineAt), /唤醒/);
});

test("a persisted wait checkpoint can be consumed after its wake time", () => {
  const goal = { ...normalizeGoal(input, now), round: 1 };
  const saved = normalizeGoalCheckpoint({ action: "wait", summary: "稍后复核", evidence: [], nextAction: "复核", wakeAt: now + 100 }, now, goal.deadlineAt);
  const result = advanceGoal(goal, saved, now + 200);
  assert.equal(result.status, "running");
  assert.equal(result.wakeAt, null);
});

test("round limits and repeated identical progress block an otherwise endless loop", () => {
  const goal = { ...normalizeGoal(input, now), round: 1 };
  const first = advanceGoal(goal, checkpoint, now);
  const repeated = advanceGoal({ ...first, round: 2 }, checkpoint, now + 1);
  assert.equal(repeated.status, "blocked");
  assert.match(repeated.summary, /没有新进展/);
  const limited = advanceGoal({ ...goal, round: goal.maxRounds }, checkpoint, now);
  assert.equal(limited.status, "blocked");
  assert.match(limited.summary, /轮次/);
});

test("superseding a goal preserves the interrupted round without reporting success", async () => {
  const { closeGoalRound } = await import("../dist/goals/state.js");
  const goal = { ...normalizeGoal(input, now), id: "g", conversationId: 7, round: 1, roundStartedAt: now, workerConversationId: 8 };
  closeGoalRound(goal, "interrupted", now + 1);
  closeGoalRound(goal, "interrupted", now + 2);
  assert.equal(goal.history.length, 1);
  assert.equal(goal.history[0].executionStatus, "interrupted");
  assert.equal(goal.history[0].startedAt, now);
  assert.equal(goal.history[0].workerConversationId, 8);
});
