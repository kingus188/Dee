import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { processAttachmentFile } from "../dist/chat/attachments.js";
import { Composer } from "../dist/chat/Composer.js";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const LIMIT = 5 * 1024 * 1024;
const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255, 128]);
const docxBytes = new Uint8Array([80, 75, 3, 4, 0, 255, 128, 0, 60, 63, 120, 109, 108]);

for (const [label, mime, bytes, names] of [
  ["PDF", PDF, pdfBytes, [["report.pdf", PDF], ["report.PDF", ""], ["report.pdf", "application/octet-stream"], ["report", "APPLICATION/PDF; version=1.7"], ["report.pdf", "text/plain"]]],
  ["DOCX", DOCX, docxBytes, [["report.docx", DOCX], ["report.DOCX", ""], ["report.docx", "application/octet-stream"], ["report", DOCX.toUpperCase()], ["report.docx", "text/plain"]]],
] as const) {
  test(`${label} uploads preserve original binary bytes with canonical MIME and the existing text kind`, async () => {
    for (const [name, type] of names) {
      const result = await processAttachmentFile(new File([bytes], name, { type }));
      assert.ok(!("error" in result), `${name} (${type}): ${"error" in result ? result.error : ""}`);
      assert.equal(result.kind, "text");
      assert.equal(result.mimeType, mime);
      assert.equal(result.name, name);
      assert.equal(result.size, bytes.byteLength);
      assert.deepEqual(Buffer.from(result.data, "base64"), Buffer.from(bytes));
      assert.equal(result.previewUrl, undefined);
    }
  });
}

test("documents accept exactly 5 MiB without applying the UTF-8 text limit", async () => {
  const bytes = new Uint8Array(LIMIT);
  bytes.set(pdfBytes);
  const result = await processAttachmentFile(new File([bytes], "full.pdf", { type: PDF }));
  assert.ok(!("error" in result));
  assert.equal(result.size, LIMIT);
  assert.deepEqual(Buffer.from(result.data, "base64"), Buffer.from(bytes));
});

test("oversized documents are rejected before reading their binary content", async () => {
  for (const [name, type] of [["huge.pdf", PDF], ["huge.docx", DOCX]]) {
    const file = new File([], name, { type });
    Object.defineProperty(file, "size", { value: LIMIT + 1 });
    Object.defineProperty(file, "arrayBuffer", { value: async () => { throw new Error("oversized file was read"); } });
    const result = await processAttachmentFile(file);
    assert.ok("error" in result);
    assert.match(result.error, /5\s*(?:MiB|MB)/);
  }
});

test("UTF-8 text bytes and its 200 KiB boundary remain unchanged", async () => {
  for (const bytes of [new TextEncoder().encode("中文资料\nhello"), new Uint8Array(200 * 1024).fill(65)]) {
    const result = await processAttachmentFile(new File([bytes], "notes.md", { type: "text/markdown" }));
    assert.ok(!("error" in result));
    assert.equal(result.kind, "text");
    assert.equal(result.mimeType, "text/markdown");
    assert.deepEqual(Buffer.from(result.data, "base64"), Buffer.from(bytes));
  }
});

test("invalid UTF-8, embedded NUL and oversized plain text remain rejected", async () => {
  for (const [bytes, reason] of [
    [new Uint8Array([255, 254]), /UTF-8/],
    [new Uint8Array([65, 0, 66]), /文本/],
    [new Uint8Array(200 * 1024 + 1).fill(65), /200KB/],
  ] as const) {
    const result = await processAttachmentFile(new File([bytes], "notes.txt", { type: "text/plain" }));
    assert.ok("error" in result);
    assert.match(result.error, reason);
  }
});

test("GIF images retain binary data and preview while SVG and oversized GIF remain rejected", async () => {
  const bytes = new TextEncoder().encode("GIF89a");
  const result = await processAttachmentFile(new File([bytes], "animation.gif", { type: "image/gif" }));
  assert.ok(!("error" in result));
  try {
    assert.equal(result.kind, "image");
    assert.equal(result.mimeType, "image/gif");
    assert.deepEqual(Buffer.from(result.data, "base64"), Buffer.from(bytes));
    assert.match(result.previewUrl!, /^blob:/);
  } finally { if (result.previewUrl) URL.revokeObjectURL(result.previewUrl); }
  const tooLarge = new File([], "huge.gif", { type: "image/gif" });
  Object.defineProperty(tooLarge, "size", { value: LIMIT + 1 });
  for (const file of [tooLarge, new File(["<svg/>"], "vector.svg", { type: "image/svg+xml" })]) {
    assert.ok("error" in await processAttachmentFile(file));
  }
});

test("unsupported archives and legacy Word documents still return a supported-format message", async () => {
  for (const name of ["archive.zip", "legacy.doc"]) {
    const result = await processAttachmentFile(new File([docxBytes], name, { type: "application/octet-stream" }));
    assert.ok("error" in result);
    assert.match(result.error, /PDF/);
    assert.match(result.error, /DOCX/);
  }
});

test("the real Composer picker and drag hint advertise PDF and DOCX alongside existing uploads", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const values: Record<string, unknown> = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => { root.render(createElement(Composer, { draft: "", setDraft() {}, view: null, connect: async () => 1, onSent() {}, onNewConversation: async () => {} })); });
    const accept = dom.window.document.querySelector<HTMLInputElement>('input[type="file"]')!.accept.split(",");
    for (const value of [".pdf", ".docx", PDF, DOCX, "image/png", "image/jpeg", "image/webp", "image/gif", "text/*", ".md"]) assert.ok(accept.includes(value), `file picker missing ${value}`);
    await act(async () => { dom.window.document.querySelector(".input-box-wrapper")!.dispatchEvent(new dom.window.Event("dragover", { bubbles: true, cancelable: true })); });
    const hint = dom.window.document.querySelector('[role="status"]')?.textContent ?? "";
    assert.match(hint, /PDF/);
    assert.match(hint, /DOCX/);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
