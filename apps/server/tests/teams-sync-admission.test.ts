import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openTeamsStore, type TeamsMessage } from "../dist/teams-store.js";
import { createTeamsSync } from "../dist/teams-sync.js";

const message = (id: string, text = "original"): TeamsMessage => ({ id: `chat:${id}`, chatId: "chat", chatType: "oneOnOne", senderId: "peer", senderName: "Peer", direction: "in", text, important: true, createdAt: new Date(Date.now() - 60_000).toISOString() });
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "dee-sync-admission-"));
  const store = openTeamsStore(dir), db = new DatabaseSync(join(dir, "agent.sqlite"));
  t.after(async () => { store.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, db };
}

for (const change of ["edit", "revoke"] as const) test(`a fetched snapshot cannot overwrite a concurrent source ${change} or advance its cursor`, async t => {
  const f = await fixture(t), original = message("one"); f.store.record(original);
  const mark = new Date(Date.now() - 3600_000).toISOString();
  await writeFile(join(f.dir, "teams-forward.json"), JSON.stringify({ chat: mark }));
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const sync = createTeamsSync({ dir: f.dir, store: f.store, getToken: async () => "synthetic", fetchImpl: async input => {
    const url = String(input);
    if (url.includes("/me?")) return Response.json({ id: "me" });
    if (url.includes("/me/chats?")) return Response.json({ value: [{ id: "chat", chatType: "oneOnOne" }] });
    started(); await blocked;
    return Response.json({ value: [{ id: "one", createdDateTime: original.createdAt, messageType: "message", from: { user: { id: "peer" } }, body: { content: "original" } }] });
  } });
  const refreshing = sync.refresh(); await entered;
  if (change === "edit") f.store.record({ ...original, text: "newer" });
  else f.store.triage.access("chat", false);
  release();
  const result = await refreshing;
  assert.equal(result.ok, false); assert.deepEqual(result.refreshedChatIds, []);
  assert.match(result.skipped!.join(" "), /来源或访问状态已变化/);
  assert.equal(JSON.parse(await readFile(join(f.dir, "teams-forward.json"), "utf8")).chat, mark);
  if (change === "edit") assert.equal(f.store.message(original.id)?.text, "newer");
  else assert.equal(f.db.prepare("SELECT available FROM teams_chat_access WHERE chat_id='chat'").get()?.available, 0);
});

test("batch failure rolls back earlier projections, tombstones, revision and access admission", async t => {
  const f = await fixture(t); f.store.record(message("existing"));
  f.store.triage.access("chat", false);
  const revision = f.store.sourceRevision("teams:chat");
  f.db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON teams_messages WHEN NEW.id='chat:fail' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  assert.throws(() => f.store.acceptSyncBatch("chat", f.store.syncSnapshot("chat"), [
    { message: message("first") }, { deletedId: "chat:existing" }, { message: message("fail") },
  ]), /synthetic failure/);
  assert.equal(f.store.message("chat:first"), undefined);
  assert.ok(f.store.message("chat:existing"));
  assert.equal(f.store.sourceRevision("teams:chat"), revision);
  assert.equal(f.store.syncSnapshot("chat").syncEpoch, 0);
  assert.equal(f.db.prepare("SELECT available FROM teams_chat_access WHERE chat_id='chat'").get()?.available, 0);
});

test("committed batch can replay after cursor-write interruption without duplicate intake or revision churn", async t => {
  const f = await fixture(t); const changes = [{ message: message("one") }, { message: message("two") }];
  assert.equal(f.store.acceptSyncBatch("chat", f.store.syncSnapshot("chat"), changes), true);
  assert.equal(f.store.acceptSyncBatch("chat", f.store.syncSnapshot("chat"), changes), true);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM teams_messages").get()?.n, 2);
  assert.equal(f.store.sourceRevision("teams:chat"), 0);
  const batch = f.store.notifications.create(true, () => ({ text: "body", prompt: "body" }));
  assert.equal(batch, undefined, "normal notification delay still applies to newly admitted events");
});

test("edits within an accepted batch advance revision once and do not reject the rest of that batch", async t => {
  const f = await fixture(t); f.store.record(message("edited")); f.store.record(message("deleted"));
  const changes = [{ message: message("edited", "changed") }, { deletedId: "chat:deleted" }, { message: message("new") }];
  assert.equal(f.store.acceptSyncBatch("chat", f.store.syncSnapshot("chat"), changes), true);
  assert.equal(f.store.message("chat:edited")?.text, "changed");
  assert.ok(f.store.message("chat:new")); assert.equal(f.store.message("chat:deleted"), undefined);
  const revision = f.store.sourceRevision("teams:chat");
  assert.equal(revision, 2, "one edit and one new tombstone each invalidate the source");
  assert.equal(f.store.acceptSyncBatch("chat", f.store.syncSnapshot("chat"), changes), true);
  assert.equal(f.store.sourceRevision("teams:chat"), revision, "replay does not create new tombstones or edits");
});

test("first-time intake fences an older fetched snapshot even without a source revision change", async t => {
  const f = await fixture(t);
  const old = f.store.syncSnapshot("chat"), newer = f.store.syncSnapshot("chat");
  assert.deepEqual(old, newer);
  assert.equal(f.store.acceptSyncBatch("chat", newer, [{ message: message("first", "new version") }]), true);
  assert.equal(f.store.sourceRevision("teams:chat"), 0);
  assert.equal(f.store.acceptSyncBatch("chat", old, [{ message: message("first", "old version") }]), false);
  assert.equal(f.store.message("chat:first")?.text, "new version");
  const reopened = openTeamsStore(f.dir);
  try {
    assert.equal(reopened.syncSnapshot("chat").syncEpoch, 1);
    assert.equal(reopened.acceptSyncBatch("chat", old, []), false);
  } finally { reopened.close(); }
});

test("unchanged accepted refresh fences older reads without invalidating pending notifications", async t => {
  const f = await fixture(t), item = { ...message("notice"), notificationPriority: "urgent" as const };
  const old = f.store.syncSnapshot("chat");
  assert.equal(f.store.acceptSyncBatch("chat", old, [{ message: item }]), true);
  const batch = f.store.notifications.create(false, () => ({ text: "body", prompt: "body" }))!;
  assert.ok(batch);
  const epoch = Number(f.store.notifications.claim(batch.id));
  const next = f.store.syncSnapshot("chat");
  assert.equal(f.store.acceptSyncBatch("chat", next, [{ message: item }]), true);
  assert.equal(f.store.syncSnapshot("chat").syncEpoch, 2);
  assert.equal(f.store.sourceRevision("teams:chat"), 0);
  assert.equal(f.store.notifications.validClaim(batch.id, epoch), true);
  assert.equal(f.store.acceptSyncBatch("chat", next, []), false);
});
