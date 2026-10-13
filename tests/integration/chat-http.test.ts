import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, post, launch, stop, readView } from "./helpers.js";


test("聊天附件、SSE、重复提交、分叉、停止和导出保持兼容", { timeout: 40000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-chat-"));
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch(dir, await freePort());
    const { id } = await post(app.origin, "/api/conversations");
    const prefix = `/api/conversations/${id}`;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=", "base64");
    const body = { text: "聊天回归", requestId: "chat-regression", attachments: [
      { name: "note.md", mimeType: "text/markdown", data: Buffer.from("测试笔记").toString("base64") },
      { name: "pixel.png", mimeType: "image/png", data: png.toString("base64") },
    ] };
    const accepted = await post(app.origin, prefix + "/messages", body);
    assert.equal((await post(app.origin, prefix + "/messages", body)).submissionId, accepted.submissionId);
    const complete = await readView(app.origin, id, v => !v.busy && v.entries.some(e => e.text === "演示任务完成。"));
    const user = complete.entries.find(e => e.kind === "user")!;
    assert.equal(user.text, body.text); assert.equal(user.attachments?.length, 2);
    assert.equal(complete.entries.filter(e => e.kind === "user").length, 1);
    assert.equal(complete.notes.todos.length, 3); assert.ok(complete.notes.todos.every(t => t.done));
    const image = await fetch(app.origin + user.attachments!.find(a => a.kind === "image")!.url);
    assert.equal(image.status, 200); assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    const exported = await (await fetch(app.origin + prefix + "/export.md")).text();
    assert.match(exported, /聊天回归/); assert.match(exported, /演示任务完成/);
    const fork = await post(app.origin, prefix + "/fork", { entryId: complete.entries.findLast(e => e.kind === "assistant")!.id });
    assert.deepEqual((await readView(app.origin, fork.id)).notes, complete.notes);
    const forkPrefix = `/api/conversations/${fork.id}`;
    await post(app.origin, forkPrefix + "/messages", { text: "停止检查", requestId: "stop-check" });
    await readView(app.origin, fork.id, v => !!v.live.tools?.some(t => t.name === "wait_seconds" && t.status === "running"));
    await post(app.origin, forkPrefix + "/abort");
    assert.equal((await readView(app.origin, fork.id, v => !v.busy)).busy, false);
    const malformed = await fetch(app.origin + prefix + "/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x", attachments: [{ name: "bad.png", mimeType: "image/png", data: "@@@@" }] }) });
    assert.equal(malformed.status, 400);
  } finally { if (app) await stop(app.child); await rm(dir, { recursive: true, force: true }); }
});
