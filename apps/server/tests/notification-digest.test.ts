import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openNotificationOutbox } from "../dist/notification-outbox.js";

async function fixture(t: TestContext, kind = "generic") {
  const dir = await mkdtemp(join(tmpdir(), "pi-digest-"));
  let now = 0, status = 200, throws = false;
  const sent: { id: string; body: string }[] = [];
  const config = { url: "https://example.test/webhook", mode: "all", kind };
  const send: typeof fetch = async (_url, init) => {
    sent.push({ id: new Headers(init?.headers).get("x-pi-event-id")!, body: String(init?.body) });
    if (throws) throw new Error("unknown outcome");
    return kind === "feishu" ? Response.json({ code: 0 }) : new Response(null, { status });
  };
  let queue = openNotificationOutbox(dir, config, send, () => now);
  t.after(async () => { await queue.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    get queue() { return queue; }, sent,
    at(value: number) { now = value; }, status(value: number) { status = value; }, throws(value: boolean) { throws = value; },
    enable(enabled = true) { queue.preferences.save({ quietHours: queue.preferences.get().quietHours, webhookDigest: { enabled, windowSeconds: 60 } }); },
    async restart() { await queue.close(); queue = openNotificationOutbox(dir, config, send, () => now); },
    interruptFifthClaim() {
      const db = new DatabaseSync(join(dir, "agent.sqlite"));
      try { db.exec("BEGIN IMMEDIATE; UPDATE notification_outbox SET status = 'pending', attempts = 5, next_at = 1365000; COMMIT"); }
      finally { db.close(); }
    },
    device() { return openNotificationOutbox(dir, config, send, () => now); },
    rows() { const db = new DatabaseSync(join(dir, "agent.sqlite")); try { return db.prepare("SELECT id, digest_id, status, attempts, next_at FROM notification_outbox ORDER BY id").all(); } finally { db.close(); } },
    async add(id: string, priority?: "normal" | "urgent" | "approval") {
      await queue.enqueue({ id, body: JSON.stringify({ id, type: "event", text: id, failed: false, at: now }), priority });
    },
  };
}

test("digest preferences default off, persist and survive legacy quiet-only saves; reject invalid atomically", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.queue.preferences.get().webhookDigest, { enabled: false, windowSeconds: 60 });
  f.enable();
  f.queue.preferences.save({ quietHours: f.queue.preferences.get().quietHours });
  await f.restart(); assert.equal(f.queue.preferences.get().webhookDigest?.enabled, true);
  const before = f.queue.preferences.get();
  for (const value of [null, {}, { enabled: "yes", windowSeconds: 60 }, { enabled: true, windowSeconds: 0 }, { enabled: true, windowSeconds: 3601 }, { enabled: true, windowSeconds: 10.5 }]) {
    assert.throws(() => f.queue.preferences.save({ quietHours: { ...before.quietHours, enabled: true }, webhookDigest: value }), { status: 400 });
    assert.deepEqual(f.queue.preferences.get(), before);
  }
});

test("opt-in preserves legacy payloads, groups normal window and never lets normal backlog precede urgent/approval", async t => {
  const f = await fixture(t);
  await f.add("legacy"); await f.queue.flush();
  assert.equal(f.sent[0].id, "legacy"); assert.equal(JSON.parse(f.sent[0].body).type, "event");
  f.enable(); await f.add("a"); f.at(59000); await f.add("b");
  await f.queue.flush(); assert.equal(f.sent.length, 1); assert.equal(f.queue.list("pending").length, 2);
  f.at(60000); await f.add("urgent", "urgent"); await f.add("approval", "approval");
  await f.queue.flush();
  assert.deepEqual(f.sent.slice(1, 3).map(row => row.id), ["approval", "urgent"]);
  const digest = JSON.parse(f.sent[3].body);
  assert.equal(digest.type, "digest"); assert.equal(digest.failed, false); assert.equal(digest.at, new Date(60000).toISOString());
  assert.equal(typeof digest.text, "string"); assert.equal(digest.id, f.sent[3].id);
  assert.deepEqual(digest.events.map((event: { id: string }) => event.id), ["a", "b"]);
  assert.deepEqual(f.queue.list().find(row => row.memberIds)?.memberIds, ["a", "b"]);
  assert.equal(f.rows().filter(row => row.digest_id).length, 2);
  assert.ok(f.rows().every(row => row.status === "sent"));
  await f.add("a"); await f.queue.flush(); assert.equal(f.sent.length, 4);
});

