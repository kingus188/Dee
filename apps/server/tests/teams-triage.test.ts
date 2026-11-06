import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTeamsStore, type TeamsMessage } from "../dist/teams-store.js";
import { classifyTeamsRequest, safeTeamsSourceUrl } from "../dist/teams-triage-store.js";
import { teamsTriageApi } from "../dist/teams-triage-api.js";
import { readConfig } from "../dist/config.js";
import { openDaylightStore } from "../dist/daylight-store.js";
import { openBusinessDatabase } from "../dist/postgres.js";
import type { TeamsSender } from "../dist/teams-reply-port.js";
import type { DaylightPort, TeamsTriageActionResult, TeamsTriageOverview } from "@assistant/contracts";
import { triageTestPort } from "./teams-triage-port.js";

const source = (id = "chat:in"): TeamsMessage => ({ id, chatId: "chat", chatType: "oneOnOne", senderId: "peer", senderName: "Peer", direction: "in",
  text: "请检查这份方案并回复，SYNTHETIC_PRIVATE_REQUEST", createdAt: new Date(Date.now() - 60_000).toISOString(), important: true,
  sourceUrl: "https://teams.microsoft.com/l/message/chat/in", notificationPriority: "normal" });
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "teams-triage-"));
  let store = openTeamsStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, get store() { return store; }, restart() { store.close(); store = openTeamsStore(dir); } };
}

test("conservative triage requires a directed action, never infers a deadline from unknown priority", () => {
  assert.equal(classifyTeamsRequest("请检查方案", true, "urgent").attention, "now");
  assert.equal(classifyTeamsRequest("请检查方案，马上", true).attention, "unclear");
  assert.equal(classifyTeamsRequest("请检查方案", false, "urgent").suggestTodo, false);
  for (const text of ["谢谢", "FYI please check", "不用回复，仅供参考", "我们已提交方案", "请不要处理"]) assert.equal(classifyTeamsRequest(text, true, "urgent").suggestTodo, false, text);
  assert.equal(safeTeamsSourceUrl("https://teams.microsoft.com/l/message/chat/in"), "https://teams.microsoft.com/l/message/chat/in");
  for (const url of ["javascript:alert(1)", "https://teams.microsoft.com.evil.test/x", "https://user@teams.microsoft.com/x", "http://teams.microsoft.com/x"]) assert.equal(safeTeamsSourceUrl(url), undefined);
});

test("settings and review decisions persist; withdrawn, replied, stale and unauthorized sources disappear", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-06T08:00:00Z") });
  const f = await fixture(t);
  f.store.record(source());
  assert.equal(f.store.triage.list().items[0].suggestTodo, true);
  const settings = { ...f.store.triage.settings(), workIntervalMinutes: 5, enabled: false };
  f.store.triage.saveSettings(settings); f.restart(); assert.deepEqual(f.store.triage.settings(), settings);
  f.store.triage.decide("chat:in", 0, "snoozed"); assert.equal(f.store.triage.list().items.length, 0);
  t.mock.timers.tick(2 * 3600_000); assert.equal(f.store.triage.list().items.length, 1);
  f.store.triage.access("chat", false); assert.equal(f.store.triage.list().items.length, 0);
  f.store.triage.access("chat", true); assert.equal(f.store.triage.list().items[0].revision, 1);
  f.store.triage.decide("chat:in", 1, "dismissed"); f.restart(); assert.equal(f.store.triage.list().items.length, 0);
  f.store.record(source("chat:new")); assert.equal(f.store.triage.list().items.length, 1);
  f.store.revokeMessage("chat", "chat:new"); assert.equal(f.store.triage.list().items.length, 0, "an unrelated revision never reopens a dismissed suggestion");
  assert.ok(f.store.triage.list().items.every(i => i.id !== "chat:new"));
  f.store.record({ ...source("chat:out"), direction: "out", createdAt: new Date().toISOString() }); assert.equal(f.store.triage.list().items.length, 0);
  f.store.record({ ...source("chat:old"), createdAt: new Date(Date.now() - 25 * 3600_000).toISOString() }); assert.equal(f.store.triage.list().items.length, 0);
});

