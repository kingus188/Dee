import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMailStore, type MailRecord } from "../dist/mail-store.js";
import { createMailAuth } from "../dist/mail-auth.js";
import { mailPagingUrl, syncMail, MailRetryError } from "../dist/mail-sync.js";
import { createMailService } from "../dist/mail-service.js";
import { mailApi } from "../dist/mail-api.js";

const settings = { enabled: true, tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222" };
const tokens = { accessToken: "fake-access-test", refreshToken: "fake-refresh-test", expiresAt: Date.now() + 3600000 };
const delta = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=unit";
const next = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=unit";
const json = (data: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const signal = () => new AbortController().signal;
const raw = (id: string) => ({ id, subject: "季度报价 100%", from: { emailAddress: { name: "张三", address: "zhang@example.test" } }, receivedDateTime: new Date().toISOString(), bodyPreview: "纯文本预览", body: { contentType: "text", content: "完整正文" }, isRead: false, hasAttachments: true });
const row = (id: string): MailRecord => ({ id, subject: "季度报价 100%", sender: "张三", address: "zhang@example.test", receivedAt: new Date().toISOString(), preview: "预览", text: "正文", isRead: false, hasAttachments: true });
async function temp(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-mail-"));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test("邮件缓存和分页游标一起落盘，基线不提醒，后续插入去重、删除与重启一致", async t => {
  const dir = await temp(t); let store = openMailStore(dir);
  try {
    store.update({ settings, tokens });
    store.page([row("old")], [], next, false);
    assert.equal(store.notices(0).items.length, 0);
    store.close(); store = openMailStore(dir);
    assert.equal(store.state().cursor, next); assert.equal(store.state().initialComplete, false);
    store.page([row("old"), row("baseline")], [], delta, true);
    assert.equal(store.notices(0).items.length, 0);
    store.page([row("new"), { ...row("old"), isRead: true }], [], delta, true);
    store.page([row("new")], [], delta, true);
    assert.deepEqual(store.notices(0).items.map(n => n.message.id), ["new"]);
    assert.equal(store.list({ sender: "example.TEST", subject: "100%", unread: true, limit: 50 }).length, 2);
    assert.equal(store.list({ subject: "%invalid", limit: 50 }).length, 0);
    assert.equal(store.read("new")!.text, "正文");
    assert.equal("text" in store.list({ limit: 1 })[0], false);
    store.close(); store = openMailStore(dir);
    assert.equal(store.notices(0).items.length, 1);
    const sequence = store.notices(0).latest;
    store.page([], ["new"], delta, true); assert.equal(store.notices(0).items.length, 0);
    store.reset(); assert.equal(store.state().tokens, null); assert.equal(store.list({ limit: 50 }).length, 0);
    store.page([], [], delta, true); store.page([row("other-account")], [], delta, true);
    assert.ok(store.notices(0).latest > sequence, "清理后序列不复用，页面游标可继续");
  } finally { store.close(); }
});

test("Graph 增量同步使用只读 GET、ImmutableId 和纯文本，支持分页、稀疏更新及删除", async t => {
  const store = openMailStore(await temp(t)); t.after(() => store.close()); store.update({ settings, tokens });
  const queue = [json({ value: [raw("a")], "@odata.nextLink": next }), json({ value: [raw("b")], "@odata.deltaLink": delta }),
    json({ value: [{ id: "a", isRead: true }, raw("c"), { id: "b", "@removed": { reason: "deleted" } }], "@odata.deltaLink": delta })];
  const urls: string[] = [];
  const mockFetch: typeof fetch = async (url, init) => {
    urls.push(String(url)); assert.equal(init!.method, undefined); assert.equal(init!.redirect, "error");
    const headers = init!.headers as Record<string, string>; assert.match(headers.Prefer, /ImmutableId/); assert.match(headers.Prefer, /body-content-type="text"/);
    assert.equal(headers.Authorization, "Bearer fake-access-test"); return queue.shift()!;
  };
  await syncMail(store, async () => tokens.accessToken, signal(), mockFetch);
  assert.match(urls[0], /%24filter=receivedDateTime/); assert.equal(urls[1], next);
  assert.equal(store.notices(0).items.length, 0); assert.equal(store.state().initialComplete, true);
  await syncMail(store, async () => tokens.accessToken, signal(), mockFetch);
  assert.equal(store.read("a")!.message.isRead, true); assert.equal(store.read("a")!.text, "完整正文");
  assert.equal(store.read("b"), undefined); assert.equal(store.notices(0).items[0].message.id, "c");
});

test("坏分页地址/页面不落盘，429 遵守 Retry-After，410 清理失效基线，HTML 只用预览", async t => {
  const store = openMailStore(await temp(t)); t.after(() => store.close()); store.update({ settings, tokens });
  for (const url of ["https://evil.test/delta", "https://graph.microsoft.com.evil.test/v1.0/me/mailFolders/inbox/messages/delta", "https://graph.microsoft.com/v1.0/users/other/messages", "https://graph.microsoft.com:444/v1.0/me/mailFolders/inbox/messages/delta", "http://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta"]) assert.throws(() => mailPagingUrl(url));
  await assert.rejects(syncMail(store, async () => "x", signal(), async () => json({ value: [raw("x")], "@odata.nextLink": "https://evil.test/" })), /不受信任/);
  assert.equal(store.read("x"), undefined); assert.equal(store.state().cursor, null);
  await assert.rejects(syncMail(store, async () => "x", signal(), async () => json({ value: [raw("x"), { id: "invalid" }], "@odata.deltaLink": delta })), /格式无效/);
  assert.equal(store.read("x"), undefined);
  await assert.rejects(syncMail(store, async () => "x", signal(), async () => json({}, 429, { "retry-after": "180" })), e => e instanceof MailRetryError && e.retryMs === 180000);
  await syncMail(store, async () => "x", signal(), async () => json({ value: [{ ...raw("html"), body: { contentType: "html", content: "<script>bad()</script>" } }], "@odata.deltaLink": delta }));
  assert.equal(store.read("html")!.text, "纯文本预览");
  await assert.rejects(syncMail(store, async () => "x", signal(), async () => json({}, 410)), /游标已过期/);
  assert.equal(store.state().initialComplete, false); assert.equal(store.state().cursor, null); assert.equal(store.read("html"), undefined); assert.ok(store.state().tokens);
});

test("设备代码登录支持 pending/slow_down，令牌不外泄，刷新轮换持久化并处理撤销", async t => {
  const store = openMailStore(await temp(t)); t.after(() => store.close()); store.update({ settings });
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const requests: URLSearchParams[] = [];
  const queue = [json({ device_code: "private-device", user_code: "CODE-UNIT", verification_uri: "https://www.microsoft.com/devicelogin", expires_in: 900, interval: 5 }),
    json({ error: "authorization_pending" }, 400), json({ error: "slow_down" }, 400), json({ access_token: "new-private-access", refresh_token: "new-private-refresh", expires_in: 3600 }),
    json({ access_token: "refreshed-access", refresh_token: "rotated-refresh", expires_in: 3600 }), json({ error: "invalid_grant", error_description: "private diagnostic" }, 400)];
  const auth = createMailAuth(store, async (url, init) => { assert.match(String(url), /login.microsoftonline.com\/11111111/); assert.equal(init!.redirect, "error"); requests.push(init!.body as URLSearchParams); return queue.shift()!; });
  await auth.begin(signal()); assert.equal(auth.status()!.userCode, "CODE-UNIT"); assert.equal(JSON.stringify(auth.status()).includes("private-device"), false);
  assert.equal(await auth.poll(signal()), false); assert.equal(requests.length, 1);
  now += 5000; assert.equal(await auth.poll(signal()), false);
  now += 5000; assert.equal(await auth.poll(signal()), false);
  now += 5000; assert.equal(await auth.poll(signal()), false); assert.equal(requests.length, 3, "slow_down 延长轮询");
  now += 5000; assert.equal(await auth.poll(signal()), true);
  assert.equal(auth.status(), null); assert.equal(await auth.token(signal()), "new-private-access");
  assert.equal(requests[0].get("scope"), "https://graph.microsoft.com/Mail.Read offline_access");
  assert.equal(requests.some(p => p.has("password") || p.has("client_secret")), false);
  now += 3600000; assert.equal(await auth.token(signal()), "refreshed-access"); assert.equal(store.state().tokens!.refreshToken, "rotated-refresh");
  now += 3600000; await assert.rejects(auth.token(signal()), /请重新登录/); assert.equal(store.state().tokens, null);
});

test("离线服务即使已有启用配置和令牌也不联网；配置即时生效、隐藏秘密并可清理", async t => {
  const dir = await temp(t), seed = openMailStore(dir); seed.update({ settings, tokens }); seed.page([row("cached")], [], delta, true); seed.close();
  let requests = 0;
  const service = createMailService(dir, true, async () => { requests++; throw new Error("不应联网"); }); t.after(() => service.close());
  service.start(); await service.refresh(); assert.equal(requests, 0); assert.equal(service.status().offline, true);
  assert.equal(service.list({ limit: 50 }).length, 1);
  assert.equal(JSON.stringify(service.status()).includes("fake-"), false);
  assert.throws(() => service.login(), /离线模式/);
  assert.throws(() => service.save({ ...settings, tenantId: "../../common" }), /UUID/);
  assert.throws(() => mailApi(service, "GET", new URL("http://localhost/api/mail/notices?after=NaN"), {}), /游标无效/);
  assert.deepEqual(await mailApi(service, "GET", new URL("http://localhost/api/mail/notices"), {}), { status: 200, data: { latest: 0, items: [] } });
  await service.save({ ...settings, enabled: false }); assert.equal(service.status().enabled, false); assert.equal(service.status().connected, true);
  await service.disconnect(); assert.equal(service.status().connected, false); assert.equal(service.list({ limit: 50 }).length, 0);
});

test("重试窗口阻止查询工具绕过限流，关闭等待在途请求且不写入迟到结果", async t => {
  const dir = await temp(t), seed = openMailStore(dir); seed.update({ settings, tokens }); seed.close();
  let calls = 0, finish!: (response: Response) => void;
  const service = createMailService(dir, false, async () => { calls++; return json({}, 429, { "retry-after": "300" }); });
  await assert.rejects(service.refresh(), /等待重试/);
  await assert.rejects(service.refresh(), /等待重试/); assert.equal(calls, 1); await service.close();
  const second = createMailService(dir, false, async () => new Promise(resolve => { finish = resolve; }));
  const refresh = second.refresh();
  await new Promise(resolve => setImmediate(resolve));
  let closed = false; const closing = second.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  finish(json({ value: [raw("late")], "@odata.deltaLink": delta }));
  await assert.rejects(refresh, /已停止/); await closing;
  const inspect = openMailStore(dir); assert.equal(inspect.read("late"), undefined); inspect.close();
});

test("服务设备登录在后台轮询并自动同步；禁用后不再联网", async t => {
  const dir = await temp(t); let now = Date.now(); t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const service = createMailService(dir, false, async url => {
    calls++;
    if (String(url).endsWith("devicecode")) return json({ device_code: "test-device", user_code: "TEST-CODE", verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 5 });
    if (String(url).endsWith("token")) return json({ access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 });
    return json({ value: [raw("baseline")], "@odata.deltaLink": delta });
  });
  t.after(() => service.close());
  await service.save(settings); await service.login(); service.start();
  await new Promise(resolve => setImmediate(resolve));
  now += 5000; t.mock.timers.tick(5000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().connected, true);
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.status().initialComplete, true); assert.equal(service.notices(0).items.length, 0);
  const count = calls; await service.save({ ...settings, enabled: false }); now += 120000; t.mock.timers.tick(120000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, count); assert.equal(service.status().enabled, false);
});

