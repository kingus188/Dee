import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Index, type Runtime } from "@assistant/runtime";
import { normalizeSourceBefore, sourceTimeRange, createEpisodes } from "@assistant/features";
import { openEpisodeStore } from "../dist/episode-store.js";
import { createEpisodeReader } from "../dist/episode-reader.js";
import { conversationBatches } from "../dist/episode-sources.js";

const cutoff = "2026-01-31T23:59:59.000Z";
const base = { source: "conv:2", channel: "web", label: "history", summary: "project observation", openItems: [], messageIds: ["1"], periodStart: "2026-01-01T00:00:00.000Z", periodEnd: cutoff };
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "dee-episode-time-"));
  const store = openEpisodeStore(dir);
  const items = [{ id: 2, title: "private", createdAt: "2026-01-01" }];
  const runtime = { root: { id: 1 }, harness: { snapshot: async (doc: unknown) => doc === Index ? { items } : undefined } } as unknown as Runtime;
  const reader = createEpisodeReader(runtime, ctx, store, { offline: () => false, teams: {} });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, runtime, reader, items };
}

test("sourceBefore requires a real complete timezone-qualified date and normalizes equivalent offsets", () => {
  assert.equal(normalizeSourceBefore("2026-02-01T07:59:59+08:00"), cutoff);
  for (const value of ["2026-01-31", "2026-01-31T23:59:59", "2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00+15:00", "invalid", "0000-01-01T00:00:00+14:00", "9999-12-31T23:59:59-14:00"]) assert.throws(() => normalizeSourceBefore(value));
  assert.deepEqual(sourceTimeRange(["2026-01-03T00:00:00Z", "2026-01-01T00:00:00Z"]), { periodStart: "2026-01-01T00:00:00.000Z", periodEnd: "2026-01-03T00:00:00.000Z", sourceTimeVerified: true });
  assert.equal(sourceTimeRange([NaN]), undefined);
});

test("time filter precedes scan budgets and excludes unknown or cross-boundary summaries", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 90; i++) f.store.add({ ...base, periodEnd: "2026-10-01T00:00:00.000Z", sourceTimeVerified: true });
  f.store.add({ ...base, label: "legacy unknown" });
  f.store.add({ ...base, label: "eligible", sourceTimeVerified: true });
  const rows = await f.reader.search(2, ["project"], 10, { sourceBefore: "2026-02-01T07:59:59+08:00" });
  assert.deepEqual(rows.map(row => row.label), ["eligible"]);
  assert.equal(rows.scan!.scanned, 1);
  const all = f.store.all(), unknown = all.find(row => row.label === "legacy unknown")!;
  assert.ok(await f.reader.read(2, unknown.id));
  assert.equal(await f.reader.read(2, unknown.id, undefined, { sourceBefore: cutoff }), undefined);
  const crossing = all.find(row => row.periodEnd.startsWith("2026-10"))!;
  assert.equal(await f.reader.read(2, crossing.id, undefined, { sourceBefore: cutoff }), undefined);
  assert.ok(await f.reader.read(2, rows[0].id, undefined, { sourceBefore: cutoff }));
  f.store.revokeSource("conv:2", "1");
  assert.equal((await f.reader.search(2, ["project"], 10, { sourceBefore: cutoff })).length, 0);
});

test("invalid verified ranges cannot enter the store; rollup inherits trust only from every constituent", async t => {
  const f = await fixture(t);
  assert.equal(f.store.add({ ...base, periodStart: "2027-01-01T00:00:00.000Z", sourceTimeVerified: true }), false);
  assert.equal(f.store.add({ ...base, periodEnd: "invalid", sourceTimeVerified: true }), false);
  f.store.add({ ...base, periodStart: "2026-01-02T00:00:00.000Z", sourceTimeVerified: true });
  f.store.add({ ...base, periodStart: "2026-01-01T00:00:00.000Z", periodEnd: "2026-01-02T00:00:00.000Z", sourceTimeVerified: true });
  assert.ok(f.store.replaceWithRollup(f.store.all().map(row => row.id), { ...base, sourceTimeVerified: true }));
  const verified = f.store.all()[0];
  assert.equal(verified.sourceTimeVerified, true); assert.equal(verified.periodStart, base.periodStart); assert.equal(verified.periodEnd, cutoff);
  f.store.add({ ...base });
  assert.ok(f.store.replaceWithRollup(f.store.all().map(row => row.id), { ...base, sourceTimeVerified: true }));
  assert.equal(f.store.all()[0].sourceTimeVerified, false, "caller cannot upgrade a legacy constituent by claiming verification");
});

