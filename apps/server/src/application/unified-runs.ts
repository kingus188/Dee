import { createHash } from "node:crypto";
import type { BackgroundJob, ExecutionRun, Goal, UnifiedRun } from "@assistant/contracts";
import type { Delegation } from "@assistant/features";

export type RuntimeObservation = { terminal: boolean; aborted?: boolean };
type Input = {
  conversationId: number;
  executions: readonly ExecutionRun[];
  goals: readonly Goal[];
  delegations: readonly Delegation[];
  background: readonly BackgroundJob[];
  runtime?: ReadonlyMap<number, RuntimeObservation>;
};
type RunInput = Omit<UnifiedRun, "revision" | "review"> & { review?: UnifiedRun["review"] };
function record(input: RunInput): UnifiedRun {
  const { review, ...result } = input;
  return { ...result, revision: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    review: review ?? { status: ["succeeded", "review"].includes(input.status) && input.result ? "pending" : "not_applicable" } };
}
function cancellation(cancelled: boolean, taskId: number | undefined, runtime: Input["runtime"]): UnifiedRun["cancellation"] {
  if (!cancelled) return "not_requested";
  if (taskId === undefined) return "unknown";
  return runtime?.get(taskId)?.terminal ? "confirmed" : "requested";
}

/** Read model over existing durable records. Legacy missing metadata stays unknown, never invented. */
export function projectUnifiedRuns(input: Input): UnifiedRun[] {
  const runs: UnifiedRun[] = input.executions.map(run => {
    const job = run.kind === "background" ? input.background.find(item => item.id === run.taskId) : undefined;
    const cancelled = run.status === "cancelled" || job?.status === "cancelled";
    const runtimeTaskId = run.runtimeTaskId ?? job?.taskId;
    const runtime = runtimeTaskId === undefined ? undefined : input.runtime?.get(runtimeTaskId);
    const interrupted = ["queued", "running"].includes(run.status) && runtime?.terminal && !cancelled;
    return record({ id: run.id, taskId: run.taskId, conversationId: run.conversationId, source: run.kind,
      ...(run.workerConversationId === undefined ? {} : { workerConversationId: run.workerConversationId }),
      status: interrupted ? "interrupted" : cancelled && ["queued", "running"].includes(run.status) ? "cancelled" : run.status === "done" ? "succeeded" : run.status,
      text: run.text, startedAt: run.startedAt, finishedAt: run.finishedAt,
      result: run.result, error: interrupted ? (run.kind === "schedule" ? "等待结果的计划任务已结束，实际模型执行状态未确认" : "执行进程已结束，未记录完整结果") : run.error, evidence: [],
      cancellation: run.kind === "schedule" && cancelled ? (runtime?.terminal ? "unknown" : "requested") : cancellation(cancelled, runtimeTaskId, input.runtime),
      delivery: run.daylightTaskId ? { status: run.deliveryError ? "failed" : run.deliveryStatus ?? "unknown", detail: `关联待办 ${run.daylightTaskId} 的结果同步，不代表外部消息送达${run.deliveryError ? `：${run.deliveryError}` : ""}` } : { status: "not_applicable" },
    });
  });
  for (const item of input.delegations) {
    const runtime = item.runtimeTaskId === undefined ? undefined : input.runtime?.get(item.runtimeTaskId);
    const interrupted = item.status === "running" && runtime?.terminal;
    runs.push(record({ id: item.runId ?? `delegate:legacy:${input.conversationId}:${item.conversationId}`, taskId: String(item.conversationId),
      conversationId: input.conversationId, workerConversationId: item.conversationId, source: "delegate",
      status: interrupted ? "interrupted" : item.status === "done" ? "succeeded" : item.status,
      text: item.task, startedAt: item.startedAt ?? null, finishedAt: item.finishedAt ?? null,
      result: item.result ?? null, error: interrupted ? "委派执行已中断，未记录完整结果" : item.error ?? null, evidence: [],
      cancellation: runtime?.aborted ? "confirmed" : "not_requested", delivery: { status: "not_applicable" },
    }));
  }
  for (const goal of input.goals.filter(item => item.conversationId === input.conversationId)) {
    for (const round of goal.history) {
      const last = round.round === goal.round;
      runs.push(record({ id: `goal:${goal.id}:${round.round}`, taskId: goal.id, conversationId: goal.conversationId, source: "goal",
        ...(round.workerConversationId === undefined ? {} : { workerConversationId: round.workerConversationId }),
        status: round.executionStatus && round.executionStatus !== "succeeded" ? round.executionStatus : round.action === "complete" ? "review" : "succeeded",
        text: `${goal.text} · 第 ${round.round} 轮`, startedAt: round.startedAt ?? null, finishedAt: round.executionStatus === "cancelled" || round.executionStatus === "interrupted" ? null : round.at,
        result: round.summary, error: round.error ?? null, evidence: [...round.evidence], cancellation: round.executionStatus === "cancelled" ? cancellation(true, last ? goal.taskId : undefined, input.runtime) : round.executionStatus === "interrupted" ? "unknown" : "not_requested",
        delivery: { status: "not_applicable" },
        review: last && goal.status === "completed" && round.action === "complete" ? { status: "accepted", reviewedAt: goal.updatedAt } : { status: round.action === "complete" ? "pending" : "not_applicable" },
      }));
    }
    if (!goal.history.some(item => item.round === goal.round)) {
      const cancelled = goal.status === "cancelled", runtime = goal.taskId === undefined ? undefined : input.runtime?.get(goal.taskId);
      const status: UnifiedRun["status"] = cancelled ? "cancelled" : goal.status === "blocked" ? "failed" : goal.status === "review" ? "review" : goal.status === "completed" ? "succeeded" : goal.status === "running" ? (runtime?.terminal ? "interrupted" : goal.round === 0 ? "queued" : "running") : "waiting";
      runs.push(record({ id: `goal:${goal.id}:${goal.round}`, taskId: goal.id, conversationId: goal.conversationId, source: "goal",
        ...(goal.workerConversationId === undefined ? {} : { workerConversationId: goal.workerConversationId }),
        status, text: `${goal.text} · 第 ${goal.round} 轮`, startedAt: goal.roundStartedAt ?? null,
        finishedAt: ["cancelled", "failed", "succeeded", "review"].includes(status) ? goal.updatedAt : null,
        result: ["review", "succeeded"].includes(status) ? goal.summary : null, error: status === "failed" ? goal.summary : null,
        evidence: [], cancellation: cancellation(cancelled, goal.taskId, input.runtime), delivery: { status: "not_applicable" },
      }));
    }
  }
  return runs.sort((a, b) => (b.startedAt ?? b.finishedAt ?? 0) - (a.startedAt ?? a.finishedAt ?? 0) || a.id.localeCompare(b.id));
}
