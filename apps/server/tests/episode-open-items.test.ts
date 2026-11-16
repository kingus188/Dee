import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, openRuntime, Index } from "@assistant/runtime";
import { Goals, Executions } from "@assistant/features";
import type { Goal, ExecutionRun } from "@assistant/contracts";
import { createEpisodeOpenItems } from "../dist/episode-open-items.js";
import type { StoredEpisode } from "../dist/episode-store.js";

const goalId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const episode = (text = `核对 ${goalId}`): StoredEpisode => ({ id: "episode", source: "conv:1", sourceRevision: 0, messageIds: ["7"], label: "原事项", channel: "web", level: 0, periodStart: "2026-01-01", periodEnd: "2026-01-02", summary: "摘要", openItems: [text] });
function fixture() {
  const state = { goals: [{ id: goalId, conversationId: 1, status: "running" }] as Goal[], runs: [] as ExecutionRun[], allowed: true, archived: false, original: `核对 ${goalId}`, reads: 0, onRead: () => {}, onRuns: () => {}, onDaylight: () => {}, daylightStatus: "doing" };
  const helper = createEpisodeOpenItems({ ctx, sourceAllowed: () => state.allowed,
    harness: { snapshot: async (doc: unknown) => doc === Index ? { items: [{ id: 1, ...(state.archived ? { archivedAt: "now" } : {}) }] } : doc === Goals ? { items: state.goals } : doc === Executions ? (state.onRuns(), { items: state.runs }) : undefined,
      conversation: async () => ({ entries: async (query: { minEntryId: number; maxEntryId: number }) => { state.reads++; state.onRead(); assert.equal(query.minEntryId, 7); assert.equal(query.maxEntryId, 7); return { items: [{ id: 7, kind: "pi.user", model: [{ content: state.original }] }] }; } })
    } as unknown as Parameters<typeof createEpisodeOpenItems>[0]["harness"],
    daylight: { getTask: async () => { state.onDaylight(); return { id: taskId, status: state.daylightStatus }; } } as unknown as Parameters<typeof createEpisodeOpenItems>[0]["daylight"],
  });
  return { state, helper };
}
test("目标当前状态只描述引用对象，始终保留未核实事项", async () => {
  const { state, helper } = fixture();
  for (const [status, expected] of [["running", "open"], ["review", "review"], ["completed", "completed"], ["cancelled", "cancelled"], ["blocked", "failed"]] as const) {
    state.goals[0]!.status = status;
    const [item] = await helper.items(episode());
    assert.equal(item!.verification, "unverified"); assert.equal(item!.text, episode().openItems[0]);
    assert.equal(item!.taskStatus, expected); assert.deepEqual(item!.taskReference, { kind: "goal", id: goalId }); assert.ok(item!.taskObservedAt);
  }
});
test("执行完成仅待验收，Daylight引用显示当前实际状态", async () => {
  const { state, helper } = fixture();
  state.runs = [{ id: "background:run:1", conversationId: 1, status: "done", daylightTaskId: taskId }] as ExecutionRun[];
  state.original = `执行 background:run:1 待办 ${taskId}`;
  assert.equal((await helper.items(episode("核对 background:run:1")))[0]!.taskStatus, "review");
  assert.equal((await helper.items(episode(`核对 ${taskId}`)))[0]!.taskStatus, "open");
  state.daylightStatus = "done";
  assert.equal((await helper.items(episode(`核对 ${taskId}`)))[0]!.taskStatus, "completed");
});
test("观察时间属于各状态读取而非最后一个慢查询或原文读取", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const { state, helper } = fixture();
  state.runs = [{ id: "background:run:1", conversationId: 1, status: "done", daylightTaskId: taskId }] as ExecutionRun[];
  state.original = `${goalId} background:run:1 ${taskId}`;
  state.onRuns = () => t.mock.timers.setTime(2000);
  state.onDaylight = () => t.mock.timers.setTime(3000);
  state.onRead = () => t.mock.timers.setTime(4000);
  const items = await helper.items({ ...episode(), openItems: [goalId, "background:run:1", taskId] });
  assert.deepEqual(items.map(item => item.taskObservedAt), [1000, 2000, 3000].map(at => new Date(at).toISOString()));
});
test("无精确源证据、歧义、模型捏造、跨源及历史无定位数据不附参考", async () => {
  const { state, helper } = fixture();
  for (const row of [episode("核对相似标题"), episode(`核对 x${goalId}`), episode(`核对 ${taskId}`), { ...episode(), messageIds: [] }, { ...episode(), source: "teams:1" }]) assert.equal((await helper.items(row))[0]!.taskReference, undefined);
  state.original = "原文没有ID"; assert.equal((await helper.items(episode()))[0]!.taskReference, undefined);
  state.original = `${goalId} ${taskId}`; state.goals.push({ id: taskId, conversationId: 1, status: "completed" } as Goal);
  assert.equal((await helper.items(episode(`${goalId} ${taskId}`)))[0]!.taskReference, undefined);
  state.goals[0]!.conversationId = 2; assert.equal((await helper.items(episode()))[0]!.taskReference, undefined);
});
test("已撤销或归档来源不读取原文", async () => {
  const { state, helper } = fixture(); state.allowed = false;
  assert.equal((await helper.items(episode()))[0]!.taskReference, undefined);
  state.allowed = true; state.archived = true;
  assert.equal((await helper.items(episode()))[0]!.taskReference, undefined); assert.equal(state.reads, 0);
});
test("读取原文期间撤销来源丢弃状态参考", async () => {
  const { state, helper } = fixture(); state.onRead = () => { state.allowed = false; };
  assert.equal((await helper.items(episode()))[0]!.taskReference, undefined); assert.equal(state.reads, 1);
});
test("真实Durable原始entry与目标状态更新可核验，不能用其他entry补关联", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-episode-items-"));
  const { models, agentModel } = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("收到"));
  const runtime = await openRuntime({ dataDir, models, agentModel, extensions: [], onReport: error => { throw error; } }, ctx);
  try {
    const owner = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: agentModel } }, ctx);
    const submission = await owner.submit({ type: "input", content: `核对 ${goalId}` }, ctx); await submission.wait(ctx);
    await owner.commit(async tx => { (await tx.doc(Index)).items.push({ id: owner.id, title: "证据", createdAt: new Date().toISOString() }); (await tx.doc(Goals)).items.push({ id: goalId, conversationId: owner.id, status: "review", text: "核对", criteria: "已核对", revision: 1, round: 0, usedTokens: 0, workers: [], maxRounds: 12, deadlineAt: Date.now() + 60000, createdAt: Date.now(), updatedAt: Date.now(), summary: "待验收", wakeAt: null, updates: [], history: [] }); }, ctx);
    const page = await owner.entries({}, 20, undefined, ctx);
    const user = page.items.find(item => item.kind === "pi.user")!, assistant = page.items.find(item => item.kind === "pi.assistant")!;
    const row = { ...episode(), source: `conv:${owner.id}`, messageIds: [String(user.id)] };
    const helper = createEpisodeOpenItems({ harness: runtime.harness, ctx, sourceAllowed: () => true, daylight: {} as Parameters<typeof createEpisodeOpenItems>[0]["daylight"] });
    assert.equal((await helper.items(row))[0]!.taskStatus, "review");
    await owner.commit(async tx => { (await tx.doc(Goals)).items[0]!.status = "completed"; }, ctx);
    const [item] = await helper.items(row); assert.equal(item!.taskStatus, "completed"); assert.equal(item!.verification, "unverified"); assert.equal(item!.text, row.openItems[0]);
    assert.equal((await helper.items({ ...row, messageIds: [String(assistant.id)] }))[0]!.taskReference, undefined);
  } finally { await runtime.harness.close(ctx); await rm(dataDir, { recursive: true, force: true }); }
});
