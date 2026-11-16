import test from "node:test";
import assert from "node:assert/strict";
import type { ExecutionRun, Goal } from "@assistant/contracts";
import type { Tx, ConversationId } from "@earendil-works/pi-durable";
import { BackgroundJobs, Delegations, Executions, Goals } from "@assistant/features";
import { projectUnifiedRuns, legacyRunRevision } from "../dist/application/unified-runs.js";
import { RunReviews, reviewRunInTx, withRunReviews } from "../dist/application/run-reviews.js";

const execution = (extra: Partial<ExecutionRun> = {}): ExecutionRun => ({ id: "background:job", kind: "background", taskId: "job", conversationId: 7, text: "检查报告", status: "done", queuedAt: 1, startedAt: 2, finishedAt: 3, result: "检查完成", error: null, ...extra });
const input = (executions: ExecutionRun[] = [execution()]) => ({ conversationId: 7, executions, background: [], delegations: [], goals: [] });

test("run success remains distinct from human acceptance and delivery", () => {
  const run = projectUnifiedRuns(input([execution({ daylightTaskId: "todo" })]))[0];
  assert.equal(run.status, "succeeded"); assert.equal(run.review.status, "pending");
  assert.equal(run.delivery.status, "unknown"); assert.notEqual(run.id, run.taskId);
  const synced = projectUnifiedRuns(input([execution({ daylightTaskId: "todo", deliveryStatus: "delivered" })]))[0];
  assert.equal(synced.delivery.status, "delivered"); assert.match(synced.delivery.detail!, /不代表外部消息送达/);
  assert.equal(synced.revision, run.revision);
});
test("cancellation request does not claim confirmed process termination", () => {
  const base = { ...input([execution({ status: "cancelled", result: null })]), background: [{ id: "job", text: "检查报告", status: "cancelled" as const, conversationId: 8, createdAt: 1, result: null, taskId: 11 }] };
  assert.equal(projectUnifiedRuns(base)[0].cancellation, "requested");
  assert.equal(projectUnifiedRuns({ ...base, runtime: new Map([[11, { terminal: true }]]) })[0].cancellation, "confirmed");
});
test("delegation legacy metadata stays unknown and known terminal tasks interrupt stale running records", () => {
  const base = { ...input([]), delegations: [{ conversationId: 8 as ConversationId, task: "调查", status: "running" as const, runtimeTaskId: 11 }] };
  const run = projectUnifiedRuns({ ...base, runtime: new Map([[11, { terminal: true, aborted: true }]]) })[0];
  assert.equal(run.status, "interrupted"); assert.equal(run.startedAt, null); assert.equal(run.finishedAt, null);
  assert.equal(run.cancellation, "confirmed"); assert.equal(run.review.status, "not_applicable");
});
test("goal rounds retain independent IDs and evidence without accepting intermediate rounds", () => {
  const goal = { id: "g", conversationId: 7, text: "调研", status: "completed", round: 2, updatedAt: 30,
    history: [{ round: 1, at: 10, action: "continue", summary: "找到资料", evidence: ["来源 A"] }, { round: 2, at: 20, action: "complete", summary: "形成报告", evidence: ["来源 B"] }] } as Goal;
  const runs = projectUnifiedRuns({ ...input([]), goals: [goal] });
  assert.equal(runs.length, 2); assert.equal(runs[0].id, "goal:g:2"); assert.equal(runs[0].taskId, "g");
  assert.equal(runs[0].review.status, "accepted"); assert.equal(runs[1].review.status, "not_applicable");
  assert.deepEqual(runs[0].evidence, ["来源 B"]); assert.equal(runs[0].startedAt, null);
});
function fixture() {
  const docs = new Map<unknown, unknown>([[Executions, { items: [execution()] }], [BackgroundJobs, { items: [] }], [Delegations, { items: [] }], [Goals, { items: [] }], [RunReviews, { items: {} }]]);
  const tx = { doc: async (token: unknown) => docs.get(token), task: async () => null } as unknown as Tx;
  const run = projectUnifiedRuns(input())[0];
  return { docs, tx, run };
}
test("review stores decision independently, replay is idempotent and changed results invalidate it", async () => {
  const f = fixture(), body = { runId: f.run.id, revision: f.run.revision, decision: "accepted", note: "已核对结果" };
  const accepted = await reviewRunInTx(f.tx, 7 as ConversationId, body);
  assert.equal(accepted.review.status, "accepted");
  assert.equal((await reviewRunInTx(f.tx, 7 as ConversationId, body)).review.reviewedAt, accepted.review.reviewedAt);
  const changed = projectUnifiedRuns(input([execution({ result: "新增结果" })]));
  const reviews = (f.docs.get(RunReviews) as { items: Parameters<typeof withRunReviews>[1] }).items;
  assert.equal(withRunReviews(changed, reviews)[0].review.status, "pending");
  f.docs.set(Executions, { items: [execution({ result: "新增结果" })] });
  await assert.rejects(reviewRunInTx(f.tx, 7 as ConversationId, body), /结果已变化/);
});
test("stale reviewers cannot overwrite a decision or note for the same result", async () => {
  const f = fixture(), body = { runId: f.run.id, revision: f.run.revision, decision: "accepted", note: "已核对结果" };
  const accepted = await reviewRunInTx(f.tx, 7 as ConversationId, body);
  for (const stale of [{ ...body, decision: "rejected" }, { ...body, note: "另一窗口的说明" }]) {
    await assert.rejects(reviewRunInTx(f.tx, 7 as ConversationId, stale), { status: 409, message: "该执行结果已验收，请重新读取最新状态" });
    assert.deepEqual((await reviewRunInTx(f.tx, 7 as ConversationId, body)).review, accepted.review);
  }
  const updated = execution({ result: "修订后的结果" });
  f.docs.set(Executions, { items: [updated] });
  const revision = projectUnifiedRuns(input([updated]))[0].revision;
  const rejected = await reviewRunInTx(f.tx, 7 as ConversationId, { ...body, revision, decision: "rejected", note: "仍需修改" });
  assert.equal(rejected.review.status, "rejected");
  assert.equal(rejected.review.note, "仍需修改");
});
test("failed, unfinished, foreign and malformed review requests cannot be accepted", async () => {
  for (const status of ["running", "failed", "cancelled"] as const) {
    const f = fixture(), run = execution({ status }); f.docs.set(Executions, { items: [run] });
    const revision = projectUnifiedRuns(input([run]))[0].revision;
    await assert.rejects(reviewRunInTx(f.tx, 7 as ConversationId, { runId: run.id, revision, decision: "accepted" }), /尚无可验收/);
  }
  const f = fixture(), body = { runId: f.run.id, revision: f.run.revision, decision: "accepted" };
  await assert.rejects(reviewRunInTx(f.tx, 7 as ConversationId, { ...body, decision: "approve" }), /参数无效/);
  await assert.rejects(reviewRunInTx(f.tx, 7 as ConversationId, { ...body, note: 5 }), /参数无效/);
  await assert.rejects(reviewRunInTx(f.tx, 7 as ConversationId, { ...body, runId: "someone-else" }), /不存在/);
});

