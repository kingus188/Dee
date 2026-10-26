import { createHash, randomUUID } from "node:crypto";
import { normalizeRequestId } from "@assistant/features";
import { Index } from "@assistant/runtime";
import type { ExecutionRun } from "@assistant/contracts";
import type { DaylightStore } from "../daylight-store.js";
import { HttpError } from "../errors.js";
import type { AppContext } from "./context.js";
import type { createConversations } from "./conversations.js";
import type { createManagement } from "./management.js";
import { openDirectChat } from "./direct-chat.js";

export { applyExecutionResult } from "./execution-outcome.js";

export function createDaylightExecution(context: AppContext, conversations: ReturnType<typeof createConversations>, management: ReturnType<typeof createManagement>) {
  async function runs(taskId: string) {
    await context.daylight.getTask(taskId);
    const index = await context.harness.snapshot(Index, context.ctx), items: ExecutionRun[] = [];
    for (const owner of index?.items ?? []) {
      const document = await management.get(await conversations.getConversation(owner.id));
      items.push(...(document.executions ?? []).filter(run => run.daylightTaskId === taskId));
    }
    return { items: items.sort((a, b) => b.queuedAt - a.queuedAt) };
  }
  async function start(taskId: string, body: Record<string, unknown>) {
    if (!context.modelConfigured) throw new HttpError(409, "请先在服务器端配置模型并重启后台服务");
    const task = await context.daylight.getTask(taskId);
    const requestId = normalizeRequestId(body.requestId) ?? randomUUID();
    const key = "daylight:" + createHash("sha256").update(taskId + ":" + requestId).digest("hex");
    return context.daylight.replayAction(key, async port => {
      const owner = await openDirectChat(context), conversation = await conversations.getConversation(owner);
      const text = `请处理这条待办，给出具体结果与仍需我确认的事项。\n待办：${task.title}\n备注（节选）：${task.description}`.slice(0, 4000);
      const item = await management.background(conversation, { text, daylightTaskId: taskId, requestId: key });
      const current = await port.getTask(taskId);
      if (current.status === "todo") await port.moveTask(taskId, "doing");
      return { item, conversationId: owner };
    });
  }
  return { runs, start };
}
