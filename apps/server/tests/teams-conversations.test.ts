import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { once } from "node:events";
import { openTeamsStore } from "../dist/teams-store.js";
import { readConfig } from "../dist/config.js";
import { teamsConversationsApi } from "../dist/teams-conversations-api.js";
import { createTeamsSync } from "../dist/teams-sync.js";
import { createRouter } from "../dist/http/router.js";
import { HttpError } from "../dist/errors.js";
import { createTeamsReader } from "../dist/teams-reader.js";
import type { TeamsSender } from "../dist/teams-reply-port.js";
import type { TeamsConversationList, TeamsConversationMessages } from "@assistant/contracts";

const GRAPH = "https://graph.microsoft.com/v1.0";
async function fixture(t: test.TestContext, sender: TeamsSender = {}) {
  const dir = await mkdtemp(join(tmpdir(), "teams-view-")), store = openTeamsStore(dir);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const context = { teamsStore: store, teamsSender: sender, config: readConfig({}) };
  return { dir, context, store, call: (query = "", method = "GET") => teamsConversationsApi(context, method, new URL("http://local/api/teams/conversations" + query)) };
}
const message = (id: string, offset = 0) => ({ id, createdDateTime: new Date(Date.now() - 10_000 + offset).toISOString(), from: { user: { id: "peer", displayName: "同事" } }, body: { content: "请检查方案并回复", contentType: "text" }, webUrl: `https://teams.microsoft.com/l/message/chat/${id}` });

test("Teams browser is unavailable without a live reader, never exposes the archive as an empty live result", async t => {
  const f = await fixture(t);
  f.store.archive.save("chat", [message("private")]);
  const data = (await f.call())!.data as TeamsConversationList;
  assert.equal(data.available, false); assert.deepEqual(data.items, []);
  await assert.rejects(f.call("/messages?chatId=chat"), /未连接/);
  assert.equal(await f.call("", "POST"), undefined, "browsing does not add a write or send route");
});

test("Teams live list preserves real chat metadata, strips preview markup, and has no fabricated unread state", async t => {
  const cursor = GRAPH + "/me/chats?$skiptoken=next";
  const f = await fixture(t, { read: async query => {
    assert.equal(query.kind, "chats");
    return { data: { items: [{ id: "chat", chatType: "oneOnOne", members: [{ userId: "me", displayName: "本人" }, { userId: "peer", displayName: "同事" }], lastMessagePreview: { body: { contentType: "html", content: "<p>真实预览</p><script>bad()</script>" } }, webUrl: "https://teams.microsoft.com/l/chat/chat", lastUpdatedDateTime: "2026-11-06T02:00:00Z" }], currentUserId: "me", nextCursor: cursor } };
  } });
  const data = (await f.call())!.data as TeamsConversationList;
  assert.equal(data.items[0].title, "同事"); assert.equal(data.items[0].preview, "真实预览"); assert.equal(data.nextCursor, cursor);
  assert.equal("unread" in data.items[0], false);
  await assert.rejects(f.call("?cursor=" + encodeURIComponent(GRAPH + "/users/other/chats")), /分页/);
});

test("Teams history is read online, ordered, source-bound, and identity is only inferred from verified IDs", async t => {
  const first = message("in", -1000), last = { ...message("out"), from: { user: { id: "me", displayName: "本人" } } };
  const cursor = GRAPH + "/chats/chat/messages?$skiptoken=next";
  let reads = 0, writes = 0;
  const f = await fixture(t, { send: async () => { writes++; }, refresh: async () => { writes++; return { ok: true, lastSuccessAt: null }; }, read: async query => {
    reads++; assert.equal(query.kind, "history");
    if (query.kind === "history") assert.equal(query.downloadMedia, false);
    return { data: { items: [last, first], nextCursor: cursor, currentUserId: "me" } };
  } });
  f.store.record({ id: "chat:in", chatId: "chat", chatType: "oneOnOne", senderId: "peer", senderName: "同事", direction: "in", text: first.body.content, createdAt: first.createdDateTime, important: true });
  const data = (await f.call("/messages?chatId=chat"))!.data as TeamsConversationMessages;
  assert.deepEqual(data.items.map(item => item.id), ["in", "out"]);
  assert.deepEqual(data.items.map(item => item.direction), ["in", "out"]);
  assert.ok(data.items[0].suggestion?.suggestTodo); assert.equal(data.items[1].suggestion, undefined);
  assert.equal(data.nextCursor, cursor); assert.equal(reads, 1); assert.equal(writes, 0);
  await assert.rejects(f.call("/messages?chatId=chat&cursor=" + encodeURIComponent(GRAPH + "/chats/other/messages")), /分页/);
  assert.equal(reads, 1);
});

