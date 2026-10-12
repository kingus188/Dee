import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { resultText } from "../results.js";
import { createSchedules } from "./schedules.js";
import { createBackground } from "./background.js";
import type { NotifyEvent } from "./notifications.js";
export * from "./documents.js";
export * from "./parameters.js";
export { Reminders } from "./reminders.js";
export { Delegations } from "./delegation.js";
export function createTaskCenter(notifyEvent: NotifyEvent) {
 const schedules = createSchedules(notifyEvent);
 const background = createBackground(notifyEvent, () => V3);
 const { ScheduleTask, scheduleInTx } = schedules;
 const { BackgroundTask, backgroundInTx } = background;
const V3: Extension = defineExtension({
  name: "v3-task-center",
  tasks: [ScheduleTask, BackgroundTask],
  tools: [
    defineTool({
      name: "schedule_task", replay: "safe",
      description: "在指定分钟后执行任务，可按固定间隔重复；everyMinutes 为 0 时只执行一次",
      parameters: Type.Object({
        text: Type.String(), minutesFromNow: Type.Number(),
        everyMinutes: Type.Optional(Type.Number()),
      }),
      execute: async (args, api, context) => {
        const item = await api.commit((tx) => scheduleInTx(tx, api.conversationId, args, "tool:" + api.callId), context);
        return resultText("计划已创建：" + item.id);
      },
    }),
    defineTool({
      name: "delegate_background", replay: "safe",
      description: "把一项独立工作交给可跨进程恢复的后台子 Agent，立即返回任务编号，不等待它完成",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (args, api, context) => {
        const item = await api.commit((tx) => backgroundInTx(tx, api.conversationId, args, "tool:" + api.callId), context);
        return resultText("后台子 Agent 已启动：" + item.id);
      },
    }),
  ],
});

return { extension: V3, ...schedules, ...background };
}
