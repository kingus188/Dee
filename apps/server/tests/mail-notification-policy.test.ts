import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMailStore, type MailRecord } from "../dist/mail-store.js";
import { openNotificationOutbox } from "../dist/notification-outbox.js";
import { createMailService } from "../dist/mail-service.js";
import { mailApi } from "../dist/mail-api.js";

const start = Date.parse("2026-11-04T23:00:00Z");
const quiet = { enabled: true, start: "22:00", end: "08:00", timeZone: "UTC" };
const row = (id: string, importance: MailRecord["importance"] = "normal"): MailRecord => ({
  id, subject: id, sender: "Test", address: "test@example.test", receivedAt: new Date().toISOString(),
  preview: "preview", text: "body", isRead: false, hasAttachments: false, importance,
});
async function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const dir = await mkdtemp(join(tmpdir(), "pi-mail-policy-"));
  const queues: ReturnType<typeof openNotificationOutbox>[] = [];
  const preferenceStore = openNotificationOutbox(dir, { url: "", mode: "off", kind: "generic" });
  queues.push(preferenceStore);
  let store = openMailStore(dir);
  store.page([], [], "unit-baseline", true);
  t.after(async () => { store.close(); for (const queue of queues) await queue.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    dir, get store() { return store; }, preferences: preferenceStore.preferences,
    restart() { store.close(); store = openMailStore(dir); },
    at(value: number) { t.mock.timers.setTime(value); },
  };
}

test("邮件与 webhook 读取同一免打扰偏好，跨重启后只放行一批摘要", async t => {
  const f = await fixture(t);
  f.preferences.save({ quietHours: quiet });
  f.store.page([row("a"), row("b")], [], "unit", true);
  const first = f.store.deliveryNotices(0);
  assert.deepEqual(first, { latest: 2, items: [], cursor: 0, total: 0, urgent: false });
  f.restart();
  f.at(Date.parse("2026-11-05T07:59:59Z"));
  assert.equal(f.store.deliveryNotices(0).items.length, 0);
  f.at(Date.parse("2026-11-05T08:00:00Z"));
  const digest = f.store.deliveryNotices(0);
  assert.deepEqual(digest.items.map(item => item.message.id), ["a", "b"]);
  assert.equal(digest.total, 2); assert.equal(digest.cursor, 2);
  assert.equal(f.store.deliveryNotices(digest.cursor!).items.length, 0);
  assert.equal(f.store.list({ limit: 50 }).length, 2, "摘要不删除邮件内容");
});

test("普通邮件等一分钟合并；大批积压的摘要数量与游标覆盖全部，不逐页刷屏", async t => {
  const f = await fixture(t);
  f.store.page(Array.from({ length: 121 }, (_, index) => row(`mail-${index}`)), [], "unit", true);
  f.at(start + 59_999); assert.equal(f.store.deliveryNotices(0).items.length, 0);
  f.at(start + 60_000);
  const digest = f.store.deliveryNotices(0);
  assert.equal(digest.items.length, 50); assert.equal(digest.total, 121); assert.equal(digest.cursor, 121);
  assert.equal(f.store.deliveryNotices(digest.cursor!).items.length, 0);
  assert.equal(f.store.list({ limit: 200 }).length, 121);
});

test("重要邮件不被免打扰或旧普通队列阻塞，且只触发一次合并摘要", async t => {
  const f = await fixture(t);
  f.preferences.save({ quietHours: quiet });
  f.store.page([row("urgent", "high"), ...Array.from({ length: 80 }, (_, index) => row(`normal-${index}`))], [], "unit", true);
  const digest = f.store.deliveryNotices(0);
  assert.equal(digest.urgent, true); assert.equal(digest.total, 81); assert.equal(digest.cursor, 81);
  assert.equal(digest.items.some(item => item.message.id === "urgent"), true, "大量普通邮件不能挤掉重要邮件预览");
  assert.equal(f.store.deliveryNotices(digest.cursor!).items.length, 0);
});

test("免打扰内同步的已读、移出和重新标未读不会补发；取消后游标不倒退", async t => {
  const f = await fixture(t);
  f.preferences.save({ quietHours: quiet });
  f.store.page([row("read"), row("removed"), row("remain")], [], "unit", true);
  f.store.page([{ ...row("read"), isRead: true }], ["removed"], "unit", true);
  f.restart();
  f.store.page([row("read"), row("removed")], [], "unit", true);
  f.at(Date.parse("2026-11-05T08:00:00Z"));
  const digest = f.store.deliveryNotices(0);
  assert.deepEqual(digest.items.map(item => item.message.id), ["remain"]); assert.equal(digest.total, 1);
  f.store.page([{ ...row("remain"), isRead: true }], [], "unit", true);
  const empty = f.store.deliveryNotices(0);
  assert.equal(empty.items.length, 0); assert.ok(empty.latest >= 3); assert.equal(empty.cursor, empty.latest);
});

test("修改免打扰即时生效，首次 API 请求仍跳过历史且不连接真实邮箱", async t => {
  const f = await fixture(t);
  f.preferences.save({ quietHours: quiet });
  f.store.page([row("new")], [], "unit", true);
  f.at(start + 60_000);
  assert.equal(f.store.deliveryNotices(0).items.length, 0);
  f.preferences.save({ quietHours: { ...quiet, enabled: false } });
  let calls = 0;
  const service = createMailService(f.dir, true, async () => { calls++; throw Error("must not connect"); });
  try {
    assert.deepEqual(mailApi(service, "GET", new URL("http://localhost/api/mail/notices"), {}), { status: 200, data: { latest: 1, items: [] } });
    const result = mailApi(service, "GET", new URL("http://localhost/api/mail/notices?after=0"), {});
    assert.equal((result as { data: { total: number } }).data.total, 1);
    assert.equal(calls, 0);
  } finally { await service.close(); }
});


test("旧增量游标缺少重要性时保守即时提示，不猜测正文也不误延迟紧急邮件", async t => {
  const f = await fixture(t);
  f.preferences.save({ quietHours: quiet });
  f.store.page([{ ...row("legacy"), importance: undefined }], [], "unit", true);
  const batch = f.store.deliveryNotices(0);
  assert.equal(batch.total, 1); assert.equal(batch.items.length, 1);
  assert.equal(batch.urgent, false, "未知重要性不能冒充已确认重要邮件");
});
