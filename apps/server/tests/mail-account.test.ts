import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailService } from "../dist/mail-service.js";
import { openMailStore } from "../dist/mail-store.js";
import { mailAccountSource } from "../dist/mail-account.js";

const account = { tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222", username: "synthetic@example.test", password: "unit-only-account-password" };
const delta = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=unit";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const raw = (id: string) => ({ id, subject: "unit", receivedDateTime: new Date().toISOString(), body: { contentType: "text", content: "unit" } });
const token = { access_token: "unit-access", refresh_token: "unit-refresh", expires_in: 3600 };
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-mail-account-test-")), file = join(dir, "account.json");
  await writeFile(file, JSON.stringify({ account }), { mode: 0o600 });
  t.after(() => rm(dir, { recursive: true, force: true })); return { dir, file };
}

test("首次自动使用现有账号、只申请邮件权限、续期和重启沿用游标，历史不提醒而新邮件提醒", async t => {
  const { dir, file } = await fixture(t), grants: string[] = [], graphUrls: string[] = [];
  let graphCalls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).startsWith("https://login.microsoftonline.com/")) {
      const form = init!.body as URLSearchParams; grants.push(form.get("grant_type")!);
      assert.equal(form.get("scope"), "https://graph.microsoft.com/Mail.Read offline_access");
      assert.equal(init!.method, "POST"); assert.equal(init!.redirect, "error");
      if (form.get("grant_type") === "password") { assert.equal(form.get("password"), account.password); assert.equal(form.get("username"), account.username); }
      else { assert.equal(form.get("refresh_token"), token.refresh_token); assert.equal(form.has("password"), false); }
      return json(token);
    }
    assert.equal(init?.method ?? "GET", "GET"); graphUrls.push(String(url));
    return json({ value: [raw(graphCalls++ ? "new" : "old")], "@odata.deltaLink": delta });
  };
  let service = createMailService(dir, false, fetcher, file);
  try {
    await service.refresh();
    assert.equal(service.status().authMode, "account"); assert.equal(service.status().connected, true); assert.equal(service.status().initialComplete, true);
    assert.equal(service.notices(0).items.length, 0); assert.deepEqual(grants, ["password"]);
    const metadata = JSON.stringify(service.status()); assert.equal(metadata.includes(account.username), false); assert.equal(metadata.includes(account.password), false); assert.equal(metadata.includes(token.access_token), false);
    await service.close();
    const seed = openMailStore(dir);
    assert.equal(JSON.stringify(seed.state()).includes(account.password), false); assert.equal(JSON.stringify(seed.state()).includes(account.username), false);
    seed.update({ tokens: { refreshToken: token.refresh_token, accessToken: "expired", expiresAt: 0 } }); seed.close();
    service = createMailService(dir, false, fetcher, file); await service.refresh();
    assert.deepEqual(grants, ["password", "refresh_token"]); assert.equal(graphUrls[1], delta);
    assert.deepEqual(service.notices(0).items.map(n => n.message.id), ["new"]);
    await service.refresh(); assert.equal(service.notices(0).items.length, 1, "重复增量不重复提醒");
  } finally { await service.close(); }
});

test("离线绝不使用账号授权；暂停和断开后重启不会自动恢复，手动重连才启用", async t => {
  const { dir, file } = await fixture(t); let calls = 0;
  const fetcher: typeof fetch = async url => { calls++; return String(url).endsWith("token") ? json(token) : json({ value: [], "@odata.deltaLink": delta }); };
  let service = createMailService(dir, true, fetcher, file);
  service.start(); await service.refresh(); assert.equal(calls, 0); assert.throws(() => service.loginAccount(), /离线/); await service.close();
  service = createMailService(dir, false, fetcher, file); await service.refresh();
  await service.save({ ...service.status(), enabled: false }); await service.close(); const paused = calls;
  service = createMailService(dir, false, fetcher, file); await service.refresh(); assert.equal(calls, paused); assert.equal(service.status().enabled, false);
  await service.disconnect(); await service.close();
  service = createMailService(dir, false, fetcher, file); await service.refresh(); assert.equal(calls, paused); assert.equal(service.status().connected, false);
  await service.loginAccount(); await service.refresh(); assert.equal(service.status().enabled, true); assert.equal(service.status().connected, true);
  await service.close();
});

test("账号密码授权失败停止重试且不泄露诊断，重启不再撞密码；手动重连成功", async t => {
  const { dir, file } = await fixture(t); let calls = 0, fail = true;
  const fetcher: typeof fetch = async url => {
    calls++;
    if (!String(url).endsWith("token")) return json({ value: [], "@odata.deltaLink": delta });
    return fail ? json({ error: "invalid_grant", error_codes: [50076], error_description: account.password }, 400) : json(token);
  };
  let service = createMailService(dir, false, fetcher, file);
  await assert.rejects(service.refresh(), /MFA/); assert.match(service.status().error, /交互登录/);
  await service.refresh(); assert.equal(calls, 1); assert.equal(JSON.stringify(service.status()).includes(account.password), false);
  assert.throws(() => service.loginAccount(), /至少等待一分钟/);
  await service.close(); service = createMailService(dir, false, fetcher, file);
  await assert.rejects(service.refresh(), /手动重连/); assert.equal(calls, 1);
  fail = false; await service.loginAccount(); await service.refresh(); assert.equal(service.status().connected, true);
  await service.close();
});

