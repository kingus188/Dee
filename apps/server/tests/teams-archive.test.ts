import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTeamsArchive } from "../dist/teams-archive-store.js";
import { openTeamsStore } from "../dist/teams-store.js";
import { createTeamsReader } from "../dist/teams-reader.js";
import { createTeamsArchiveSync } from "../dist/teams-archive-sync.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5mQAAAAASUVORK5CYII=", "base64");
const oldMessage = { id: "old", createdDateTime: "2020-01-01T00:00:00.000Z", from: { user: { displayName: "同事" } }, body: { content: "完整原文".repeat(1000) }, attachments: [{ id: "file", name: "合同.docx", contentUrl: "https://tenant.sharepoint.com/合同.docx" }] };

test("长期归档保存原文、附件与截图，重启和 90 天缓存清理不删除，更新幂等且保留图片", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dee-archive-"));
  let store = openTeamsStore(dir);
  try {
    store.archive.bindAccount("owner"); store.archive.chats([{ id: "chat" }]);
    store.archive.save("chat", [{ ...oldMessage, body: { content: oldMessage.body.content + '<img src="https://graph.microsoft.com/v1.0/chats/chat/messages/old/hostedContents/hosted/$value">' } }]); store.archive.hosted("chat", "old", ["hosted"]);
    const image = store.archive.mediaRows("chat", "old").find(m => m.kind === "image")!;
    store.archive.saveBytes(image.id, "image/png", png);
    store.archive.save("chat", [{ ...oldMessage, body: { content: "更新正文".repeat(1000) + '<img src="https://graph.microsoft.com/v1.0/chats/chat/messages/old/hostedContents/hosted/$value">' } }]);
    assert.equal(store.archive.status().messages, 1);
    assert.ok(store.archive.search({ limit: 10 }).items[0].body.content.startsWith("更新正文".repeat(1000)));
    assert.equal(store.archive.media(image.id)?.bytes?.length, png.length);
    store.close(); store = openTeamsStore(dir);
    assert.equal(store.archive.status().messages, 1, "归档独立于临时消息缓存的保留期限");
    assert.equal(store.archive.search({ text: "更新正文", limit: 10 }).items.length, 1);
    assert.equal(store.archive.mediaRows("chat", "old").length, 2);
    assert.ok(store.archive.mediaRows("chat", "old").some(m => m.previewUrl?.includes(image.id)));
    assert.throws(() => store.archive.bindAccount("another-owner"), /账号已变化/);
    assert.equal(store.archive.status().messages, 1, "账号变化不能清空或混用已有归档");
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("相同时间的归档跨聊天稳定分页，参数化搜索，非法附件地址不成为可点击链接", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const archive = openTeamsArchive(db);
    for (const chat of ["a", "b"]) archive.save(chat, [oldMessage, { ...oldMessage, id: "unsafe", attachments: [{ name: "无效附件", contentUrl: "javascript:alert(1)" }] }]);
    const first = archive.search({ limit: 2 }); assert.ok(first.nextCursor);
    const second = archive.search({ limit: 2, before: first.nextCursor! });
    assert.equal(new Set([...first.items, ...second.items].map(x => x.chatId + x.id)).size, 4);
    assert.equal(second.nextCursor, null);
    assert.equal(archive.search({ text: "' OR 1=1 --", limit: 10 }).items.length, 0);
    assert.equal(archive.mediaRows("a", "unsafe")[0].url, undefined);
    assert.equal(archive.mediaRows("a", "unsafe")[0].status, "unavailable");
    assert.throws(() => archive.search({ limit: 10, before: "invalid" }), /分页/);
  } finally { db.close(); }
});

test("真实形状的消息图片经 Graph 获取并入库，后续读取归档和图片不再联网", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const archive = openTeamsArchive(db); let calls = 0, offline = false;
    const read = createTeamsReader({ archive, getToken: async () => { assert.ok(!offline); return "test"; }, fetchImpl: async input => {
      calls++; const url = String(input);
      if (url.includes("/me?")) return Response.json({ id: "owner" });
      if (url.endsWith("/$value")) return new Response(png, { headers: { "content-type": "image/png" } });
      if (url.endsWith("/hostedContents")) return Response.json({ value: [{ id: "hosted" }] });
      return Response.json({ value: [{ ...oldMessage, body: { content: '<p>正文</p><img src="https://graph.microsoft.com/v1.0/chats/chat/messages/old/hostedContents/hosted/$value">' } }] });
    } });
    const result = await read({ kind: "history", chatId: "chat" });
    assert.equal(archive.status().messages, 1);
    assert.equal(result.media?.filter(m => m.kind === "image").length, 1);
    const image = result.media!.find(m => m.kind === "image")!;
    assert.equal(image.status, "ready"); assert.match(image.previewUrl!, /^\/api\/teams\/media\/[a-f0-9]{64}$/);
    const count = calls; offline = true;
    const persisted = await read({ kind: "archive", chatId: "chat" });
    assert.equal((persisted.data as { items: unknown[] }).items.length, 1);
    const content = await read({ kind: "media", id: image.id });
    assert.equal(content.attachment?.kind, "image");
    assert.equal(calls, count);
  } finally { db.close(); }
});

