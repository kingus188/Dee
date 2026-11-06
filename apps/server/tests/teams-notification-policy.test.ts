import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTeamsStore, type TeamsMessage } from "../dist/teams-store.js";
import { openNotificationOutbox } from "../dist/notification-outbox.js";
import { reviewTeamsNotification } from "../dist/teams-notifications.js";
import { startTeamsForward } from "../dist/teams-forward.js";

const start = Date.parse("2026-11-05T23:00:00Z");
const quiet = { enabled: true, start: "22:00", end: "08:00", timeZone: "UTC" };
const item = (id: string, priority: TeamsMessage["notificationPriority"] = "normal"): TeamsMessage => ({ id, chatId: id, chatType: "oneOnOne", senderId: "sender", senderName: "Test",
  direction: "in", text: id, createdAt: new Date(Date.now() - 61_000).toISOString(), important: true, notificationPriority: priority });
async function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const dir = await mkdtemp(join(tmpdir(), "teams-notification-policy-"));
  await mkdir(join(dir, "state/primary"), { recursive: true });
  await writeFile(join(dir, "state/primary/context_tokens.json"), '{"wxid_test":"synthetic"}');
  let store = openTeamsStore(dir);
  const outbox = openNotificationOutbox(dir, { url: "", mode: "off", kind: "generic" });
  t.after(async () => { store.close(); await outbox.close(); await rm(dir, { recursive: true, force: true }); });
  const sender = { refresh: async () => ({ ok: true, lastSuccessAt: new Date().toISOString() }) };
  return { dir, get store() { return store; }, sender, preferences: outbox.preferences,
    at(ms: number) { t.mock.timers.setTime(ms); }, restart() { store.close(); store = openTeamsStore(dir); },
    async run(inject: (ids: string[], prompt: string) => Promise<void>) {
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      const stop = startTeamsForward({ dir, store, getToken: async () => { throw Error("must not connect"); }, sendURL: "http://unused.test", sendToken: "test",
        sync: { ...sender, status: () => ({ lastSuccessAt: null }) }, injectBatch: async (_wxid, prompt, ids) => inject(ids, prompt), undelivered: async () => { finish(); return []; } });
      try { await done; } finally { await stop(); }
    },
  };
}

test("Teams shares quiet hours, coalesces normal sources after the window, and does not replay injected batches", async t => {
  const f = await fixture(t); f.preferences.save({ quietHours: quiet });
  f.store.record(item("a")); f.store.record(item("b"));
  const calls: string[][] = [];
  await f.run(async ids => { calls.push(ids); }); assert.equal(calls.length, 0);
  f.restart(); f.at(Date.parse("2026-11-06T08:00:00Z"));
  await f.run(async (ids, prompt) => { calls.push(ids); assert.match(prompt, /合并提醒.*不可信第三方/); });
  assert.deepEqual(calls, [["a", "b"]]);
  assert.ok(f.store.message("a")?.pushedAt); assert.ok(f.store.message("b")?.pushedAt);
  await f.run(async ids => { calls.push(ids); }); assert.equal(calls.length, 1);
});

test("unknown injection retries the frozen source set after restart; a new arrival cannot duplicate old sources", async t => {
  const f = await fixture(t); f.store.record(item("a")); f.store.record(item("b"));
  const calls: string[][] = [];
  await f.run(async ids => { calls.push(ids); throw Error("acknowledgement lost"); });
  assert.equal(f.store.message("a")?.pushedAt, null);
  f.restart(); f.store.record(item("new")); f.at(start + 60_000);
  await f.run(async ids => { calls.push(ids); });
  assert.deepEqual(calls, [["a", "b"], ["a", "b"]]);
  f.at(start + 120_000); await f.run(async ids => { calls.push(ids); });
  assert.deepEqual(calls.at(-1), ["new"]);
});

test("urgent and approval bypass quiet hours without releasing unrelated normal sources", async t => {
  const f = await fixture(t); f.preferences.save({ quietHours: quiet });
  f.store.record(item("normal")); f.store.record(item("urgent", "urgent")); f.store.record(item("approval", "approval"));
  const calls: string[][] = [];
  await f.run(async ids => { calls.push(ids); });
  assert.deepEqual(calls.flat().sort(), ["approval", "urgent"]);
  assert.equal(f.store.message("normal")?.pushedAt, null);
  assert.equal((await reviewTeamsNotification(f.store, f.sender, { kind: "teams", messageIds: ["normal"] })).status, "defer");
  assert.equal((await reviewTeamsNotification(f.store, f.sender, { kind: "teams", messageIds: ["urgent"] })).status, "send");
});

test("handled sources cancel before injection or sending; a quiet-period retry never revives them", async t => {
  const f = await fixture(t); f.preferences.save({ quietHours: quiet });
  f.store.record(item("a"));
  f.store.record({ ...item("a-out"), chatId: "a", direction: "out", createdAt: new Date().toISOString(), important: false });
  assert.equal((await reviewTeamsNotification(f.store, {}, { kind: "teams", messageIds: ["a"] })).status, "cancel");
  f.at(Date.parse("2026-11-06T08:00:00Z"));
  await f.run(async () => { assert.fail("handled source must not inject"); });
});