test("schedule watcher termination does not claim model execution was cancelled", () => {
  const run = execution({ kind: "schedule", id: "schedule:plan:1", runtimeTaskId: 11, status: "running", result: null });
  const projected = projectUnifiedRuns({ ...input([run]), runtime: new Map([[11, { terminal: true }], [12, { terminal: false }]]) })[0];
  assert.equal(projected.status, "interrupted");
  assert.match(projected.error!, /实际模型执行状态未确认/);
  const cancelled = projectUnifiedRuns({ ...input([{ ...run, status: "cancelled" }]), runtime: new Map([[11, { terminal: true }]]) })[0];
  assert.equal(cancelled.cancellation, "unknown");
});

test("review persists across runtime restart and cannot cross conversation boundaries", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { BACKGROUND_CONTEXT: context } = await import("@earendil-works/chord/context");
  const { createModelCatalog, openRuntime } = await import("@assistant/runtime");
  const { fauxAssistantMessage } = await import("@earendil-works/pi-ai/providers/faux");
  const dataDir = await mkdtemp(join(tmpdir(), "dee-run-review-"));
  const { models, agentModel } = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, () => fauxAssistantMessage("test"));
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined;
  try {
    runtime = await openRuntime({ dataDir, models, agentModel, resume: false, extensions: [], onReport: error => { throw error; } }, context);
    const conversation = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const other = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const run = execution({ conversationId: conversation.id });
    await conversation.commit(async tx => { (await tx.doc(Executions, conversation.id)).items.push(run); }, context);
    const projected = projectUnifiedRuns({ ...input([run]), conversationId: conversation.id })[0];
    const body = { runId: projected.id, revision: projected.revision, decision: "accepted", note: "检查过原始报告" };
    await assert.rejects(other.commit(tx => reviewRunInTx(tx, other.id, body), context), /不存在/);
    await conversation.commit(tx => reviewRunInTx(tx, conversation.id, body), context);
    await runtime.harness.close(context); runtime = undefined;
    runtime = await openRuntime({ dataDir, models, agentModel, resume: false, extensions: [], onReport: error => { throw error; } }, context);
    const saved = await runtime.harness.snapshot(RunReviews, conversation.id, context);
    assert.equal(withRunReviews([projected], saved!.items)[0].review.status, "accepted");
    assert.equal(saved!.items[projected.id].note, "检查过原始报告");
    assert.equal((await runtime.harness.snapshot(RunReviews, other.id, context))?.items[projected.id], undefined);
  } finally { await runtime?.harness.close(context); await rm(dataDir, { recursive: true, force: true }); }
});

