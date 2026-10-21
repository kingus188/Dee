import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openNotificationOutbox } from "../dist/notification-outbox.js";

test("notifications survive restart, retry with stable payload and deduplicate completed events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-notify-"));
  const received: { id: string; body: string }[] = [];
  const receiver = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received.push({ id: String(req.headers["x-pi-event-id"]), body });
    res.writeHead(received.length === 1 ? 503 : 200); res.end();
  });
  await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const config = { url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`, mode: "all", kind: "generic" };
  let now = 1000;
  let outbox = openNotificationOutbox(dir, config, fetch, () => now);
  try {
    await outbox.enqueue({ id: "event:1", body: '{"text":"hello"}' });
    await outbox.flush();
    assert.equal(outbox.list()[0].status, "pending");
    assert.equal(outbox.list()[0].lastError, "HTTP 503");
    await outbox.close();
    outbox = openNotificationOutbox(dir, config, fetch, () => now);
    await outbox.enqueue({ id: "event:1", body: '{"text":"changed"}' });
    await outbox.flush(); assert.equal(received.length, 1);
    now += 15000; await outbox.flush();
    assert.equal(outbox.list()[0].status, "sent");
    assert.deepEqual(received, [ { id: "event:1", body: '{"text":"hello"}' }, { id: "event:1", body: '{"text":"hello"}' } ]);
    await outbox.enqueue({ id: "event:1", body: "duplicate" });
    await outbox.flush(); assert.equal(received.length, 2);
  } finally { await outbox.close(); await new Promise<void>(resolve => receiver.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test("failed notifications stop after five attempts and offline mode never drains saved events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-notify-fail-"));
  const config = { url: "http://127.0.0.1:1", mode: "all", kind: "generic" };
  let calls = 0, now = 0;
  const send: typeof fetch = async () => { calls++; throw new Error("secret URL must not be persisted"); };
  let outbox = openNotificationOutbox(dir, config, send, () => now);
  try {
    await outbox.enqueue({ id: "failure", body: "{}" });
    await outbox.close();
    outbox = openNotificationOutbox(dir, { ...config, mode: "off" }, send, () => now);
    await outbox.flush(); assert.equal(calls, 0);
    await outbox.close(); outbox = openNotificationOutbox(dir, config, send, () => now);
    for (let i = 0; i < 6; i++) { await outbox.flush(); now += 86400000; }
    assert.equal(calls, 5);
    const item = outbox.list()[0];
    assert.equal(item.status, "failed"); assert.equal(item.attempts, 5);
    assert.equal(item.lastError, "Network error or timeout");
  } finally { await outbox.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Feishu application errors retry, permanent HTTP failures stop, and destinations stay isolated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-notify-target-"));
  const config = { url: "http://127.0.0.1:1/original", mode: "all", kind: "feishu" };
  let now = 0, calls = 0;
  const send: typeof fetch = async () => { calls++; return Response.json({ code: calls === 1 ? 999 : 0 }); };
  let outbox = openNotificationOutbox(dir, config, send, () => now);
  try {
    await outbox.enqueue({ id: "feishu", body: "{}" }); await outbox.flush();
    assert.equal(outbox.list()[0].lastError, "Feishu rejected notification");
    await outbox.close();
    outbox = openNotificationOutbox(dir, { ...config, url: "http://127.0.0.1:1/replacement" }, send, () => now);
    now += 15000; await outbox.flush(); assert.equal(calls, 1);
    assert.deepEqual(outbox.list(), []);
    await outbox.close(); outbox = openNotificationOutbox(dir, config, send, () => now);
    await outbox.flush(); assert.equal(outbox.list()[0].status, "sent");
    await outbox.close();
    outbox = openNotificationOutbox(dir, config, async () => new Response(null, { status: 400 }), () => now);
    await outbox.enqueue({ id: "permanent", body: "{}" }); await outbox.flush();
    const failed = outbox.list().find(item => item.id === "permanent")!;
    assert.equal(failed.status, "failed"); assert.equal(failed.attempts, 1);
    assert.equal(failed.lastError, "HTTP 400");
  } finally { await outbox.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const [status, retryAfter] of [[429, "120"], [503, "Wed, 21 Oct 2026 00:02:00 GMT"]] as const) {
  test(`HTTP ${status} Retry-After survives restart and prevents premature delivery`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-notify-rate-"));
    const received: string[] = [];
    const receiver = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      received.push(body);
      res.writeHead(received.length === 1 ? status : 200, received.length === 1 ? { "Retry-After": retryAfter } : {});
      res.end();
    });
    await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve));
    const config = { url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`, mode: "all", kind: "generic" };
    let now = Date.parse("2026-10-21T00:00:00Z");
    let outbox = openNotificationOutbox(dir, config, fetch, () => now);
    try {
      await outbox.enqueue({ id: "rate-limited", body: '{"text":"reminder"}' });
      await outbox.flush();
      await outbox.close();
      outbox = openNotificationOutbox(dir, config, fetch, () => now);
      now += 119999;
      await outbox.flush();
      assert.deepEqual(received, ['{"text":"reminder"}']);
      assert.equal(outbox.list()[0].attempts, 1);
      now++;
      await outbox.flush();
      assert.deepEqual(received, ['{"text":"reminder"}', '{"text":"reminder"}']);
      assert.equal(outbox.list()[0].status, "sent");
    } finally {
      await outbox.close();
      await new Promise<void>(resolve => receiver.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("invalid, past and shorter Retry-After values retain the local retry backoff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-notify-backoff-"));
  const config = { url: "http://127.0.0.1:1", mode: "all", kind: "generic" };
  let now = Date.parse("2026-10-21T00:00:00Z");
  let calls = 0;
  const headers = ["invalid", "-1", "1.5", "99999999999999999999999", "Tue, 20 Oct 2026 00:00:00 GMT", "1"];
  const outbox = openNotificationOutbox(dir, config, async () => {
    const value = headers[Math.floor(calls++ / 2)];
    return calls % 2 ? new Response(null, { status: 429, headers: { "Retry-After": value } }) : new Response(null);
  }, () => now);
  try {
    for (const value of headers) {
      await outbox.enqueue({ id: value, body: "{}" });
      await outbox.flush();
      const before = calls;
      now += 14999;
      await outbox.flush();
      assert.equal(calls, before, value);
      now++;
      await outbox.flush();
      assert.equal(outbox.list().find(row => row.id === value)?.status, "sent", value);
    }
  } finally { await outbox.close(); await rm(dir, { recursive: true, force: true }); }
});