test("刷新令牌请求取消后，迟到的撤销响应不能更改登录状态", async t => {
  const store = openMailStore(await temp(t)); t.after(() => store.close());
  store.update({ settings, tokens: { ...tokens, expiresAt: 0 } });
  let finish!: (response: Response) => void;
  const auth = createMailAuth(store, async () => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController(), pending = auth.token(controller.signal);
  controller.abort(); finish(json({ error: "invalid_grant" }, 400));
  await assert.rejects(pending);
  assert.equal(store.state().tokens?.refreshToken, tokens.refreshToken, "取消后的响应不能写入令牌状态");
});

test("设备登录接受微软实际返回的 login.microsoft.com，拒绝仿冒和不安全链接", async t => {
  const store = openMailStore(await temp(t)); t.after(() => store.close()); store.update({settings});
  for (const verification_uri of ["https://login.microsoft.com/device", "https://microsoft.com/devicelogin", "https://login.microsoft.com.attacker.example/device", "http://login.microsoft.com/device", "https://user@login.microsoft.com/device"]) {
    const auth = createMailAuth(store, async () => json({device_code:"private-test",user_code:"TEST-ONLY",verification_uri,expires_in:900,interval:5}));
    if (["https://login.microsoft.com/device", "https://microsoft.com/devicelogin"].includes(verification_uri)) {
      await auth.begin(signal()); assert.equal(auth.status()?.verificationUri,verification_uri);
    } else await assert.rejects(auth.begin(signal()), /不受支持/);
  }
});

test("微软真实 OData inbox 分页路径可续传，其他邮箱和文件夹仍拒绝", async t => {
  const quotedNext = "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta?$skiptoken=unit";
  const quotedDelta = "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta?$deltatoken=unit";
  assert.equal(mailPagingUrl(quotedNext), quotedNext);
  for (const url of [
    "https://graph.microsoft.com/v1.0/me/mailFolders('sentitems')/messages/delta?$skiptoken=unit",
    "https://graph.microsoft.com/v1.0/users('other')/mailFolders('inbox')/messages/delta?$skiptoken=unit",
    "https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=unit",
    "https://graph.microsoft.com.attacker.test/v1.0/me/mailFolders('inbox')/messages/delta",
    "http://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta",
    "https://user@graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta",
    "https://graph.microsoft.com:444/v1.0/me/mailFolders('inbox')/messages/delta",
  ]) assert.throws(() => mailPagingUrl(url), /不受信任/);
  const store = openMailStore(await temp(t)); t.after(() => store.close()); store.update({ settings, tokens });
  const paths: string[] = [];
  await syncMail(store, async () => tokens.accessToken, signal(), async url => {
    paths.push(String(url));
    return paths.length === 1 ? json({ value: [raw("baseline1")], "@odata.nextLink": quotedNext }) : json({ value: [raw("baseline2")], "@odata.deltaLink": quotedDelta });
  });
  assert.equal(paths[1], quotedNext); assert.equal(store.state().cursor, quotedDelta); assert.equal(store.state().initialComplete, true);
  assert.equal(store.notices(0).items.length, 0); assert.equal(store.list({ limit: 10 }).length, 2);
});