test("Daylight delivery requires a recorded transition, not a successful no-op", async () => {
  const { applyExecutionResult } = await import("../dist/application/execution-outcome.js");
  type Store = Parameters<typeof applyExecutionResult>[0];
  for (const current of [undefined, "done", "todo", "doing"]) {
    let moves = 0;
    const store = { replayAction: async (_key: string, action: (port: unknown) => unknown) => action({ snapshot: async () => ({ tasks: current ? [{ id: "todo", status: current }] : [] }), moveTask: async () => { moves++; } }) } as unknown as Store;
    assert.equal(await applyExecutionResult(store, execution({ daylightTaskId: "todo" })), ["todo", "doing"].includes(current ?? "") ? "delivered" : "not_applicable");
    assert.equal(moves, ["todo", "doing"].includes(current ?? "") ? 1 : 0);
    assert.equal(await applyExecutionResult(store, execution({ daylightTaskId: "todo", status: "failed" })), "not_applicable");
  }
  const legacyReceipt = { replayAction: async () => ({ ok: true }) } as unknown as Store;
  assert.equal(await applyExecutionResult(legacyReceipt, execution({ daylightTaskId: "todo" })), "unknown");
});

test("schedule result queue progress is independent from execution, Daylight and review fingerprints", () => {
  const base = input([execution({ kind: "schedule", daylightTaskId: "todo", deliveryStatus: "delivered" })]);
  const legacy = projectUnifiedRuns(base)[0];
  assert.equal(legacy.resultDelivery?.status, "unknown");
  const states = [
    { status: "pending" as const, phase: "deliver" as const, attempts: 0 },
    { status: "running" as const, phase: "notify" as const, attempts: 1, rebuilds: 1 },
    { status: "failed" as const, phase: "notify" as const, attempts: 3, error: "queue unavailable" },
    { status: "completed" as const, phase: "notify" as const, notification: "queued" as const },
    { status: "completed" as const, phase: "notify" as const, notification: "skipped" as const },
    { status: "completed" as const, phase: "notify" as const, notification: "unknown" as const },
  ];
  for (const progress of states) {
    const run = projectUnifiedRuns({ ...base, resultDelivery: { [legacy.id]: progress } })[0];
    assert.deepEqual(run.resultDelivery, progress);
    assert.equal(run.status, "succeeded");
    assert.equal(run.delivery.status, "delivered");
    assert.equal(run.revision, legacy.revision);
    const reviewed = withRunReviews([run], { [run.id]: { revision: legacy.revision, decision: "accepted", reviewedAt: 20 } });
    assert.equal(reviewed[0].review.status, "accepted");
  }
  assert.equal(projectUnifiedRuns(input())[0].resultDelivery, undefined);
});

