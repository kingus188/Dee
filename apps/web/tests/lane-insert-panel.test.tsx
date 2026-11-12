import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { LaneInsertPanel } from "../dist/editor/lane/LaneInsertPanel.js";
import { mount } from "./dom.js";

async function inputValue(dom: Awaited<ReturnType<typeof mount>>["dom"], value: string) {
  const input = dom.window.document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  return input;
}

test("插入面板的 Enter/Escape 不截断输入法候选，普通 Enter 提交完整值", async t => {
  const inserted: string[] = []; let cancelled = 0;
  const { dom } = await mount(t, <LaneInsertPanel kind="link" selected="链接" disabled={false} apply={value => inserted.push(value)} cancel={() => cancelled++} />);
  const input = await inputValue(dom, "https://example.test/zhong");
  for (const [key, isComposing, keyCode] of [["Enter", true, 13], ["Escape", true, 27], ["Enter", false, 229]] as const) {
    const event = new dom.window.KeyboardEvent("keydown", { key, isComposing, keyCode, bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(event));
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(inserted, []); assert.equal(cancelled, 0);
  await inputValue(dom, "https://example.test/中文");
  await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  assert.deepEqual(inserted, ["[链接](<https://example.test/中文>)"]);
});

test("图片面板拒绝脚本和 SVG 数据地址，安全地址保留转义后的说明", async t => {
  const inserted: string[] = [];
  const { dom } = await mount(t, <LaneInsertPanel kind="image" selected="a[b]" disabled={false} apply={value => inserted.push(value)} cancel={() => {}} />);
  const submit = dom.window.document.querySelector("button")!;
  for (const value of ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4="]) {
    await inputValue(dom, value);
    await act(async () => submit.click());
    assert.deepEqual(inserted, []);
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /HTTPS/);
  }
  await inputValue(dom, "https://example.test/image.png");
  await act(async () => submit.click());
  assert.deepEqual(inserted, ["![a\\[b\\]](<https://example.test/image.png>)"]);
});

test("公式面板接受单行 LaTeX 并拒绝多余定界符", async t => {
  const inserted: string[] = [];
  const { dom } = await mount(t, <LaneInsertPanel kind="inline-math" selected="" disabled={false} apply={value => inserted.push(value)} cancel={() => {}} />);
  const submit = dom.window.document.querySelector("button")!;
  await inputValue(dom, "$x^2$"); await act(async () => submit.click()); assert.deepEqual(inserted, []);
  await inputValue(dom, "x^2 + y^2"); await act(async () => submit.click());
  assert.deepEqual(inserted, ["$x^2 + y^2$"]);
});
