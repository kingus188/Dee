import { setTimeout as sleep } from "node:timers/promises";
import { defineDoc, defineTask } from "@earendil-works/pi-durable";
import type { ConversationId, TaskId, Tx } from "@earendil-works/pi-durable";
import type { ExecutionRun, RunResultDelivery } from "@assistant/contracts";
import { Executions } from "./documents.js";
import { deliverExecution } from "./executions.js";
import { detach, finishTask } from "../results.js";
import type { NotifyEvent } from "./notifications.js";

// Keep the persisted document/task identity for pre-existing schedule jobs.
export const ScheduleResults = defineDoc<{ jobs: Record<string, TaskId>; completed: Record<string, boolean>; rebuilds: Record<string, number>; errors: Record<string, string>; progress?: Record<string, RunResultDelivery> }>({
  kind: "app.schedule-results", version: 1, scope: "conversation", fork: "initial", history: "latest", initial: () => ({ jobs: {}, completed: {}, rebuilds: {}, errors: {}, progress: {} }),
});

async function progress(tx: Tx, conversationId: ConversationId, runId: string, value: RunResultDelivery) {
  const doc = await tx.doc(ScheduleResults, conversationId);
  (doc.progress ??= {})[runId] = { ...value, rebuilds: doc.rebuilds[runId] ?? 0 };
  if (value.error) doc.errors[runId] = value.error; else delete doc.errors[runId];
  return undefined;
}

// This bounds persisted failure rounds, not I/O calls: a crash before recording
// a receipt can replay the same idempotent operation. Reuse the two-rebuild budget
// inside the durable task as well as
// tick-driven recovery. One-shot schedules have no next tick to restart them.
async function retryResult(tx: Tx, conversationId: ConversationId, runId: string, phase: "deliver" | "notify", attempts: number, error: string) {
  const doc = await tx.doc(ScheduleResults, conversationId);
  if (attempts >= 3 && (doc.rebuilds[runId] ?? 0) < 2) {
    doc.rebuilds[runId] = (doc.rebuilds[runId] ?? 0) + 1;
    attempts = 0;
  }
  const exhausted = attempts >= 3;
  await progress(tx, conversationId, runId, { status: exhausted ? "failed" : "running", phase, attempts, error });
  return { attempts, exhausted };
}

async function stopExhaustedResult(tx: Tx, conversationId: ConversationId, runId: string, phase: "deliver" | "notify"): Promise<string | undefined> {
  const doc = await tx.doc(ScheduleResults, conversationId);
  if (doc.completed[runId]) return undefined;
  const error = (phase === "deliver" ? "结果交付" : "通知入队") + "已达到恢复次数上限";
  await progress(tx, conversationId, runId, { status: "failed", phase, attempts: 3, error: doc.errors[runId] ?? error });
  return error;
}