test("terminated result processor cannot leave schedule delivery falsely running", () => {
  const base = input([execution({ kind: "schedule" })]);
  const projected = projectUnifiedRuns({ ...base, resultDelivery: { "background:job": { status: "running", phase: "notify", attempts: 1 } }, resultDeliveryJobs: { "background:job": 90 }, runtime: new Map([[90, { terminal: true }]]) })[0];
  assert.equal(projected.status, "succeeded");
  assert.equal(projected.resultDelivery?.status, "unknown");
  assert.match(projected.resultDelivery!.error!, /最终交付状态未记录/);
});


test("accepted artifacts survive Daylight pending, delivered and failed transitions", async () => {
  const f = fixture();
  const original = execution({ daylightTaskId: "todo", deliveryStatus: "pending" });
  f.docs.set(Executions, { items: [original] });
  const run = projectUnifiedRuns(input([original]))[0];
  await reviewRunInTx(f.tx, 7 as ConversationId, { runId: run.id, revision: run.revision, decision: "accepted" });
  const reviews = (f.docs.get(RunReviews) as { items: Parameters<typeof withRunReviews>[1] }).items;
  for (const extra of [{ deliveryStatus: "delivered" as const }, { deliveryStatus: "pending" as const, deliveryError: "retry failed" }]) {
    const changed = projectUnifiedRuns(input([{ ...original, ...extra }]))[0];
    assert.equal(changed.revision, run.revision);
    assert.equal(withRunReviews([changed], reviews)[0].review.status, "accepted");
  }
  const changed = projectUnifiedRuns(input([{ ...original, result: "different artifact" }]))[0];
  assert.notEqual(changed.revision, run.revision);
  assert.equal(withRunReviews([changed], reviews)[0].review.status, "pending");
});

test("only verifiable current legacy fingerprints migrate, preserving decision time and note", async () => {
  const f = fixture();
  const legacy = legacyRunRevision(f.run);
  const reviews = { [f.run.id]: { revision: legacy, decision: "accepted" as const, note: "original note", reviewedAt: 123 } };
  f.docs.set(RunReviews, { items: reviews });
  assert.equal(withRunReviews([f.run], reviews)[0].review.status, "accepted");
  await assert.rejects(reviewRunInTx(f.tx, 7 as ConversationId, { runId: f.run.id, revision: legacy, decision: "rejected" }), /已验收/);
  const migrated = await reviewRunInTx(f.tx, 7 as ConversationId, { runId: f.run.id, revision: legacy, decision: "accepted", note: "original note" });
  assert.equal(reviews[f.run.id].revision, f.run.revision);
  assert.equal(migrated.review.reviewedAt, 123);
  assert.equal(migrated.review.note, "original note");
  const changed = projectUnifiedRuns(input([execution({ daylightTaskId: "changed-target" })]))[0];
  const unverifiable = { [f.run.id]: { revision: legacy, decision: "accepted" as const, reviewedAt: 123 } };
  assert.equal(withRunReviews([changed], unverifiable)[0].review.status, "pending");
  f.docs.set(Executions, { items: [execution({ result: "changed artifact" })] });
  await assert.rejects(reviewRunInTx(f.tx, 7 as ConversationId, { runId: f.run.id, revision: legacy, decision: "accepted" }), /结果已变化/);
});
