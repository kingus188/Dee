import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { openNotificationOutbox } from "../dist/notification-outbox.js";
import { notificationApi } from "../dist/notification-api.js";

const config = { url: "https://notify.example.test/events", mode: "all", kind: "generic" };
const quiet = { enabled: true, start: "22:00", end: "08:00", timeZone: "Asia/Shanghai" };

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-notification-preferences-"));
  let now = Date.parse("2026-10-25T15:30:00Z"), fail = false;
  const sent: { id: string; body: string }[] = [];
  const send: typeof fetch = async (_url, init) => {
    sent.push({ id: new Headers(init?.headers).get("x-pi-event-id")!, body: String(init?.body) });
    return new Response(null, { status: fail ? 503 : 200 });
  };
  const queues: ReturnType<typeof openNotificationOutbox>[] = [];
  function open() { const value = openNotificationOutbox(dir, config, send, () => now); queues.push(value); return value; }
  let queue = open();
  t.after(async () => { for (const value of queues) await value.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    get queue() { return queue; }, sent,
    at(value: string) { now = Date.parse(value); }, fail(value: boolean) { fail = value; },
    async restart() { await queue.close(); queue = open(); },
    device() { return open(); },
    api(method: string, path: string, body: Record<string, unknown> = {}, notifications = queue) {
      return notificationApi({ config: { offline: false, notifications: config }, notifications } as Parameters<typeof notificationApi>[0], method, new URL(path, "http://localhost"), body);
    },
  };
}

test("阅读增删在SQLite重启后跨设备同步，不覆盖其他设备的新标记", async t => {
  const f = await fixture(t);
  const read = () => f.api("GET", "/api/notifications/reads")?.data;
  assert.deepEqual(read(), { keys: [] });
  f.api("POST", "/api/notifications/reads", { keys: ["1:reminder:a:123"], read: true });
  const second = f.device();
  f.api("POST", "/api/notifications/reads", { keys: ["2:background:b:456"], read: true }, second);
  assert.deepEqual(read(), { keys: ["1:reminder:a:123", "2:background:b:456"] });
  f.api("POST", "/api/notifications/reads", { keys: ["1:reminder:a:123"], read: false });
  await f.restart();
  assert.deepEqual(read(), { keys: ["2:background:b:456"] });
});

test("阅读标记保留最近500个版本，校验键与批量长度且失败不部分写入", async t => {
  const f = await fixture(t);
  const keys = Array.from({ length: 500 }, (_, i) => `1:reminder:event-${i}:42`);
  f.api("POST", "/api/notifications/reads", { keys, read: true });
  f.api("POST", "/api/notifications/reads", { keys: ["1:reminder:event-500:42"], read: true });
  const current = f.api("GET", "/api/notifications/reads")?.data as { keys: string[] };
  assert.equal(current.keys.length, 500); assert.equal(current.keys.includes(keys[0]), false);
  for (const body of [{ keys: [...keys, "x"], read: true }, { keys: ["valid", 1], read: true }, { keys: [""], read: true }, { keys: ["a\nsecret"], read: true }, { keys: ["x".repeat(1025)], read: true }, { keys: ["x"], read: "yes" }]) {
    assert.throws(() => f.api("POST", "/api/notifications/reads", body), { status: 400 });
  }
  assert.deepEqual(f.api("GET", "/api/notifications/reads")?.data, current);
});

test("免打扰起止与时区严格验证，持久设置不泄漏渠道正文", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.api("GET", "/api/notifications/preferences")?.data, { quietHours: { ...quiet, enabled: false }, webhookDigest: { enabled: false, windowSeconds: 60 }, webhookAttention: { enabled: false, maxPerHour: 6, cooldownSeconds: 300 } });
  assert.deepEqual(f.api("POST", "/api/notifications/preferences", { quietHours: quiet })?.data, { quietHours: quiet, webhookDigest: { enabled: false, windowSeconds: 60 }, webhookAttention: { enabled: false, maxPerHour: 6, cooldownSeconds: 300 } });
  for (const patch of [{ start: "25:00" }, { start: "9:00" }, { end: "08:60" }, { start: "08:00" }, { timeZone: "Invalid/Zone" }, { enabled: "yes" }, { timeZone: "" }]) {
    assert.throws(() => f.api("POST", "/api/notifications/preferences", { quietHours: { ...quiet, ...patch } }), { status: 400 });
  }
  await f.restart();
  assert.deepEqual(f.api("GET", "/api/notifications/preferences")?.data, { quietHours: quiet, webhookDigest: { enabled: false, windowSeconds: 60 }, webhookAttention: { enabled: false, maxPerHour: 6, cooldownSeconds: 300 } });
  assert.doesNotMatch(JSON.stringify(f.api("GET", "/api/notifications/preferences")), /notify\.example|events|body/);
});

