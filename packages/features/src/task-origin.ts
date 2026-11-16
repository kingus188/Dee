import type { Tx } from "@earendil-works/pi-durable";
import type { IndependentTaskOrigin } from "@assistant/runtime";
import { Goals, GoalWorker } from "./goals/documents.js";
import { BackgroundJobs } from "./tasks/documents.js";

/** Validate existing host-admitted worker protocols; this grants neither user
 * provenance nor peer authority, and never infers approval from conversation history. */
export async function independentTaskAdmitted(tx: Tx, origin: IndependentTaskOrigin): Promise<boolean> {
  const task = await tx.task(origin.taskId);
  if (!task || task.conversationId !== origin.conversationId || task.state.status !== "running" || task.abortRequested) return false;
  const worker = await tx.conversation(origin.workerConversationId);
  if (worker?.owner?.taskId !== task.id || worker.owner.conversationId !== task.conversationId) return false;
  const input = task.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  let requestId: string;
  if (task.kind === "app.goal-loop") {
    const goal = (await tx.doc(Goals)).items.find(item => item.id === input.goalId);
    const state = await tx.doc(GoalWorker, origin.workerConversationId);
    if (!goal || goal.taskId !== task.id || goal.conversationId !== task.conversationId || goal.workerConversationId !== origin.workerConversationId
      || goal.status !== "running" || goal.deadlineAt <= Date.now() || goal.revision !== input.revision
      || state.goalId !== goal.id || state.revision !== goal.revision || state.round !== goal.round) return false;
    requestId = `goal:${goal.id}:${goal.revision}:${state.round}`;
  } else if (task.kind === "app.v3.background-agent") {
    const job = (await tx.doc(BackgroundJobs, origin.conversationId)).items.find(item => item.id === input.jobId);
    if (!job || job.taskId !== task.id || job.conversationId !== origin.workerConversationId || job.status !== "running") return false;
    requestId = `background:${job.id}`;
  } else return false;
  const submission = await tx.submissionByRequest(origin.workerConversationId, requestId);
  return submission?.type === "input" && "entry" in submission && submission.entry === origin.inputEntryId;
}
