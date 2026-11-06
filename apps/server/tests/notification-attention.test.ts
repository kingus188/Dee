import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createNotifier } from "@assistant/features";
import { openNotificationOutbox } from "../dist/notification-outbox.js";

const defaults = { enabled: false, maxPerHour: 6, cooldownSeconds: 300 };
async function fixture(t: TestContext, kind = "generic") {
  const dir = await mkdtemp(join(tmpdir(), "pi-notification-attention-"));
  let at = 0, status = 200;
  const config = { url: "https://unused.example.test/notify", mode: "all", kind };
  const sent: { id: string; body: string }[] = [];
  const send: typeof fetch = async (_url, init) => {
    sent.push({ id: new Headers(init?.headers).get("x-pi-event-id")!, body: String(init?.body) });
    return status === 200 && kind === "feishu" ? Response.json({ code: 0 }) : new Response(null, { status });
  };
  const open = () => openNotificationOutbox(dir, config, send, () => at);
  let queue = open();
  t.after(async () => { await queue.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    get queue() { return queue; }, sent, config, dir, open,
    at(value: number) { at = value; }, fail(value = true) { status = value ? 503 : 200; },
    policy(patch: Partial<typeof defaults> = {}) { queue.preferences.save({ quietHours: queue.preferences.get().quietHours, webhookAttention: { ...defaults, enabled: true, ...patch } }); },
    async restart() { await queue.close(); queue = open(); },
    add(id: string, type = "background") { return queue.enqueue({ id, body: JSON.stringify({ id, type, text: id, failed: false }) }); },
  };
}

test("attention policy is explicit, validated atomically, survives restart and legacy preference writes", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.queue.preferences.get().webhookAttention, defaults);
  f.policy({ maxPerHour: 2, cooldownSeconds: 60 });
  f.queue.preferences.save({ quietHours: f.queue.preferences.get().quietHours });
  await f.restart();
  const before = f.queue.preferences.get();
  assert.deepEqual(before.webhookAttention, { enabled: true, maxPerHour: 2, cooldownSeconds: 60 });
  for (const webhookAttention of [null, {}, { ...defaults, enabled: 1 }, { ...defaults, maxPerHour: 0 }, { ...defaults, maxPerHour: 61 },
    { ...defaults, maxPerHour: 1.5 }, { ...defaults, cooldownSeconds: -1 }, { ...defaults, cooldownSeconds: 3601 }, { ...defaults, cooldownSeconds: 1.5 }]) {
    assert.throws(() => f.queue.preferences.save({ quietHours: { ...before.quietHours, enabled: true }, webhookAttention }), { status: 400 });
    assert.deepEqual(f.queue.preferences.get(), before);
  }
});

test("cooldown and rolling budget defer without dropping or attempting; explanations survive restart", async t => {
  const f = await fixture(t); f.policy({ maxPerHour: 2, cooldownSeconds: 60 });
  await f.add("a"); await f.add("b"); await f.add("c");
  await f.queue.flush();
  assert.deepEqual(f.sent.map(row => row.id), ["a"]);
  assert.equal(f.queue.list("pending").find(row => row.id === "b")?.nextAt, 60_000);
  assert.equal(f.queue.list("pending").find(row => row.id === "b")?.delivery?.reason, "cooldown");
  assert.ok(f.queue.list("pending").every(row => row.attempts === 0 && row.lastError === null));
  await f.restart(); f.at(59_999); await f.queue.flush(); assert.equal(f.sent.length, 1);
  f.at(60_000); await f.queue.flush();
  assert.deepEqual(f.sent.map(row => row.id), ["a", "b"]);
  assert.equal(f.queue.list("pending")[0].delivery?.reason, "hourly_budget");
  assert.equal(f.queue.list("pending")[0].nextAt, 3_600_000);
  f.at(3_599_999); await f.queue.flush(); assert.equal(f.sent.length, 2);
  f.at(3_600_000); await f.queue.flush(); assert.deepEqual(f.sent.map(row => row.id), ["a", "b", "c"]);
  assert.ok(f.sent.every(row => JSON.parse(row.body).type === "background"), "no protocol rewrite");
});

test("structured failures, approvals and requested reminders bypass exhausted attention without keyword inference", async t => {
  const f = await fixture(t); f.policy({ maxPerHour: 1, cooldownSeconds: 3600 });
  await f.add("a"); await f.queue.flush();
  await f.add("b:ordinary");
  await f.queue.enqueue({ id: "c:keywords", body: '{"text":"urgent approval failed reminder"}' });
  await f.queue.enqueue({ id: "d:failure", body: '{"failed":true}', priority: "normal" });
  await f.queue.enqueue({ id: "e:approval", body: '{"type":"approval"}', priority: "normal" });
  await f.add("f:reminder", "reminder"); await f.add("g:schedule", "schedule");
  await f.queue.enqueue({ id: "h:urgent", body: "{}", priority: "urgent" });
  await f.queue.flush();
  assert.deepEqual(f.sent.map(row => row.id), ["a", "d:failure", "e:approval", "h:urgent", "f:reminder", "g:schedule"]);
  assert.deepEqual(f.queue.list("pending").map(row => row.id), ["b:ordinary", "c:keywords"]);
  f.queue.preferences.save({ quietHours: { enabled: true, start: "00:00", end: "01:00", timeZone: "UTC" } });
  await f.add("quiet-reminder", "reminder"); await f.queue.flush();
  assert.equal(f.queue.list("pending").find(row => row.id === "quiet-reminder")?.delivery?.reason, "quiet_hours");
});

