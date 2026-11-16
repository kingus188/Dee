import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openNotificationOutbox } from "../dist/notification-outbox.js";
import { createSourceLifecycle } from "../dist/source-lifecycle.js";

async function fixture(t: TestContext, kind = "generic", digest = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-notification-race-"));
  const db = new DatabaseSync(join(dir, "agent.sqlite"));
  const sources = createSourceLifecycle(db);
  let at = 0, calls = 0, begin!: () => void, accept!: (value: Response) => void, reject!: (reason: Error) => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const queue = openNotificationOutbox(dir, { url: "https://unused.example.test/webhook", mode: "all", kind }, async () => {
    calls++; begin();
    return new Promise<Response>((resolve, fail) => { accept = resolve; reject = fail; });
  }, () => at);
  t.after(async () => {
    // Release a suspended mock even when an assertion fails before the reply.
    accept?.(new Response(null, { status: 500 }));
    await queue.close(); db.close(); await rm(dir, { recursive: true, force: true });
  });
  if (digest) queue.preferences.save({ quietHours: queue.preferences.get().quietHours, webhookDigest: { enabled: true, windowSeconds: 60 } });
  await queue.enqueue({ id: "first", body: '{"text":"one"}', sources: [{ source: "conv:1" }] });
  if (digest) await queue.enqueue({ id: "second", body: '{"text":"two"}', sources: [{ source: "conv:1" }] });
  at = 60_000;
  const sending = queue.flush(); await started;
  return { queue, db, sending, get calls() { return calls; }, revoke() { sources.revoke("conv:1"); },
    accept(value: Response) { accept(value); }, reject() { reject(new Error("private network details must not be persisted")); } };
}

for (const kind of ["generic", "feishu"]) {
  test(kind + " confirmed receipt detects revocation without an intervening list or polling call", async t => {
    const f = await fixture(t, kind);
    f.revoke();
    f.accept(kind === "feishu" ? Response.json({ code: 0 }) : new Response(null, { status: 200 }));
    await f.sending;
    assert.equal(f.queue.list()[0].status, "sent");
    assert.match(f.queue.list()[0].lastError!, /delivery succeeded after cancellation/);
    assert.equal(f.queue.retry("first"), "conflict");
    await f.queue.flush(); assert.equal(f.calls, 1);
  });
}

for (const outcome of ["http", "unknown", "feishu"] as const) {
  test(outcome + " outcome after revocation stays stopped and records its actual result category", async t => {
    const f = await fixture(t, outcome === "feishu" ? "feishu" : "generic");
    f.revoke();
    assert.equal(f.queue.list()[0].status, "cancelled");
    assert.match(f.queue.list()[0].lastError!, /in-flight delivery may already have occurred/);
    if (outcome === "unknown") f.reject();
    else f.accept(outcome === "http" ? new Response(null, { status: 503 }) : Response.json({ code: 1 }));
    await f.sending;
    const record = f.queue.list()[0];
    assert.equal(record.status, "cancelled"); assert.equal(record.attempts, 1);
    assert.match(record.lastError!, outcome === "http" ? /HTTP 503/ : outcome === "feishu" ? /Feishu rejected notification/ : /Network error or timeout/);
    assert.match(record.lastError!, /delivery not confirmed and may already have occurred/);
    assert.doesNotMatch(record.lastError!, /private network details/);
    assert.equal(f.queue.retry("first"), "conflict");
    await f.queue.flush(); assert.equal(f.calls, 1);
  });
}

test("late successful digest receipt synchronizes every cancelled member without re-enqueueing", async t => {
  const f = await fixture(t, "generic", true);
  f.revoke();
  assert.equal(f.queue.list()[0].status, "cancelled");
  f.accept(new Response(null, { status: 200 })); await f.sending;
  const record = f.queue.list()[0];
  assert.equal(record.status, "sent"); assert.deepEqual(record.memberIds, ["first", "second"]);
  const rows = f.db.prepare("SELECT status,attempts,last_error FROM notification_outbox").all();
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.status === "sent" && row.attempts === 1 && String(row.last_error).includes("delivery succeeded after cancellation")));
  assert.equal(f.queue.retry("second"), "conflict");
  await f.queue.flush(); assert.equal(f.calls, 1);
});

