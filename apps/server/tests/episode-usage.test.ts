import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEpisodeStore } from "../dist/episode-store.js";
const DAY = 86400_000;
const episode = { source: "conv:1", label: "Synthetic", channel: "web", periodStart: "2026-01-01", periodEnd: "2026-01-01", summary: "project fact", openItems: [], messageIds: ["12", "13"] };

test("candidate exposure is separate from explicit reading and does not extend retention", async t => {
  const dir = await mkdtemp(join(tmpdir(), "episode-usage-")); const store = openEpisodeStore(dir), db = new DatabaseSync(join(dir, "agent.sqlite"));
  t.after(async () => { db.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  store.add(episode); const [row] = store.all();
  store.setLastUsed(row.id, new Date(Date.now() - 100 * DAY).toISOString());
  const hit = store.search(["project"], 1)[0]; assert.equal(hit.id, row.id); assert.deepEqual(hit.messageIds, ["12", "13"]);
  assert.equal(db.prepare("SELECT last_read_at FROM episodes").get()?.last_read_at, null);
  assert.equal(db.prepare("SELECT last_exposed_at FROM episodes").get()?.last_exposed_at, null, "a database match is not authorized exposure");
  assert.equal(store.expose(hit.id, 0)?.id, hit.id);
  assert.ok(db.prepare("SELECT last_exposed_at FROM episodes").get()?.last_exposed_at);
  assert.equal(store.forget(), 1);
  store.add(episode); const [read] = store.all(); store.setLastUsed(read.id, new Date(Date.now() - 100 * DAY).toISOString());
  assert.equal(store.read(read.id, 1), undefined); assert.equal(store.read(read.id, 0)?.id, read.id);
  assert.equal(store.forget(), 0); assert.ok(db.prepare("SELECT last_read_at FROM episodes").get()?.last_read_at);
  store.revokeSource("conv:1", "12"); assert.equal(store.peek(read.id), undefined); assert.equal(store.read(read.id), undefined);
});

test("legacy last_used_at is preserved as retention baseline, never backfilled as a read", async t => {
  const dir = await mkdtemp(join(tmpdir(), "episode-migration-")), db = new DatabaseSync(join(dir, "agent.sqlite"));
  db.exec(`CREATE TABLE episodes (id TEXT PRIMARY KEY,source TEXT NOT NULL,label TEXT NOT NULL,channel TEXT NOT NULL,level INTEGER NOT NULL DEFAULT 0,
    period_start TEXT NOT NULL,period_end TEXT NOT NULL,summary TEXT NOT NULL,open_items TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,last_used_at TEXT NOT NULL)`);
  const baseline = new Date(Date.now() - 100 * DAY).toISOString();
  db.prepare("INSERT INTO episodes VALUES ('legacy','conv:1','label','web',0,?,?,?,'[]',?,?)").run(baseline, baseline, "summary", baseline, baseline);
  const store = openEpisodeStore(dir);
  t.after(async () => { store.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  const row = db.prepare("SELECT last_used_at,last_read_at,last_exposed_at FROM episodes").get()!;
  assert.equal(row.last_used_at, baseline); assert.equal(row.last_read_at, null); assert.equal(row.last_exposed_at, null);
  assert.equal(store.forget(), 1, "migration does not grant old records another 90 days");
});

test("rollup preserves source provenance and exact original message identifiers", async t => {
  const dir = await mkdtemp(join(tmpdir(), "episode-rollup-proof-")), store = openEpisodeStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  store.add(episode); store.add({ ...episode, messageIds: ["13", "14"] });
  const originals = store.all(); assert.equal(store.replaceWithRollup(originals.map(row => row.id), episode), true);
  const [merged] = store.all(); assert.equal(merged.sourceRevision, 0); assert.deepEqual(merged.messageIds, ["12", "13", "14"]);
  for (const row of originals) assert.equal(store.read(row.id), undefined);
  assert.equal(store.read(merged.id)?.level, 1);
});
