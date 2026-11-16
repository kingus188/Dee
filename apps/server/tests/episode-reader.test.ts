import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Index, type Runtime } from "@assistant/runtime";
import { WechatState } from "@assistant/channel-wechat";
import { createEpisodeReader } from "../dist/episode-reader.js";
import { openEpisodeStore } from "../dist/episode-store.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "dee-episode-reader-"));
  const store = openEpisodeStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const items: Array<{ id: number; title: string; channel?: string; createdAt: string; archivedAt?: string; archivingAt?: string }> = [2, 3, 4, 5, 6].map(id => ({ id, title: `conversation ${id}`, createdAt: "2026-01-01" }));
  items[1].channel = "teams"; items[2].channel = "wechat"; items[3].channel = "desktop";
  const bound = new Set<number>();
  let offline = false, canRead = true, probes = 0, onProbe: (() => void) | undefined;
  const runtime = { root: { id: 1 }, harness: { snapshot: async (doc: unknown) => doc === Index ? { items } : doc === WechatState ? { bindings: Object.fromEntries([...bound].map(id => [id, { conversationId: id }])) } : undefined } } as unknown as Runtime;
  const reader = createEpisodeReader(runtime, ctx, store, { offline: () => offline, teams: { canReadEpisodeSource: async () => { probes++; onProbe?.(); return canRead; } } });
  for (const [source, channel] of [["conv:2", "web"], ["conv:3", "teams"], ["conv:4", "wechat"], ["conv:5", "desktop"], ["teams:chat", "teams"]]) store.add({ source, channel, label: `project ${source}`, summary: `project summary ${source}`, openItems: [`follow up ${source}`], periodStart: new Date().toISOString(), periodEnd: new Date().toISOString(), messageIds: ["1"] });
  const id = (source: string) => store.all().find(row => row.source === source)!.id;
  return { reader, store, items, bound, id, directory, probes: () => probes, setOffline: () => { offline = true; }, deny: () => { canRead = false; }, onProbe: (fn: () => void) => { onProbe = fn; } };
}

test("episode candidate, detail and open-item readers apply the same private caller/source boundary", async t => {
  const f = await fixture(t);
  const candidates = await f.reader.search(2, ["project"], 10);
  assert.deepEqual(candidates.map(row => row.source).sort(), ["conv:2", "conv:5", "teams:chat"]);
  assert.equal((await f.reader.read(2, f.id("conv:5")))!.source, "conv:5");
  assert.equal(await f.reader.read(2, f.id("conv:3")), undefined);
  assert.equal(await f.reader.read(2, f.id("conv:4")), undefined);
  assert.deepEqual((await f.reader.openItems(2, 30, 10)).map(item => item.source).sort(), ["conv:2", "conv:5", "teams:chat"]);
  for (const caller of [1, 3, 4, 999]) {
    await assert.rejects(async () => f.reader.search(caller, ["project"], 10), /不能查询/);
    await assert.rejects(async () => f.reader.read(caller, f.id("conv:2")), /不能查询/);
    assert.deepEqual(await f.reader.openItems(caller, 30, 10), []);
  }
  f.bound.add(5);
  assert.equal(await f.reader.read(2, f.id("conv:5")), undefined);
});

test("offline or revoked remote access never falls back to cached Teams summaries; local private history remains readable", async t => {
  const f = await fixture(t);
  assert.ok(await f.reader.read(2, f.id("teams:chat")));
  f.deny();
  assert.equal(await f.reader.read(2, f.id("teams:chat")), undefined);
  assert.ok(!(await f.reader.search(2, ["project"], 10)).some(row => row.source === "teams:chat"));
  assert.ok(!(await f.reader.openItems(2, 30, 10)).some(row => row.source === "teams:chat"));
  f.setOffline(); const before = f.probes();
  assert.ok(await f.reader.read(2, f.id("conv:2")));
  assert.equal(await f.reader.read(2, f.id("teams:chat")), undefined);
  assert.equal(f.probes(), before);
});

for (const change of ["caller-archive", "caller-bind", "caller-revision", "source-revoke", "source-message", "local-bind"]) test(`async source access rechecks all local visibility/revisions after ${change}`, async t => {
  const f = await fixture(t), teamsId = f.id("teams:chat");
  f.onProbe(() => {
    if (change === "caller-archive") f.items[0].archivingAt = "now";
    if (change === "caller-bind") f.bound.add(2);
    if (change === "caller-revision") f.store.revokeSource("conv:2", "unrelated");
    if (change === "source-revoke") f.store.revokeSource("teams:chat");
    if (change === "source-message") f.store.revokeSource("teams:chat", "1");
    if (change === "local-bind") f.bound.add(5);
  });
  if (change.startsWith("caller")) await assert.rejects(async () => f.reader.search(2, ["project"], 10), /不能查询|访问范围已变化/);
  else {
    const result = await f.reader.search(2, ["project"], 10);
    assert.ok(!result.some(row => row.source === (change === "local-bind" ? "conv:5" : "teams:chat")));
    if (change !== "local-bind") assert.equal(await f.reader.read(2, teamsId), undefined);
  }
});

for (const method of ["read", "openItems"] as const) test(`${method} rejects a source revoked during the current remote permission probe`, async t => {
  const f = await fixture(t), id = f.id("teams:chat");
  f.onProbe(() => f.store.revokeSource("teams:chat", "1"));
  if (method === "read") assert.equal(await f.reader.read(2, id), undefined);
  else assert.ok(!(await f.reader.openItems(2, 30, 10)).some(item => item.source === "teams:chat"));
});

test("archived private sources remain readable, but archived callers receive no private memory", async t => {
  const f = await fixture(t);
  f.items.find(item => item.id === 5)!.archivedAt = "now";
  assert.ok(await f.reader.read(2, f.id("conv:5")));
  assert.deepEqual(await f.reader.openItems(5, 30, 10), []);
});

test("only authorized returned candidates and displayed open items count as exposure", async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.directory, "agent.sqlite"));
  t.after(() => db.close());
  const exposed = () => db.prepare("SELECT source FROM episodes WHERE last_exposed_at IS NOT NULL").all().map(row => String(row.source)).sort();
  await assert.rejects(async () => f.reader.search(3, ["project"], 10));
  assert.deepEqual(exposed(), []);
  f.deny(); await f.reader.search(2, ["project"], 10);
  assert.deepEqual(exposed(), ["conv:2", "conv:5"]);
  db.exec("UPDATE episodes SET last_exposed_at=NULL");
  assert.deepEqual(await f.reader.openItems(3, 30, 10), []);
  assert.deepEqual(exposed(), []);
  const shown = await f.reader.openItems(2, 30, 3);
  assert.deepEqual(exposed(), [...new Set(shown.map(item => item.source))].sort());
});
