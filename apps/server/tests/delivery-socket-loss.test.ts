import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNotificationOutbox } from "../dist/notification-outbox.js";
import { openTeamsStore } from "../dist/teams-store.js";
import { startTeamsForward } from "../dist/teams-forward.js";

async function receiver() {
  const requests: { id: string; body: string }[] = [], effects = new Set<string>();
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const id = String(req.headers["x-pi-event-id"]); requests.push({ id, body }); effects.add(id);
    // The receiver has applied its business effect, but the response is lost.
    if (requests.length === 1) req.socket.destroy();
    else { res.writeHead(200); res.end(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  let closing: Promise<void> | undefined;
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/notify`, requests, effects,
    close: () => closing ??= new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

test("webhook socket receipt loss replays identical operation identity; receiver dedup is separate from transport", async t => {
  const dir = await mkdtemp(join(tmpdir(), "webhook-socket-loss-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = await receiver(); t.after(() => remote.close());
  let now = 1000;
  const config = { url: remote.url, mode: "all", kind: "generic" };
  let queue = openNotificationOutbox(dir, config, fetch, () => now);
  try {
    await queue.enqueue({ id: "stable-operation", body: '{"text":"synthetic"}' }); await queue.flush();
    assert.equal(remote.requests.length, 1); assert.equal(remote.effects.size, 1);
    assert.equal(queue.list()[0].status, "pending");
    await queue.close(); queue = openNotificationOutbox(dir, config, fetch, () => now);
    now += 15_000; await queue.flush();
    assert.equal(queue.list()[0].status, "sent");
    assert.equal(remote.requests.length, 2); assert.deepEqual(remote.requests[1], remote.requests[0]);
    assert.equal(remote.effects.size, 1, "only this receiver's explicit event-id dedup prevents duplicate effects");
  } finally { await queue.close(); await remote.close(); await rm(dir, { recursive: true, force: true }); }
});

test("raw Teams notification socket receipt loss remains unknown after restart without replay", async t => {
  const dir = await mkdtemp(join(tmpdir(), "teams-socket-loss-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = await receiver(); t.after(() => remote.close());
  let store = openTeamsStore(dir);
  try {
    await mkdir(join(dir, "state/primary"), { recursive: true });
    await writeFile(join(dir, "state/primary/context_tokens.json"), '{"synthetic-wxid":"synthetic-context"}');
    store.record({ id: "chat:in", chatId: "chat", chatType: "oneOnOne", senderId: "peer", senderName: "Peer", direction: "in", text: "synthetic", important: true, notificationPriority: "urgent", createdAt: new Date().toISOString() });
    const notices: string[] = [];
    async function poll() {
      let done!: () => void;
      const finished = new Promise<void>(resolve => { done = resolve; });
      const stop = startTeamsForward({ dir, store, getToken: async () => { assert.fail("no real Graph token is permitted"); }, sendURL: remote.url, sendToken: "synthetic-only",
        sync: { refresh: async () => ({ ok: true, lastSuccessAt: new Date().toISOString(), refreshedChatIds: ["chat"] }), status: () => ({ lastSuccessAt: null }) },
        onStuck: (_count, reason) => { notices.push(reason); }, undelivered: async () => { done(); return []; } });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("local forwarding cycle did not finish")), 3000); });
      try { await Promise.race([finished, deadline]); } finally { clearTimeout(timer); await stop(); }
    }
    await poll();
    assert.equal(remote.requests.length, 1); assert.equal(store.notifications.deliveryIssues().items[0].state, "unknown");
    assert.equal(store.message("chat:in")?.pushedAt, null);
    store.close(); store = openTeamsStore(dir);
    await poll();
    assert.equal(remote.requests.length, 1); assert.equal(store.notifications.deliveryIssues().items[0].state, "unknown");
    assert.ok(notices.every(reason => /结果未知/.test(reason)));
    assert.ok(notices.length >= 2, "restart keeps the unresolved result visible");
  } finally { store.close(); await remote.close(); await rm(dir, { recursive: true, force: true }); }
});