test("Revoked or deleted originals expose no private text, sender, attachment, source or suggestion", async t => {
  const f = await fixture(t, { read: async () => ({ data: { items: [{ ...message("gone"), deletedDateTime: new Date().toISOString() }, message("revoked"), { ...message("unknown"), from: undefined, webUrl: "javascript:alert(1)" }], nextCursor: null } }) });
  f.store.revokeMessage("chat", "chat:revoked");
  const data = (await f.call("/messages?chatId=chat"))!.data as TeamsConversationMessages;
  for (const item of data.items.filter(item => item.id !== "unknown")) {
    assert.equal(item.text, ""); assert.equal(item.senderName, ""); assert.deepEqual(item.media, []); assert.equal(item.sourceUrl, undefined); assert.equal(item.suggestion, undefined);
  }
  assert.equal(data.items.find(item => item.id === "unknown")!.direction, "unknown");
  assert.equal(data.items.find(item => item.id === "unknown")!.sourceUrl, undefined);
});

test("Access errors, malformed pages and looping cursors fail explicitly instead of leaking cached records", async t => {
  const sender: TeamsSender = {}, f = await fixture(t, sender);
  f.store.archive.save("chat", [message("cached")]);
  for (const status of [401, 403, 404]) {
    sender.read = async () => { throw Object.assign(new Error("读取被拒绝"), { status }); };
    await assert.rejects(f.call("/messages?chatId=chat"), error => typeof error === "object" && error !== null && "status" in error && error.status === status);
  }
  for (const data of [{ items: [], nextCursor: "https://evil.example/token" }, { items: [{ id: "missing-time" }], nextCursor: null }, { nope: true }]) {
    sender.read = async () => ({ data }); await assert.rejects(f.call("/messages?chatId=chat"), /格式|标识|分页/);
  }
  const cursor = GRAPH + "/chats/chat/messages?$skiptoken=stuck";
  sender.read = async () => ({ data: { items: [], nextCursor: cursor } });
  await assert.rejects(f.call("/messages?chatId=chat&cursor=" + encodeURIComponent(cursor)), /未推进/);
});

test("Browser history skips slow screenshot work and returns verified account identity", async t => {
  const f = await fixture(t), calls: string[] = [];
  const reader = createTeamsReader({ getToken: async () => "synthetic-token", archive: f.store.archive, fetchImpl: async input => {
    const url = String(input); calls.push(url);
    if (url.includes("/me?")) return Response.json({ id: "me" });
    if (url.includes("/messages?")) return Response.json({ value: [{ ...message("image"), body: { contentType: "html", content: '<p>截图说明</p><img src="https://graph.microsoft.com/v1.0/chats/chat/messages/image/hostedContents/img/$value">' } }] });
    assert.fail("Browser reads must not wait for screenshot discovery or download: " + url);
  } });
  const result = await reader({ kind: "history", chatId: "chat", downloadMedia: false });
  assert.equal((result.data as { currentUserId: string }).currentUserId, "me");
  assert.equal(calls.length, 2);
  assert.equal(f.store.archive.message("chat", "image")?.id, "image");
});

test("Editing away files and hosted images removes media and old URLs; late media work cannot restore them", async t => {
  const f = await fixture(t), original = { ...message("media"), body: { contentType: "html", content: '<p>截图</p><img src="image-old">' }, attachments: [{ id: "file", name: "旧附件", contentUrl: "https://tenant.sharepoint.com/old" }] };
  f.store.archive.save("chat", [original]); f.store.archive.hosted("chat", "media", ["image-old"]);
  const old = f.store.archive.mediaRows("chat", "media"), image = old.find(item => item.kind === "image")!;
  f.store.archive.saveBytes(image.id, "image/png", new Uint8Array([1, 2, 3]));
  const revision = f.store.archive.sourceRevision("chat");
  const edited = { ...original, lastModifiedDateTime: new Date(Date.now() + 1000).toISOString(), body: { contentType: "text", content: "截图已移除" }, attachments: [] };
  f.context.teamsSender.read = async () => { f.store.archive.save("chat", [edited]); return { data: { items: [edited], nextCursor: null } }; };
  const result = (await f.call("/messages?chatId=chat"))!.data as TeamsConversationMessages;
  assert.deepEqual(result.items[0].media, []);
  for (const item of old) assert.equal(f.store.archive.media(item.id), undefined, "old media URL must fail closed");
  f.store.archive.hosted("chat", "media", ["image-old"], revision);
  f.store.archive.saveBytes(image.id, "image/png", new Uint8Array([1, 2, 3]), revision);
  assert.deepEqual(f.store.archive.mediaRows("chat", "media"), [], "late discovery and downloads cannot resurrect edited media");
});

