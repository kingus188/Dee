import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { resultText } from "../results.js";
import { createSchedules } from "./schedules.js";
import { createBackground } from "./background.js";
import { createReminders } from "./reminders.js";
import type { NotifyEvent } from "./notifications.js";
export * from "./documents.js";
export * from "./parameters.js";
export * from "./calendar.js";
export { Reminders, normalizeReminder } from "./reminders.js";
export type { Reminder } from "./reminders.js";
export { Delegations } from "./delegation.js";
export { cancelExecution } from "./executions.js";
import type { ExecutionRun } from "@assistant/contracts";
export function createTaskCenter(notifyEvent: NotifyEvent, onSettled: (run: ExecutionRun) => Promise<void> = async () => {}) {
 const schedules = createSchedules(notifyEvent, onSettled);
 const background = createBackground(notifyEvent, () => V3, onSettled);
 const reminders = createReminders(notifyEvent);
 const { ScheduleTask, scheduleInTx } = schedules;
 const { BackgroundTask, backgroundInTx } = background;
const V3: Extension = defineExtension({
  name: "v3-task-center",
  tasks: [ScheduleTask, BackgroundTask],
  tools: [
    defineTool({
      name: "schedule_task", replay: "safe",
      description: "按分钟延迟或日历规则执行任务。calendar 使用 IANA 时区与 HH:mm；weekly.weekdays 为 1～7（周一为1）。两种时间方式只能选一种。可用 daylightTaskId 关联已有待办，运行记录会保留结果。",
      parameters: Type.Object({
        text: Type.String(), minutesFromNow: Type.Optional(Type.Number()),
        everyMinutes: Type.Optional(Type.Number()), daylightTaskId: Type.Optional(Type.String()),
        calendar: Type.Optional(Type.Union([
          Type.Object({ kind: Type.Literal("daily"), time: Type.String(), timeZone: Type.String() }),
          Type.Object({ kind: Type.Literal("weekly"), time: Type.String(), timeZone: Type.String(), weekdays: Type.Array(Type.Integer({ minimum: 1, maximum: 7 })) }),
          Type.Object({ kind: Type.Literal("monthly"), time: Type.String(), timeZone: Type.String(), monthDay: Type.Integer({ minimum: 1, maximum: 31 }) }),
        ])),
      }),
      execute: async (args, api, context) => {
        const item = await api.commit((tx) => scheduleInTx(tx, api.conversationId, args, "tool:" + api.callId), context);
        return resultText("计划已创建：" + item.id);
      },
    }),
    defineTool({
      name: "delegate_background", replay: "safe",
      description: "把一项独立工作交给可跨进程恢复的后台子 Agent，立即返回任务编号，不等待它完成",
      parameters: Type.Object({ text: Type.String(), daylightTaskId: Type.Optional(Type.String()) }),
      execute: async (args, api, context) => {
        const item = await api.commit((tx) => backgroundInTx(tx, api.conversationId, args, "tool:" + api.callId), context);
        return resultText("后台子 Agent 已启动：" + item.id);
      },
    }),
  ],
});

return { extension: V3, ...schedules, ...background, reminderInTx: reminders.reminderInTx };
}
