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
