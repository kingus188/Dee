import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { ServerConnection, validateServerUrl } from "../dist/settings/ServerConnection.js";
import { mount } from "./dom.js";

test("server addresses require HTTPS or exact local HTTP roots without credentials", () => {
  for (const input of ["https://assistant.example/", " HTTPS://Assistant.Example:443/ "]) assert.equal(validateServerUrl(input), "https://assistant.example");
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) assert.equal(validateServerUrl(`http://${host}:3000`), `http://${host}:3000`);
  for (const input of ["", "invalid", "//assistant.example", "http://assistant.example", "http://localhost.example", "http://127.0.0.1.example", "https://user:secret@assistant.example", "https://:secret@assistant.example", "https://@assistant.example", "https://assis\ntant.example", "https://assistant.example/path", "https://assistant.example/foo/..", "https://assistant.example/%2e", "https://assistant.example?", "https://assistant.example#", "https://assistant.example?token=secret", "https://assistant.example#settings", "https://assistant.example\\path", "file:///index.html"]) assert.throws(() => validateServerUrl(input), input);
});

async function enter(dom: Awaited<ReturnType<typeof mount>>["dom"], value: string) {
  const input = dom.window.document.querySelector<HTMLInputElement>("#server-url")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

async function submit(dom: Awaited<ReturnType<typeof mount>>["dom"]) {
  await act(async () => { dom.window.document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
}

test("server connection shows a single root address and navigates to the target settings", async t => {
  const targets: string[] = [];
  const { dom } = await mount(t, <ServerConnection onConnect={target => { targets.push(target); }} />);
  const document = dom.window.document;
  assert.equal(document.querySelectorAll("input").length, 1);
  assert.equal(document.querySelector<HTMLInputElement>("#server-url")!.value, "http://localhost");
  assert.match(document.querySelector('label[for="server-url"]')!.textContent!, /后台服务器地址/);
  assert.equal(document.querySelector('input[type="password"]'), null);
  await enter(dom, "https://assistant.example/"); await submit(dom);
  assert.deepEqual(targets, ["https://assistant.example/#settings"]);
  assert.equal(dom.window.localStorage.length, 0); assert.equal(dom.window.sessionStorage.length, 0);
});

test("default connection calls location.assign on the target root", async t => {
  const { dom } = await mount(t, <ServerConnection />);
  const targets: string[] = [];
  const location = { origin: dom.window.location.origin, assign: (target: string) => { targets.push(target); } };
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: new Proxy(dom.window, {
    get(target, property) { return property === "location" ? location : Reflect.get(target, property, target); },
  }) });
  await enter(dom, "https://backend.example:3443"); await submit(dom);
  assert.deepEqual(targets, ["https://backend.example:3443/#settings"]);
});

test("desktop connection uses the native bridge and reports persistence failures", async t => {
  const { dom } = await mount(t, <ServerConnection />);
  const addresses: string[] = [];
  let failure = true;
  dom.window.desktopServer = { connect: async url => { addresses.push(url); return failure ? { ok: false, error: "测试保存失败" } : { ok: true }; } };
  await enter(dom, "https://backend.example/"); await submit(dom);
  assert.deepEqual(addresses, ["https://backend.example"]);
  assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /测试保存失败/);
  failure = false;
  await submit(dom);
  assert.deepEqual(addresses, ["https://backend.example", "https://backend.example"]);
  assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
  assert.match(dom.window.document.querySelector('[role="status"]')!.textContent!, /正在连接新的后台服务器/);
});

test("same-origin submit reports the current connection and invalid input stays editable", async t => {
  const targets: string[] = [];
  const { dom } = await mount(t, <ServerConnection onConnect={target => { targets.push(target); }} />);
  await submit(dom); assert.deepEqual(targets, []);
  assert.match(dom.window.document.querySelector('[role="status"]')!.textContent!, /当前已连接/);
  for (const value of ["http://remote.example", "https://user:secret@remote.example", "https://remote.example/path", "https://remote.example/?x=1", "https://remote.example/#settings"]) {
    await enter(dom, value); await submit(dom);
    assert.ok(dom.window.document.querySelector('[role="alert"]'));
    assert.equal(dom.window.document.querySelector<HTMLInputElement>("#server-url")!.value, value);
    assert.deepEqual(targets, []);
  }
  await enter(dom, "http://127.0.0.1:3000"); await submit(dom);
  assert.deepEqual(targets, ["http://127.0.0.1:3000/#settings"]);
  assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
});
