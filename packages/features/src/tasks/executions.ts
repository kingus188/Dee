import { setTimeout as sleep } from "node:timers/promises";
import { AssistantEntry } from "@earendil-works/pi-durable";
import type { ConversationId, SubmissionRecord, Tx } from "@earendil-works/pi-durable";
import type { ExecutionRun } from "@assistant/contracts";
import { Executions } from "./documents.js";

export function normalizeDaylightTaskId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error("无效的关联待办标识");
  return value;
}
export async function recordExecution(tx: Tx, conversationId: ConversationId, input: Pick<ExecutionRun, "id" | "kind" | "taskId" | "text"> & { daylightTaskId?: string }) {
  const doc = await tx.doc(Executions, conversationId);
  let run = doc.items.find(item => item.id === input.id);
  if (!run) {
    run = { ...input, conversationId, status: "queued", queuedAt: Date.now(), startedAt: null, finishedAt: null, result: null, error: null };
    doc.items.push(run);
  }
  return run;
}
export async function finishExecution(tx: Tx, conversationId: ConversationId, id: string, settled: SubmissionRecord) {
  const run = (await tx.doc(Executions, conversationId)).items.find(item => item.id === id);
  if (!run || run.status === "cancelled" || run.status === "done" || run.status === "failed") return;
  run.finishedAt = Date.now();
  if (settled.type === "input" && settled.status === "done") {
    const parts = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0]?.content ?? [];
    run.status = "done";
    run.answerId = settled.answer;
    run.result = (typeof parts === "string" ? parts : parts.filter(part => part.type === "text").map(part => part.text).join("")).slice(0, 12000) || "任务已完成，没有文字结果";
    run.error = null;
  } else {
    run.status = "failed";
    run.error = ("reason" in settled ? settled.reason : undefined) || settled.status;
  }
}
export async function deliverExecution(run: ExecutionRun, onSettled: (run: ExecutionRun) => Promise<void>, signal: AbortSignal, commit: (work: (tx: Tx) => Promise<void>) => Promise<unknown>) {
  let failure: string | undefined;
  for (const delay of [0, 100, 400]) {
    if (delay) await sleep(delay, undefined, { signal });
    try { await onSettled(run); failure = undefined; break; }
    catch (error) {
      if (signal.aborted) throw error;
      failure = error instanceof Error ? error.message.slice(0, 500) : "关联待办状态同步失败";
    }
  }
  if (failure) run.deliveryError = failure; else delete run.deliveryError;
  await commit(async tx => {
    const stored = (await tx.doc(Executions, run.conversationId as ConversationId)).items.find(item => item.id === run.id);
    if (stored) { if (failure) stored.deliveryError = failure; else delete stored.deliveryError; }
  });
}

export async function cancelExecution(tx: Tx, conversationId: ConversationId, id: string) {
  const run = (await tx.doc(Executions, conversationId)).items.find(item => item.id === id);
  if (run && (run.status === "queued" || run.status === "running")) {
    run.status = "cancelled";
    run.finishedAt = Date.now();
  }
}
