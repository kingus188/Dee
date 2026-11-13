import { defineDoc } from "@earendil-works/pi-durable";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { UnifiedRun } from "@assistant/contracts";
import { BackgroundJobs, Delegations, Executions, Goals } from "@assistant/features";
import { HttpError } from "../errors.js";
import { projectUnifiedRuns, type RuntimeObservation } from "./unified-runs.js";

export type RunReview = { revision: string; decision: "accepted" | "rejected"; note?: string; reviewedAt: number };
export const RunReviews = defineDoc<{ items: Record<string, RunReview> }>({
  kind: "app.run-reviews", version: 1, scope: "conversation", fork: "initial", history: "latest", initial: () => ({ items: {} }),
});
export function withRunReviews(runs: UnifiedRun[], reviews: Readonly<Record<string, RunReview>>): UnifiedRun[] {
  return runs.map(run => {
    const review = reviews[run.id];
    return review?.revision === run.revision ? { ...run, review: { status: review.decision, reviewedAt: review.reviewedAt, ...(review.note ? { note: review.note } : {}) } } : run;
  });
}
export async function reviewRunInTx(tx: Tx, conversationId: ConversationId, body: Record<string, unknown>): Promise<UnifiedRun> {
  if (typeof body.runId !== "string" || !body.runId || body.runId.length > 300 || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision)
    || (body.decision !== "accepted" && body.decision !== "rejected") || (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 4000))) throw new HttpError(400, "执行验收参数无效");
  const executions = await tx.doc(Executions, conversationId), background = await tx.doc(BackgroundJobs, conversationId),
    delegations = await tx.doc(Delegations, conversationId), goals = (await tx.doc(Goals)).items.filter(goal => goal.conversationId === conversationId);
  const runtime = new Map<number, RuntimeObservation>();
  const taskIds = [...executions.items.map(item => item.runtimeTaskId), ...background.items.map(item => item.taskId), ...delegations.items.map(item => item.runtimeTaskId), ...goals.map(item => item.taskId)];
  for (const id of new Set(taskIds)) if (id !== undefined) {
    const task = await tx.task(id as import("@earendil-works/pi-durable").TaskId);
    if (task) runtime.set(id, { terminal: task.state.status === "terminal", aborted: task.state.status === "terminal" && task.state.outcome.status === "aborted" });
  }
  const run = projectUnifiedRuns({ conversationId, executions: executions.items, background: background.items, delegations: delegations.items, goals, runtime }).find(item => item.id === body.runId);
  if (!run) throw new HttpError(404, "执行记录不存在");
  if (run.source === "goal") throw new HttpError(409, "委托成果请通过委托验收操作确认");
  if (run.revision !== body.revision) throw new HttpError(409, "执行结果已变化，请重新读取后验收");
  if (!["succeeded", "review"].includes(run.status) || !run.result) throw new HttpError(409, "执行尚无可验收结果");
  const reviews = await tx.doc(RunReviews, conversationId);
  const previous = reviews.items[run.id], note = typeof body.note === "string" ? body.note.trim() : undefined;
  if (previous?.revision === run.revision && (previous.decision !== body.decision || (previous.note ?? "") !== (note ?? ""))) {
    throw new HttpError(409, "该执行结果已验收，请重新读取最新状态");
  }
  if (!previous || previous.revision !== run.revision) {
    reviews.items[run.id] = { revision: run.revision, decision: body.decision, reviewedAt: Date.now(), ...(note ? { note } : {}) };
  }
  return withRunReviews([run], reviews.items)[0];
}