test("历史页失败保留游标，重建同步器后继续，已保存页不会丢失或伪造完成", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const archive = openTeamsArchive(db); let fail = true;
    const read = async (query: Parameters<ReturnType<typeof createTeamsReader>>[0]) => {
      if (query.kind === "chats") return { data: { items: [{ id: "chat" }], nextCursor: null } };
      assert.equal(query.kind, "history");
      if (query.kind !== "history") throw new Error("unexpected");
      if (query.cursor && fail) throw new Error("temporary failure");
      archive.save("chat", [{ ...oldMessage, id: query.cursor ? "second" : "first" }]);
      return { data: { items: [oldMessage], nextCursor: query.cursor ? null : "next" } };
    };
    await createTeamsArchiveSync(archive, read).refresh();
    await createTeamsArchiveSync(archive, read).refresh();
    assert.equal(archive.status().messages, 1);
    assert.equal((db.prepare("SELECT cursor FROM teams_archive_chats").get() as { cursor: string }).cursor, "next");
    fail = false; db.exec("UPDATE teams_archive_chats SET retry_at=''");
    await createTeamsArchiveSync(archive, read).refresh();
    assert.equal(archive.status().messages, 2);
    assert.equal((db.prepare("SELECT complete FROM teams_archive_chats").get() as { complete: number }).complete, 1);
  } finally { db.close(); }
});

test("图片下载失败不伪造已保存，记录失败状态并限制重试次数", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const archive = openTeamsArchive(db);
    const read = createTeamsReader({ archive, getToken: async () => "test", fetchImpl: async input => {
      const url = String(input);
      if (url.includes("/me?")) return Response.json({ id: "owner" });
      if (url.endsWith("/$value")) return new Response("not an image", { headers: { "content-type": "image/png" } });
      if (url.endsWith("/hostedContents")) return Response.json({ value: [{ id: "hosted" }] });
      return Response.json({ value: [{ ...oldMessage, body: { content: '<img src="https://graph.microsoft.com/v1.0/chats/chat/messages/old/hostedContents/hosted/$value">' } }] });
    } });
    const result = await read({ kind: "history", chatId: "chat" });
    const image = result.media!.find(m => m.kind === "image")!;
    assert.equal(image.status, "failed"); assert.equal(image.previewUrl, undefined);
    await assert.rejects(read({ kind: "media", id: image.id }), /尚未保存/);
    for (let i = 0; i < 3; i++) archive.mediaFailure(image.id, "failed");
    db.exec("UPDATE teams_archive_media SET retry_at=''");
    assert.equal(archive.pendingMedia(10).length, 0);
  } finally { db.close(); }
});

test("完成基线后的增量跨页保留原扫描下界，遇到旧消息停止，不重新全扫", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const archive = openTeamsArchive(db); archive.chats([{ id: "chat" }]);
    archive.progress("chat", null, "2026-01-01T12:00:00.000Z");
    const read = async (query: Parameters<ReturnType<typeof createTeamsReader>>[0]) => {
      if (query.kind === "chats") return { data: { items: [{ id: "chat" }], nextCursor: null } };
      if (query.kind !== "history") throw new Error("unexpected");
      return { data: { items: [{ ...oldMessage, lastModifiedDateTime: query.cursor ? "2026-01-01T11:00:00.000Z" : "2026-01-01T13:00:00.000Z" }], nextCursor: query.cursor ? "must-not-follow" : "next" } };
    };
    const sync = createTeamsArchiveSync(archive, read);
    await sync.refresh();
    const midway = archive.nextChat()!;
    assert.equal(midway.complete, 1); assert.equal(midway.scan_floor, "2026-01-01T12:00:00.000Z");
    await sync.refresh();
    assert.equal(archive.nextChat()!.cursor, null);
    assert.equal(archive.nextChat()!.newest, "2026-01-01T13:00:00.000Z");
  } finally { db.close(); }
});

test("截图列表权限失败保留原文和明确失败状态，不阻断聊天页归档", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const archive = openTeamsArchive(db);
    const read = createTeamsReader({ archive, getToken: async () => "test", fetchImpl: async input => {
      const url = String(input);
      if (url.includes("/me?")) return Response.json({ id: "owner" });
      if (url.endsWith("/hostedContents")) return new Response("", { status: 403 });
      return Response.json({ value: [{ ...oldMessage, body: { content: '<img src="https://graph.microsoft.com/v1.0/chats/chat/messages/old/hostedContents/hosted/$value">' } }] });
    } });
    const result = await read({ kind: "history", chatId: "chat" });
    assert.equal(archive.status().messages, 1);
    assert.equal(result.media?.find(m => m.kind === "image")?.status, "failed");
    assert.equal(archive.pendingMedia(10).length, 0);
  } finally { db.close(); }
});
