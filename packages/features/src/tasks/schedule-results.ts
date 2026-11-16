import { setTimeout as sleep } from "node:timers/promises";
import { defineDoc, defineTask } from "@earendil-works/pi-durable";
import type { ConversationId, TaskId, Tx } from "@earendil-works/pi-durable";
import type { ExecutionRun, RunResultDelivery } from "@assistant/contracts";
import { Executions } from "./documents.js";
import { deliverExecution } from "./executions.js";
import { detach, finishTask } from "../results.js";
import type { NotifyEvent } from "./notifications.js";

export const ScheduleResults = defineDoc<{ jobs: Record<string, TaskId>; completed: Record<string, boolean>; rebuilds: Record<string, number>; errors: Record<string, string>; progress?: Record<string, RunResultDelivery> }>({
  kind: "app.schedule-results", version: 1, scope: "conversation", fork: "initial", history: "latest", initial: () => ({ jobs: {}, completed: {}, rebuilds: {}, errors: {}, progress: {} }),
});

async function progress(tx: Tx, conversationId: ConversationId, runId: string, value: RunResultDelivery) {
  const doc = await tx.doc(ScheduleResults, conversationId);
  (doc.progress ??= {})[runId] = { ...value, rebuilds: doc.rebuilds[runId] ?? 0 };
  if (value.error) doc.errors[runId] = value.error; else delete doc.errors[runId];
  return undefined;
}

// onSettled is the host's idempotent Daylight replayAction, not an arbitrary
// external send. notifyEvent durably enqueues with the stable result event ID.
export function createScheduleResults(notifyEvent: NotifyEvent, onSettled: (run: ExecutionRun) => Promise<"delivered" | "not_applicable" | "unknown" | void>) {
  const ScheduleResultTask = defineTask<{ runId: string }, { phase: "deliver"; attempts?: number } | { phase: "notify"; attempts?: number }, string | null, object>({
    name: "app.schedule-result", version: 1, initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, context) => {
        await runtime.commit(tx => progress(tx, runtime.conversationId, task.input.runId,
          { status: "running", phase: "deliver", attempts: task.state.checkpoint.attempts ?? 0 }), context);
        const run = detach((await runtime.snapshot(Executions, runtime.conversationId, context))?.items.find(item => item.id === task.input.runId));
        if (!run || (run.status !== "done" && run.status !== "failed")) throw new Error("计划执行结果尚不可交付");
        // An explicit unknown is a durable stop, not permission to resend.
        if (run.deliveryStatus !== "unknown" && run.deliveryStatus !== "delivered" && run.deliveryStatus !== "not_applicable") {
          await deliverExecution(run, onSettled, runtime.signal, work => runtime.commit(async tx => { await work(tx); }, context));
          if (run.deliveryError) {
            const attempts = (task.state.checkpoint.attempts ?? 0) + 1;
            await runtime.commit(async tx => {
              await progress(tx, runtime.conversationId, run.id, { status: attempts >= 3 ? "failed" : "running", phase: "deliver", attempts, error: run.deliveryError });
              return attempts >= 3 ? undefined : { status: "running", checkpoint: { phase: "deliver", attempts } };
            }, context);
            if (attempts >= 3) throw new Error(run.deliveryError);
            await sleep(1000 * attempts, undefined, { signal: runtime.signal });
            return;
          }
        }
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "notify" } }), context);
      },
      notify: async (task, runtime, context) => {
        await runtime.commit(tx => progress(tx, runtime.conversationId, task.input.runId,
          { status: "running", phase: "notify", attempts: task.state.checkpoint.attempts ?? 0 }), context);
        const run = (await runtime.snapshot(Executions, runtime.conversationId, context))?.items.find(item => item.id === task.input.runId);
        if (!run || (run.status !== "done" && run.status !== "failed")) throw new Error("计划执行结果不存在");
        const failed = run.status === "failed";
        let notification: RunResultDelivery["notification"] = "unknown";
        try { const receipt = await notifyEvent({ sources: [{ source: `conv:${runtime.conversationId}` }], id: run.id + ":result", type: "schedule", text: (failed ? "计划任务失败：" : "计划任务本轮执行结束：") + run.text, failed }); notification = receipt?.status ?? "unknown"; }
        catch (error) {
          if (runtime.signal.aborted) throw error;
          const attempts = (task.state.checkpoint.attempts ?? 0) + 1;
          const message = error instanceof Error ? error.message.slice(0, 500) : "通知入队失败";
          await runtime.commit(async tx => {
            await progress(tx, runtime.conversationId, run.id, { status: attempts >= 3 ? "failed" : "running", phase: "notify", attempts, error: message });
            return attempts >= 3 ? undefined : { status: "running", checkpoint: { phase: "notify", attempts } };
          }, context);
          if (attempts >= 3) throw error;
          await sleep(1000 * attempts, undefined, { signal: runtime.signal });
          return;
        }
        await runtime.commit(async tx => {
          const results = await tx.doc(ScheduleResults, runtime.conversationId);
          results.completed[run.id] = true;
          await progress(tx, runtime.conversationId, run.id, { status: "completed", phase: "notify", attempts: task.state.checkpoint.attempts ?? 0, notification });
          return finishTask();
        }, context);
      },
    },
    abort: (task, runtime, context) => runtime.commit(async tx => {
      await progress(tx, runtime.conversationId, task.input.runId, { status: "failed", phase: task.state.checkpoint.phase, error: "结果处理已停止，未确认完成" });
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context),
  });
  async function enqueueResult(tx: Tx, conversationId: ConversationId, runId: string) {
    const doc = await tx.doc(ScheduleResults, conversationId);
    if (doc.completed[runId]) return;
    if (Object.hasOwn(doc.jobs, runId)) {
      const existing = await tx.task(doc.jobs[runId]);
      if (existing && existing.state.status !== "terminal") return;
      if ((doc.rebuilds[runId] ?? 0) >= 2) {
        await progress(tx, conversationId, runId, { ...doc.progress?.[runId], status: "failed", error: "结果交付已达到恢复次数上限，请检查执行记录与通知状态。" }); return;
      }
      doc.rebuilds[runId] = (doc.rebuilds[runId] ?? 0) + 1;
    }
    await progress(tx, conversationId, runId, { status: "pending", phase: "deliver", attempts: 0 });
    doc.jobs[runId] = await tx.createTask(ScheduleResultTask, { runId }, { ownership: { kind: "conversation" }, background: true });
  }
  async function recoverResults(tx: Tx, conversationId: ConversationId) {
    const doc = await tx.doc(ScheduleResults, conversationId);
    for (const id of Object.keys(doc.jobs)) if (!doc.completed[id]) await enqueueResult(tx, conversationId, id);
  }
  return { ScheduleResultTask, enqueueResult, recoverResults };
}
