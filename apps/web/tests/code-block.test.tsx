import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { setTimeout } from "node:timers/promises";
import { MarkdownContent } from "../dist/chat/MarkdownContent.js";
import type { ConversationView } from "@assistant/contracts";
import { ChatThread, ResponseCard } from "../dist/chat/ChatThread.js";
import { mount } from "./dom.js";

test("code cards preserve source, use language highlighting, and copy only the selected block", async t => {
  const text = 'Intro\n\n```ts\nconst value = "<script>";\nconsole.log(value);\n```\n\n~~~mystery\n<&>\n~~~';
  const { dom } = await mount(t, <ResponseCard text={text} />);
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll(".code-card").length, 2);
  assert.equal(doc.querySelectorAll(".code-line-numbers > span").length, 3);
  assert.equal(doc.querySelector(".code-language")?.textContent, "ts");
  assert.ok(doc.querySelector(".hljs-keyword"));
  assert.equal(doc.querySelectorAll("pre code")[1].textContent, "<&>");
  let copied = "";
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
  await act(async () => { doc.querySelectorAll<HTMLButtonElement>('[aria-label="Copy code"]')[0].click(); });
  assert.equal(copied, 'const value = "<script>";\nconsole.log(value);');
  assert.equal(doc.querySelector("script"), null);
});

test("streaming open fences retain completed blocks and line selections and horizontal scroll", async t => {
  const beginning = "```ts\nconst done = 1;\n```\n\n```js\nconst first = 1;\n";
  const { dom, render } = await mount(t, <MarkdownContent text={beginning + "const"} streaming />);
  const doc = dom.window.document, cards = doc.querySelectorAll(".code-card"), preview = cards[1].querySelector<HTMLElement>(".code-card-scroll")!;
  const first = cards[1].querySelector(".code-source-line")!;
  const range = doc.createRange(); range.selectNodeContents(first);
  doc.getSelection()!.addRange(range); preview.scrollLeft = 35;
  await render(<MarkdownContent text={beginning + "const next = 2;\n```\nAfter"} streaming />);
  await act(async () => { await setTimeout(130); });
  assert.equal(doc.querySelectorAll(".code-card")[0], cards[0]);
  assert.equal(doc.querySelectorAll(".code-card")[1], cards[1]);
  assert.equal(doc.querySelectorAll(".code-card")[1].querySelector(".code-source-line"), first);
  assert.match(doc.getSelection()!.toString(), /const first = 1/);
  assert.equal(preview.scrollLeft, 35);
  assert.match(cards[1].textContent!, /const next = 2/);
});

test("nested fences, markdown tables, and unsafe model HTML/URLs render without executable content", async t => {
  const text = '> ```html\n> <img src=x onerror=alert(1)>\n> ```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n[ok](https://example.com)\n\n|A|B|\n|---|---|\n|1|2|';
  const { dom } = await mount(t, <MarkdownContent text={text} />), doc = dom.window.document;
  assert.ok(doc.querySelector("blockquote .code-card"));
  assert.equal(doc.querySelectorAll("script,img,[onerror]").length, 0);
  assert.equal(doc.querySelectorAll("a").length, 1);
  assert.equal(doc.querySelector("a")!.getAttribute("href"), "https://example.com");
  assert.equal(doc.querySelector("a")!.getAttribute("target"), "_blank");
  assert.equal(doc.querySelector("a")!.getAttribute("rel"), "noopener noreferrer");
  assert.equal(doc.querySelectorAll("td").length, 2);
});

test("multiple blocks expand only the requested code and preserve focus after close", async t => {
  const { dom } = await mount(t, <MarkdownContent text={'```js\nconst one = 1;\n```\n```py\nprint(2)\n```'} />), doc = dom.window.document;
  const button = doc.querySelectorAll<HTMLButtonElement>('[aria-label="Expand code"]')[1];
  await act(async () => { button.focus(); button.click(); await setTimeout(120); });
  // The first lazy load can settle after React's initial suspense retry.
  await act(async () => { await setTimeout(100); });
  assert.equal(doc.querySelectorAll('[role="dialog"]').length, 1);
  assert.match(doc.querySelector(".cm-content")!.textContent!, /print\(2\)/);
  assert.doesNotMatch(doc.querySelector(".cm-content")!.textContent!, /const one/);
  await act(async () => { doc.querySelector<HTMLButtonElement>('[aria-label="Close code reader"]')!.click(); });
  assert.equal(doc.querySelector('[role="dialog"]'), null);
  assert.equal(doc.activeElement, button);
});


test("live response becomes persisted without closing code reader or losing preview scroll", async t => {
  const text = "```ts\nconst first = 1;\nconst last = 2;\n```";
  const view: ConversationView = { conversationId: 1, entries: [{ id: 1, kind: "user", text: "Write code" }], live: { text }, busy: true, inbox: 0, usage: null, notes: { todos: [], memos: [] }, tasks: [], reminders: [], subagents: [], parentId: null };
  const { dom, render } = await mount(t, <ChatThread view={view} />), doc = dom.window.document;
  const preview = doc.querySelector<HTMLElement>(".code-card-scroll")!;
  preview.scrollLeft = 45;
  const button = doc.querySelector<HTMLButtonElement>('[aria-label="Expand code"]')!;
  await act(async () => { button.focus(); button.click(); await setTimeout(200); });
  await act(async () => { await setTimeout(100); });
  const editor = doc.querySelector(".cm-editor")!;
  assert.ok(editor);
  await render(<ChatThread view={{ ...view, entries: [...view.entries, { id: 2, kind: "assistant", text }], live: {}, busy: false }} />);
  assert.equal(doc.querySelector(".cm-editor"), editor);
  assert.equal(doc.querySelector(".code-card-scroll"), preview);
  assert.equal(preview.scrollLeft, 45);
  await act(async () => { doc.querySelector<HTMLButtonElement>('[aria-label="Close code reader"]')!.click(); });
  assert.equal(doc.activeElement, button);
});


test("rapid expand clicks own a single reader and restore usable background", async t => {
  const { dom } = await mount(t, <><ResponseCard text={"```js\nfirst\n```"} /><ResponseCard text={"```js\nsecond\n```"} /></>), doc = dom.window.document;
  const buttons = doc.querySelectorAll<HTMLButtonElement>('[aria-label="Expand code"]');
  await act(async () => { buttons[0].focus(); buttons[0].click(); buttons[1].focus(); buttons[1].click(); await setTimeout(200); });
  await act(async () => { await setTimeout(100); });
  assert.equal(doc.querySelectorAll('[role="dialog"]').length, 1);
  assert.equal(doc.querySelector(".cm-content")!.textContent, "second");
  await act(async () => doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(doc.querySelector('[role="dialog"]'), null);
  assert.notEqual((doc.querySelector("#root") as HTMLElement).inert, true);
});

test("very long code bounds preview rows without truncating copied source", async t => {
  const source = Array.from({ length: 400 }, (_, i) => `const row${i} = ${i};`).join("\n");
  const { dom } = await mount(t, <MarkdownContent text={'```ts\n' + source + '\n```'} />), doc = dom.window.document;
  assert.equal(doc.querySelectorAll(".code-source-line").length, 300);
  assert.equal(doc.querySelector(".code-show-all")!.textContent, "Show all 400 lines");
  let copied = "";
  Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
  await act(async () => doc.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!.click());
  assert.equal(copied, source);
});
