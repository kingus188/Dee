import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { defineTask } from "@earendil-works/pi-durable";
import type { ConversationId, Task, Tx } from "@earendil-works/pi-durable";
import { Schedules } from "./documents.js";
import type { Schedule, ScheduleInput, ScheduleCheckpoint } from "./documents.js";
import { nextOccurrence, normalizeSchedule, scheduleMatches, normalizeRequestId } from "./parameters.js";
import { detach, finishTask as finish } from "../results.js";
import type { NotifyEvent } from "./notifications.js";
export function createSchedules(notifyEvent: NotifyEvent) {
const ScheduleTask: Task<ScheduleInput, ScheduleCheckpoint, string | null, object> = defineTask<ScheduleInput, ScheduleCheckpoint, string | null, object>({
  name: "app.v3.schedule", version: 1,
  initial: () => ({ phase: "sleep" }),
  phases: {
    sleep: async (task, runtime, context) => {
      const ms = task.input.at - Date.now();
      while (Date.now() < task.input.at) {
        await sleep(Math.min(60000, task.input.at - Date.now()), undefined, { signal: runtime.signal });
      }
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "fire" } }), context);
    },
    fire: async (task, runtime, context) => {
      // 取消、暂停或修改后，旧任务到期时不会产生消息。
      let shouldFire = false;
      await runtime.commit(async (tx) => {
        const item = (await tx.doc(Schedules, runtime.conversationId)).items.find((it) => it.id === task.input.scheduleId);
        shouldFire = scheduleMatches(item, task.input);
        return shouldFire ? { status: "running", checkpoint: { phase: "deliver" } } : finish("已跳过过期任务");
      }, context);
    },
    deliver: async (task, runtime, context) => {
      let current = false;
      await runtime.commit(async (tx) => {
        const item = (await tx.doc(Schedules, runtime.conversationId)).items.find((it) => it.id === task.input.scheduleId);
        current = scheduleMatches(item, task.input);
        return current ? undefined : finish("已取消或已更新");
      }, context);
      if (!current) return;
      const parent = await runtime.conversation(runtime.conversationId, context);
      await parent!.submit({
        type: "input", content: "[计划任务] " + task.input.text,
        requestId: "schedule:" + task.input.scheduleId + ":" + task.input.at,
        whenBusy: "followUp",
      }, context);
      await runtime.commit(async (tx) => {
        const doc = await tx.doc(Schedules, runtime.conversationId);
        const item = doc.items.find((it) => it.id === task.input.scheduleId);
        if (scheduleMatches(item, task.input)) {
          item.runs += 1;
          item.lastRunAt = task.input.at;
          const nextAt = nextOccurrence(task.input.at, item.everyMinutes);
          if (nextAt !== null) {
            item.nextAt = nextAt;
            item.revision += 1;
            item.jobId = await tx.createTask(ScheduleTask, {
              scheduleId: item.id, text: item.text, at: nextAt, revision: item.revision,
            }, { ownership: { kind: "conversation" }, background: true });
          } else {
            item.nextAt = null;
            item.status = "completed";
          }
        }
        return finish();
      }, context);
      await notifyEvent({ id: "schedule:" + task.input.scheduleId + ":" + task.input.at,
        type: "schedule", text: "计划任务已触发：" + task.input.text });
    },
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

async function scheduleInTx(tx: Tx, conversationId: ConversationId, input: Parameters<typeof normalizeSchedule>[0], rawRequestId: unknown) {
  const requestId = normalizeRequestId(rawRequestId);
  const doc = await tx.doc(Schedules, conversationId);
  if (requestId && Object.hasOwn(doc.applied ?? {}, requestId)) {
    const previous = doc.applied[requestId];
    return detach(doc.items.find((item) => item.id === previous.id) ?? previous);
  }
  const normalized = normalizeSchedule(input);
  const item: Schedule = {
    id: randomUUID(), text: normalized.text, nextAt: normalized.at,
    everyMinutes: normalized.everyMinutes, runs: 0, lastRunAt: null,
    status: "active", revision: 1, createdAt: Date.now(),
  };
  item.jobId = await tx.createTask(ScheduleTask, {
    scheduleId: item.id, text: item.text, at: normalized.at, revision: item.revision,
  }, { ownership: { kind: "conversation" }, background: true });
  doc.items.push(item);
  if (requestId) (doc.applied ??= {})[requestId] = item;
  return detach(item);
}

async function manageScheduleInTx(tx: Tx, conversationId: ConversationId, id: string, action: string) {
  const item = (await tx.doc(Schedules, conversationId)).items.find((it) => it.id === id);
  if (!item) throw new Error("计划任务不存在");
  if (action === "cancel" && item.status !== "completed") {
    item.status = "cancelled";
    item.revision += 1;
  } else if (action === "pause" && item.status === "active") {
    item.status = "paused";
    item.revision += 1;
  } else if (action === "resume" && item.status === "paused") {
    item.status = "active";
    item.revision += 1;
    // 恢复时保留未来的截止时间；过去的截止时间改成 1 分钟后。
    item.nextAt = Math.max(item.nextAt || 0, Date.now() + 60000);
    item.jobId = await tx.createTask(ScheduleTask, {
      scheduleId: item.id, text: item.text, at: item.nextAt, revision: item.revision,
    }, { ownership: { kind: "conversation" }, background: true });
  } else {
    throw new Error("当前状态不能执行该操作");
  }
  return detach(item);
}


return { ScheduleTask, scheduleInTx, manageScheduleInTx };
}