test("network-unknown retry and restart retain exact digest ID/body, new arrivals form separate units", async t => {
  const f = await fixture(t); f.enable(); await f.add("a"); await f.add("b");
  f.throws(true); f.at(60000); await f.queue.flush();
  assert.equal(f.queue.list()[0].status, "pending"); assert.equal(f.queue.list()[0].attempts, 1);
  assert.ok(f.rows().every(row => row.status === "pending" && row.attempts === 1));
  await f.restart(); f.enable(false); await f.add("c");
  await f.queue.flush(); // c is independent; digest is still in backoff
  f.throws(false); f.at(75000); await f.queue.flush();
  assert.deepEqual(f.sent.filter(row => row.id.startsWith("digest:")), [f.sent[0], f.sent[0]]);
  assert.equal(f.queue.list().find(row => row.memberIds)?.status, "sent");
});

test("permanent digest failure and member retry atomically synchronize states without splitting", async t => {
  const f = await fixture(t); f.enable(); await f.add("a"); await f.add("b");
  f.status(400); f.at(60000); await f.queue.flush();
  const first = f.sent[0];
  assert.equal(f.queue.list("failed").length, 1);
  assert.ok(f.rows().every(row => row.status === "failed" && row.attempts === 1));
  assert.equal(f.queue.retry("a"), "queued"); assert.equal(f.queue.retry("b"), "conflict");
  assert.ok(f.rows().every(row => row.status === "pending" && row.attempts === 0));
  f.status(200); await f.queue.flush(); assert.deepEqual(f.sent, [first, first]);
  assert.ok(f.rows().every(row => row.status === "sent" && row.attempts === 1));
});

test("quiet hours keep digest members unattempted; resume with one digest and Feishu text", async t => {
  const f = await fixture(t, "feishu"); f.enable();
  f.queue.preferences.save({ quietHours: { enabled: true, start: "00:00", end: "01:00", timeZone: "UTC" } });
  await f.add("a"); f.at(60000); await f.add("b"); await f.queue.flush();
  assert.equal(f.sent.length, 0); assert.ok(f.rows().every(row => row.attempts === 0));
  await f.restart(); f.at(3600000); await f.queue.flush();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(JSON.parse(f.sent[0].body), { msg_type: "text", content: { text: "通知摘要（2 条）\n• a\n• b" } });
});

test("attempt limit after an interrupted digest atomically fails every member, and retry retains the snapshot", async t => {
  const f = await fixture(t); f.enable(); await f.add("a"); f.throws(true); f.at(60000); await f.queue.flush();
  const original = f.sent[0];
  // Model a process dying after its fifth persisted claim, before storing the HTTP outcome.
  const rows = f.rows(); assert.equal(rows.length, 2);
  // All five network attempts use the immutable delivery unit.
  for (const at of [75000, 135000, 435000]) { f.at(at); await f.queue.flush(); }
  f.interruptFifthClaim();
  assert.equal(f.sent.length, 4); assert.ok(f.sent.every(row => row.body === original.body && row.id === original.id));
  await f.restart(); f.at(9000000); await f.queue.flush();
  assert.equal(f.sent.length, 4); assert.ok(f.rows().every(row => row.status === "failed" && row.attempts === 5));
  assert.equal(f.queue.retry(original.id), "queued"); f.throws(false); await f.queue.flush();
  assert.deepEqual(f.sent[4], original);
});

test("a manually retried single event cannot acquire a new digest identity after opt-in", async t => {
  const f = await fixture(t);
  f.status(400); await f.add("original"); await f.queue.flush(); const original = f.sent[0];
  f.enable(); assert.equal(f.queue.retry("original"), "queued"); f.status(200); await f.queue.flush();
  assert.deepEqual(f.sent, [original, original]);
  assert.equal(f.queue.list()[0].memberIds, undefined);
});