test("manual retry cannot reuse an old delivery claim epoch", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-notification-epoch-"));
  let at = 0, first!: (response: Response) => void, latest!: (response: Response) => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const config = { url: "https://unused.example.test/webhook", mode: "all" as const, kind: "generic" };
  const old = openNotificationOutbox(dir, config, async () => {
    started(); return new Promise<Response>(resolve => { first = resolve; });
  }, () => at);
  let calls = 0;
  const fresh = openNotificationOutbox(dir, config, async () => {
    calls++;
    if (calls === 1) return new Response(null, { status: 400 });
    return new Promise<Response>(resolve => { latest = resolve; });
  }, () => at);
  t.after(async () => {
    first?.(new Response(null, { status: 400 })); latest?.(new Response(null, { status: 400 }));
    await Promise.all([old.close(), fresh.close()]); await rm(dir, { recursive: true, force: true });
  });
  await old.enqueue({ id: "event", body: "{}" });
  const stale = old.flush(); await waiting;
  at = 30_001; await fresh.flush();
  assert.equal(fresh.list()[0].status, "failed");
  assert.equal(fresh.retry("event"), "queued");
  const current = fresh.flush();
  assert.equal(fresh.list()[0].attempts, 1);
  first(new Response(null, { status: 200 })); await stale;
  assert.equal(fresh.list()[0].status, "pending", "old success must not settle the new attempt with the same attempt count");
  latest(new Response(null, { status: 400 })); await current;
  assert.equal(fresh.list()[0].status, "failed");
});

test("legacy outbox migrates claim epoch without changing existing delivery state", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-notification-migration-"));
  const db = new DatabaseSync(join(dir, "agent.sqlite"));
  db.exec(`CREATE TABLE notification_outbox (
    target TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    finished_at INTEGER, last_error TEXT, PRIMARY KEY(target,id));
    INSERT INTO notification_outbox(target,id,body,status,attempts,next_at,created_at,last_error)
      VALUES ('legacy','existing','{}','failed',5,100,0,'HTTP 400')`);
  const queue = openNotificationOutbox(dir, { url: "https://unused.example.test/webhook", mode: "all", kind: "generic" });
  t.after(async () => { await queue.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  const row = db.prepare("SELECT status, attempts, claim_epoch, last_error FROM notification_outbox WHERE id='existing'").get()!;
  assert.equal(row.claim_epoch, 0);
  assert.equal(row.status, "failed"); assert.equal(row.attempts, 5); assert.equal(row.last_error, "HTTP 400");
});

for (const status of [200, 400, 503]) {
  test(`expired fifth claim cannot settle manual retry before its next claim (${status})`, async t => {
    const dir = await mkdtemp(join(tmpdir(), "pi-notification-fifth-epoch-"));
    let at = 0, respond!: (response: Response) => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const config = { url: "https://unused.example.test/webhook", mode: "all" as const, kind: "generic" };
    const old = openNotificationOutbox(dir, config, async () => {
      started(); return new Promise<Response>(resolve => { respond = resolve; });
    }, () => at);
    let newCalls = 0;
    const fresh = openNotificationOutbox(dir, config, async () => {
      newCalls++; return new Response(null, { status: 400 });
    }, () => at);
    const db = new DatabaseSync(join(dir, "agent.sqlite"));
    t.after(async () => {
      respond?.(new Response(null, { status: 400 }));
      await Promise.all([old.close(), fresh.close()]); db.close(); await rm(dir, { recursive: true, force: true });
    });
    await old.enqueue({ id: "event", body: "{}" });
    db.prepare("UPDATE notification_outbox SET attempts=4 WHERE id='event'").run();
    const stale = old.flush(); await waiting;
    const epoch = Number(db.prepare("SELECT claim_epoch FROM notification_outbox WHERE id='event'").get()!.claim_epoch);
    at = 30_001; await fresh.flush();
    assert.equal(fresh.list()[0].status, "failed");
    assert.ok(Number(db.prepare("SELECT claim_epoch FROM notification_outbox WHERE id='event'").get()!.claim_epoch) > epoch);
    const expiredEpoch = Number(db.prepare("SELECT claim_epoch FROM notification_outbox WHERE id='event'").get()!.claim_epoch);
    assert.equal(fresh.retry("event"), "queued");
    assert.ok(Number(db.prepare("SELECT claim_epoch FROM notification_outbox WHERE id='event'").get()!.claim_epoch) > expiredEpoch);
    const queued = fresh.list()[0];
    // No new claim: retry itself must revoke the old worker's settlement authority.
    const stopping = old.close();
    respond(new Response(null, { status })); await stale; await stopping;
    assert.equal(newCalls, 0);
    assert.deepEqual(fresh.list()[0], queued);
  });
}
