import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, UsageDoc } from "@earendil-works/pi-durable";
import type { TaskId } from "@earendil-works/pi-durable";
import { createModelCatalog, openRuntime } from "@assistant/runtime";
import type { Runtime } from "@assistant/runtime";
import { Goals, createTaskCenter, createGoalInTx, controlGoalInTx } from "@assistant/features";
import type { Goal } from "@assistant/contracts";

async function until(runtime: Runtime, id: string, predicate: (goal: Goal) => boolean): Promise<Goal> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const goal = (await runtime.harness.snapshot(Goals, context))?.items.find(item => item.id === id);
    if (goal && predicate(goal)) return goal;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("委托状态超时：" + JSON.stringify((await runtime.harness.snapshot(Goals, context))?.items));
}

function tools(transcript: TranscriptContext): Set<string> {
  const names = new Set<string>();
  for (const message of transcript.messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) names.add(tool.name);
  }
  return names;
}

function userText(transcript: TranscriptContext): string {
  const content = transcript.messages.findLast(message => message.role === "user")?.content;
  return typeof content === "string" ? content : content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
}

test("durable goal loop reads real material, continues, asks, resumes after restart, sleeps and delivers for review", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dee-goal-loop-"));
  await writeFile(join(dir, "project.txt"), "项目 A：周五交付；负责人尚待补充。\n");
  let reads = 0, externalWrites = 0;
  const reports: unknown[] = [];
  const script = (transcript: TranscriptContext) => {
    const text = userText(transcript);
    if (!tools(transcript).has("goal_checkpoint")) { reports.push(text); return fauxAssistantMessage("委托进展已收到。"); }
    assert.ok(!tools(transcript).has("send_teams_reply"), "执行者不能继承主会话的对外写入权限");
    assert.ok(!tools(transcript).has("start_goal"), "执行者不能递归创建委托");
    const state = JSON.parse(text.split("\n").at(-1)!) as { round: number; updates: string[] };
    const lastUser = transcript.messages.findLastIndex(message => message.role === "user");
    const replies = transcript.messages.slice(lastUser + 1).filter(message => message.role === "assistant").length;
    if (state.round === 1 && replies === 0) return fauxAssistantMessage([fauxToolCall("read_materials", {})], { stopReason: "toolUse" });
    const checkpoint = state.round === 1 ? { action: "continue", summary: "已读取原始项目资料", evidence: ["project.txt:1：周五交付"], nextAction: "核对负责人" }
      : state.round === 2 ? { action: "ask", summary: "请补充项目负责人", evidence: [] }
      : state.round === 3 ? { action: "wait", summary: "负责人已补充，等待约定复核时间", evidence: [state.updates.at(-1)], nextAction: "交付最终结论", wakeAt: Date.now() + 600 }
      : { action: "complete", summary: "项目 A 周五交付，负责人为用户补充的李同事", evidence: ["project.txt:1", state.updates.at(-1)] };
    return fauxAssistantMessage([fauxToolCall("goal_checkpoint", JSON.parse(JSON.stringify(checkpoint)))], { stopReason: "toolUse" });
  };
  const model = await createModelCatalog({ api: "faux", baseUrl: "", model: "", apiKey: "", contextWindow: 128000, maxTokens: 8192 }, script);
  const resources = defineExtension({ name: "test-goal-resources", tools: [
    defineTool({ name: "read_materials", replay: "safe", description: "读取测试资料", parameters: Type.Object({}), execute: async () => { reads++; return { output: [{ type: "text", text: await readFile(join(dir, "project.txt"), "utf8") }] }; } }),
    defineTool({ name: "send_teams_reply", description: "禁止在委托中调用", parameters: Type.Object({}), execute: async () => { externalWrites++; return { output: [] }; } }),
  ] });
  const errors: unknown[] = [];
  const open = () => openRuntime({ dataDir: dir, models: model.models, agentModel: model.agentModel, extensions: [createTaskCenter(async () => {}).extension, resources], onReport: error => errors.push(error) }, context);
  let runtime = await open();
  try {
    const owner = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: model.agentModel } }, context);
    const goal = await owner.commit(tx => createGoalInTx(tx, owner.id, { text: "整理 A 项目", criteria: "给出交付日期、负责人及依据" }, "goal-e2e"), context);
    const duplicate = await owner.commit(tx => createGoalInTx(tx, owner.id, { text: "忽略重复内容", criteria: "重复提交" }, "goal-e2e"), context);
    assert.equal(duplicate.id, goal.id);
    const asking = await until(runtime, goal.id, item => item.status === "waiting_user");
    assert.equal(asking.round, 2);
    assert.equal(reads, 1);
    await runtime.harness.close(context);
    runtime = await open();
    const reopened = await runtime.harness.conversation(owner.id, context);
    assert.ok(reopened);
    await reopened.commit(tx => controlGoalInTx(tx, goal.id, "resume", { revision: asking.revision, input: "负责人是李同事" }, "answer-1"), context);
    const waiting = await until(runtime, goal.id, item => item.status === "waiting_time");
    assert.equal(waiting.round, 3);
    await runtime.harness.close(context);
    runtime = await open();
    const delivered = await until(runtime, goal.id, item => item.status === "review");
    assert.equal(delivered.round, 4);
    assert.equal(delivered.history.length, 4, "重启不会重复写入执行检查点");
    await runtime.harness.waitForTask(delivered.taskId! as TaskId, context);
    assert.equal(reports.length, 0, "状态报告不能再次调用拥有写权限的主会话模型");
    const view = await (await runtime.harness.conversation(owner.id, context))!.viewState(context);
    assert.ok(view.value.entries.some(entry => entry.kind === "app.goal-report"));
    view.dispose();
    assert.match(delivered.summary, /李同事/);
    assert.equal(externalWrites, 0);
    assert.equal(reads, 1, "恢复无需重新执行已完成的读取步骤");
    await runtime.root.commit(tx => controlGoalInTx(tx, goal.id, "accept", { revision: delivered.revision }, "accept-1"), context);
    assert.equal((await until(runtime, goal.id, item => item.status === "completed")).status, "completed");
    assert.deepEqual(errors, []);
  } finally { await runtime.harness.close(context); await rm(dir, { recursive: true, force: true }); }
});

