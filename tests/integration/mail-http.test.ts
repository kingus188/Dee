import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, startServer } from "../../apps/server/dist/index.js";
import { openMailStore } from "../../apps/server/dist/mail-store.js";

const settings = { enabled: true, tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222" };
test("邮件 API 复用鉴权与同源保护，离线不授权，重启保留配置且不暴露令牌", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mail-http-"));
  const config = readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: dir, PORT: "0", DEMO_PASSWORD: "mail-unit-password", PI_OFFLINE: "1", NOTIFY_MODE: "off" });
  let service: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    service = await startServer(config, "127.0.0.1");
    const path = "/api/settings/mail", headers = { authorization: "Basic " + Buffer.from("demo:mail-unit-password").toString("base64"), "content-type": "application/json" };
    assert.equal((await fetch(service.origin + path)).status, 401);
    const write = (body: unknown, origin?: string) => fetch(service!.origin + path, { method: "POST", headers: { ...headers, ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    assert.equal((await write(settings, "https://evil.test")).status, 403);
    assert.equal((await write({ ...settings, clientId: "not-a-uuid" })).status, 400);
    const saved = await write(settings); assert.equal(saved.status, 200); assert.equal(saved.headers.get("cache-control"), "no-store"); assert.equal((await saved.json()).enabled, true);
    const login = await fetch(service.origin + "/api/mail/login", { method: "POST", headers, body: "{}" }); assert.equal(login.status, 409); assert.match((await login.json()).error, /离线/);
    await service.close(); service = undefined;
    const seed = openMailStore(dir); seed.update({ tokens: { accessToken: "private-test-access", refreshToken: "private-test-refresh", expiresAt: 9999999999999 } }); seed.close();
    service = await startServer(config, "127.0.0.1");
    const response = await fetch(service.origin + path, { headers }), text = await response.text();
    assert.equal(JSON.parse(text).connected, true); assert.equal(JSON.parse(text).clientId, settings.clientId); assert.equal(text.includes("private-test"), false);
    const notices = await fetch(service.origin + "/api/mail/notices?after=bad", { headers }); assert.equal(notices.status, 400);
    const cleared = await fetch(service.origin + "/api/mail/disconnect", { method: "POST", headers, body: "{}" }); assert.equal(cleared.status, 200); assert.equal((await cleared.json()).connected, false);
  } finally { await service?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Web 指定本地账号自动同步，账号连接接口有鉴权和同源保护且不返回秘密", { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mail-account-http-")), file = join(dir, "account.json");
  const username = "synthetic@example.test", password = "synthetic-only-password";
  await writeFile(file, JSON.stringify({ account: { tenantId: settings.tenantId, clientId: settings.clientId, username, password } }), { mode: 0o600 });
  const originalFetch = globalThis.fetch, tokenForms: URLSearchParams[] = [];
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(url).startsWith("https://login.microsoftonline.com/")) {
      tokenForms.push(init!.body as URLSearchParams);
      return new Response(JSON.stringify({ access_token: "private-access-unit", refresh_token: "private-refresh-unit", expires_in: 3600 }));
    }
    if (String(url).startsWith("https://graph.microsoft.com/")) return new Response(JSON.stringify({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=unit" }));
    return originalFetch(url, init);
  });
  const config = readConfig({ NODE_ENV: "test", DATA_DIR: dir, PORT: "0", MAIL_ACCOUNT_FILE: file, DEMO_PASSWORD: "http-unit-password", NOTIFY_MODE: "off" });
  const headers = { authorization: "Basic " + Buffer.from("demo:http-unit-password").toString("base64"), "content-type": "application/json" };
  let service: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    service = await startServer(config, "127.0.0.1"); await service.mail.refresh();
    const statusResponse = await fetch(service.origin + "/api/settings/mail", { headers }), text = await statusResponse.text(), state = JSON.parse(text);
    assert.equal(state.authMode, "account"); assert.equal(state.connected, true); assert.equal(state.initialComplete, true); assert.equal(state.savedAccountAvailable, true);
    for (const secret of [username, password, "private-access-unit", "private-refresh-unit", file]) assert.equal(text.includes(secret), false);
    const connect = service.origin + "/api/mail/login-account";
    assert.equal((await fetch(connect, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(connect, { method: "POST", headers: { ...headers, origin: "https://evil.test" }, body: "{}" })).status, 403);
    await service.mail.disconnect();
    await service.close(); service = await startServer(config, "127.0.0.1"); await service.mail.refresh();
    assert.equal(service.mail.status().connected, false); assert.equal(tokenForms.length, 1);
    const connected = await fetch(service.origin + "/api/mail/login-account", { method: "POST", headers, body: "{}" });
    assert.equal(connected.status, 200); assert.equal(connected.headers.get("cache-control"), "no-store"); assert.equal((await connected.json()).connected, true);
    assert.equal(tokenForms.length, 2); assert.equal(tokenForms[1].get("scope"), "https://graph.microsoft.com/Mail.Read offline_access");
  } finally { await service?.close(); await rm(dir, { recursive: true, force: true }); }
});
