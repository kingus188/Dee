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
  assert.equal(store.read(read.id, 1), undefined); assert.equal(store.read(read.id, 0, { callerId: 1, taskId: 1, callId: "call-1" })?.id, read.id);
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

test("durable read evidence survives reopen, retires old replay keys and keeps fresh reads renewing", async t => {
  const dir = await mkdtemp(join(tmpdir(), "episode-replay-")); let store = openEpisodeStore(dir);
  const db = new DatabaseSync(join(dir, "agent.sqlite"));
  t.after(async () => { store.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  store.add(episode); const row = store.all()[0];
  const read = (taskId: number) => store.read(row.id, 0, { callerId: 1, taskId, callId: `call-${taskId}` });
  assert.equal(read(1)?.readEvidence?.status, "recorded");
  const initial = db.prepare("SELECT observed_at FROM episode_reads").get()!.observed_at;
  const old = new Date(Date.now() - 100 * DAY).toISOString();
  db.prepare("UPDATE episodes SET last_used_at=?,last_read_at=?").run(old, old);
  store.close(); store = openEpisodeStore(dir);
  assert.equal(read(1)?.readEvidence?.status, "replayed");
  assert.equal(db.prepare("SELECT last_read_at FROM episodes").get()!.last_read_at, old);
  assert.equal(db.prepare("SELECT observed_at FROM episode_reads").get()!.observed_at, initial);
  for (let id = 2; id <= 258; id++) assert.ok(read(id));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM episode_reads").get()!.n, 256);
  assert.equal(db.prepare("SELECT read_retired_through FROM episodes").get()!.read_retired_through, 2);
  db.prepare("UPDATE episodes SET last_read_at=?").run(old);
  assert.equal(read(1)?.readEvidence?.status, "outside_window"); assert.equal(read(2)?.readEvidence?.status, "outside_window");
  assert.equal(db.prepare("SELECT last_read_at FROM episodes").get()!.last_read_at, old);
  assert.ok(read(259)); assert.notEqual(db.prepare("SELECT last_read_at FROM episodes").get()!.last_read_at, old);
  const future = new Date(Date.now() + DAY).toISOString();
  db.prepare("UPDATE episodes SET last_read_at=?").run(future);
  assert.equal(read(260)?.readEvidence?.status, "recorded");
  assert.equal(db.prepare("SELECT last_read_at FROM episodes").get()!.last_read_at, future, "a backwards clock cannot move the retention anchor earlier");
  const columns = db.prepare("PRAGMA table_info(episode_reads)").all().map(row => row.name);
  assert.deepEqual(columns, ["episode_id", "revision", "caller_id", "task_id", "call_id", "observed_at"]);
  store.setLastUsed(row.id, old); assert.equal(store.forget(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM episode_reads").get()!.n, 0);
});

test("reads without durable identity or with invalid source never create evidence or renew retention", async t => {
  const dir = await mkdtemp(join(tmpdir(), "episode-unverified-")), store = openEpisodeStore(dir), db = new DatabaseSync(join(dir, "agent.sqlite"));
  t.after(async () => { store.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  store.add(episode); const row = store.all()[0];
  assert.ok(store.read(row.id, 0));
  assert.equal(store.read(row.id, 1, { callerId: 1, taskId: 1, callId: "read" }), undefined);
  assert.equal(db.prepare("SELECT last_read_at FROM episodes").get()!.last_read_at, null);
  store.revokeSource("conv:1");
  assert.equal(store.read(row.id, 0, { callerId: 1, taskId: 1, callId: "read" }), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM episode_reads").get()!.n, 0);
});

test("recording and retention renewal roll back together on failure", async t => {
  const dir = await mkdtemp(join(tmpdir(), "episode-atomic-")), store = openEpisodeStore(dir), db = new DatabaseSync(join(dir, "agent.sqlite"));
  t.after(async () => { store.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  store.add(episode); const row = store.all()[0];
  db.exec("CREATE TRIGGER fail_read BEFORE UPDATE OF last_read_at ON episodes BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(() => store.read(row.id, 0, { callerId: 1, taskId: 1, callId: "read" }), /test failure/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM episode_reads").get()!.n, 0);
  assert.equal(db.prepare("SELECT last_read_at FROM episodes").get()!.last_read_at, null);
  db.exec("DROP TRIGGER fail_read");
  assert.equal(store.read(row.id, 0, { callerId: 1, taskId: 1, callId: "read" })?.readEvidence?.status, "recorded");
});


test("a late first call that retires itself cannot renew retention", async t => {
  const dir = await mkdtemp(join(tmpdir(), "episode-late-")), store = openEpisodeStore(dir), db = new DatabaseSync(join(dir, "agent.sqlite"));
  t.after(async () => { store.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  store.add(episode); const row = store.all()[0];
  for (let taskId = 2; taskId <= 257; taskId++) store.read(row.id, 0, { callerId: 1, taskId, callId: `call-${taskId}` });
  const before = new Date(Date.now() - 100 * DAY).toISOString();
  db.prepare("UPDATE episodes SET last_read_at=?").run(before);
  const late = store.read(row.id, 0, { callerId: 1, taskId: 1, callId: "late" });
  assert.deepEqual(late?.readEvidence, { kind: "explicit_read", status: "outside_window" });
  assert.equal(db.prepare("SELECT last_read_at FROM episodes").get()!.last_read_at, before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM episode_reads").get()!.n, 256);
});
