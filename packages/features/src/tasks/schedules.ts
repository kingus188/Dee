import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ConversationBusy, defineTask } from "@earendil-works/pi-durable";
import type { ConversationId, Task, Tx } from "@earendil-works/pi-durable";
import { Executions, Schedules } from "./documents.js";
import type { Schedule, ScheduleInput, ScheduleCheckpoint } from "./documents.js";
import { nextOccurrence, normalizeSchedule, scheduleMatches, normalizeRequestId } from "./parameters.js";
import { nextCalendarOccurrence } from "./calendar.js";
import { cancelExecution, finishExecution, normalizeDaylightTaskId, recordExecution } from "./executions.js";
import { detach, finishTask as finish } from "../results.js";
import { createScheduleResults } from "./schedule-results.js";
import type { NotifyEvent } from "./notifications.js";

const runId = (input: ScheduleInput) => `schedule:${input.scheduleId}:${input.at}`;
const submission = (input: ScheduleInput) => ({ type: "input" as const, content: "[计划任务] " + input.text, requestId: runId(input), whenBusy: "followUp" as const,
  entry: { kind: "app.schedule-input", data: { scheduleId: input.scheduleId, at: input.at } } });

import type { ExecutionRun } from "@assistant/contracts";
export function createSchedules(notifyEvent: NotifyEvent, onSettled: (run: ExecutionRun) => Promise<"delivered" | "not_applicable" | "unknown" | void> = async () => {}) {
  const { ScheduleResultTask, enqueueResult, recoverResults } = createScheduleResults(notifyEvent, onSettled);
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
          await recoverResults(tx, runtime.conversationId);
          const item = (await tx.doc(Schedules, runtime.conversationId)).items.find(it => it.id === task.input.scheduleId);
          return scheduleMatches(item, task.input) ? { status: "running", checkpoint: { phase: "deliver" } } : finish("已跳过过期任务");
        }, context);
      },
      deliver: async (task, runtime, context) => {
        let current = false, skipWhenBusy = false;
        await runtime.commit(async tx => {
          const item = (await tx.doc(Schedules, runtime.conversationId)).items.find(it => it.id === task.input.scheduleId);
          current = scheduleMatches(item, task.input);
          skipWhenBusy = !!item && (!!item.calendar || item.everyMinutes > 0);
          // A recovered delivery may already have advanced the next scheduled occurrence.
          const executions = (await tx.doc(Executions, runtime.conversationId)).items;
          const admitted = executions.find(run => run.id === runId(task.input));
          if (admitted?.submissionId !== undefined) { current = true; return; }
          if (!current) return finish("已取消或已更新");
          // One recurring schedule has at most one in-flight occurrence. Skip overlapping
          // ticks without a model call; unrelated and one-shot reminders are not gated.
          if (!admitted && item && (item.calendar || item.everyMinutes > 0)) {
            for (const run of executions.filter(run => run.kind === "schedule" && run.taskId === item.id && (run.status === "queued" || run.status === "running"))) {
              // Read the real submission, not the observer task's terminal state. The
              // stable request ID also covers a crash before submissionId was saved.
              const observed = await tx.submissionByRequest(runtime.conversationId, run.id);
              if (!observed || observed.type !== "input" || (run.submissionId !== undefined && observed.id !== run.submissionId)) {
                run.error = "无法核实上一轮模型执行状态；后续周期暂缓，需核对执行记录。";
                continue;
              }
              run.submissionId = observed.id;
              if (observed.status === "done" || observed.status === "unanswered") {
                await finishExecution(tx, runtime.conversationId, run.id, observed);
                await enqueueResult(tx, runtime.conversationId, run.id);
              }
            }
          }
          if (!admitted && item && (item.calendar || item.everyMinutes > 0) && executions.some(run =>
            run.kind === "schedule" && run.taskId === item.id && (run.status === "queued" || run.status === "running"))) {
            await advanceSchedule(tx, item, task.input.at);
            current = false;
            return finish("上一轮仍在执行，已跳过重叠周期");
          }
          await recordExecution(tx, runtime.conversationId, { id: runId(task.input), kind: "schedule", taskId: task.input.scheduleId, runtimeTaskId: task.id, text: task.input.text, ...(item?.daylightTaskId ? { daylightTaskId: item.daylightTaskId } : {}) });
        }, context);
        if (!current) return;
        const parent = await runtime.conversation(runtime.conversationId, context);
        const admitted = await parent!.submit({ ...submission(task.input), whenBusy: skipWhenBusy ? "reject" : "followUp" }, context).catch(async error => {
          if (!skipWhenBusy || !(error instanceof ConversationBusy)) throw error;
          // The SDK guarantees this exception means no submission was admitted.
          // Never queue unbounded recurring inputs behind a busy user conversation.
          await runtime.commit(async tx => {
            const run = (await tx.doc(Executions, runtime.conversationId)).items.find(item => item.id === runId(task.input));
            if (run && run.submissionId === undefined && run.status === "queued") {
              run.status = "failed"; run.finishedAt = Date.now();
              run.error = "会话正在处理其他输入，本周期未入队；将在下一周期重新检查。";
              if (run.daylightTaskId) run.deliveryStatus = "not_applicable";
            }
            const item = (await tx.doc(Schedules, runtime.conversationId)).items.find(item => item.id === task.input.scheduleId);
            if (scheduleMatches(item, task.input)) await advanceSchedule(tx, item, task.input.at);
            return finish("会话忙，已跳过本周期");
          }, context);
          return undefined;
        });
        if (!admitted) return;
        await runtime.commit(async tx => {
          const run = (await tx.doc(Executions, runtime.conversationId)).items.find(item => item.id === runId(task.input))!;
          const counted = run.submissionId !== undefined;
          run.submissionId = admitted.id;
          const item = (await tx.doc(Schedules, runtime.conversationId)).items.find(it => it.id === task.input.scheduleId);
          if (!counted && scheduleMatches(item, task.input)) {
            item.runs += 1;
            item.lastRunAt = task.input.at;
            await advanceSchedule(tx, item, task.input.at);
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
        await runtime.commit(async tx => {
          await finishExecution(tx, runtime.conversationId, runId(task.input), settled);
          const run = (await tx.doc(Executions, runtime.conversationId)).items.find(item => item.id === runId(task.input));
          if (run && (run.status === "done" || run.status === "failed")) await enqueueResult(tx, runtime.conversationId, run.id);
          return finish();
        }, context);
      },
    },
    abort: (task, runtime, context) => runtime.commit(async tx => {
      await cancelExecution(tx, runtime.conversationId, runId(task.input));
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context),
  });

  async function advanceSchedule(tx: Tx, item: Schedule, at: number) {
    const nextAt = item.calendar ? nextCalendarOccurrence(item.calendar, Math.max(Date.now(), at)) : nextOccurrence(at, item.everyMinutes);
    if (nextAt !== null) {
      item.nextAt = nextAt; item.revision += 1;
      item.jobId = await tx.createTask(ScheduleTask, { scheduleId: item.id, text: item.text, at: nextAt, revision: item.revision }, { ownership: { kind: "conversation" }, background: true });
    } else { item.nextAt = null; item.status = "completed"; }
  }

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
  return { ScheduleTask, ScheduleResultTask, scheduleInTx, manageScheduleInTx };
}
