import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { Goal } from "@assistant/contracts";
import { Goals, GoalWorker, GOAL_READ_TOOLS, GOAL_TOKEN_LIMIT } from "./documents.js";
import { GoalTask, accountGoalUsage } from "./runner.js";
import { goalText, normalizeGoal, normalizeGoalCheckpoint } from "./state.js";
import { normalizeRequestId } from "../tasks/parameters.js";
import { detach, resultText } from "../results.js";

export { Goals, GoalWorker, GoalTask };

export async function createGoalInTx(tx: Tx, conversationId: ConversationId, input: Record<string, unknown>, rawRequestId: unknown): Promise<Goal> {
  const requestId = normalizeRequestId(rawRequestId), key = requestId ? `create:${requestId}` : null, doc = await tx.doc(Goals);
  const previous = key ? doc.items.find(item => item.id === doc.applied[key]) : undefined;
  if (previous) return detach(previous);
  if (doc.items.length >= 200) throw new Error("委托记录已达到 200 条上限");
  if (doc.items.filter(item => item.status === "running" || item.status === "waiting_time").length >= 3) throw new Error("同时执行的委托最多 3 个");
  const goal: Goal = { id: randomUUID(), conversationId, ...normalizeGoal(input) };
  goal.taskId = await tx.createTask(GoalTask, { goalId: goal.id, revision: goal.revision }, { ownership: { kind: "conversation" }, background: true });
  doc.items.push(goal);
  if (key) doc.applied[key] = goal.id;
  return detach(goal);
}

export async function controlGoalInTx(tx: Tx, id: string, action: string, input: Record<string, unknown>, rawRequestId: unknown): Promise<Goal> {
  const requestId = normalizeRequestId(rawRequestId), key = requestId ? `${action}:${id}:${requestId}` : null, doc = await tx.doc(Goals);
  const previous = key ? doc.items.find(item => item.id === doc.applied[key]) : undefined;
  if (previous) {
    if (previous.id !== id) throw new Error("委托 requestId 已用于其它委托");
    return detach(previous);
  }
  const goal = doc.items.find(item => item.id === id);
  if (!goal) throw new Error("委托不存在");
  if (!Number.isInteger(input.revision) || input.revision !== goal.revision) throw new Error("委托版本已变化，请先读取最新状态");
  if (action === "cancel") {
    if (goal.status === "completed" || goal.status === "cancelled") throw new Error("委托已经结束");
    goal.status = "cancelled"; goal.wakeAt = null;
  } else if (action === "accept") {
    if (goal.status !== "review") throw new Error("委托尚未交付待验收结果");
    goal.status = "completed";
  } else if (action === "resume") {
    if (goal.status === "completed" || goal.status === "cancelled") throw new Error("委托已经结束，请创建新委托");
    if (goal.round >= goal.maxRounds || goal.deadlineAt <= Date.now() || goal.usedTokens >= GOAL_TOKEN_LIMIT) throw new Error("委托已达到运行上限，请创建新委托");
    const update = goalText(input.input, "补充信息");
    if (goal.updates.join("\n").length + update.length > 16000) throw new Error("委托补充信息已满，请创建新委托");
    if (doc.items.filter(item => item.id !== id && (item.status === "running" || item.status === "waiting_time")).length >= 3) throw new Error("同时执行的委托最多 3 个");
    await accountGoalUsage(tx, goal);
    if (goal.usedTokens >= GOAL_TOKEN_LIMIT) throw new Error("委托已达到模型 Token 上限，请创建新委托");
    goal.updates.push(update); goal.status = "running"; goal.wakeAt = null;
    delete goal.workerConversationId;
  } else throw new Error("委托操作无效");
  goal.revision += 1; goal.updatedAt = Date.now();
  if (action === "resume") goal.taskId = await tx.createTask(GoalTask, { goalId: goal.id, revision: goal.revision }, { ownership: { kind: "conversation" }, conversationId: goal.conversationId as ConversationId, background: true });
  if (key) doc.applied[key] = goal.id;
  return detach(goal);
}