test("跨日免打扰保留普通通知与正文，零投递次数，窗口结束重启后仅投一次", async t => {
  const f = await fixture(t);
  f.api("POST", "/api/notifications/preferences", { quietHours: quiet });
  const event = { id: "normal:pending", body: '{"failed":false,"text":"保留原始事件"}' };
  await f.queue.enqueue(event); await f.queue.flush();
  assert.equal(f.sent.length, 0);
  assert.equal(f.queue.list()[0].status, "pending"); assert.equal(f.queue.list()[0].attempts, 0);
  assert.equal(f.queue.list()[0].nextAt, Date.parse("2026-10-26T00:00:00Z"));
  await f.restart();
  f.at("2026-10-25T23:59:59Z"); await f.queue.flush(); assert.equal(f.sent.length, 0);
  f.at("2026-10-26T00:00:00Z"); await f.queue.flush();
  assert.deepEqual(f.sent, [event]);
  await f.queue.enqueue({ ...event, body: "duplicate" }); await f.queue.flush();
  assert.equal(f.sent.length, 1); assert.equal(f.queue.list()[0].attempts, 1);
});

test("关闭免打扰立即释放队列；已有失败记录保留，显式重试仍受窗口限制", async t => {
  const f = await fixture(t);
  f.at("2026-10-25T13:00:00Z"); f.fail(true);
  await f.queue.enqueue({ id: "failed", body: "{}" });
  for (let i = 0; i < 5; i++) { await f.queue.flush(); f.at(new Date(Date.parse("2026-10-25T13:00:00Z") + (i + 1) * 20 * 60000).toISOString()); }
  assert.equal(f.queue.list()[0].status, "failed"); assert.equal(f.sent.length, 5);
  f.api("POST", "/api/notifications/preferences", { quietHours: quiet });
  f.at("2026-10-25T15:00:00Z");
  assert.equal(f.queue.list()[0].status, "failed");
  assert.equal(f.queue.retry("failed"), "queued"); await f.queue.flush(); assert.equal(f.sent.length, 5);
  f.api("POST", "/api/notifications/preferences", { quietHours: { ...quiet, enabled: false }, webhookDigest: { enabled: false, windowSeconds: 60 }, webhookAttention: { enabled: false, maxPerHour: 6, cooldownSeconds: 300 } });
  f.fail(false); await f.queue.flush(); assert.equal(f.sent.length, 6); assert.equal(f.queue.list()[0].status, "sent");
});

test("白天窗口起点包含终点排除，设置变更即时生效", async t => {
  const f = await fixture(t);
  f.api("POST", "/api/notifications/preferences", { quietHours: { enabled: true, start: "09:00", end: "10:00", timeZone: "UTC" } });
  f.at("2026-10-26T09:00:00Z"); await f.queue.enqueue({ id: "day", body: "{}" }); await f.queue.flush(); assert.equal(f.sent.length, 0);
  f.at("2026-10-26T10:00:00Z"); await f.queue.flush(); assert.equal(f.sent.length, 1);
});

test("夏令时回拨与跳时按真实时区窗口恢复，免打扰不消耗重试", async t => {
  for (const [at, end] of [["2026-11-01T05:45:00Z", "2026-11-01T07:30:00Z"], ["2026-03-08T06:45:00Z", "2026-03-08T07:00:00Z"]]) {
    const f = await fixture(t);
    f.api("POST", "/api/notifications/preferences", { quietHours: { enabled: true, start: "01:00", end: "02:30", timeZone: "America/New_York" } });
    f.at(at); await f.queue.enqueue({ id: at, body: "{}" }); await f.queue.flush();
    assert.equal(f.sent.length, 0); assert.equal(f.queue.list()[0].nextAt, Date.parse(end));
    f.at(end); await f.queue.flush(); assert.equal(f.sent.length, 1); assert.equal(f.queue.list()[0].attempts, 1);
  }
});