test("manual retry only requeues failures, survives restart and preserves event identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-notify-manual-"));
  const config = { url: "http://127.0.0.1:1", mode: "all", kind: "generic" };
  const delivered: { id: string | null; body: string }[] = [];
  let now = 1000;
  let outbox = openNotificationOutbox(dir, config, async () => new Response(null, { status: 400 }), () => now);
  try {
    await outbox.enqueue({ id: "failed:1", body: '{"text":"original"}' });
    await outbox.flush();
    assert.equal(outbox.list()[0].status, "failed");
    assert.equal(outbox.retry("missing"), "missing");
    assert.equal(outbox.retry("failed:1"), "queued");
    assert.equal(outbox.retry("failed:1"), "conflict");
    assert.equal(outbox.list()[0].attempts, 0);
    assert.equal(outbox.list()[0].lastError, null);
    assert.equal(outbox.list()[0].finishedAt, null);
    await outbox.close();
    now++;
    outbox = openNotificationOutbox(dir, config, async (_url, init) => {
      delivered.push({ id: new Headers(init?.headers).get("x-pi-event-id"), body: String(init?.body) });
      return new Response(null);
    }, () => now);
    await outbox.enqueue({ id: "failed:1", body: "replacement must be ignored" });
    await outbox.flush();
    assert.deepEqual(delivered, [{ id: "failed:1", body: '{"text":"original"}' }]);
    assert.equal(outbox.list()[0].status, "sent");
    assert.equal(outbox.retry("failed:1"), "conflict");
  } finally { await outbox.close(); await rm(dir, { recursive: true, force: true }); }
});
