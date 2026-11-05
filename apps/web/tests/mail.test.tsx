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

async function mountMail(t: test.TestContext, visibility = "visible") {
  const mounted = await mount(t, null);
  Object.defineProperty(mounted.dom.window.document, "visibilityState", { configurable: true, value: visibility });
  await mounted.render(<MailNotifications />);
  return mounted;
}

function delivery(sequence: number, extras = {}) {
  return { latest: sequence, items: [{ sequence, message: { id: `mail-${sequence}`, sender: "<img src=x>", subject: "<script>bad()</script>" } }],
    delivery: { id: `digest-${sequence}`, token: `token-${sequence}`, leaseUntil: Date.now() + 45_000 }, ...extras };
}

test("Web claims shared delivery, escapes text, acknowledges only rendered toast and closes after 5s", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let sequence = 0;
  const calls: { path: string; body: unknown }[] = [];
  t.mock.method(apiClient, "request", async (path: string, body: unknown) => {
    calls.push({ path, body });
    if (path.endsWith("/ack")) return { acknowledged: true };
    return sequence ? delivery(sequence) : { latest: 7, items: [] };
  });
  const { dom } = await mountMail(t), document = dom.window.document;
  assert.equal(document.querySelector("aside"), null);
  sequence = 8; await act(async () => { t.mock.timers.tick(15000); });
  assert.match(document.querySelector("aside")!.textContent!, /<script>/);
  assert.equal(document.querySelector("script, img"), null);
  assert.equal(calls[2].path, "/api/mail/delivery/ack");
  assert.equal((calls[0].body as { clientId: string }).clientId, (calls[2].body as { clientId: string }).clientId);
  await act(async () => { t.mock.timers.tick(5000); });
  assert.equal(document.querySelector("aside"), null);
  await act(async () => { t.mock.timers.tick(10000); });
  assert.equal(document.querySelector("aside"), null, "same digest retry does not show again");
});

test("Web ack loss retries without another toast; summary totals and urgent preview are retained", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let ackFails = true, ackCalls = 0;
  t.mock.method(apiClient, "request", async (path: string) => {
    if (path.endsWith("/ack")) { ackCalls++; if (ackFails) throw Error("lost response"); return { acknowledged: true }; }
    return delivery(151, { total: 150, urgent: true, cursor: 151, items: [
      { sequence: 2, message: { id: "urgent", importance: "high", subject: "紧急审批", sender: "Alice" } },
      { sequence: 151, message: { id: "normal", subject: "日常更新", sender: "Bob" } },
    ] });
  });
  const { dom } = await mountMail(t), document = dom.window.document;
  assert.match(document.querySelector("aside")!.textContent!, /150 封新邮件（含重要邮件）/);
  assert.match(document.querySelector("aside")!.textContent!, /紧急审批/);
  await act(async () => { t.mock.timers.tick(5000); });
  ackFails = false; await act(async () => { t.mock.timers.tick(10000); });
  assert.ok(ackCalls >= 2); assert.equal(document.querySelector("aside"), null);
});

test("Web ignores expired leases", async t => {
  t.mock.method(apiClient, "request", async () => delivery(1, { delivery: { id: "expired", token: "old", leaseUntil: Date.now() - 1 } }));
  const { dom } = await mountMail(t);
  assert.equal(dom.window.document.querySelector("aside"), null);
});


test("Web late claim after unmount neither displays nor acknowledges", async t => {
  let resolve!: (value: unknown) => void;
  const calls: string[] = [];
  t.mock.method(apiClient, "request", (path: string) => {
    calls.push(path); return new Promise(done => { resolve = done; });
  });
  const { dom, render } = await mountMail(t);
  await render(null);
  await act(async () => { resolve(delivery(1)); });
  assert.equal(dom.window.document.querySelector("aside"), null);
  assert.deepEqual(calls, ["/api/mail/delivery"]);
});

test("Web hung claim times out and retries while ignoring the late old result", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let resolve!: (value: unknown) => void, claims = 0;
  t.mock.method(apiClient, "request", (path: string) => {
    if (path.endsWith("/ack")) return Promise.resolve({ acknowledged: true });
    claims++;
    if (claims === 1) return new Promise(done => { resolve = done; });
    return Promise.resolve(delivery(2));
  });
  const { dom } = await mountMail(t);
  await act(async () => { t.mock.timers.tick(10000); });
  await act(async () => { t.mock.timers.tick(5000); });
  assert.equal(claims, 2);
  await act(async () => { resolve(delivery(1, { total: 999 })); });
  assert.doesNotMatch(dom.window.document.querySelector("aside")!.textContent!, /999/);
});


test("hidden Web does not claim; visibility/focus resumes; a claim resolved in background is not acknowledged", async t => {
  let resolve!: (value: unknown) => void;
  const calls: string[] = [];
  t.mock.method(apiClient, "request", (path: string) => {
    calls.push(path);
    if (path.endsWith("/ack")) return Promise.resolve({ acknowledged: true });
    return new Promise(done => { resolve = done; });
  });
  const { dom } = await mountMail(t, "hidden"), document = dom.window.document;
  assert.equal(calls.length, 0);
  const visibility = async (value: string) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
    await act(async () => { document.dispatchEvent(new dom.window.Event("visibilitychange")); });
  };
  await visibility("visible");
  assert.equal(calls.length, 1);
  await visibility("hidden");
  await act(async () => { resolve(delivery(1)); });
  assert.equal(document.querySelector("aside"), null);
  assert.equal(calls.length, 1, "unseen background delivery must not ack");
  await visibility("visible");
  await act(async () => { resolve(delivery(1)); });
  assert.notEqual(document.querySelector("aside"), null);
  assert.equal(calls.at(-1), "/api/mail/delivery/ack");
  await visibility("hidden");
  assert.equal(document.querySelector("aside"), null);
});


for (const phase of ["before render", "during render before commit"] as const) {
  test(`Web lease expiring ${phase} never acknowledges or leaves a visible toast`, async t => {
    let now = 1000;
    t.mock.method(Date, "now", () => now);
    const calls: string[] = [];
    const message = { id: "late-commit", sender: "Alice", subject: "expired", importance: "normal" };
    Object.defineProperty(message, phase === "before render" ? "importance" : "subject", {
      get() { now = 1200; return phase === "before render" ? "normal" : "expired"; },
    });
    t.mock.method(apiClient, "request", async (path: string) => {
      calls.push(path);
      return { latest: 1, items: [{ sequence: 1, message }],
        delivery: { id: "late-commit", token: "old-token", leaseUntil: 1100 } };
    });
    const { dom } = await mountMail(t);
    assert.equal(dom.window.document.querySelector(".mail-notice"), null);
    assert.deepEqual(calls, ["/api/mail/delivery"]);
  });
}