test("An explicit online access denial closes old media URLs until successful source revalidation", async t => {
  const sender: TeamsSender = {}, f = await fixture(t, sender), original = message("image");
  f.store.archive.save("chat", [original]); f.store.archive.hosted("chat", "image", ["picture"]);
  const media = f.store.archive.mediaRows("chat", "image")[0];
  f.store.archive.saveBytes(media.id, "image/png", new Uint8Array([1, 2, 3]));
  assert.ok(f.store.archive.media(media.id)?.bytes);
  sender.read = async () => { throw Object.assign(new Error("No access"), { status: 403 }); };
  await assert.rejects(f.call("/messages?chatId=chat"));
  assert.equal(f.store.archive.media(media.id), undefined); assert.deepEqual(f.store.archive.mediaRows("chat", "image"), []);
  sender.read = async () => ({ data: { items: [original], nextCursor: null } });
  await f.call("/messages?chatId=chat");
  assert.ok(f.store.archive.media(media.id)?.bytes, "temporary access loss must not be a permanent source tombstone");
});

test("An older successful read cannot reopen media after a newer access denial, even during recovery", async t => {
  const sender: TeamsSender = {}, f = await fixture(t, sender), original = message("image");
  f.store.archive.save("chat", [original]); f.store.archive.hosted("chat", "image", ["picture"]);
  const media = f.store.archive.mediaRows("chat", "image")[0]; f.store.archive.saveBytes(media.id, "image/png", new Uint8Array([1]));
  for (let attempt = 0; attempt < 2; attempt++) {
    let finish!: (data: { data: unknown }) => void, calls = 0;
    sender.read = async () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.reject(Object.assign(new Error("No access"), { status: 403 }));
    const old = f.call("/messages?chatId=chat");
    await assert.rejects(f.call("/messages?chatId=chat"));
    assert.equal(f.store.archive.media(media.id), undefined);
    finish({ data: { items: [original], nextCursor: null } });
    await assert.rejects(old, /访问状态已变化/);
    assert.equal(f.store.archive.media(media.id), undefined, "the late success must not restore access");
  }
  sender.read = async () => ({ data: { items: [original], nextCursor: null } });
  await f.call("/messages?chatId=chat");
  assert.ok(f.store.archive.media(media.id)?.bytes, "a new explicit read can restore access");
});

test("Rereading unchanged originals repairs obsolete media rows inherited from older archives", async t => {
  const f = await fixture(t), original = message("legacy");
  f.store.archive.save("chat", [{ ...original, attachments: [{ id: "legacy-file", name: "旧附件", contentUrl: "https://tenant.sharepoint.com/old" }] }]);
  f.store.archive.hosted("chat", "legacy", ["obsolete-image"]);
  const old = f.store.archive.mediaRows("chat", "legacy"), image = old.find(item => item.kind === "image")!;
  f.store.archive.saveBytes(image.id, "image/png", new Uint8Array([1]));
  // Simulate the pre-fix upsert: original value changed, media rows survived.
  const legacy = new DatabaseSync(join(f.dir, "agent.sqlite"));
  legacy.prepare("UPDATE teams_archive_messages SET value=? WHERE chat_id='chat' AND id='legacy'").run(JSON.stringify(original)); legacy.close();
  assert.equal(f.store.archive.mediaRows("chat", "legacy").length, 2);
  f.context.teamsSender.read = async () => { f.store.archive.save("chat", [original]); return { data: { items: [original], nextCursor: null } }; };
  const result = (await f.call("/messages?chatId=chat"))!.data as TeamsConversationMessages;
  assert.deepEqual(result.items[0].media, []);
  for (const item of old) assert.equal(f.store.archive.media(item.id), undefined);
});

