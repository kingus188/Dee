import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.deepEqual(f.api("GET", "/api/notifications/preferences")?.data, { quietHours: { ...quiet, enabled: false } });
  assert.deepEqual(f.api("POST", "/api/notifications/preferences", { quietHours: quiet })?.data, { quietHours: quiet });
  for (const patch of [{ start: "25:00" }, { start: "9:00" }, { end: "08:60" }, { start: "08:00" }, { timeZone: "Invalid/Zone" }, { enabled: "yes" }, { timeZone: "" }]) {
    assert.throws(() => f.api("POST", "/api/notifications/preferences", { quietHours: { ...quiet, ...patch } }), { status: 400 });
  }
  await f.restart();
  assert.deepEqual(f.api("GET", "/api/notifications/preferences")?.data, { quietHours: quiet });
  assert.doesNotMatch(JSON.stringify(f.api("GET", "/api/notifications/preferences")), /notify\.example|events|body/);
});

test("跨日免打扰保留失败通知与正文，零投递次数，窗口结束重启后仅投一次", async t => {
  const f = await fixture(t);
  f.api("POST", "/api/notifications/preferences", { quietHours: quiet });
  const event = { id: "failure:pending", body: '{"failed":true,"text":"保留原始失败事件"}' };
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
  f.api("POST", "/api/notifications/preferences", { quietHours: { ...quiet, enabled: false } });
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