test("已保存手动配置不会被现有账号覆盖，交互登录后也不回退密码授权", async t => {
  const { dir, file } = await fixture(t); const grants: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("devicecode")) return json({ device_code: "unit", user_code: "UNIT", verification_uri: "https://login.microsoft.com/device", expires_in: 900 });
    grants.push((init!.body as URLSearchParams).get("grant_type")!); return json(token);
  };
  let service = createMailService(dir, false, fetcher, file);
  await service.save({ ...account, tenantId: "33333333-3333-3333-3333-333333333333", enabled: true }); await service.refresh(); assert.equal(grants.length, 0);
  assert.equal(service.status().tenantId.startsWith("33333333"), true);
  await service.login(); assert.equal(service.status().authMode, "device"); await service.close();
  service = createMailService(dir, false, fetcher, file); await service.refresh(); assert.equal(grants.length, 0); await service.close();
});

test("重启时现有账号变更清理旧令牌邮件和游标，基线重新建立而不混用", async t => {
  const { dir, file } = await fixture(t), forms: string[] = [], urls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("token")) { forms.push((init!.body as URLSearchParams).get("username")!); return json(token); }
    urls.push(String(url)); return json({ value: [raw(forms.length === 1 ? "old-account" : "new-account")], "@odata.deltaLink": delta });
  };
  let service = createMailService(dir, false, fetcher, file); await service.refresh(); await service.close();
  await writeFile(file, JSON.stringify({ account: { ...account, username: "changed@example.test" } }));
  service = createMailService(dir, false, fetcher, file); await service.refresh();
  assert.deepEqual(forms, [account.username, "changed@example.test"]); assert.notEqual(urls[1], delta);
  assert.equal(service.read("old-account"), undefined); assert.equal(service.notices(0).items.length, 0); await service.close();
});

test("本地账号来源拒绝缺失、畸形配置和路径注入，错误不泄露原始内容", async t => {
  const { file } = await fixture(t);
  await assert.rejects(mailAccountSource("").read(), /未指定/);
  for (const value of ["private-invalid-json", JSON.stringify({ account: { ...account, tenantId: "../../common" } }), JSON.stringify({ account: { ...account, password: "" } }), JSON.stringify({ account: null }), JSON.stringify({ account: [] })]) {
    await writeFile(file, value); await assert.rejects(mailAccountSource(file).read(), e => e instanceof Error && !e.message.includes(account.password) && !e.message.includes(value));
  }
  await writeFile(file, JSON.stringify({ account }));
  const first = await mailAccountSource(file).read(); assert.equal(first.key.length, 64);
  await writeFile(file, JSON.stringify({ account: { ...account, password: "changed-password" } }));
  assert.equal((await mailAccountSource(file).read()).key, first.key, "密码轮换不改变邮箱身份");
});

test("关闭等待密码请求，迟到成功或失败都不能保存令牌或永久禁止登录", async t => {
  for (const response of [json(token), json({ error: "invalid_grant" }, 400)]) {
    const { dir, file } = await fixture(t); let finish!: (response: Response) => void;
    const service = createMailService(dir, false, async () => new Promise(resolve => { finish = resolve; }), file);
    const pending = service.refresh();
    // 等本地文件读取完成并进入 fetch，而不是用固定延时猜测。
    for (let i = 0; !finish && i < 100; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(finish); const closing = service.close(); finish(response);
    await assert.rejects(pending, /取消/); await closing;
    const store = openMailStore(dir); assert.equal(store.state().tokens, null); assert.equal(store.state().accountLoginBlocked, false); store.close();
  }
});

test("刷新令牌被撤销后不自动回退密码，必须显式重连", async t => {
  const { dir, file } = await fixture(t); let passwordCalls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (!String(url).endsWith("token")) return json({ value: [], "@odata.deltaLink": delta });
    if ((init!.body as URLSearchParams).get("grant_type") === "password") { passwordCalls++; return json(token); }
    return json({ error: "invalid_grant" }, 400);
  };
  let service = createMailService(dir, false, fetcher, file); await service.refresh(); await service.close();
  const seed = openMailStore(dir); seed.update({ tokens: { accessToken: "expired", refreshToken: token.refresh_token, expiresAt: 0 } }); seed.close();
  service = createMailService(dir, false, fetcher, file); await assert.rejects(service.refresh(), /重新登录/); await service.refresh(); await service.close();
  service = createMailService(dir, false, fetcher, file); await assert.rejects(service.refresh(), /手动重连/); assert.equal(passwordCalls, 1); await service.close();
});

test("后台启动无需手动刷新即可连接，并按一分钟自动同步和提醒", async t => {
  const { dir, file } = await fixture(t); t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  let pages = 0, passwordCalls = 0, firstPage!: () => void;
  const initial = new Promise<void>(resolve => { firstPage = resolve; });
  const service = createMailService(dir, false, async url => {
    if (String(url).endsWith("token")) { passwordCalls++; return json(token); }
    pages++; firstPage(); return json({ value: [raw(pages === 1 ? "baseline" : "new")], "@odata.deltaLink": delta });
  }, file);
  try {
    service.start(); await initial; await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.status().connected, true); assert.equal(service.status().initialComplete, true); assert.equal(service.notices(0).items.length, 0);
    t.mock.timers.tick(59000); await new Promise(resolve => setImmediate(resolve)); assert.equal(pages, 1);
    t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); assert.equal(pages, 2);
    assert.equal(passwordCalls, 1); assert.equal(service.notices(0).items[0]?.message.id, "new");
  } finally { await service.close(); }
});
