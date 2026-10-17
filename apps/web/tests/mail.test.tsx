import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { MailStatus } from "@assistant/contracts";
import { MailSettings } from "../dist/settings/MailSettings.js";
import { MailNotifications } from "../dist/mail/MailNotifications.js";
import { apiClient } from "../dist/api/socket.js";
import { mount } from "./dom.js";

const status: MailStatus = { enabled: false, tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222", connected: false, offline: false,
  lastSuccessAt: null, error: "", syncing: false, initialComplete: false, login: null, authMode: "device", savedAccountAvailable: false };

test("邮件设置保存防重复，未保存不能登录，设备登录只展示用户代码与安全链接", async t => {
  const writes: { path: string; body: unknown }[] = [];
  let resolve!: (result: MailStatus) => void;
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    if (body === undefined) return status;
    writes.push({ path, body });
    if (path === "/api/settings/mail") return new Promise<MailStatus>(done => { resolve = done; });
    return { ...status, enabled: true, login: { userCode: "CODE-TEST", verificationUri: "https://microsoft.com/devicelogin", expiresAt: Date.now() + 600000 } };
  });
  const { dom } = await mount(t, <MailSettings />), document = dom.window.document;
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
  const login = () => buttons().find(b => b.textContent === "登录微软邮箱")!;
  assert.equal(login().disabled, true);
  await act(async () => { document.querySelector<HTMLInputElement>("#mail-enabled")!.click(); });
  assert.equal(login().disabled, true, "未保存的启用选项不能绕过后端");
  const form = document.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(writes.length, 1); assert.equal(document.querySelector("fieldset")!.disabled, true);
  await act(async () => { resolve({ ...status, enabled: true }); });
  assert.equal(login().disabled, false);
  await act(async () => login().click());
  assert.equal(writes[1].path, "/api/mail/login"); assert.match(document.body.textContent!, /CODE-TEST/);
  const link = document.querySelector<HTMLAnchorElement>("a")!;
  assert.equal(link.href, "https://microsoft.com/devicelogin"); assert.equal(link.target, "_blank"); assert.equal(link.rel, "noopener noreferrer");
  assert.equal(login().disabled, true, "授权等待中不重复申请代码");
});

test("邮件状态轮询保留未保存输入，离线禁登录，读取失败可重试", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let fail = true;
  t.mock.method(apiClient, "request", async () => { if (fail) throw new Error("断线"); return { ...status, offline: true, enabled: true }; });
  const { dom } = await mount(t, <MailSettings />), document = dom.window.document;
  assert.equal(document.querySelector("form"), null); assert.match(document.querySelector('[role="alert"]')!.textContent!, /无法读取/);
  fail = false;
  await act(async () => { document.querySelector<HTMLButtonElement>("button")!.click(); });
  assert.match(document.body.textContent!, /离线模式/);
  assert.equal([...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "登录微软邮箱")!.disabled, true);
  const input = document.querySelector<HTMLInputElement>("#mail-client")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "unsaved");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => { t.mock.timers.tick(5000); });
  assert.equal(input.value, "unsaved"); assert.match(document.body.textContent!, /请先保存/);
});

test("现有账号入口无需密码输入，离线禁用；自动连接状态回填但不覆盖用户草稿", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let state: MailStatus = { ...status, tenantId: "", clientId: "", savedAccountAvailable: true };
  const writes: string[] = [];
  t.mock.method(apiClient, "request", async (path: string, body?: unknown) => {
    if (body !== undefined) { writes.push(path); state = { ...status, savedAccountAvailable: true, authMode: "account", enabled: true, connected: true }; }
    return state;
  });
  const { dom } = await mount(t, <MailSettings />), document = dom.window.document;
  const connect = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.startsWith("使用现有账号"))!;
  assert.equal(connect().disabled, false); assert.equal(document.querySelector('input[type="password"]'), null);
  state = { ...status, savedAccountAvailable: true, authMode: "account", enabled: true, connected: true };
  await act(async () => { t.mock.timers.tick(5000); });
  assert.equal(document.querySelector<HTMLInputElement>("#mail-tenant")!.value, status.tenantId);
  assert.equal(document.querySelector<HTMLInputElement>("#mail-enabled")!.checked, true);
  assert.match(document.body.textContent!, /现有账号配置（密码授权/); assert.equal(connect().disabled, false);
  await act(async () => { connect().click(); }); assert.deepEqual(writes, ["/api/mail/login-account"]);
  state = { ...state, offline: true }; await act(async () => { t.mock.timers.tick(5000); }); assert.equal(connect().disabled, true);
});

test("Web 新邮件提醒跳过历史，断线保留游标，文本转义，可关闭", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls: string[] = []; let fails = false;
  t.mock.method(apiClient, "request", async (path: string) => {
    calls.push(path); if (fails) throw new Error("offline");
    return path === "/api/mail/notices" ? { latest: 7, items: [] } : { latest: 8, items: [{ sequence: 8, message: { id: "new", sender: "<img src=x onerror=bad()>", subject: "<script>bad()</script>" } }] };
  });
  const { dom } = await mount(t, <MailNotifications />), document = dom.window.document;
  assert.equal(document.querySelector("aside"), null);
  fails = true; await act(async () => { t.mock.timers.tick(15000); });
  assert.equal(document.querySelector("aside"), null);
  fails = false; await act(async () => { t.mock.timers.tick(15000); });
  assert.deepEqual(calls, ["/api/mail/notices", "/api/mail/notices?after=7", "/api/mail/notices?after=7"]);
  assert.match(document.querySelector("aside")!.textContent!, /<script>/); assert.equal(document.querySelector("script, img"), null);
  await act(async () => document.querySelector<HTMLButtonElement>("aside button")!.click()); assert.equal(document.querySelector("aside"), null);
});
