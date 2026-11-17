import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Index, type Runtime } from "@assistant/runtime";
import { createEpisodes, normalizeSummaryRecordedBefore } from "@assistant/features";
import { openEpisodeStore } from "../dist/episode-store.js";
import { createEpisodeReader } from "../dist/episode-reader.js";
const cutoff = "2026-01-31T23:59:59.000Z";
const base = { source: "conv:2", channel: "web", label: "history", summary: "project observation", openItems: [], messageIds: ["1"], periodStart: "2026-01-01T00:00:00.000Z", periodEnd: "2026-01-02T00:00:00.000Z", sourceTimeVerified: true };
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "dee-recorded-time-")), store = openEpisodeStore(dir), db = new DatabaseSync(join(dir, "agent.sqlite"));
  const runtime = { root: { id: 1 }, harness: { snapshot: async (doc: unknown) => doc === Index ? { items: [{ id: 2, title: "private", createdAt: "2026-01-01" }] } : undefined } } as unknown as Runtime;
  const reader = createEpisodeReader(runtime, ctx, store, { offline: () => false, teams: {} });
  t.after(async () => { db.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  function add(label: string, recordedAt: string, sourceTimeVerified = true) {
    store.add({ ...base, label, sourceTimeVerified });
    const row = store.all().find(row => row.label === label)!;
    // Synthetic fixture clock values only; production created_at is host-owned.
    db.prepare("UPDATE episodes SET created_at=? WHERE id=?").run(recordedAt, row.id);
    return row.id;
  }
  return { store, db, reader, add };
}

test("late summaries with old source times are excluded before scan budget by the recording boundary", async t => {
  const f = await fixture(t), old = f.add("early", cutoff);
  for (let i = 0; i < 90; i++) f.add(`late-${i}`, "2026-10-01T00:00:00.000Z");
  assert.ok((await f.reader.search(2, ["project"], 10, { sourceBefore: cutoff })).some(row => row.id !== old));
  const rows = await f.reader.search(2, ["project"], 10, { sourceBefore: cutoff, summaryRecordedBefore: "2026-02-01T07:59:59+08:00" });
  assert.deepEqual(rows.map(row => row.id), [old]); assert.equal(rows.scan!.scanned, 1);
  const late = f.store.all().find(row => row.label === "late-0")!;
  assert.equal(await f.reader.read(2, late.id, undefined, { sourceBefore: cutoff, summaryRecordedBefore: cutoff }), undefined);
  assert.equal(f.db.prepare("SELECT last_read_at FROM episodes WHERE id=?").get(late.id)!.last_read_at, null);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM episode_reads WHERE episode_id=?").get(late.id)!.n, 0);
});

test("source and recording windows are independent and conjunctive when both supplied", async t => {
  const f = await fixture(t), unknownSource = f.add("legacy source range", cutoff, false);
  assert.deepEqual((await f.reader.search(2, ["project"], 10, { summaryRecordedBefore: cutoff })).map(row => row.id), [unknownSource]);
  assert.equal((await f.reader.search(2, ["project"], 10, { sourceBefore: cutoff, summaryRecordedBefore: cutoff })).length, 0);
  assert.ok(await f.reader.read(2, unknownSource, undefined, { summaryRecordedBefore: cutoff }));
});

test("malformed legacy storage dates stay unknown and fail equally in search and explicit read", async t => {
  const f = await fixture(t);
  for (const [index, invalid] of ["2026-02-30T00:00:00Z", "2026-01-01", "123", ""].entries()) {
    const id = f.add(`invalid-${index}`, invalid);
    assert.ok(await f.reader.read(2, id)); assert.equal(f.store.peek(id)!.summaryRecordedAt, undefined);
    assert.equal(await f.reader.read(2, id, undefined, { summaryRecordedBefore: "2026-12-31T00:00:00Z" }), undefined);
  }
  assert.equal((await f.reader.search(2, ["project"], 10, { summaryRecordedBefore: "2026-12-31T00:00:00Z" })).length, 0);
  assert.equal(normalizeSummaryRecordedBefore("2026-02-01T07:59:59+08:00"), cutoff);
  for (const value of ["2026-01-01", "2026-02-30T00:00:00Z", "0000-01-01T00:00:00+14:00"]) assert.throws(() => normalizeSummaryRecordedBefore(value), /summaryRecordedBefore/);
});

test("exposure and reads never alter record time; rollup gets its own new host time", async t => {
  const f = await fixture(t);
  const a = f.add("a", "2020-01-01T00:00:00.000Z"), b = f.add("b", "2020-01-02T00:00:00.000Z");
  f.store.expose(a, 0); f.store.read(a, 0);
  assert.equal(f.store.peek(a)!.summaryRecordedAt, "2020-01-01T00:00:00.000Z");
  assert.ok(f.store.replaceWithRollup([a, b], base));
  const merged = f.store.all()[0]; assert.ok(merged.summaryRecordedAt! > "2021-01-01T00:00:00.000Z");
  assert.equal((await f.reader.search(2, ["project"], 10, { summaryRecordedBefore: "2021-01-01T00:00:00Z" })).length, 0);
  f.store.revokeSource("conv:2", "1");
  assert.equal(await f.reader.read(2, merged.id, undefined, { summaryRecordedBefore: "2099-01-01T00:00:00Z" }), undefined);
});

test("real tool entry points forward both bounds and label fact validity unknown", async t => {
  const f = await fixture(t), id = f.add("early", cutoff);
  const extension = createEpisodes(f.reader), api = { conversationId: 2 } as never;
  const recall = extension.tools!.find(tool => tool.name === "recall")!, read = extension.tools!.find(tool => tool.name === "read_episode")!;
  const query = { sourceBefore: cutoff, summaryRecordedBefore: cutoff };
  const recalled = JSON.stringify(await recall.execute({ query: "project", ...query }, api, {} as never));
  assert.match(recalled, /summaryRecordedBefore/); assert.match(recalled, /current_summary_storage_time/); assert.match(recalled, /not_resolved/);
  const detailed = JSON.stringify(await read.execute({ id, ...query }, api, {} as never));
  assert.match(detailed, /withinRecordedWindow/); assert.match(detailed, /factValidity/); assert.match(detailed, /unknown/);
  await assert.rejects(read.execute({ id, summaryRecordedBefore: "yesterday" }, api, {} as never), /summaryRecordedBefore/);
});
