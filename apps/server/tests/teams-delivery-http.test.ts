import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, readConfig } from "../dist/index.js";
import { openTeamsStore } from "../dist/teams-store.js";

test("delivery issues HTTP routes enforce authentication and origin without mutating unknown evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teams-delivery-http-")), store = openTeamsStore(dir);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    store.record({ id: "chat:in", chatId: "chat", chatType: "oneOnOne", senderId: "peer", senderName: "Peer", direction: "in", text: "PRIVATE_SOURCE", important: true, notificationPriority: "urgent", createdAt: new Date().toISOString() });
    const batch = store.notifications.create(false, () => ({ text: "PRIVATE_BODY", prompt: "PRIVATE_PROMPT" }))!;
    const epoch = Number(store.notifications.claim(batch.id)); store.notifications.beginExternal(batch.id, epoch); store.notifications.unknown(batch.id, epoch);
    server = await startServer(readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: dir, PORT: "0", PI_OFFLINE: "1", DEMO_PASSWORD: "synthetic-password" }), "127.0.0.1");
    const endpoint = server.origin + "/api/teams/delivery-issues", headers = { authorization: "Basic " + Buffer.from("demo:synthetic-password").toString("base64") };
    const post = (id: unknown, extra: Record<string, string> = {}) => fetch(endpoint + "/recheck", { method: "POST", headers: { ...headers, "content-type": "application/json", ...extra }, body: JSON.stringify({ id }) });
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint + "/recheck", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: batch.id }) })).status, 401);
    const listed = await fetch(endpoint, { headers }); assert.equal(listed.status, 200);
    const text = await listed.text(); assert.doesNotMatch(text, /PRIVATE_/); assert.match(text, /unknown/); assert.match(text, /"available":false/);
    assert.equal((await post(batch.id, { origin: "https://foreign.invalid" })).status, 403);
    assert.equal((await post("bad", { origin: server.origin })).status, 400);
    const offline = await post(batch.id, { origin: server.origin }); assert.equal(offline.status, 503);
    assert.match(await offline.text(), /未重新发送/);
    assert.equal(store.notifications.deliveryIssues().items[0].state, "unknown");
    assert.equal(store.notifications.claim(batch.id), false);
  } finally { await server?.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});