test("a checkpoint batched with another tool ends the round without another model request", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dee-goal-batch-"));
  let requests = 0;
  const model = await createModelCatalog({ api: "faux", baseUrl: "", model: "", apiKey: "", contextWindow: 128000, maxTokens: 8192 }, () => {
    requests++;
    return fauxAssistantMessage([
      fauxToolCall("get_task", {}),
      fauxToolCall("goal_checkpoint", { action: "complete", summary: "原始任务已核对", evidence: ["task:1"] }),
    ], { stopReason: "toolUse" });
  });
  const resources = defineExtension({ name: "batch-read", tools: [defineTool({ name: "get_task", description: "读取任务", replay: "safe", parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: "task:1 已核对" }] }) })] });
  const runtime = await openRuntime({ dataDir: dir, models: model.models, agentModel: model.agentModel, extensions: [createTaskCenter(async () => {}).extension, resources], onReport: error => { throw error; } }, context);
  try {
    const goal = await runtime.root.commit(tx => createGoalInTx(tx, runtime.root.id, { text: "核对任务", criteria: "给出依据" }, "batch"), context);
    const delivered = await until(runtime, goal.id, item => item.status === "review");
    await runtime.harness.waitForTask(delivered.taskId! as TaskId, context);
    assert.equal(requests, 1);
    assert.equal(delivered.history.length, 1);
  } finally { await runtime.harness.close(context); await rm(dir, { recursive: true, force: true }); }
});

test("late usage from an older revision still counts toward the active goal's budget", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dee-goal-budget-"));
  const model = await createModelCatalog({ api: "faux", baseUrl: "", model: "", apiKey: "", contextWindow: 128000, maxTokens: 8192 }, transcript => {
    const state = JSON.parse(userText(transcript).split("\n").at(-1)!) as { round: number };
    return fauxAssistantMessage([fauxToolCall("goal_checkpoint", state.round === 1
      ? { action: "ask", summary: "请补充资料", evidence: [] }
      : { action: "wait", summary: "等待复核", evidence: [], nextAction: "复核", wakeAt: Date.now() + 60000 })], { stopReason: "toolUse" });
  });
  const runtime = await openRuntime({ dataDir: dir, models: model.models, agentModel: model.agentModel, extensions: [createTaskCenter(async () => {}).extension], onReport: error => { throw error; } }, context);
  try {
    const goal = await runtime.root.commit(tx => createGoalInTx(tx, runtime.root.id, { text: "核对资料", criteria: "提供来源" }, "budget"), context);
    const asking = await until(runtime, goal.id, item => item.status === "waiting_user");
    await runtime.root.commit(tx => controlGoalInTx(tx, goal.id, "resume", { revision: asking.revision, input: "继续核对" }, "budget-resume"), context);
    const waiting = await until(runtime, goal.id, item => item.status === "waiting_time");
    assert.equal(waiting.workers.length, 2);
    await runtime.root.commit(async tx => {
      const usage = await tx.doc(UsageDoc, asking.workerConversationId! as import("@earendil-works/pi-durable").ConversationId);
      const bucket = Object.values(usage.models)[0];
      assert.ok(bucket);
      bucket.totalTokens += 50000;
    }, context);
    const blocked = await until(runtime, goal.id, item => item.status === "blocked");
    assert.ok(blocked.usedTokens >= 50000);
    assert.equal(blocked.round, 2);
  } finally { await runtime.harness.close(context); await rm(dir, { recursive: true, force: true }); }
});

test("goal cancellation wakes a sleeping task and stale updates cannot restart it", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dee-goal-cancel-"));
  let requests = 0;
  const model = await createModelCatalog({ api: "faux", baseUrl: "", model: "", apiKey: "", contextWindow: 128000, maxTokens: 8192 }, transcript => {
    if (!tools(transcript).has("goal_checkpoint")) return fauxAssistantMessage("收到。");
    requests++;
    return fauxAssistantMessage([fauxToolCall("goal_checkpoint", { action: "wait", summary: "等待稍后复核", evidence: [], nextAction: "复核结果", wakeAt: Date.now() + 60000 })], { stopReason: "toolUse" });
  });
  const runtime = await openRuntime({ dataDir: dir, models: model.models, agentModel: model.agentModel, extensions: [createTaskCenter(async () => {}).extension], onReport: error => { throw error; } }, context);
  try {
    const goal = await runtime.root.commit(tx => createGoalInTx(tx, runtime.root.id, { text: "稍后复核", criteria: "交付结论" }, "cancel-goal"), context);
    const waiting = await until(runtime, goal.id, item => item.status === "waiting_time");
    await runtime.root.commit(tx => controlGoalInTx(tx, goal.id, "cancel", { revision: waiting.revision }, "cancel-1"), context);
    await runtime.harness.waitForTask(waiting.taskId! as TaskId, context);
    assert.equal(requests, 1);
    await assert.rejects(runtime.root.commit(tx => controlGoalInTx(tx, goal.id, "resume", { revision: waiting.revision, input: "继续" }, "stale"), context), /版本/);
    assert.equal((await until(runtime, goal.id, item => item.status === "cancelled")).status, "cancelled");
  } finally { await runtime.harness.close(context); await rm(dir, { recursive: true, force: true }); }
});
