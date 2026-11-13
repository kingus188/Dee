import type { Goal, GoalCheckpoint, GoalStatus } from "@assistant/contracts";

type GoalSeed = Omit<Goal, "id" | "conversationId">;

export function goalText(value: unknown, label: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`委托${label}必须是 1～${max} 字`);
  return value.trim();
}

function bounded(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new Error(`委托运行上限必须是 1～${max} 的整数`);
  return value;
}

export function normalizeGoal(input: Record<string, unknown>, now = Date.now()): GoalSeed {
  return {
    text: goalText(input.text, "目标"), criteria: goalText(input.criteria, "验收标准"),
    status: "running", revision: 1, round: 0, usedTokens: 0, workers: [],
    maxRounds: bounded(input.maxRounds, 12, 24), deadlineAt: now + bounded(input.maxMinutes, 1440, 1440) * 60_000,
    createdAt: now, updatedAt: now, summary: "等待开始", wakeAt: null, updates: [], history: [],
  };
}

export function normalizeGoalCheckpoint(input: Record<string, unknown>, now: number, deadlineAt: number): GoalCheckpoint {
  const action = input.action;
  if (action !== "continue" && action !== "wait" && action !== "ask" && action !== "complete" && action !== "blocked") throw new Error("委托检查点动作无效");
  const summary = goalText(input.summary, "进展");
  if (!Array.isArray(input.evidence) || input.evidence.length > 10) throw new Error("委托依据必须是最多 10 条的数组");
  const evidence = input.evidence.map(item => goalText(item, "依据", 1000));
  if (action === "complete" && evidence.length === 0) throw new Error("委托交付必须提供可核对的依据");
  const nextAction = action === "continue" || action === "wait" ? goalText(input.nextAction, "下一步", 1000) : undefined;
  let wakeAt: number | undefined;
  if (action === "wait") {
    if (typeof input.wakeAt !== "number" || !Number.isSafeInteger(input.wakeAt) || input.wakeAt <= now || input.wakeAt >= deadlineAt) throw new Error("委托唤醒时间必须在现在之后、截止时间之前");
    wakeAt = input.wakeAt;
  }
  return { action, summary, evidence, ...(nextAction ? { nextAction } : {}), ...(wakeAt ? { wakeAt } : {}) };
}

// Checkpoints are validated before persistence; recovery may consume them after wakeAt.
export function advanceGoal<T extends GoalSeed>(goal: T, checkpoint: GoalCheckpoint, now = Date.now()): T {
  const statuses: Record<GoalCheckpoint["action"], GoalStatus> = {
    continue: "running", wait: "waiting_time", ask: "waiting_user", complete: "review", blocked: "blocked",
  };
  let status = statuses[checkpoint.action], summary = checkpoint.summary;
  if (status === "waiting_time" && checkpoint.wakeAt! <= now) status = "running";
  if (goal.deadlineAt <= now) { status = "blocked"; summary = "委托已到截止时间，请检查已有结果。"; }
  const previous = goal.history.at(-1);
  if (checkpoint.action === "continue" && previous?.action === "continue" && previous.summary === checkpoint.summary && JSON.stringify(previous.evidence) === JSON.stringify(checkpoint.evidence)) {
    status = "blocked"; summary = "连续两轮没有新进展，请补充信息或调整目标。";
  }
  if ((status === "running" || status === "waiting_time") && goal.round >= goal.maxRounds) {
    status = "blocked"; summary = "已达到委托轮次上限，请检查已有结果。";
  }
  return { ...goal, status, summary, updatedAt: now, wakeAt: status === "waiting_time" ? checkpoint.wakeAt! : null,
    history: [...goal.history, { ...checkpoint, round: goal.round, at: now, ...(goal.roundStartedAt !== undefined ? { startedAt: goal.roundStartedAt } : {}), ...(goal.workerConversationId !== undefined ? { workerConversationId: goal.workerConversationId } : {}), executionStatus: "succeeded" }] };
}

// Superseding a live round preserves its identity without claiming the worker has stopped.
export function closeGoalRound(goal: Goal, status: "cancelled" | "interrupted", now = Date.now()): void {
  if (goal.round < 1 || goal.history.some(item => item.round === goal.round)) return;
  goal.history.push({ action: "blocked", summary: status === "cancelled" ? "已请求取消本轮执行" : "本轮已被新的用户指示替代", evidence: [],
    round: goal.round, at: now, ...(goal.roundStartedAt === undefined ? {} : { startedAt: goal.roundStartedAt }),
    ...(goal.workerConversationId === undefined ? {} : { workerConversationId: goal.workerConversationId }), executionStatus: status });
}
