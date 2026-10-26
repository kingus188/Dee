import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { defineTask } from "@earendil-works/pi-durable";
import type { ConversationId, Task, Tx } from "@earendil-works/pi-durable";
import { Executions, Schedules } from "./documents.js";
import type { Schedule, ScheduleInput, ScheduleCheckpoint } from "./documents.js";
import { nextOccurrence, normalizeSchedule, scheduleMatches, normalizeRequestId } from "./parameters.js";
import { nextCalendarOccurrence } from "./calendar.js";
import { cancelExecution, deliverExecution, finishExecution, normalizeDaylightTaskId, recordExecution } from "./executions.js";
import { detach, finishTask as finish } from "../results.js";
import type { NotifyEvent } from "./notifications.js";

const runId = (input: ScheduleInput) => `schedule:${input.scheduleId}:${input.at}`;
const submission = (input: ScheduleInput) => ({ type: "input" as const, content: "[计划任务] " + input.text, requestId: runId(input), whenBusy: "followUp" as const,
  entry: { kind: "app.schedule-input", data: { scheduleId: input.scheduleId, at: input.at } } });

import type { ExecutionRun } from "@assistant/contracts";
export function createSchedules(notifyEvent: NotifyEvent, onSettled: (run: ExecutionRun) => Promise<void> = async () => {}) {
  const ScheduleTask: Task<ScheduleInput, ScheduleCheckpoint, string | null, object> = defineTask<ScheduleInput, ScheduleCheckpoint, string | null, object>({
    name: "app.v3.schedule", version: 1,
    initial: () => ({ phase: "sleep" }),
    phases: {
      sleep: async (task, runtime, context) => {
        while (Date.now() < task.input.at) await sleep(Math.min(60000, task.input.at - Date.now()), undefined, { signal: runtime.signal });
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "fire" } }), context);
      },
      fire: async (task, runtime, context) => {
        await runtime.commit(async tx => {
          const item = (await tx.doc(Schedules, runtime.conversationId)).items.find(it => it.id === task.input.scheduleId);
          return scheduleMatches(item, task.input) ? { status: "running", checkpoint: { phase: "deliver" } } : finish("已跳过过期任务");
        }, context);
      },
      deliver: async (task, runtime, context) => {
        let current = false;
        await runtime.commit(async tx => {
          const item = (await tx.doc(Schedules, runtime.conversationId)).items.find(it => it.id === task.input.scheduleId);
          current = scheduleMatches(item, task.input);
          // A recovered delivery may already have advanced the next scheduled occurrence.
          const admitted = (await tx.doc(Executions, runtime.conversationId)).items.find(run => run.id === runId(task.input));
          if (admitted?.submissionId !== undefined) { current = true; return; }
          if (!current) return finish("已取消或已更新");
          await recordExecution(tx, runtime.conversationId, { id: runId(task.input), kind: "schedule", taskId: task.input.scheduleId, text: task.input.text, ...(item?.daylightTaskId ? { daylightTaskId: item.daylightTaskId } : {}) });
        }, context);
        if (!current) return;
        const parent = await runtime.conversation(runtime.conversationId, context);
        const admitted = await parent!.submit(submission(task.input), context);
        await runtime.commit(async tx => {
          const run = (await tx.doc(Executions, runtime.conversationId)).items.find(item => item.id === runId(task.input))!;
          const counted = run.submissionId !== undefined;
          run.submissionId = admitted.id;
          const item = (await tx.doc(Schedules, runtime.conversationId)).items.find(it => it.id === task.input.scheduleId);
          if (!counted && scheduleMatches(item, task.input)) {
            item.runs += 1;
            item.lastRunAt = task.input.at;
            const nextAt = item.calendar ? nextCalendarOccurrence(item.calendar, Math.max(Date.now(), task.input.at)) : nextOccurrence(task.input.at, item.everyMinutes);
            if (nextAt !== null) {
              item.nextAt = nextAt; item.revision += 1;
              item.jobId = await tx.createTask(ScheduleTask, { scheduleId: item.id, text: item.text, at: nextAt, revision: item.revision }, { ownership: { kind: "conversation" }, background: true });
            } else { item.nextAt = null; item.status = "completed"; }
          }
          return { status: "running", checkpoint: { phase: "wait" } };
        }, context);
      },
      wait: async (task, runtime, context) => {
        const parent = await runtime.conversation(runtime.conversationId, context);
        const admitted = await parent!.submit(submission(task.input), context);
        while ((await admitted.status(context)).status === "queued") await sleep(250, undefined, { signal: runtime.signal });
        await runtime.commit(async tx => {
          const run = (await tx.doc(Executions, runtime.conversationId)).items.find(item => item.id === runId(task.input));
          if (run && run.status === "queued") { run.status = "running"; run.startedAt = Date.now(); }
        }, context);
        const settled = await admitted.wait(context);
        let completed: ExecutionRun | undefined;
         await runtime.commit(async tx => {
           await finishExecution(tx, runtime.conversationId, runId(task.input), settled);
           completed = detach((await tx.doc(Executions, runtime.conversationId)).items.find(run => run.id === runId(task.input)));
         }, context);
         if (completed) await deliverExecution(completed, onSettled, runtime.signal, work => runtime.commit(async tx => { await work(tx); return undefined; }, context));
        const failed = settled.type !== "input" || settled.status !== "done";
        await notifyEvent({ id: runId(task.input) + ":result", type: "schedule", text: (failed ? "计划任务失败：" : "计划任务完成：") + task.input.text, failed });
        await runtime.commit(() => finish(), context);
      },
    },
    abort: (task, runtime, context) => runtime.commit(async tx => {
      await cancelExecution(tx, runtime.conversationId, runId(task.input));
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context),
  });

  async function scheduleInTx(tx: Tx, conversationId: ConversationId, input: Parameters<typeof normalizeSchedule>[0] & { daylightTaskId?: unknown }, rawRequestId: unknown) {
    const requestId = normalizeRequestId(rawRequestId), doc = await tx.doc(Schedules, conversationId);
    if (requestId && Object.hasOwn(doc.applied ?? {}, requestId)) {
      const previous = doc.applied[requestId];
      return detach(doc.items.find(item => item.id === previous.id) ?? previous);
    }
    const normalized = normalizeSchedule(input), daylightTaskId = normalizeDaylightTaskId(input?.daylightTaskId);
    const item: Schedule = { id: randomUUID(), text: normalized.text, nextAt: normalized.at, everyMinutes: normalized.everyMinutes, runs: 0, lastRunAt: null,
      status: "active", revision: 1, createdAt: Date.now(), ...(normalized.calendar ? { calendar: normalized.calendar } : {}), ...(daylightTaskId ? { daylightTaskId } : {}) };
    item.jobId = await tx.createTask(ScheduleTask, { scheduleId: item.id, text: item.text, at: normalized.at, revision: item.revision }, { ownership: { kind: "conversation" }, background: true });
    doc.items.push(item);
    if (requestId) (doc.applied ??= {})[requestId] = item;
    return detach(item);
  }
  async function manageScheduleInTx(tx: Tx, conversationId: ConversationId, id: string, action: string) {
    const item = (await tx.doc(Schedules, conversationId)).items.find(it => it.id === id);
    if (!item) throw new Error("计划任务不存在");
    if (action === "cancel" && item.status !== "completed") { item.status = "cancelled"; item.revision += 1; }
    else if (action === "pause" && item.status === "active") { item.status = "paused"; item.revision += 1; }
    else if (action === "resume" && item.status === "paused") {
      item.status = "active"; item.revision += 1;
      item.nextAt = item.calendar ? nextCalendarOccurrence(item.calendar) : Math.max(item.nextAt || 0, Date.now() + 60000);
      item.jobId = await tx.createTask(ScheduleTask, { scheduleId: item.id, text: item.text, at: item.nextAt, revision: item.revision }, { ownership: { kind: "conversation" }, background: true });
    } else throw new Error("当前状态不能执行该操作");
    return detach(item);
  }
  return { ScheduleTask, scheduleInTx, manageScheduleInTx };
}