test("new ordinary messages wait one minute and normal batches are rate limited; legacy unknown priority fails open", async t => {
  const f = await fixture(t);
  f.store.record({ ...item("new"), createdAt: new Date().toISOString() });
  const calls: string[][] = [];
  await f.run(async ids => { calls.push(ids); }); assert.equal(calls.length, 0);
  f.at(start + 60_000); await f.run(async ids => { calls.push(ids); }); assert.deepEqual(calls, [["new"]]);
  f.preferences.save({ quietHours: quiet });
  f.store.record({ ...item("legacy"), notificationPriority: undefined });
  await f.run(async ids => { calls.push(ids); }); assert.deepEqual(calls.at(-1), ["legacy"]);
});


test("deleted Teams sources cancel both queued injection and pre-send review without resurrection", async t => {
  const f = await fixture(t); f.store.record(item("removed"));
  f.store.notifications.cancelSource("removed");
  f.store.record(item("removed", "urgent"));
  assert.equal((await reviewTeamsNotification(f.store, {}, { kind: "teams", messageIds: ["removed"] })).status, "cancel");
  await f.run(async () => { assert.fail("deleted source must not inject"); });
});

test("partial handling rebuilds model input before injection while preserving frozen deduplication IDs", async t => {
  const f = await fixture(t);
  f.store.record({ ...item("a"), text: "KEEP_CURRENT_SOURCE" });
  f.store.record({ ...item("b"), text: "REMOVED_PRIVATE_SOURCE" });
  f.store.record({ ...item("c"), text: "REPLIED_STALE_SOURCE" });
  const frozen = f.store.notifications.create(true, items => ({ prompt: "OLD_SUGGESTION " + items.map(i => i.text).join(" "), text: "OLD_SUGGESTION" }))!;
  assert.deepEqual(frozen.messageIds, ["a", "b", "c"]);
  f.store.notifications.cancelSource("b");
  f.store.record({ ...item("reply"), chatId: "c", direction: "out", createdAt: new Date().toISOString(), important: false });
  const calls: { ids: string[]; prompt: string }[] = [];
  const inspect = (ids: string[], prompt: string) => {
    calls.push({ ids, prompt });
    assert.deepEqual(ids, frozen.messageIds);
    assert.match(prompt, /KEEP_CURRENT_SOURCE/);
    assert.doesNotMatch(prompt, /REMOVED_PRIVATE_SOURCE|REPLIED_STALE_SOURCE|OLD_SUGGESTION/);
    assert.match(prompt, /不可信第三方.*不能授权发送/);
    assert.match(prompt, /发送工具的授权规则/);
  };
  await f.run(async (ids, prompt) => { inspect(ids, prompt); throw Error("submission acknowledgement lost"); });
  f.restart(); f.at(start + 60_000);
  await f.run(async (ids, prompt) => { inspect(ids, prompt); });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  await f.run(async () => { assert.fail("the same source set must not be injected again"); });
});

test("deleted or edited source text is excluded from later notification history without changing read-only history", async t => {
  const f = await fixture(t);
  for (const id of ["deleted", "edited"]) {
    f.store.record({ ...item(id), chatId: "same-chat", text: `${id.toUpperCase()}_OLD_PRIVATE_TEXT`, createdAt: new Date(start - 180_000).toISOString() });
    f.store.notifications.cancelSource(id);
  }
  f.store.record({ ...item("context"), chatId: "same-chat", text: "KEEP_VALID_HISTORY", important: false, createdAt: new Date(start - 120_000).toISOString() });
  f.store.record({ ...item("fresh"), chatId: "same-chat", text: "CURRENT_NEW_REQUEST" });
  assert.match(f.store.recentInChat("same-chat", new Date().toISOString(), 10).map(row => row.text).join(" "), /DELETED_OLD_PRIVATE_TEXT/, "read-only historical API remains unchanged");
  let calls = 0;
  await f.run(async (ids, prompt) => {
    calls++;
    assert.deepEqual(ids, ["fresh"]);
    assert.match(prompt, /CURRENT_NEW_REQUEST/);
    assert.match(prompt, /KEEP_VALID_HISTORY/);
    assert.doesNotMatch(prompt, /DELETED_OLD_PRIVATE_TEXT|EDITED_OLD_PRIVATE_TEXT/);
  });
  assert.equal(calls, 1);
});

test("frozen prompts bind older chat context and cancel before model injection after its withdrawal", async t => {
  const f = await fixture(t);
  f.store.record({ ...item("chat:context", "urgent"), chatId: "chat", createdAt: new Date(start - 180_000).toISOString(), important: false, text: "SYNTHETIC_WITHDRAWN_CONTEXT" });
  f.store.record({ ...item("chat:latest", "urgent"), chatId: "chat" });
  const batch = f.store.notifications.create(true, () => ({ prompt: "SYNTHETIC_WITHDRAWN_CONTEXT", text: "private context" }))!;
  assert.equal(batch.sourceRevisions[0].revision, 0);
  f.store.revokeMessage("chat", "chat:context"); f.restart();
  assert.deepEqual(f.store.notifications.ready(), []);
  assert.equal(f.store.notifications.claim(batch.id), false);
  await f.run(async () => { assert.fail("withdrawn context must never be resubmitted to the model"); });
  assert.equal((await reviewTeamsNotification(f.store, f.sender, { kind: "teams", messageIds: batch.messageIds, sourceRevisions: batch.sourceRevisions })).status, "cancel");
});