test("two outbox connections cannot split members or concurrently send the same claimed digest", async t => {
  const f = await fixture(t); f.enable(); await f.add("a"); await f.add("b"); f.at(60000);
  const other = f.device();
  try {
    await Promise.all([f.queue.flush(), other.flush()]);
    assert.equal(f.sent.length, 1);
    assert.equal(f.queue.list().length, 1);
    assert.deepEqual(f.queue.list()[0].memberIds, ["a", "b"]);
    assert.ok(f.rows().every(row => row.status === "sent" && row.attempts === 1));
  } finally { await other.close(); }
});


test("a backlog larger than one digest stays grouped rather than leaking remaining source events", async t => {
  const f = await fixture(t); f.enable();
  for (let i = 0; i < 105; i++) await f.add("event:" + i);
  f.at(65000); await f.queue.flush();
  assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(row => row.id.startsWith("digest:")));
  assert.deepEqual(f.sent.map(row => JSON.parse(row.body).events.length), [100, 5]);
  assert.ok(f.rows().every(row => row.status === "sent"));
});

for (const [kind, budget] of [["generic", 32 * 1024], ["feishu", 16 * 1024]] as const) {
  test(kind + " digest splits long Chinese content by complete UTF-8 JSON bytes, without losing members", async t => {
    const f = await fixture(t, kind); f.enable();
    const texts: string[] = [];
    for (let i = 0; i < 35; i++) {
      const text = i + "中文消息".repeat(500) + "\n\"\\"; texts.push(text);
      const body = kind === "feishu" ? { msg_type: "text", content: { text } }
        : { id: "long:" + i, type: "event", text, failed: false, at: new Date(0).toISOString() };
      await f.queue.enqueue({ id: "long:" + i, body: JSON.stringify(body) });
    }
    f.at(60000); await f.queue.flush(); await f.queue.flush();
    assert.ok(f.sent.length > 1 && f.sent.length < 35);
    assert.ok(f.sent.every(row => row.id.startsWith("digest:") && Buffer.byteLength(row.body, "utf8") <= budget));
    const memberIds = f.queue.list().flatMap(row => row.memberIds ?? []);
    assert.equal(memberIds.length, 35); assert.equal(new Set(memberIds).size, 35);
    assert.ok(f.rows().every(row => row.status === "sent"));
    if (kind === "generic") {
      const events = f.sent.flatMap(row => JSON.parse(row.body).events) as { id: string; text: string }[];
      for (const event of events) assert.equal(event.text, texts[Number(event.id.split(":")[1])]);
    } else {
      const bodies = f.sent.map(row => JSON.parse(row.body).content.text as string);
      for (const text of texts) assert.ok(bodies.some(body => body.includes(text)));
    }
  });

  test(kind + " over-budget singleton falls back unchanged and cannot block later summaries or retries", async t => {
    const f = await fixture(t, kind); f.enable();
    // The original fits the budget, but the digest wrapper (including duplicate
    // generic summary text) does not. No truncation or protocol change is allowed.
    const text = "中".repeat(kind === "feishu" ? 5444 : 6000);
    const body = JSON.stringify(kind === "feishu" ? { msg_type: "text", content: { text } }
      : { id: "a:large", type: "event", text, failed: false, at: new Date(0).toISOString() });
    assert.ok(Buffer.byteLength(body, "utf8") <= budget);
    await f.queue.enqueue({ id: "a:large", body }); await f.add("b:small");
    f.throws(true); f.at(60000); await f.queue.flush();
    assert.deepEqual(f.sent.find(row => row.id === "a:large"), { id: "a:large", body });
    assert.ok(f.sent.some(row => row.id.startsWith("digest:")));
    assert.equal(f.queue.list().find(row => row.id === "a:large")?.memberIds, undefined);
    const first = [...f.sent]; await f.restart(); f.throws(false); f.at(75000); await f.queue.flush();
    for (const row of first) assert.deepEqual(f.sent.filter(sent => sent.id === row.id), [row, row]);
    assert.ok(f.rows().every(row => row.status === "sent"));
  });
}