test("A background sync started before a denial cannot restore access or advance its watermark", async t => {
  const f = await fixture(t), original = { ...message("pending"), messageType: "message" }, oldMark = new Date(Date.now() - 3600_000).toISOString();
  await writeFile(join(f.dir, "teams-forward.json"), JSON.stringify({ chat: oldMark }));
  f.store.archive.save("chat", [original]); f.store.archive.hosted("chat", "pending", ["picture"]);
  const media = f.store.archive.mediaRows("chat", "pending")[0]; f.store.archive.saveBytes(media.id, "image/png", new Uint8Array([1]));
  let finish!: (response: Response) => void, began!: () => void, paused = true;
  const started = new Promise<void>(resolve => { began = resolve; });
  const sync = createTeamsSync({ dir: f.dir, store: f.store, getToken: async () => "synthetic", fetchImpl: async input => {
    const url = String(input);
    if (url.includes("/me?")) return Response.json({ id: "me" });
    if (url.includes("/me/chats?")) return Response.json({ value: [{ id: "chat", chatType: "oneOnOne" }] });
    if (paused) { began(); return new Promise(resolve => { finish = resolve; }); }
    return Response.json({ value: [original] });
  } });
  const pending = sync.refresh(); await started;
  f.store.triage.access("chat", false); finish(Response.json({ value: [original] }));
  assert.equal((await pending).ok, false);
  assert.equal(f.store.archive.media(media.id), undefined);
  assert.equal(f.store.message("chat:pending"), undefined);
  assert.equal(JSON.parse(await readFile(join(f.dir, "teams-forward.json"), "utf8")).chat, oldMark);
  paused = false;
  assert.equal((await sync.refresh()).ok, true); assert.ok(f.store.archive.media(media.id)?.bytes);
});

test("The actual archived-media HTTP route denies old URLs after 403 and permits a new verified recovery", async t => {
  const f = await fixture(t), original = message("image");
  f.store.archive.save("chat", [original]); f.store.archive.hosted("chat", "image", ["picture"]);
  const media = f.store.archive.mediaRows("chat", "image")[0]; f.store.archive.saveBytes(media.id, "image/png", new Uint8Array([1, 2, 3]));
  const router = createRouter(f.context as Parameters<typeof createRouter>[0], {} as Parameters<typeof createRouter>[1]);
  const server = createServer((req, res) => { void router(req, res).catch(error => { res.statusCode = error instanceof HttpError ? error.status : 500; res.end(); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/api/teams/media/${media.id}`;
  assert.equal((await fetch(url)).status, 200);
  f.context.teamsSender.read = async () => { throw Object.assign(new Error("denied"), { status: 403 }); };
  await assert.rejects(f.call("/messages?chatId=chat"));
  assert.equal((await fetch(url)).status, 404);
  f.context.teamsSender.read = async () => ({ data: { items: [original], nextCursor: null } });
  await f.call("/messages?chatId=chat");
  const recovered = await fetch(url); assert.equal(recovered.status, 200); assert.equal(recovered.headers.get("cache-control"), "private, no-store");
});

test("An unchanged upgraded original retaining one image cannot retain an unrelated removed image", async t => {
  const f = await fixture(t), original = { ...message("partial"), body: { contentType: "html", content: '<p>只保留这一张</p><img src="https://graph.microsoft.com/v1.0/chats/chat/messages/partial/hostedContents/kept/$value">' } };
  f.store.archive.save("chat", [original]); f.store.archive.hosted("chat", "partial", ["kept", "removed"]);
  const old = f.store.archive.mediaRows("chat", "partial"); for (const item of old) f.store.archive.saveBytes(item.id, "image/png", new Uint8Array([1]));
  f.context.teamsSender.read = async () => { f.store.archive.save("chat", [original]); return { data: { items: [original], nextCursor: null } }; };
  const result = (await f.call("/messages?chatId=chat"))!.data as TeamsConversationMessages;
  assert.equal(result.items[0].media.length, 1);
  assert.equal(result.items[0].media[0].id, old.find(item => item.name === "截图 1")!.id);
  const stillThere = old.filter(item => f.store.archive.media(item.id));
  assert.equal(stillThere.length, 1);
  assert.ok(f.store.archive.media(old.find(item => item.name === "截图 1")!.id));
  assert.equal(f.store.archive.media(old.find(item => item.name === "截图 2")!.id), undefined);
});