test("legacy rows migrate to unknown without inferring historical verification", async t => {
  const dir = await mkdtemp(join(tmpdir(), "dee-episode-time-legacy-"));
  const db = new DatabaseSync(join(dir, "agent.sqlite"));
  db.exec(`CREATE TABLE episodes(id TEXT PRIMARY KEY, source TEXT NOT NULL, label TEXT NOT NULL, channel TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 0, period_start TEXT NOT NULL, period_end TEXT NOT NULL, summary TEXT NOT NULL, open_items TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, last_used_at TEXT NOT NULL);
    INSERT INTO episodes VALUES ('old','conv:2','old','web',0,'2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z','project','[]','2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z')`);
  db.close(); const store = openEpisodeStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(store.peek("old")!.sourceTimeVerified, false);
  assert.equal(store.peek("old")!.summaryRecordedAt, "2026-02-01T00:00:00.000Z");
  assert.equal(store.searchPage(["project"], 10, undefined, { sourceBefore: cutoff }).items.length, 0);
});

test("collector computes min/max from included messages rather than entry order", async t => {
  const f = await fixture(t);
  const entries = [Date.parse("2026-01-03T00:00:00Z"), Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-01-02T00:00:00Z")].map((timestamp, index) => ({ id: index + 1, kind: "pi.user", model: [{ role: "user", content: "project evidence", timestamp }] }));
  const harness = { ...f.runtime.harness, conversation: async () => ({ entries: async () => ({ items: entries }) }) } as unknown as Runtime["harness"];
  const batches = await conversationBatches({ harness, ctx, episodeStore: f.store }, () => undefined);
  assert.equal(batches[0].periodStart, "2026-01-01T00:00:00.000Z"); assert.equal(batches[0].periodEnd, "2026-01-03T00:00:00.000Z"); assert.equal(batches[0].sourceTimeVerified, true);
  entries[1].model[0].timestamp = NaN;
  assert.deepEqual(await conversationBatches({ harness, ctx, episodeStore: f.store }, () => undefined), []);
});

test("real tool parameters propagate one normalized source boundary and retain unknown fact validity", async t => {
  const f = await fixture(t); f.store.add({ ...base, sourceTimeVerified: true });
  const extension = createEpisodes(f.reader), api = { conversationId: 2 } as never;
  const recall = extension.tools!.find(tool => tool.name === "recall")!, read = extension.tools!.find(tool => tool.name === "read_episode")!;
  const result = JSON.stringify(await recall.execute({ query: "project", sourceBefore: cutoff }, api, {} as never));
  assert.match(result, /source_message_creation_time/); assert.match(result, /not_resolved/); assert.match(result, /后来编辑/);
  const detailed = JSON.stringify(await read.execute({ id: f.store.all()[0].id, sourceBefore: cutoff }, api, {} as never));
  assert.match(detailed, /factValidity/); assert.match(detailed, /unknown/); assert.match(detailed, /summaryRecordedAt/);
  await assert.rejects(recall.execute({ query: "project", sourceBefore: "2026-01-01" }, api, {} as never));
});

test("generation uses host time evidence, never extra verification fields in model JSON", async t => {
  const f = await fixture(t);
  const { runEpisodePass } = await import("../dist/episode-job.js");
  await runEpisodePass({ store: f.store, allowSource: async () => true,
    collect: async () => [{ ...base, text: "ordinary evidence ".repeat(50), chars: 850, cursor: "1", afterCursor: null }],
    summarize: async () => JSON.stringify({ summary: "project observation", openItems: [], sourceTimeVerified: true, effectiveAt: "2026-01-01" }), log: () => {}, now: () => Date.parse("2026-02-03T00:00:00Z"),
  });
  assert.equal(f.store.all()[0].sourceTimeVerified, false);
  assert.equal("effectiveAt" in f.store.all()[0], false);
  assert.equal(f.store.searchPage(["project"], 10, undefined, { sourceBefore: cutoff }).items.length, 0);
});