// onSettled is the host's idempotent Daylight replayAction, not an arbitrary
// external send. notifyEvent durably enqueues with the stable result event ID.
export function createExecutionResults(notifyEvent: NotifyEvent, onSettled: (run: ExecutionRun) => Promise<"delivered" | "not_applicable" | "unknown" | void>) {
  const ScheduleResultTask = defineTask<{ runId: string }, { phase: "deliver"; attempts?: number } | { phase: "notify"; attempts?: number }, string | null, object>({
    name: "app.schedule-result", version: 1, initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, context) => {
        if ((task.state.checkpoint.attempts ?? 0) >= 3) {
          let error: string | undefined;
          await runtime.commit(async tx => {
            error = await stopExhaustedResult(tx, runtime.conversationId, task.input.runId, "deliver");
            if (!error) return finishTask();
          }, context);
          if (error) throw new Error(error);
          return;
        }
        await runtime.commit(tx => progress(tx, runtime.conversationId, task.input.runId,
          { status: "running", phase: "deliver", attempts: task.state.checkpoint.attempts ?? 0 }), context);
        const run = detach((await runtime.snapshot(Executions, runtime.conversationId, context))?.items.find(item => item.id === task.input.runId));
        if (!run || (run.status !== "done" && run.status !== "failed")) throw new Error("计划执行结果尚不可交付");
        // An explicit unknown is a durable stop, not permission to resend.
        if (run.deliveryStatus !== "unknown" && run.deliveryStatus !== "delivered" && run.deliveryStatus !== "not_applicable") {
          await deliverExecution(run, onSettled, runtime.signal, work => runtime.commit(async tx => { await work(tx); }, context));
          if (run.deliveryError) {
            let retry = { attempts: (task.state.checkpoint.attempts ?? 0) + 1, exhausted: false };
            await runtime.commit(async tx => {
              retry = await retryResult(tx, runtime.conversationId, run.id, "deliver", retry.attempts, run.deliveryError!);
              return { status: "running", checkpoint: { phase: "deliver", attempts: retry.attempts } };
            }, context);
            if (retry.exhausted) throw new Error(run.deliveryError);
            await sleep(1000 * Math.max(1, retry.attempts), undefined, { signal: runtime.signal });
            return;
          }
        }
        if (run.kind !== "schedule") {
          await runtime.commit(async tx => {
            (await tx.doc(ScheduleResults, runtime.conversationId)).completed[run.id] = true;
            await progress(tx, runtime.conversationId, run.id, { status: "completed", phase: "deliver", attempts: task.state.checkpoint.attempts ?? 0 });
            return finishTask();
          }, context);
          return;
        }
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "notify" } }), context);
      },
      notify: async (task, runtime, context) => {
        if ((task.state.checkpoint.attempts ?? 0) >= 3) {
          let error: string | undefined;
          await runtime.commit(async tx => {
            error = await stopExhaustedResult(tx, runtime.conversationId, task.input.runId, "notify");
            if (!error) return finishTask();
          }, context);
          if (error) throw new Error(error);
          return;
        }
        await runtime.commit(tx => progress(tx, runtime.conversationId, task.input.runId,
          { status: "running", phase: "notify", attempts: task.state.checkpoint.attempts ?? 0 }), context);
        const run = (await runtime.snapshot(Executions, runtime.conversationId, context))?.items.find(item => item.id === task.input.runId);
        if (!run || (run.status !== "done" && run.status !== "failed")) throw new Error("计划执行结果不存在");
        const failed = run.status === "failed";
        let notification: RunResultDelivery["notification"] = "unknown";
        try { const receipt = await notifyEvent({ sources: [{ source: `conv:${runtime.conversationId}` }], id: run.id + ":result", type: "schedule", text: (failed ? "计划任务失败：" : "计划任务本轮执行结束：") + run.text, failed }); notification = receipt?.status ?? "unknown"; }
        catch (error) {
          if (runtime.signal.aborted) throw error;
          let retry = { attempts: (task.state.checkpoint.attempts ?? 0) + 1, exhausted: false };
          const message = error instanceof Error ? error.message.slice(0, 500) : "通知入队失败";
          await runtime.commit(async tx => {
            retry = await retryResult(tx, runtime.conversationId, run.id, "notify", retry.attempts, message);
            return { status: "running", checkpoint: { phase: "notify", attempts: retry.attempts } };
          }, context);
          if (retry.exhausted) throw error;
          await sleep(1000 * Math.max(1, retry.attempts), undefined, { signal: runtime.signal });
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
  async function enqueueResults(tx: Tx, conversationId: ConversationId, runIds: readonly string[]) {
    const doc = await tx.doc(ScheduleResults, conversationId);
    const pending: string[] = [];
    // Tx.task is a table read: inspect every previous job before createTask
    // performs the first table write in this transaction.
    for (const runId of new Set(runIds)) {
      if (doc.completed[runId]) continue;
      if (Object.hasOwn(doc.jobs, runId)) {
        const existing = await tx.task(doc.jobs[runId]);
        if (existing && existing.state.status !== "terminal") continue;
        if ((doc.rebuilds[runId] ?? 0) >= 2) {
          await progress(tx, conversationId, runId, { ...doc.progress?.[runId], status: "failed", error: "结果交付已达到恢复次数上限，请检查执行记录与通知状态。" }); continue;
        }
        doc.rebuilds[runId] = (doc.rebuilds[runId] ?? 0) + 1;
      }
      pending.push(runId);
    }
    for (const runId of pending) {
      await progress(tx, conversationId, runId, { status: "pending", phase: "deliver", attempts: 0 });
      doc.jobs[runId] = await tx.createTask(ScheduleResultTask, { runId }, { ownership: { kind: "conversation" }, background: true });
    }
  }
  async function enqueueResult(tx: Tx, conversationId: ConversationId, runId: string) {
    await enqueueResults(tx, conversationId, [runId]);
  }
  async function recoverResults(tx: Tx, conversationId: ConversationId) {
    const doc = await tx.doc(ScheduleResults, conversationId);
    const runs = (await tx.doc(Executions, conversationId)).items;
    const pending = runs.filter(run => run.deliveryStatus !== "unknown" &&
      ((!!run.daylightTaskId && !!run.deliveryError && run.status === "done") || Object.hasOwn(doc.jobs, run.id)));
    await enqueueResults(tx, conversationId, pending.map(run => run.id));
  }
  return { ScheduleResultTask, enqueueResult, enqueueResults, recoverResults };
}
