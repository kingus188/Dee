import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, openRuntime, Index } from "@assistant/runtime";
import { createEpisodes, type EpisodeRecord, type EpisodeReader } from "@assistant/features";
import { openEpisodeStore } from "../dist/episode-store.js";
import { createEpisodeReader } from "../dist/episode-reader.js";
import { MEMORY_EVAL_NOW } from "./fixtures/memory-evaluation.js";
import { JANUARY_CUTOFF, TIME_EVAL_ROWS, TIME_EVAL_VERSION } from "./fixtures/memory-time-evaluation.js";

test("固定来源窗口评测不把历史可用性当事实有效性或读取次数当优先级", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(MEMORY_EVAL_NOW) });
  const dir = await mkdtemp(join(tmpdir(), "dee-memory-time-eval-"));
  const store = openEpisodeStore(dir);
  let reader: ReturnType<typeof createEpisodeReader>, target = "";
  const reads: EpisodeRecord[] = [];
  const adapter: EpisodeReader = {
    search: (...args) => reader.search(...args), openItems: (...args) => reader.openItems(...args),
    read: async (...args) => { const row = await reader.read(...args); if (row) reads.push(row); return row; },
  };
  const { models, agentModel } = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => transcript.messages.at(-1)?.role === "user"
    ? fauxAssistantMessage(fauxToolCall("read_episode", { id: target, sourceBefore: JANUARY_CUTOFF }), { stopReason: "toolUse" }) : fauxAssistantMessage("read completed"));
  const runtime = await openRuntime({ dataDir: dir, models, agentModel, extensions: [createEpisodes(adapter)], onReport: error => { throw error; } }, ctx);
  try {
    const owner = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: agentModel } }, ctx);
    const denied = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
    const revoked = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
    await owner.commit(async tx => { (await tx.doc(Index)).items.push(...[owner, denied, revoked].map(item => ({ id: item.id, title: "time fixture", createdAt: MEMORY_EVAL_NOW, ...(item.id === denied.id ? { channel: "teams" } : {}) }))); }, ctx);
    for (const row of TIME_EVAL_ROWS) store.add({ source: `conv:${row.access === "denied" ? denied.id : row.access === "revoked" ? revoked.id : owner.id}`, channel: row.access === "denied" ? "teams" : "web", label: row.label, summary: row.summary,
      periodStart: row.start, periodEnd: row.end, ...(row.trusted ? { sourceTimeVerified: true } : {}), openItems: [] });
    const ids = new Map(store.all().map(row => [row.label, row.id]));
    store.revokeSource(`conv:${revoked.id}`);
    reader = createEpisodeReader(runtime, ctx, store, { offline: () => false, teams: { canReadEpisodeSource: async () => false } });
    const current = await reader.search(owner.id, ["预算窗口"], 10);
    const historical = await reader.search(owner.id, ["预算窗口"], 10, { sourceBefore: JANUARY_CUTOFF });
    const equivalent = await reader.search(owner.id, ["预算窗口"], 10, { sourceBefore: "2026-02-01T07:59:59+08:00" });
    const currentTruth = TIME_EVAL_ROWS.filter(row => row.access === "private").map(row => row.label);
    const historicalTruth = TIME_EVAL_ROWS.filter(row => row.historical).map(row => row.label);
    assert.deepEqual(current.map(row => row.label).sort(), [...currentTruth].sort());
    assert.deepEqual(historical.map(row => row.label).sort(), [...historicalTruth].sort());
    assert.deepEqual(equivalent.map(row => row.id), historical.map(row => row.id));
    const direct: Record<string, boolean> = {};
    for (const row of TIME_EVAL_ROWS) {
      const result = await reader.read(owner.id, ids.get(row.label)!, undefined, { sourceBefore: JANUARY_CUTOFF });
      direct[row.label] = !!result;
      assert.equal(!!result, row.historical, `按ID也不能绕过时间/撤回/权限：${row.label}`);
    }
    target = ids.get("january")!;
    for (let i = 0; i < 4; i++) {
      const submission = await owner.submit({ type: "input", content: `Read the January synthetic record, attempt ${i}.` }, ctx);
      assert.equal((await submission.wait(ctx)).status, "done");
    }
    assert.equal(reads.length, 4);
    assert.ok(reads.every(row => row.readEvidence?.status === "recorded"));
    target = ids.get("october-update")!;
    const db = new DatabaseSync(join(dir, "agent.sqlite"));
    const ledger = () => ({ count: db.prepare("SELECT COUNT(*) AS count FROM episode_reads WHERE episode_id=?").get(target)!.count,
      lastRead: db.prepare("SELECT last_read_at FROM episodes WHERE id=?").get(target)!.last_read_at });
    try {
      const beforeDenied = ledger();
      const submission = await owner.submit({ type: "input", content: "Read the October synthetic record with the January cutoff." }, ctx);
      assert.equal((await submission.wait(ctx)).status, "done");
      assert.equal(reads.length, 4, "越界SDK读取不能返回完整摘要或新增recorded证据");
      assert.deepEqual(ledger(), beforeDenied, "越界工具调用不续期、不记录读取");
    } finally { db.close(); }
    const afterReads = await reader.search(owner.id, ["预算窗口"], 10);
    assert.deepEqual(afterReads.map(row => row.id), current.map(row => row.id), "真实独立读取不更改SQL检索优先级");
    const entries = await owner.entries({}, 100, undefined, ctx);
    const toolTexts = entries.items.filter(entry => entry.kind === "pi.tool-result").flatMap(entry => {
      const content = entry.model?.[0]?.content;
      return Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text) : [];
    });
    assert.equal(toolTexts.length, 5);
    const rejectedTexts = toolTexts.filter(text => !text.startsWith("{"));
    assert.equal(rejectedTexts.length, 1);
    assert.match(rejectedTexts[0]!, /不符合来源(?:或摘要入库)?时间边界/);
    assert.ok(!rejectedTexts[0]!.includes(TIME_EVAL_ROWS.find(row => row.label === "october-update")!.summary));
    const toolRows = toolTexts.filter(text => text.startsWith("{")).map(text => JSON.parse(text) as { temporal: { sourceBefore: string; withinSourceWindow: boolean; factValidity: string; supersession: string; conflicts: string } });
    assert.equal(toolRows.length, 4);
    assert.ok(toolRows.every(row => row.temporal.sourceBefore === JANUARY_CUTOFF && row.temporal.withinSourceWindow === true));
    assert.ok(toolRows.every(row => row.temporal.factValidity === "unknown" && row.temporal.supersession === "unknown" && row.temporal.conflicts === "not_resolved"));
    const metric = (rows: EpisodeRecord[], truth: readonly string[]) => ({ availableHits: rows.filter(row => truth.includes(row.label)).length, availableTotal: truth.length,
      availableRecall: rows.filter(row => truth.includes(row.label)).length / truth.length,
      outsideTruth: rows.filter(row => !truth.includes(row.label)).length, returned: rows.length, summaryChars: rows.reduce((sum, row) => sum + row.summary.length, 0) });
    t.diagnostic(JSON.stringify({ corpusVersion: TIME_EVAL_VERSION, rows: TIME_EVAL_ROWS.length, current: metric(current, currentTruth), historical: metric(historical, historicalTruth),
      currentLabels: current.map(row => row.label), historicalLabels: historical.map(row => row.label), directReads: direct, currentScan: current.scan, historicalScan: historical.scan,
      genuineReads: reads.length, rejectedSdkReads: rejectedTexts.length, orderAfterReads: "unchanged", contradiction: "not_resolved", factValidity: "unknown", supersession: "unknown",
      limits: "Synthetic source-window availability, not historical fact truth or knowledge reconstruction. Model answer accuracy, citation correctness, real tokens and fees not measured. Existing lexical ranking unchanged." }));
  } finally { await runtime.harness.close(ctx); store.close(); await rm(dir, { recursive: true, force: true }); }
});