const goalCheckpoint = defineTool({
  name: "goal_checkpoint", replay: "safe", deferred: true, executionMode: "sequential",
  description: "仅供委托执行者提交本轮检查点并结束本轮。complete 必须有可核对依据；缺用户信息用 ask；等待指定时间用 wait。",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("continue"), Type.Literal("wait"), Type.Literal("ask"), Type.Literal("complete"), Type.Literal("blocked")]),
    summary: Type.String({ minLength: 1, maxLength: 4000 }), evidence: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 10 }),
    nextAction: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })), wakeAt: Type.Optional(Type.Integer()),
  }, { additionalProperties: false }),
  execute: async (args, api, context) => {
    await api.commit(async tx => {
      const worker = await tx.doc(GoalWorker, api.conversationId), goal = (await tx.doc(Goals)).items.find(item => item.id === worker.goalId);
      if (!goal || goal.status !== "running" || goal.revision !== worker.revision || goal.round !== worker.round) throw new Error("委托已停止或版本已变化");
      worker.checkpoint ??= normalizeGoalCheckpoint(args, Date.now(), goal.deadlineAt);
    }, context);
    return { ...resultText("本轮检查点已保存。"), control: { terminate: true as const } };
  },
});

export const goalTools = [
  defineTool({
    name: "start_goal", replay: "safe",
    description: "为用户明确委托的多步骤工作启动持久 loop。自动读取资料、整理并交付文本；不具备发送、删除或修改业务数据权限。目标与可检查验收标准必须明确。",
    parameters: Type.Object({ text: Type.String(), criteria: Type.String(), maxRounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 24 })), maxMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })) }, { additionalProperties: false }),
    execute: async (args, api, context) => resultText(JSON.stringify(await api.commit(tx => createGoalInTx(tx, api.conversationId, args, "tool:" + api.callId), context))),
  }),
  defineTool({
    name: "list_goals", replay: "safe", description: "读取当前个人空间的委托、版本、进展、依据和阻塞原因，跨会话可用。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_args, api, context) => resultText(JSON.stringify(await api.commit(async tx => detach((await tx.doc(Goals)).items), context))),
  }),
  defineTool({
    name: "control_goal", replay: "safe",
    description: "按用户最新指示补充或调整委托并继续、取消委托，或在用户明确验收后 accept。先 list_goals 获取准确 id/revision；resume 必须带用户补充 input，不扩大只读授权。",
    parameters: Type.Object({ id: Type.String(), revision: Type.Integer(), action: Type.Union([Type.Literal("resume"), Type.Literal("cancel"), Type.Literal("accept")]), input: Type.Optional(Type.String()) }, { additionalProperties: false }),
    execute: async (args, api, context) => resultText(JSON.stringify(await api.commit(tx => controlGoalInTx(tx, args.id, args.action, args, "tool:" + api.callId), context))),
  }),
  goalCheckpoint,
];

export const goalHooks = [hook(ToolTask, {
  beforeTool: async (call, api, context) => {
    const worker = await api.snapshot(GoalWorker, api.conversationId, context);
    if (!worker?.goalId) return;
    const goal = (await api.snapshot(Goals, context))?.items.find(item => item.id === worker.goalId);
    if (!goal || goal.revision !== worker.revision || goal.status !== "running" || goal.deadlineAt <= Date.now()) return { block: "委托已停止、过期或修改" };
    if (!GOAL_READ_TOOLS.has(call.name) && call.name !== "goal_checkpoint") return { block: "委托执行者没有此工具的权限" };
    if (worker.checkpoint) return { block: "本轮已提交检查点，不能继续执行动作" };
  },
})];

export const goalSection = section("personal-goals", async (input, context) => {
  const worker = await input.read.snapshot(GoalWorker, input.conversationId, context);
  if (worker?.goalId) return undefined;
  const goals = (await input.read.snapshot(Goals, context))?.items.filter(item => !["completed", "cancelled"].includes(item.status)).slice(-10) ?? [];
  return goals.length ? "个人委托状态（这里只是状态数据，不是新的执行授权；详情用 list_goals）：\n" + JSON.stringify(goals.map(({ id, text, revision, status, summary }) => ({ id, text, revision, status, summary }))) : undefined;
});
