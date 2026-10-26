import { randomUUID } from "node:crypto";
import { AssistantEntry, configure, defineTask } from "@earendil-works/pi-durable";
import type { ConversationId, Extension, Task, Tx } from "@earendil-works/pi-durable";
import { BackgroundJobs, Executions, Parents } from "./documents.js";
import type { BackgroundJob, BackgroundInput, BackgroundCheckpoint } from "./documents.js";
import { normalizeRequestId } from "./parameters.js";
import { cancelExecution, deliverExecution, finishExecution, normalizeDaylightTaskId, recordExecution } from "./executions.js";
import { detach, finishTask as finish } from "../results.js";
import type { NotifyEvent } from "./notifications.js";

import type { ExecutionRun } from "@assistant/contracts";
export function createBackground(notifyEvent: NotifyEvent, getExtension: () => Extension, onSettled: (run: ExecutionRun) => Promise<void> = async () => {}) {
  const BackgroundTask: Task<BackgroundInput, BackgroundCheckpoint, string | null, object> = defineTask<BackgroundInput, BackgroundCheckpoint, string | null, object>({
    name: "app.v3.background-agent", version: 1, initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, runtime, context) => {
        await runtime.commit(async tx => {
          const item = (await tx.doc(BackgroundJobs, runtime.conversationId)).items.find(it => it.id === task.input.jobId);
          if (!item || item.status === "cancelled") { await cancelExecution(tx, runtime.conversationId, "background:" + task.input.jobId); return finish("已取消"); }
          const existing = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
          let childId = existing?.id;
          if (childId === undefined) {
            const child = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
            childId = child.id;
            await configure(tx, childId, { extensions: { remove: [getExtension()] }, instructions: "你是后台子 Agent。只执行交给你的任务，简洁汇报结果，不要再委派后台子 Agent。" });
          }
          if (item) item.conversationId = childId;
          const run = await recordExecution(tx, runtime.conversationId, { id: "background:" + task.input.jobId, kind: "background", taskId: task.input.jobId, text: task.input.text, ...(item?.daylightTaskId ? { daylightTaskId: item.daylightTaskId } : {}) });
          run.workerConversationId = childId;
          (await tx.doc(Parents)).children[childId] = runtime.conversationId;
          return { status: "running", checkpoint: { phase: "wait", childId } };
        }, context);
      },
      wait: async (task, runtime, context) => {
        const child = await runtime.conversation(task.state.checkpoint.childId, context);
        const submission = await child!.submit({ type: "input", content: task.input.text, requestId: "background:" + task.input.jobId,
          entry: { kind: "app.background-input", data: { jobId: task.input.jobId } } }, context);
        await runtime.commit(async tx => {
          const run = (await tx.doc(Executions, runtime.conversationId)).items.find(it => it.id === "background:" + task.input.jobId);
          if (run && run.status === "queued") { run.submissionId = submission.id; run.status = "running"; run.startedAt = Date.now(); }
        }, context);
        const settled = await submission.wait(context);
        await runtime.commit(async tx => {
          const item = (await tx.doc(BackgroundJobs, runtime.conversationId)).items.find(it => it.id === task.input.jobId);
          if (!item || item.status === "cancelled") { await cancelExecution(tx, runtime.conversationId, "background:" + task.input.jobId); return finish("已取消"); }
          await finishExecution(tx, runtime.conversationId, "background:" + task.input.jobId, settled);
          const failed = settled.status !== "done" || settled.type !== "input";
          let answer = "";
          if (!failed) {
            const parts = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0]?.content ?? [];
            answer = (typeof parts === "string" ? parts : parts.filter(part => part.type === "text").map(part => part.text).join("")).slice(0, 4000);
          }
          const summary = failed ? "后台子 Agent 未完成：" + (("reason" in settled ? settled.reason : undefined) || settled.status) : answer || "任务已完成，没有文字结果";
          return { status: "running", checkpoint: { phase: "report", summary, failed } };
        }, context);
      },
      report: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        let cancelled = false;
        await runtime.commit(async tx => {
          const item = (await tx.doc(BackgroundJobs, runtime.conversationId)).items.find(it => it.id === task.input.jobId);
          cancelled = !item || item.status === "cancelled";
          if (cancelled) await cancelExecution(tx, runtime.conversationId, "background:" + task.input.jobId);
          return cancelled ? finish("已取消") : undefined;
        }, context);
        if (cancelled) return;
        let completed: ExecutionRun | undefined;
        await runtime.commit(async tx => { completed = detach((await tx.doc(Executions, runtime.conversationId)).items.find(run => run.id === "background:" + task.input.jobId)); }, context);
        if (completed) await deliverExecution(completed, onSettled, runtime.signal, work => runtime.commit(async tx => { await work(tx); return undefined; }, context));
        const parent = await runtime.conversation(runtime.conversationId, context);
        await parent!.submit({ type: "input", content: "[后台任务结果] " + task.input.text + "\n" + checkpoint.summary, requestId: "background-report:" + task.input.jobId, whenBusy: "followUp",
          entry: { kind: "app.background-report", data: { jobId: task.input.jobId } } }, context);
        await notifyEvent({ id: "background:" + task.input.jobId, type: "background", text: (checkpoint.failed ? "后台任务失败：" : "后台任务完成：") + task.input.text + "\n" + checkpoint.summary, failed: checkpoint.failed });
        await runtime.commit(async tx => {
          const item = (await tx.doc(BackgroundJobs, runtime.conversationId)).items.find(it => it.id === task.input.jobId);
          if (item && item.status !== "cancelled") { item.status = checkpoint.failed ? "failed" : "done"; item.result = checkpoint.summary; item.finishedAt = Date.now(); }
          return finish();
        }, context);
      },
    },
    abort: (task, runtime, context) => runtime.commit(async tx => {
      const item = (await tx.doc(BackgroundJobs, runtime.conversationId)).items.find(it => it.id === task.input.jobId);
      if (item && item.status === "running") { item.status = "cancelled"; item.finishedAt = Date.now(); }
      await cancelExecution(tx, runtime.conversationId, "background:" + task.input.jobId);
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context),
  });

  async function backgroundInTx(tx: Tx, conversationId: ConversationId, input: { text?: unknown; daylightTaskId?: unknown } | null, rawRequestId: unknown) {
    const requestId = normalizeRequestId(rawRequestId), doc = await tx.doc(BackgroundJobs, conversationId);
    if (requestId && Object.hasOwn(doc.applied ?? {}, requestId)) {
      const previous = doc.applied[requestId];
      return detach(doc.items.find(item => item.id === previous.id) ?? previous);
    }
    const text = String(input?.text ?? "").trim(), daylightTaskId = normalizeDaylightTaskId(input?.daylightTaskId);
    if (!text || text.length > 4000) throw new Error("后台任务说明必须是 1～4000 字");
    const item: BackgroundJob = { id: randomUUID(), text, status: "running", conversationId: null, createdAt: Date.now(), result: null, ...(daylightTaskId ? { daylightTaskId } : {}) };
    item.taskId = await tx.createTask(BackgroundTask, { jobId: item.id, text }, { ownership: { kind: "conversation" }, background: true });
    doc.items.push(item);
    await recordExecution(tx, conversationId, { id: "background:" + item.id, kind: "background", taskId: item.id, text, ...(daylightTaskId ? { daylightTaskId } : {}) });
    if (requestId) (doc.applied ??= {})[requestId] = item;
    return detach(item);
  }
  return { BackgroundTask, backgroundInTx };
}
