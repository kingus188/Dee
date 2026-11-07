import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { AppearanceSettings } from "../dist/settings/AppearanceSettings.js";
import { applyAppearance, readAppearance } from "../dist/settings/appearance.js";
import { mount } from "./dom.js";

test("字体和组件独立调整、即时应用，重新打开设置保留选择，支持恢复默认", async t => {
  const { dom, render } = await mount(t, <AppearanceSettings />);
  const doc = dom.window.document;
  const options = (key: string) => [...doc.querySelectorAll<HTMLButtonElement>(`[aria-labelledby="appearance-${key}"] button`)];
  await act(async () => { options("font")[2].click(); });
  assert.deepEqual(readAppearance(), { font: 110, components: 100 });
  assert.equal(doc.documentElement.style.getPropertyValue("--ui-font-scale"), "1.1");
  await act(async () => { options("components")[0].click(); });
  assert.deepEqual(readAppearance(), { font: 110, components: 90 });
  assert.equal(doc.documentElement.style.getPropertyValue("--ui-component-scale"), "0.9");
  assert.equal(doc.documentElement.style.getPropertyValue("--ui-font-scale"), "1.1");
  assert.equal(doc.documentElement.style.getPropertyValue("--ui-scale"), "");
  await render(null);
  await render(<AppearanceSettings />);
  assert.equal(options("font")[2].getAttribute("aria-pressed"), "true");
  assert.equal(options("components")[0].getAttribute("aria-pressed"), "true");
  doc.documentElement.removeAttribute("style");
  applyAppearance(readAppearance());
  assert.equal(doc.documentElement.style.getPropertyValue("--ui-component-scale"), "0.9", "启动时恢复已保存偏好");
  await act(async () => { doc.querySelector<HTMLButtonElement>(".appearance-heading button")!.click(); });
  assert.deepEqual(readAppearance(), { font: 100, components: 100 });
  assert.equal(doc.documentElement.style.getPropertyValue("--ui-component-scale"), "1");
  assert.equal(doc.documentElement.style.getPropertyValue("--ui-font-scale"), "1");
});

test("异常存储与不合法偏好不阻断页面，保存失败明确提示", async t => {
  const { dom, render } = await mount(t, null);
  const storage = dom.window.localStorage;
  storage.setItem("dee.appearance", "broken");
  assert.deepEqual(readAppearance(), { font: 100, components: 100 });
  storage.setItem("dee.appearance", JSON.stringify({ font: 110, components: -1 }));
  assert.deepEqual(readAppearance(), { font: 110, components: 100 });
  storage.setItem("dee.appearance", JSON.stringify({ font: "90", components: 0 }));
  assert.deepEqual(readAppearance(), { font: 100, components: 100 });
  t.mock.method(dom.window.Storage.prototype, "getItem", () => { throw new Error("Blocked"); });
  t.mock.method(dom.window.Storage.prototype, "setItem", () => { throw new Error("Blocked"); });
  await render(<AppearanceSettings />);
  await act(async () => { dom.window.document.querySelector<HTMLButtonElement>('[aria-labelledby="appearance-font"] button')!.click(); });
  assert.equal(dom.window.document.documentElement.style.getPropertyValue("--ui-font-scale"), "0.9");
  assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /已应用.*无法保存/);
});