for (const database of ["memory", "postgres"] as const) test(`review API is read-only until explicit create, revalidates exact source, and deduplicates (${database})`, { skip: database === "postgres" && !process.env.DATABASE_URL }, async t => {
  const f = await fixture(t);
  const pool = database === "postgres" ? await openBusinessDatabase(process.env.DATABASE_URL!, f.dir, true) : undefined;
  if (pool) t.after(() => pool.end());
  const daylight = pool ? await openDaylightStore(pool) : triageTestPort();
  let refreshes = 0, reads = 0;
  const sender: TeamsSender = { refresh: async () => { refreshes++; return { ok: true, lastSuccessAt: new Date().toISOString(), refreshedChatIds: ["chat"] }; },
    syncStatus: () => ({ lastSuccessAt: null }), read: async query => { reads++; assert.equal(query.kind, "history"); return { data: { id: query.kind === "history" ? query.messageId : undefined } }; } };
  const context = () => ({ config: readConfig({}), teamsStore: f.store, teamsSender: sender, daylight });
  const call = (path = "", body: Record<string, unknown> = {}, method = "POST") => teamsTriageApi(context(), method, new URL("http://local/api/teams/triage" + path), body);
  f.store.record(source());
  const overview = (await call("", {}, "GET"))!.data as TeamsTriageOverview;
  assert.equal(overview.stale, true); assert.equal(refreshes, 0); assert.equal((await daylight.snapshot()).tasks.length, 0);
  const request = { id: "chat:in", revision: 0, action: "create" };
  const results = await Promise.all([call("/act", request), call("/act", request)]);
  const ids = results.map(result => (result!.data as TeamsTriageActionResult).taskId);
  assert.equal(ids[0], ids[1]); assert.equal(reads, 2);
  const tasks = (await daylight.snapshot()).tasks;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].dueDate, null);
  assert.doesNotMatch(JSON.stringify(tasks), /SYNTHETIC_PRIVATE_REQUEST|Peer/);
  assert.equal(f.store.triage.list().items.length, 0);
  f.restart(); assert.equal((await call("/act", request))!.data && (await daylight.snapshot()).tasks.length, 1);
  await daylight.deleteTask(ids[0]!); await call("/act", request); assert.equal((await daylight.snapshot()).tasks.length, 0, "deleted task cannot resurrect through replay");
  assert.equal(refreshes, 2);
});

for (const database of ["memory", "postgres"] as const) test(`create rejects stale revision, failed/partial refresh, revoked exact source and changes during write (${database})`, { skip: database === "postgres" && !process.env.DATABASE_URL }, async t => {
  const f = await fixture(t);
  const pool = database === "postgres" ? await openBusinessDatabase(process.env.DATABASE_URL!, f.dir, true) : undefined;
  if (pool) t.after(() => pool.end());
  const base = pool ? await openDaylightStore(pool) : triageTestPort();
  for (const mode of ["revision", "offline", "partial", "exact", "during"] as const) {
    const id = `chat:${mode}`; f.store.record(source(id));
    const revision = f.store.sourceRevision("teams:chat");
    const sender: TeamsSender = { refresh: async () => ({ ok: mode !== "offline", lastSuccessAt: null, refreshedChatIds: mode === "partial" ? [] : ["chat"] }),
      read: async () => { if (mode === "exact") f.store.revokeMessage("chat", id); return { data: { id: mode } }; } };
    const daylight = { ...base, replayAction: <T>(key: string, action: (port: DaylightPort) => Promise<T>) => base.replayAction(key, tx => action({ ...tx, saveTask: async task => {
      await tx.saveTask(task); if (mode === "during") f.store.revokeMessage("chat", id);
    } })) };
    await assert.rejects(teamsTriageApi({ config: readConfig({}), teamsStore: f.store, teamsSender: sender, daylight }, "POST", new URL("http://local/api/teams/triage/act"), { id, revision: mode === "revision" ? revision + 1 : revision, action: "create" }), /来源|核对/);
    assert.equal((await base.snapshot()).tasks.length, 0, mode);
  }
});