test("Feishu requested reminders retain structured classification without changing provider payload", async t => {
  const f = await fixture(t, "feishu"); f.policy({ maxPerHour: 1 });
  const notify = createNotifier(f.config, f.queue.enqueue);
  await notify({ id: "complete", type: "background", text: "completed" }); await f.queue.flush();
  await notify({ id: "reminder", type: "reminder", text: "due now" });
  await f.restart(); await f.queue.flush();
  assert.deepEqual(JSON.parse(f.sent[1].body), { msg_type: "text", content: { text: "due now" } });
});

test("unknown network outcomes retain a single budget reservation; retries respect backoff, not cooldown", async t => {
  const f = await fixture(t); f.policy({ maxPerHour: 1, cooldownSeconds: 3600 }); f.fail();
  await f.add("a:retry"); await f.add("b:new"); await f.queue.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.queue.list().find(row => row.id === "a:retry")?.delivery?.reason, "retry_backoff");
  await f.restart(); f.at(14_999); await f.queue.flush(); assert.equal(f.sent.length, 1);
  f.fail(false); f.at(15_000); await f.queue.flush();
  assert.deepEqual(f.sent.map(row => row.id), ["a:retry", "a:retry"]);
  assert.equal(f.queue.list("pending")[0].nextAt, 3_600_000);
  f.policy({ enabled: false }); await f.queue.flush();
  assert.equal(f.sent[2].id, "b:new");
});

test("concurrent outbox connections share atomic budget reservations", async t => {
  const f = await fixture(t); f.policy({ maxPerHour: 1, cooldownSeconds: 0 });
  await f.add("a"); await f.add("b");
  const other = f.open();
  try { await Promise.all([f.queue.flush(), other.flush()]); }
  finally { await other.close(); }
  assert.equal(f.sent.length, 1);
  assert.equal(f.queue.list("pending")[0].attempts, 0);
  await f.restart(); await f.queue.flush(); assert.equal(f.sent.length, 1);
});

test("digest is one budget unit and reminder members cannot be trapped behind normal backlog", async t => {
  const f = await fixture(t); f.policy({ maxPerHour: 1, cooldownSeconds: 0 });
  f.queue.preferences.save({ quietHours: f.queue.preferences.get().quietHours, webhookDigest: { enabled: true, windowSeconds: 60 } });
  await f.add("a"); await f.add("b"); f.at(60_000); await f.queue.flush();
  assert.equal(f.sent.length, 1); assert.equal(JSON.parse(f.sent[0].body).events.length, 2);
  await f.add("c"); f.at(120_000); await f.queue.flush(); assert.equal(f.sent.length, 1);
  await f.add("reminder", "reminder"); f.at(180_000); await f.queue.flush();
  assert.equal(f.sent.length, 2); assert.equal(JSON.parse(f.sent[1].body).events[0].id, "reminder");
  assert.equal(f.queue.list("pending").length, 1);
});

test("budget history is destination-scoped and off remains off", async t => {
  const f = await fixture(t); f.policy({ maxPerHour: 1 }); await f.add("a"); await f.queue.flush();
  let sends = 0;
  const alternate = openNotificationOutbox(f.dir, { ...f.config, url: "https://other.example.test/notify" }, async () => { sends++; return new Response(null); }, () => 0);
  try { await alternate.enqueue({ id: "b", body: "{}" }); await alternate.flush(); assert.equal(sends, 1); }
  finally { await alternate.close(); }
  const off = openNotificationOutbox(f.dir, { ...f.config, mode: "off" }, async () => { assert.fail("off cannot send"); }, () => 0);
  try { await off.enqueue({ id: "urgent", body: '{"failed":true}' }); await off.flush(); }
  finally { await off.close(); }
});

test("legacy opaque reminders with explicit provenance keep timing when the new policy is enabled", async t => {
  const f = await fixture(t, "feishu"); await f.queue.close();
  const db = new DatabaseSync(join(f.dir, "agent.sqlite"));
  const target = createHash("sha256").update(JSON.stringify([f.config.url, f.config.kind])).digest("hex");
  db.exec("ALTER TABLE notification_outbox DROP COLUMN attention_class");
  db.prepare("INSERT INTO notification_outbox(target,id,body,next_at,created_at,sources_json) VALUES (?,?,?,?,?,'[]')")
    .run(target, "legacy", '{"msg_type":"text","content":{"text":"legacy reminder"}}', 0, 0);
  db.close(); await f.restart(); f.policy({ maxPerHour: 1 });
  await f.add("a"); await f.queue.flush();
  assert.deepEqual(f.sent.map(row => row.id), ["legacy", "a"]);
});