test("紧急、失败和审批绕过免打扰，较早普通事件不阻塞且重启仍保留优先级", async t => {
  const f = await fixture(t);
  f.api("POST", "/api/notifications/preferences", { quietHours: quiet });
  await f.queue.enqueue({ id: "a:normal", body: "{}" });
  await f.queue.enqueue({ id: "b:failure", body: '{"failed":true}' });
  await f.queue.enqueue({ id: "c:approval", body: '{"type":"approval"}' });
  await f.queue.enqueue({ id: "d:urgent", body: '{"msg_type":"text","content":{"text":"保持接收端格式"}}', priority: "urgent" });
  await f.restart();
  assert.equal(f.queue.list().find(item => item.id === "a:normal")?.nextAt, Date.parse("2026-10-26T00:00:00Z"));
  assert.equal(f.queue.list().find(item => item.id === "d:urgent")?.nextAt, Date.parse("2026-10-25T15:30:00Z"));
  await f.queue.flush();
  assert.deepEqual(f.sent.map(item => item.id), ["b:failure", "c:approval", "d:urgent"]);
  assert.equal(f.queue.list().find(item => item.id === "a:normal")?.attempts, 0);
  await f.queue.flush(); assert.equal(f.sent.length, 3);
});


test("旧 outbox 保留原文、优先级和幂等键；缺少来源信息时不自动发送", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-notification-legacy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const at = Date.parse("2026-10-25T15:30:00Z");
  const target = createHash("sha256").update(JSON.stringify([config.url, config.kind])).digest("hex");
  const db = new DatabaseSync(join(dir, "agent.sqlite"));
  db.exec(`CREATE TABLE notification_outbox (
    target TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER, last_error TEXT, PRIMARY KEY(target, id))`);
  for (const [id, body] of [["failure", '{"failed":true,"text":"原始失败"}'], ["approval", '{"type":"approval"}'],
    ["normal", '{"text":"urgent approval failed 这些只是正文"}'], ["malformed", "legacy opaque payload"]]) {
    db.prepare("INSERT INTO notification_outbox(target,id,body,next_at,created_at) VALUES (?,?,?,?,?)").run(target, id, body, at, at);
  }
  db.close();
  const sent: { id: string; body: string }[] = [];
  const queue = openNotificationOutbox(dir, config, async (_url, init) => {
    sent.push({ id: new Headers(init?.headers).get("x-pi-event-id")!, body: String(init?.body) }); return new Response(null, { status: 200 });
  }, () => at);
  try {
    queue.preferences.save({ quietHours: quiet });
    await queue.flush();
    assert.deepEqual(sent, []);
    assert.deepEqual(queue.list("cancelled").map(item => item.id), ["approval", "failure", "malformed", "normal"]);
    assert.ok(queue.list().every(item => item.attempts === 0 && item.lastError === "Source provenance unavailable"));
    await queue.enqueue({ id: "failure", body: "new body must not overwrite", priority: "normal" });
    await queue.flush(); assert.equal(sent.length, 0);
    assert.equal(queue.retry("failure"), "conflict");
    const inspect = new DatabaseSync(join(dir, "agent.sqlite"));
    try {
      const records = inspect.prepare("SELECT id,priority,body FROM notification_outbox ORDER BY id").all();
      assert.deepEqual(records.map(row => [row.id, row.priority]), [["approval", "approval"], ["failure", "urgent"], ["malformed", "normal"], ["normal", "normal"]]);
      assert.equal(records[1].body, '{"failed":true,"text":"原始失败"}');
    } finally { inspect.close(); }
  } finally { await queue.close(); }
});


test("紧急旁路不绕过网络失败的重试退避，也不消耗额外尝试", async t => {
  const f = await fixture(t);
  f.api("POST", "/api/notifications/preferences", { quietHours: quiet });
  f.fail(true);
  await f.queue.enqueue({ id: "urgent-retry", body: "{}", priority: "urgent" });
  await f.queue.flush(); await f.queue.flush();
  assert.equal(f.sent.length, 1); assert.equal(f.queue.list()[0].attempts, 1);
  assert.equal(f.queue.list()[0].nextAt, Date.parse("2026-10-25T15:30:15Z"));
  f.at("2026-10-25T15:30:14.999Z"); await f.queue.flush(); assert.equal(f.sent.length, 1);
  f.at("2026-10-25T15:30:15Z"); f.fail(false); await f.queue.flush();
  assert.equal(f.sent.length, 2); assert.equal(f.queue.list()[0].status, "sent");
});
