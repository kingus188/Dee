import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, openRuntime, Index } from "@assistant/runtime";
import { createEpisodes, type EpisodeReader, type EpisodeRecord, type EpisodeTimeQuery } from "@assistant/features";
import { createEpisodeReader } from "../dist/episode-reader.js";
import { openEpisodeStore } from "../dist/episode-store.js";
import { JANUARY_CUTOFF } from "./fixtures/memory-time-evaluation.js";
import { MEMORY_EVAL_NOW } from "./fixtures/memory-evaluation.js";

const EARLY = "2026-01-15T12:00:00.000Z";
const RECORDED_CUTOFF = "2026-03-01T12:00:00.000Z";
// Independent fixed availability truth, not truth about effective dates.
const CURRENT = ["original", "boundary", "late-correction", "later-source", "invalid-recorded"];
const SOURCE_ONLY = ["original", "boundary", "late-correction", "invalid-recorded"];
const RECORDED_ONLY = ["original", "boundary"];

test("晚到更正固定评测区分来源创建和本次入库，不重建历史事实", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(EARLY) });
  const directory = await mkdtemp(join(tmpdir(), "dee-recorded-time-eval-"));
  const store = openEpisodeStore(directory);
  let reader: ReturnType<typeof createEpisodeReader>, target = "", time: EpisodeTimeQuery = {};
  const receipts: EpisodeRecord[] = [];
  const adapter: EpisodeReader = { search: (...args) => reader.search(...args), openItems: (...args) => reader.openItems(...args),
    read: async (...args) => { const row = await reader.read(...args); if (row) receipts.push(row); return row; } };
  const { models, agentModel } = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, transcript => transcript.messages.at(-1)?.role === "user"
    ? fauxAssistantMessage(fauxToolCall("read_episode", { id: target, ...time }), { stopReason: "toolUse" }) : fauxAssistantMessage("read finished"));
  const runtime = await openRuntime({ dataDir: directory, models, agentModel, extensions: [createEpisodes(adapter)], onReport: error => { throw error; } }, ctx);
  const db = new DatabaseSync(join(directory, "agent.sqlite"));
  try {
    const owner = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: agentModel } }, ctx);
    const withdrawn = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
    await owner.commit(async tx => { (await tx.doc(Index)).items.push(...[owner, withdrawn].map(item => ({ id: item.id, title: "synthetic", createdAt: EARLY }))); }, ctx);
    const add = (label: string, summary: string, source = `conv:${owner.id}`, sourceEnd = "2026-01-10T12:00:00.000Z") => {
      assert.equal(store.add({ label, summary, source, channel: "web", periodStart: "2026-01-10T10:00:00.000Z", periodEnd: sourceEnd, sourceTimeVerified: true, openItems: [] }), true);
      return store.all().find(row => row.label === label)!.id;
    };
    const original = add("original", "更正评测：早期摘要称预算30，有效期未注明。");
    const revoked = add("revoked", "更正评测：后来撤回的旧记录。", `conv:${withdrawn.id}`);
    t.mock.timers.setTime(Date.parse(RECORDED_CUTOFF));
    const boundary = add("boundary", "更正评测：补充审批条件，未声明生效时间。");
    t.mock.timers.setTime(Date.parse(MEMORY_EVAL_NOW));
    const correction = add("late-correction", "更正评测：晚到摘要称原消息预算实际为20，与原摘要矛盾，未注明事实生效日。");
    add("later-source", "更正评测：十月消息的另一项记录。", undefined, "2026-10-01T12:00:00.000Z");
    const invalid = add("invalid-recorded", "更正评测：模拟遗留损坏入库时间，事实有效日未知。");
    // Explicit corruption fixture only. Production add derives created_at from
    // the host clock; this test does not pass a model-controlled storage time.
    db.prepare("UPDATE episodes SET created_at=? WHERE id=?").run("invalid-time", invalid);
    store.revokeSource(`conv:${withdrawn.id}`);
    reader = createEpisodeReader(runtime, ctx, store, { offline: () => false, teams: { canReadEpisodeSource: async () => false } });
    const queries = [
      { name: "current", time: {}, truth: CURRENT },
      { name: "source-only", time: { sourceBefore: JANUARY_CUTOFF }, truth: SOURCE_ONLY },
      { name: "recorded-only", time: { summaryRecordedBefore: RECORDED_CUTOFF }, truth: RECORDED_ONLY },
      { name: "both", time: { sourceBefore: JANUARY_CUTOFF, summaryRecordedBefore: RECORDED_CUTOFF }, truth: RECORDED_ONLY },
    ];
    const results = [];
    for (const query of queries) {
      const rows = await reader.search(owner.id, ["更正评测"], 10, query.time);
      assert.deepEqual(rows.map(row => row.label).sort(), [...query.truth].sort());
      results.push({ name: query.name, availableHits: rows.filter(row => query.truth.includes(row.label)).length, availableTotal: query.truth.length,
        outsideTruth: rows.filter(row => !query.truth.includes(row.label)).length, returned: rows.length, summaryChars: rows.reduce((sum, row) => sum + row.summary.length, 0), scan: rows.scan });
    }
    assert.equal((await reader.read(owner.id, correction, undefined, { sourceBefore: JANUARY_CUTOFF }))?.summaryRecordedAt, MEMORY_EVAL_NOW);
    assert.equal(await reader.read(owner.id, correction, undefined, { summaryRecordedBefore: RECORDED_CUTOFF }), undefined);
    assert.equal(await reader.read(owner.id, invalid, undefined, { summaryRecordedBefore: MEMORY_EVAL_NOW }), undefined);
    assert.equal((await reader.read(owner.id, invalid))?.summaryRecordedAt, undefined);
    assert.equal(await reader.read(owner.id, revoked, undefined, { summaryRecordedBefore: RECORDED_CUTOFF }), undefined);
    const submit = async () => {
      const submission = await owner.submit({ type: "input", content: "Read the synthetic record using the supplied temporal boundaries." }, ctx);
      assert.equal((await submission.wait(ctx)).status, "done");
    };
    target = correction; time = { sourceBefore: JANUARY_CUTOFF }; await submit();
    assert.equal(receipts.at(-1)?.id, correction);
    assert.equal(receipts.at(-1)?.readEvidence?.status, "recorded");
    const ledger = () => ({ count: db.prepare("SELECT COUNT(*) AS count FROM episode_reads WHERE episode_id=?").get(correction)!.count,
      lastRead: db.prepare("SELECT last_read_at FROM episodes WHERE id=?").get(correction)!.last_read_at });
    const beforeReject = ledger();
    t.mock.timers.setTime(Date.parse(MEMORY_EVAL_NOW) + 1000);
    time = { sourceBefore: JANUARY_CUTOFF, summaryRecordedBefore: RECORDED_CUTOFF }; await submit();
    assert.equal(receipts.length, 1);
    assert.deepEqual(ledger(), beforeReject, "record cutoff rejection cannot renew read evidence");
    target = original; time = { summaryRecordedBefore: RECORDED_CUTOFF };
    for (let i = 0; i < 3; i++) await submit();
    assert.ok(receipts.slice(1).every(row => row.summaryRecordedAt === EARLY && row.readEvidence?.status === "recorded"));
    const recordedAtAfterRepeatedReads = store.peek(original)?.summaryRecordedAt;
    assert.equal(recordedAtAfterRepeatedReads, EARLY);
    const entries = await owner.entries({}, 100, undefined, ctx);
    const texts = entries.items.filter(entry => entry.kind === "pi.tool-result").flatMap(entry => {
      const content = entry.model?.[0]?.content; return Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text) : [];
    });
    assert.equal(texts.length, 5);
    const refused = texts.filter(text => !text.startsWith("{"));
    assert.equal(refused.length, 1); assert.match(refused[0]!, /边界/);
    assert.ok(!refused[0]!.includes(store.peek(correction)!.summary));
    const payloads = texts.filter(text => text.startsWith("{")).map(text => JSON.parse(text));
    assert.ok(payloads.every(row => row.temporal.factValidity === "unknown" && row.temporal.supersession === "unknown" && row.temporal.conflicts === "not_resolved"));
    assert.ok(payloads.some(row => row.temporal.summaryRecordedBefore === RECORDED_CUTOFF && row.temporal.withinRecordedWindow === true));
    // Retention/rollup is not an event-time archive. Old IDs are removed and the
    // current aggregate is recorded now, not backdated to its source messages.
    assert.equal(store.replaceWithRollup([original, boundary], { source: `conv:${owner.id}`, channel: "web", label: "rollup", summary: "更正评测：两份早期摘要的有损合并。", periodStart: EARLY, periodEnd: EARLY, openItems: [] }), true);
    assert.equal(await reader.read(owner.id, original), undefined);
    const merged = store.all().find(row => row.label === "rollup")!;
    assert.notEqual(merged.id, original); assert.equal(merged.summaryRecordedAt, new Date(Date.parse(MEMORY_EVAL_NOW) + 1000).toISOString());
    const afterRollup = await reader.search(owner.id, ["更正评测"], 10, { summaryRecordedBefore: RECORDED_CUTOFF });
    assert.equal(afterRollup.length, 0, "zero extant records is not proof there were no historical records");
    t.diagnostic(JSON.stringify({ corpusVersion: "synthetic-late-correction-v1", cases: results, genuineReads: receipts.length, rejectedSdkReads: refused.length,
      recordedAtAfterRepeatedReads, afterRollupAvailable: afterRollup.length,
      temporalClaim: "factValidity and supersession unknown; conflicts not resolved", limitations: "Availability of extant authorized summaries only, not facts or complete historical knowledge. Synthetic corruption explicit. Model accuracy/citation errors/real tokens/fees not measured." }));
  } finally { db.close(); await runtime.harness.close(ctx); store.close(); await rm(directory, { recursive: true, force: true }); }
});
