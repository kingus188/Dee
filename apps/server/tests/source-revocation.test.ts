import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openEpisodeStore } from "../dist/episode-store.js";
import { openTeamsStore } from "../dist/teams-store.js";
import { openNotificationOutbox } from "../dist/notification-outbox.js";
import { runEpisodePass } from "../dist/episode-job.js";

const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
const episode = (source = "conv:1") => ({ source, label: "Test source", channel: source.startsWith("teams:") ? "teams" : "web", periodStart: ago(1), periodEnd: ago(1), summary: "撤回测试事实", openItems: ["等待跟进"] });
const config = { url: "https://receiver.invalid/webhook", mode: "all", kind: "generic" };
const fixture = () => mkdtemp(join(tmpdir(), "dee-source-revocation-"));

test("source tombstones invalidate recall and open items, are idempotent, and survive restart", async () => {
  const dir = await fixture(); let store = openEpisodeStore(dir);
  try {
    store.add(episode()); store.setCursor("conv:1", "20");
    assert.equal(store.search(["事实"], 5).length, 1);
    assert.equal(store.revokeSource("conv:1"), true);
    assert.equal(store.revokeSource("conv:1"), false);
    assert.equal(store.sourceRevision("conv:1"), 1);
    assert.deepEqual(store.search(["事实"], 5), []);
    assert.deepEqual(store.openItems(30, 10), []);
    assert.equal(store.commitBatch(episode(), "conv:1", "21", 0), false);
    assert.equal(store.cursor("conv:1"), "20");
    store.close(); store = openEpisodeStore(dir);
    assert.equal(store.add({ ...episode(), sourceRevision: 1 }), false);
    assert.deepEqual(store.all(), []);
    assert.equal(store.sourceAllowed("conv:1"), false);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("message deletion invalidates legacy and weekly summaries but permits new unrelated messages", async () => {
  const dir = await fixture(); const store = openEpisodeStore(dir);
  try {
    for (const day of [5, 7]) store.add({ ...episode("teams:chat"), periodStart: `2026-01-0${day}T10:00:00.000Z`, periodEnd: `2026-01-0${day}T11:00:00.000Z`, messageIds: [`chat:${day}`] });
    const [group] = store.rollupGroups(ago(1));
    assert.equal(store.replaceWithRollup(group.map(row => row.id), episode("teams:chat")), true);
    assert.deepEqual(store.all()[0].messageIds, ["chat:5", "chat:7"]);
    store.revokeSource("teams:chat", "chat:5");
    assert.deepEqual(store.all(), []);
    assert.deepEqual(store.rollupGroups(new Date().toISOString()), []);
    assert.equal(store.replaceWithRollup(group.map(row => row.id), episode("teams:chat")), false);
    const revision = store.sourceRevision("teams:chat");
    assert.equal(store.commitBatch(episode("teams:chat"), "teams:chat", "new", revision, ["chat:5"]), false);
    assert.equal(store.commitBatch(episode("teams:chat"), "teams:chat", "new", revision, ["chat:new"]), true);
    assert.equal(store.search(["事实"], 5).length, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("revocation while summary or rollup generation is in flight cannot save its stale result", async () => {
  const dir = await fixture(); const store = openEpisodeStore(dir);
  try {
    const batch = { ...episode(), text: "测试内容".repeat(200), chars: 800, cursor: "end", messageIds: ["1"], sourceRevision: 0 };
    await runEpisodePass({ store, collect: async () => [batch], allowSource: () => true,
      summarize: async () => { store.revokeSource("conv:1"); return '{"summary":"must not persist","openItems":[]}'; }, log: () => {} });
    assert.deepEqual(store.all(), []); assert.equal(store.cursor("conv:1"), undefined);
    for (const day of [5, 7]) store.add({ ...episode("conv:2"), periodStart: `2026-01-0${day}T10:00:00.000Z`, periodEnd: `2026-01-0${day}T11:00:00.000Z` });
    await runEpisodePass({ store, collect: async () => [], allowSource: () => true,
      summarize: async () => { store.revokeSource("conv:2"); return '{"summary":"stale rollup","openItems":[]}'; }, log: () => {} });
    assert.deepEqual(store.all(), []);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("episode insertion and cursor commit roll back together after a storage failure and deduplicate restart replay", async () => {
  const dir = await fixture(); let store = openEpisodeStore(dir); const db = new DatabaseSync(join(dir, "agent.sqlite"));
  try {
    db.exec("CREATE TRIGGER fail_cursor BEFORE INSERT ON episode_cursors BEGIN SELECT RAISE(ABORT,'simulated cursor failure'); END");
    assert.throws(() => store.commitBatch(episode(), "conv:1", "end", 0, ["1"]), /simulated cursor failure/);
    assert.deepEqual(store.all(), []); assert.equal(store.cursor("conv:1"), undefined);
    db.exec("DROP TRIGGER fail_cursor");
    assert.equal(store.commitBatch(episode(), "conv:1", "end", 0, ["1"]), true);
    store.close(); store = openEpisodeStore(dir);
    assert.equal(store.commitBatch(episode(), "conv:1", "end", 0, ["1"]), false);
    assert.equal(store.all().length, 1);
  } finally { db.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Teams archive deletion invalidates cached text, media, summaries and future stale sync after restart", async () => {
  const dir = await fixture(); let teams = openTeamsStore(dir); let episodes = openEpisodeStore(dir);
  const message = { id: "m", createdDateTime: ago(1), body: { content: "withdrawn-original" } };
  try {
    teams.record({ id: "chat:m", chatId: "chat", chatType: "oneOnOne", senderId: "sender", senderName: "Sender", direction: "in", text: "withdrawn-original", createdAt: ago(1), important: true });
    teams.archive.save("chat", [message]); teams.archive.hosted("chat", "m", ["image"]);
    const imageId = teams.archive.mediaRows("chat", "m")[0].id;
    teams.archive.saveBytes(imageId, "image/png", Buffer.from("synthetic"));
    episodes.add({ ...episode("teams:chat"), messageIds: ["chat:m"] });
    teams.archive.save("chat", [{ ...message, deletedDateTime: new Date().toISOString() }]);
    assert.equal(teams.message("chat:m"), undefined);
    assert.deepEqual(teams.messagesSince(ago(2), 100), []);
    assert.deepEqual(teams.archive.search({ text: "withdrawn", limit: 20 }).items, []);
    assert.equal(teams.archive.message("chat", "m"), undefined);
    assert.equal(teams.archive.media(imageId), undefined);
    assert.deepEqual(episodes.search(["事实"], 10), []);
    const revision = episodes.sourceRevision("teams:chat");
    teams.close(); episodes.close(); teams = openTeamsStore(dir); episodes = openEpisodeStore(dir);
    teams.archive.save("chat", [message]);
    assert.equal(episodes.sourceRevision("teams:chat"), revision, "replayed stale content cannot clear a tombstone");
    assert.deepEqual(teams.archive.search({ limit: 20 }).items, []);
    assert.equal(teams.archive.media(imageId), undefined);
  } finally { teams.close(); episodes.close(); await rm(dir, { recursive: true, force: true }); }
});

test("pending source-bound notifications are cancelled across restart, including immutable mixed digests", async () => {
  const dir = await fixture(); const episodes = openEpisodeStore(dir); let now = 0, calls = 0;
  const send: typeof fetch = async () => { calls++; return new Response(null, { status: 503 }); };
  let box = openNotificationOutbox(dir, config, send, () => now);
  try {
    box.preferences.save({ quietHours: { enabled: false, start: "22:00", end: "08:00", timeZone: "UTC" }, webhookDigest: { enabled: true, windowSeconds: 60 } });
    await box.enqueue({ id: "first", body: '{"text":"first"}', sources: [{ source: "conv:1" }] });
    await box.enqueue({ id: "second", body: '{"text":"second"}', sources: [{ source: "conv:2" }] });
    now = 60_000; await box.flush(); assert.equal(calls, 1);
    const digestId = box.list()[0].id;
    await box.close(); episodes.revokeSource("conv:1");
    box = openNotificationOutbox(dir, config, send, () => now);
    now += 86400_000; await box.flush();
    assert.equal(calls, 1); assert.equal(box.list()[0].status, "cancelled");
    assert.equal(box.retry("first"), "conflict"); assert.equal(box.retry(digestId), "conflict");
    const db = new DatabaseSync(join(dir, "agent.sqlite"));
    try { assert.deepEqual(db.prepare("SELECT DISTINCT status FROM notification_outbox").all().map(row => row.status), ["cancelled"]); }
    finally { db.close(); }
  } finally { await box.close(); episodes.close(); await rm(dir, { recursive: true, force: true }); }
});

test("source revocation during a failed attempt prevents retry without claiming to undo a completed send", async () => {
  const dir = await fixture(); const episodes = openEpisodeStore(dir); let calls = 0, now = 0;
  const box = openNotificationOutbox(dir, config, async () => { calls++; episodes.revokeSource("conv:1"); return new Response(null, { status: 503 }); }, () => now);
  try {
    await box.enqueue({ id: "in-flight", body: "{}", sources: [{ source: "conv:1" }] });
    await box.flush(); now += 900_000; await box.flush();
    assert.equal(calls, 1); assert.equal(box.list()[0].status, "cancelled");
    assert.equal(box.retry("in-flight"), "conflict");
  } finally { await box.close(); episodes.close(); await rm(dir, { recursive: true, force: true }); }
});

test("archive edits fence stale cache until refreshed, and withdrawn media do not starve later downloads", async () => {
  const dir = await fixture(); const teams = openTeamsStore(dir); const episodes = openEpisodeStore(dir);
  const raw = { id: "m", createdDateTime: ago(1), body: { content: "old fact" } };
  const cached = { id: "chat:m", chatId: "chat", chatType: "oneOnOne", senderId: "sender", senderName: "Sender", direction: "in" as const, text: "old fact", createdAt: ago(1), important: true };
  try {
    teams.record(cached); teams.archive.save("chat", [raw]); episodes.add(episode("teams:chat"));
    teams.archive.save("chat", [{ ...raw, body: { content: "new fact" } }]);
    assert.equal(teams.archive.message("chat", "m")?.body?.content, "new fact");
    assert.equal(teams.message("chat:m"), undefined, "old cached body cannot acquire the new source revision");
    assert.deepEqual(teams.messagesSince(ago(2), 10), []);
    assert.deepEqual(episodes.all(), []);
    teams.record(cached);
    assert.equal(teams.message("chat:m"), undefined, "an old in-flight sync cannot clear the stale-content fence");
    teams.record({ ...cached, text: "new fact" });
    assert.equal(teams.message("chat:m")?.text, "new fact");
    teams.archive.hosted("chat", "m", ["old-image"]);
    teams.archive.save("chat", [{ ...raw, deletedDateTime: new Date().toISOString() }]);
    teams.archive.save("chat", [{ ...raw, id: "live" }]); teams.archive.hosted("chat", "live", ["new-image"]);
    assert.deepEqual(teams.archive.pendingMedia(1).map(item => item.message_id), ["live"]);
  } finally { teams.close(); episodes.close(); await rm(dir, { recursive: true, force: true }); }
});

test("upgrade reconciles old deleted archive markers and removed conversations before reuse", async () => {
  const dir = await fixture(); let teams = openTeamsStore(dir); let episodes = openEpisodeStore(dir);
  try {
    episodes.add(episode("teams:chat")); episodes.add(episode("conv:1")); episodes.add(episode("conv:2"));
    teams.archive.save("chat", [{ id: "deleted", createdDateTime: ago(1), deletedDateTime: ago(0), body: { content: "legacy withdrawn text" } }]);
    const db = new DatabaseSync(join(dir, "agent.sqlite"));
    try { db.exec("DELETE FROM source_message_revocations; DELETE FROM source_lifecycle"); } finally { db.close(); }
    teams.close(); episodes.close(); teams = openTeamsStore(dir); episodes = openEpisodeStore(dir);
    assert.equal(teams.archive.message("chat", "deleted"), undefined);
    assert.equal(teams.archive.search({ limit: 5 }).items.length, 0);
    assert.equal(episodes.all().some(item => item.source === "teams:chat"), false);
    assert.equal(episodes.reconcileConversations([1]), 1);
    assert.deepEqual(episodes.all().map(item => item.source), ["conv:1"], "indexed sources, including archives, remain readable");
    assert.equal(episodes.reconcileConversations([1]), 0, "restart reconciliation is idempotent");
  } finally { teams.close(); episodes.close(); await rm(dir, { recursive: true, force: true }); }
});

test("two connections cannot regress a cursor or replay a newer batch after a stale result", async () => {
  const dir = await fixture(); const first = openEpisodeStore(dir), second = openEpisodeStore(dir);
  try {
    assert.equal(second.commitBatch(episode(), "conv:1", "20", 0, ["20"], null), true);
    assert.equal(first.commitBatch(episode(), "conv:1", "10", 0, ["10"], null), false);
    assert.equal(first.commitBatch(episode(), "conv:1", "10", 0, ["10"]), false);
    assert.equal(first.commitBatch(episode(), "conv:1", "20", 0, ["20"]), false);
    assert.equal(first.cursor("conv:1"), "20"); assert.equal(first.all().length, 1);
    assert.equal(first.commitBatch(episode(), "conv:1", "30", 0, ["30"], "20"), true);
    assert.equal(second.commitBatch(episode(), "conv:1", "40", 0, ["40"], "20"), false);
  } finally { first.close(); second.close(); await rm(dir, { recursive: true, force: true }); }
});

test("legacy notifications without provenance fail closed even without any known source tombstone", async () => {
  const dir = await fixture(); const episodes = openEpisodeStore(dir); let calls = 0;
  const box = openNotificationOutbox(dir, config, async () => { calls++; return new Response(null, { status: 200 }); });
  try {
    await box.enqueue({ id: "legacy", body: '{"text":"unknown old origin"}' });
    const db = new DatabaseSync(join(dir, "agent.sqlite"));
    try { db.exec("UPDATE notification_outbox SET sources_json=NULL"); } finally { db.close(); }
    await box.flush();
    assert.equal(calls, 0); assert.equal(box.list()[0].status, "cancelled");
  } finally { await box.close(); episodes.close(); await rm(dir, { recursive: true, force: true }); }
});

test("legacy sensitive summaries and labels cannot return through recall or open items", async () => {
  const dir = await fixture(); const store = openEpisodeStore(dir);
  try {
    store.add({ ...episode(), label: "password: synthetic-sensitive-value", summary: "安全事实" });
    store.add({ ...episode("conv:2"), summary: "安全事实", openItems: ["api_key: synthetic-sensitive-value"] });
    store.add({ ...episode("conv:3"), summary: "安全事实", openItems: ["普通跟进"] });
    assert.deepEqual(store.search(["事实"], 1).map(item => item.label), ["Test source"]);
    assert.deepEqual(store.openItems(30, 10).map(item => item.text), ["普通跟进"]);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a failed conversation removal still leaves its durable source fence in place", async () => {
  const { createConversations } = await import("../dist/application/conversations.js");
  const { Index } = await import("@assistant/runtime");
  const dir = await fixture(); let episodes = openEpisodeStore(dir);
  try {
    const app = { episodeStore: episodes, ctx: {}, redact: String,
      root: { id: 99, commit: async () => { throw new Error("simulated index commit failure"); } },
      harness: {
        snapshot: async (doc: unknown) => doc === Index ? { items: [{ id: 1, title: "test" }] } : { bindings: {} },
        conversation: async () => ({ id: 1, commit: async (work: (tx: unknown) => Promise<unknown>) => work({ doc: async () => ({ items: [] }) }) }),
      },
    } as unknown as import("../dist/application/context.js").AppContext;
    episodes.add(episode());
    await assert.rejects(createConversations(app).shelveConversation(1, "remove"), /simulated index commit failure/);
    assert.equal(episodes.sourceAllowed("conv:1"), false);
    episodes.close(); episodes = openEpisodeStore(dir);
    assert.deepEqual(episodes.all(), []);
  } finally { episodes.close(); await rm(dir, { recursive: true, force: true }); }
});

test("a successful in-flight webhook receipt remains sent even if its source was revoked meanwhile", async () => {
  const dir = await fixture(); const episodes = openEpisodeStore(dir);
  let accept!: (response: Response) => void;
  let started!: () => void;
  const beginning = new Promise<void>(resolve => { started = resolve; });
  const box = openNotificationOutbox(dir, config, async () => { started(); return new Promise<Response>(resolve => { accept = resolve; }); });
  try {
    await box.enqueue({ id: "receipt", body: "{}", sources: [{ source: "conv:1" }] });
    const sending = box.flush(); await beginning;
    episodes.revokeSource("conv:1"); assert.equal(box.list()[0].status, "cancelled");
    accept(new Response(null, { status: 200 })); await sending;
    assert.equal(box.list()[0].status, "sent", "we cannot undo a request already accepted by its receiver");
    assert.equal(box.retry("receipt"), "conflict");
  } finally { await box.close(); episodes.close(); await rm(dir, { recursive: true, force: true }); }
});

test("first archive observation and stale in-flight archive writes cannot revive superseded cache", async () => {
  const dir = await fixture(); const teams = openTeamsStore(dir); const episodes = openEpisodeStore(dir);
  const old = { id: "m", createdDateTime: ago(1), lastModifiedDateTime: ago(1), body: { content: "old value" } };
  const newer = { ...old, lastModifiedDateTime: ago(0), body: { content: "corrected value" } };
  const cached = { id: "chat:m", chatId: "chat", chatType: "oneOnOne", senderId: "sender", senderName: "Sender", direction: "in" as const, text: "old value", createdAt: old.createdDateTime, important: true };
  try {
    teams.record(cached); episodes.add(episode("teams:chat"));
    const readRevision = teams.archive.sourceRevision("chat");
    teams.archive.save("chat", [newer]);
    assert.equal(teams.message("chat:m"), undefined);
    assert.deepEqual(episodes.all(), []);
    teams.archive.save("chat", [old], readRevision);
    teams.archive.save("chat", [old]);
    assert.equal(teams.archive.message("chat", "m")?.body?.content, "corrected value");
    teams.record(cached); assert.equal(teams.message("chat:m"), undefined);
    teams.record({ ...cached, text: "corrected value" });
    assert.equal(teams.message("chat:m")?.text, "corrected value");
    teams.record(cached);
    assert.equal(teams.message("chat:m"), undefined, "a stale sync after a successful refresh still cannot restore old content");
    teams.record({ ...cached, text: "corrected value" });
    // If upstream omits a modification timestamp, the collection snapshot still
    // rejects an older network response after a concurrently observed edit.
    const beforeNext = teams.archive.sourceRevision("chat");
    teams.archive.save("chat", [{ ...newer, body: { content: "another correction" } }]);
    teams.archive.save("chat", [newer], beforeNext);
    assert.equal(teams.archive.message("chat", "m")?.body?.content, "another correction");
  } finally { teams.close(); episodes.close(); await rm(dir, { recursive: true, force: true }); }
});
