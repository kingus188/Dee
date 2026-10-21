import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { NotificationOverview } from "@assistant/contracts";
import { readConfig } from "../dist/config.js";
import { startServer } from "../dist/index.js";
import { openNotificationOutbox } from "../dist/notification-outbox.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-notification-api-"));
  const received: { id: string; body: string; path: string }[] = [];
  const rejected = new Set<string>();
  const receiver = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const id = String(req.headers["x-pi-event-id"]);
    received.push({ id, body, path: req.url || "/" });
    res.writeHead(rejected.has(id) ? 400 : 200); res.end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      receiver.once("error", reject);
      receiver.listen(0, "127.0.0.1", () => { receiver.removeListener("error", reject); resolve(); });
    });
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  const config = readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: dir, PORT: "0", NOTIFY_MODE: "all",
    NOTIFY_WEBHOOK_URL: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/notify?token=private-test-token` });
  const queues: { close(): Promise<void> }[] = [];
  const services: { close(): Promise<void> }[] = [];
  return {
    config, received, rejected,
    open(notifications = config.notifications, now = Date.now) {
      const queue = openNotificationOutbox(dir, notifications, fetch, now); queues.push(queue); return queue;
    },
    async start(overrides: Partial<typeof config> = {}) {
      const service = await startServer({ ...config, ...overrides }, "127.0.0.1"); services.push(service); return service;
    },
    async close() {
      try { for (const service of services) await service.close(); }
      finally {
        try { for (const queue of queues) await queue.close(); }
        finally {
          try {
            await new Promise<void>((resolve, reject) => {
              receiver.close(error => error ? reject(error) : resolve()); receiver.closeAllConnections();
            });
          } finally { await rm(dir, { recursive: true, force: true }); }
        }
      }
    },
  };
}

async function overview(origin: string, status = "", headers: Record<string, string> = {}): Promise<NotificationOverview> {
  const response = await fetch(origin + "/api/notifications" + (status ? `?status=${status}` : ""), { headers });
  assert.equal(response.status, 200);
  return await response.json() as NotificationOverview;
}

function retry(origin: string, body: unknown, headers: Record<string, string> = {}) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  return fetch(origin + "/api/notifications/retry", { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
}

async function waitForSent(origin: string, id: string) {
  const deadline = Date.now() + 5000;
  do {
    const item = (await overview(origin)).items.find(row => row.id === id);
    if (item?.status === "sent") return item;
    // Exercise the real server's one-second drain interval; fake clocks would not drive its HTTP I/O.
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`notification ${id} was not sent within 5 seconds`);
}

test("HTTP notifications redact payloads, filter before limiting, and isolate targets and terminal states", async () => {
  const f = await fixture();
  try {
    let now = Date.now() - 10000;
    const queue = f.open(f.config.notifications, () => now);
    f.rejected.add("old-failed");
    await queue.enqueue({ id: "old-failed", body: '{"text":"private original payload"}' });
    await queue.flush();
    for (let i = 0; i < 101; i++) {
      now++;
      await queue.enqueue({ id: `sent:${String(i).padStart(3, "0")}`, body: '{"text":"private sent payload"}' });
      if (i % 20 === 19) await queue.flush();
    }
    await queue.flush();
    now = Date.now() + 60000;
    await queue.enqueue({ id: "future-pending", body: '{"text":"private pending payload"}' });
    await queue.close();
    const foreignConfig = { ...f.config.notifications, url: f.config.notifications.url + "&target=other" };
    const foreign = f.open(foreignConfig);
    f.rejected.add("foreign-failed");
    await foreign.enqueue({ id: "foreign-failed", body: '{"text":"private foreign payload"}' });
    await foreign.flush(); await foreign.close();
    const count = f.received.length;
    const service = await f.start();
    const all = await overview(service.origin);
    assert.equal(all.enabled, true); assert.equal(all.mode, "all"); assert.equal(all.kind, "generic");
    assert.equal(all.items.length, 100);
    assert.equal(all.items.some(item => item.id === "old-failed" || item.id === "foreign-failed"), false);
    const failed = await overview(service.origin, "failed");
    assert.deepEqual(failed.items.map(item => item.id), ["old-failed"]);
    assert.equal(failed.items[0].status, "failed"); assert.equal(failed.items[0].lastError, "HTTP 400");
    const sent = await overview(service.origin, "sent");
    assert.equal(sent.items.length, 100); assert.ok(sent.items.every(item => item.status === "sent"));
    const pending = await overview(service.origin, "pending");
    assert.deepEqual(pending.items.map(item => item.id), ["future-pending"]);
    for (const result of [all, failed, sent, pending]) {
      assert.deepEqual(Object.keys(result).sort(), ["enabled", "items", "kind", "mode"]);
      for (const item of result.items) {
        assert.deepEqual(Object.keys(item).sort(), ["attempts", "createdAt", "finishedAt", "id", "lastError", "nextAt", "status"]);
      }
      assert.doesNotMatch(JSON.stringify(result), /private|127\.0\.0\.1|private-test-token|"body"|"url"|"target"/);
    }
    for (const id of ["future-pending", "sent:100"]) assert.equal((await retry(service.origin, { id })).status, 409);
    for (const id of ["foreign-failed", "missing"]) assert.equal((await retry(service.origin, { id })).status, 404);
    assert.equal(f.received.length, count);
    assert.deepEqual((await overview(service.origin, "failed")).items, failed.items);
  } finally { await f.close(); }
});

test("HTTP manual retry persists the original event and payload, resets attempts, and cannot resend success", async () => {
  const f = await fixture();
  try {
    const event = { id: "retry:original", body: '{"text":"原始通知\\nunchanged", "number":42}' };
    f.rejected.add(event.id);
    const queue = f.open();
    await queue.enqueue(event); await queue.flush(); await queue.close();
    const service = await f.start();
    const failed = (await overview(service.origin, "failed")).items[0];
    assert.equal(failed.id, event.id); assert.equal(failed.attempts, 1); assert.ok(failed.finishedAt !== null);
    f.rejected.delete(event.id);
    const response = await retry(service.origin, { id: event.id });
    assert.equal(response.status, 202); assert.deepEqual(await response.json(), { ok: true });
    const sent = await waitForSent(service.origin, event.id);
    assert.equal(sent.attempts, 1); assert.equal(sent.lastError, null); assert.ok(sent.finishedAt !== null);
    assert.equal(sent.createdAt, failed.createdAt);
    assert.deepEqual(f.received.map(({ id, body }) => ({ id, body })), [event, event]);
    assert.equal((await retry(service.origin, { id: event.id })).status, 409);
    await service.close();
    const reopened = f.open();
    await reopened.enqueue({ id: event.id, body: "replacement must not be delivered" });
    assert.deepEqual(reopened.list().map(item => ({ ...item })), [sent]); await reopened.close();
    const restarted = await f.start();
    assert.deepEqual((await overview(restarted.origin)).items, [sent]);
    assert.equal((await retry(restarted.origin, { id: event.id })).status, 409);
    assert.equal(f.received.length, 2);
  } finally { await f.close(); }
});

test("HTTP notifications remain readable but reject retries when off, unconfigured, or offline", async () => {
  for (const mode of ["off", "no-url", "offline"] as const) {
    const f = await fixture();
    try {
      const notifications = mode === "no-url" ? { ...f.config.notifications, url: "" } : f.config.notifications;
      const queue = f.open(notifications);
      f.rejected.add("disabled-event");
      await queue.enqueue({ id: "disabled-event", body: '{"text":"must not resend"}' });
      if (mode !== "no-url") await queue.flush();
      await queue.close();
      const count = f.received.length;
      const service = await f.start(mode === "offline" ? { offline: true }
        : { notifications: { ...notifications, mode: mode === "off" ? "off" : "all" } });
      const result = await overview(service.origin);
      assert.equal(result.enabled, false, mode);
      assert.equal(result.items.length, 1, mode);
      assert.equal(result.items[0].id, "disabled-event", mode);
      assert.equal(result.items[0].status, mode === "no-url" ? "pending" : "failed", mode);
      assert.equal((await retry(service.origin, { id: "disabled-event" })).status, 409, mode);
      assert.deepEqual((await overview(service.origin)).items, result.items, mode);
      assert.equal(f.received.length, count, mode);
    } finally { await f.close(); }
  }
});

test("HTTP notification management requires authentication and same-origin writes and validates retry ids", async () => {
  const f = await fixture();
  try {
    f.rejected.add("protected-failure");
    const queue = f.open();
    await queue.enqueue({ id: "protected-failure", body: "{}" }); await queue.flush(); await queue.close();
    const service = await f.start({ password: "notification-test-password" });
    const headers = { authorization: "Basic " + Buffer.from("demo:notification-test-password").toString("base64") };
    assert.equal((await fetch(service.origin + "/api/notifications")).status, 401);
    assert.equal((await retry(service.origin, { id: "protected-failure" })).status, 401);
    assert.equal((await fetch(service.origin + "/api/notifications", { headers: { authorization: "Basic " + Buffer.from("demo:wrong").toString("base64") } })).status, 401);
    const before = await overview(service.origin, "failed", headers);
    assert.equal((await retry(service.origin, { id: "protected-failure" }, { ...headers, origin: "https://cross-site.invalid" })).status, 403);
    for (const id of [undefined, "", "x".repeat(513), 0, null, {}, []]) {
      assert.equal((await retry(service.origin, { id }, { ...headers, origin: service.origin })).status, 400);
    }
    assert.equal((await retry(service.origin, { id: "x".repeat(512) }, headers)).status, 404);
    assert.deepEqual((await overview(service.origin, "failed", headers)).items, before.items);
    assert.equal(f.received.length, 1);
  } finally { await f.close(); }
});
