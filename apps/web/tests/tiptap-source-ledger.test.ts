import test from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { history, undo, redo } from "@tiptap/pm/history";
import type { Node as PMNode } from "@tiptap/pm/model";
import { MarkdownSourceLedger } from "../dist/editor/tiptap/source-ledger.js";

const extensions = [StarterKit, Image];
const schema = getSchema(extensions);
const markdown = new MarkdownManager({ extensions });
const parse = (source: string) => schema.nodeFromJSON(markdown.parse(source));
const serialize = (doc: PMNode) => markdown.serialize(doc.toJSON());

function setup(source: string) {
  let state = EditorState.create({ doc: parse(source), plugins: [history()] });
  let calls = 0;
  const ledger = new MarkdownSourceLedger(source, state.doc, doc => { calls++; return serialize(doc); });
  const apply = (tr: ReturnType<typeof state.tr.insertText>) => {
    const raw = ledger.update(tr);
    state = state.apply(tr);
    return raw;
  };
  return { ledger, apply, get state() { return state; }, get calls() { return calls; } };
}

function textPosition(doc: PMNode, text: string, occurrence = 0) {
  let found = -1;
  doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes(text) && occurrence-- === 0) found = pos + node.text.indexOf(text);
  });
  assert.ok(found >= 0, `Missing ${text}`);
  return found;
}

test("opening, focus, selection and equivalent documents preserve every source character", () => {
  for (const source of ["", "\r\n", "# Heading  \r\n\r\n* one\r\n* two  \r\n\r\n<div data-x='x'>raw</div>\r\n", "first\u00a0last\r\n\r\n[unused]: /definition\r\n"]) {
    const fixture = setup(source);
    assert.equal(fixture.ledger.source, source);
    const calls = fixture.calls;
    assert.equal(fixture.apply(fixture.state.tr.setSelection(TextSelection.atStart(fixture.state.doc))), source);
    assert.equal(fixture.apply(fixture.state.tr.replaceWith(0, fixture.state.doc.content.size, parse(source).content)), source);
    assert.equal(fixture.calls, calls);
  }
});

test("editing one block preserves other lists, HTML, CRLF, trailing spaces and definitions", () => {
  const original = "# Heading  \r\n\r\n* one\r\n* two\r\n\r\n<div data-x='x'>raw</div>\r\n\r\n[unused]: /definition\r\n\r\nlast  \r\n";
  const fixture = setup(original);
  const at = textPosition(fixture.state.doc, "Heading");
  const actual = fixture.apply(fixture.state.tr.insertText("Changed", at, at + 7));
  assert.equal(actual, original.replace("# Heading  ", "# Changed"));
  assert.ok(parse(actual).eq(fixture.state.doc));
});

test("editing separate blocks never reserializes an untouched list or HTML block", () => {
  const original = "first\r\n\r\n* one\r\n* two\r\n\r\n<div>x</div>\r\n\r\nlast\r\n";
  const fixture = setup(original);
  fixture.apply(fixture.state.tr.insertText("A", textPosition(fixture.state.doc, "first")));
  const last = textPosition(fixture.state.doc, "last");
  assert.equal(fixture.apply(fixture.state.tr.insertText("Z", last + 4)), original.replace("first", "Afirst").replace("last", "lastZ"));
});

test("cross-block replacement preserves untouched edge blocks and mixed separators", () => {
  const original = "# Keep  \r\n\r\none\n\ntwo\r\n\r\n* untouched\r\n";
  const fixture = setup(original);
  const from = textPosition(fixture.state.doc, "one");
  const to = textPosition(fixture.state.doc, "two") + 3;
  const actual = fixture.apply(fixture.state.tr.insertText("replacement", from, to));
  assert.equal(actual, "# Keep  \r\n\r\nreplacement\r\n\r\n* untouched\r\n");
  assert.ok(parse(actual).eq(fixture.state.doc));
});

test("mapping distinguishes identical blocks with different source spellings", () => {
  const original = "same  \r\n\r\nsame\n\n* item\r\n";
  const fixture = setup(original);
  const at = textPosition(fixture.state.doc, "same", 1);
  assert.equal(fixture.apply(fixture.state.tr.insertText("changed", at, at + 4)), "same  \r\n\r\nchanged\n\n* item\r\n");
});

test("normalizing the edited block preserves document semantics for alternate Markdown syntax", () => {
  for (const original of [
    "Title\r\n=====\r\n\r\nlast\r\n",
    "<p>one</p>\r\n\r\nlast",
    "~~~js\r\nconst value = 1;\r\n~~~\r\n\r\nlast\r\n",
    "3) one\r\n4) two\r\n\r\nlast\r\n",
  ]) {
    const fixture = setup(original);
    let at = -1;
    fixture.state.doc.descendants((node, pos) => { if (node.isText && at < 0) at = pos; });
    const actual = fixture.apply(fixture.state.tr.insertText("X", at));
    assert.ok(parse(actual).eq(fixture.state.doc), JSON.stringify(actual));
    assert.ok(actual.endsWith(original.slice(original.lastIndexOf("last"))));
  }
});

test("undo and redo restore complete original source and previous edited source", () => {
  const original = "Title\r\n=====\r\n\r\n* untouched  \r\n\r\nlast\r\n";
  const fixture = setup(original);
  const at = textPosition(fixture.state.doc, "Title");
  const changed = fixture.apply(fixture.state.tr.insertText("New", at, at + 5));
  assert.equal(undo(fixture.state, tr => { fixture.apply(tr); }), true);
  assert.equal(fixture.ledger.source, original);
  assert.equal(redo(fixture.state, tr => { fixture.apply(tr); }), true);
  assert.equal(fixture.ledger.source, changed);
});

test("typing back to the initial document restores its raw spelling without undo", () => {
  const original = "Title\r\n=====\r\n\r\nlast  \r\n";
  const fixture = setup(original);
  const at = textPosition(fixture.state.doc, "Title");
  fixture.apply(fixture.state.tr.insertText("X", at));
  assert.equal(fixture.apply(fixture.state.tr.delete(at, at + 1)), original);
});

test("successive composition transactions and reset retain the correct source", () => {
  const fixture = setup("first\r\n\r\n* untouched\r\n");
  fixture.apply(fixture.state.tr.insertText("n", 1).setMeta("composition", 7));
  fixture.apply(fixture.state.tr.insertText("你", 1, 2).setMeta("composition", 7));
  assert.equal(fixture.apply(fixture.state.tr.insertText("好", 2).setMeta("composition", 7)), "你好first\r\n\r\n* untouched\r\n");
  const source = "Reset  \r\n\r\nlast\r\n";
  const doc = parse(source);
  fixture.ledger.reset(source, doc);
  assert.equal(fixture.ledger.source, source);
  assert.throws(() => fixture.ledger.update(fixture.state.tr.insertText("stale", 1)), /before|reset|document/i);
});

test("insertion and deletion keep surrounding untouched raw blocks", () => {
  const fixture = setup("first\r\n\r\n* last\r\n");
  const firstEnd = fixture.state.doc.firstChild!.nodeSize;
  const paragraph = schema.nodes.paragraph!.create(null, schema.text("new"));
  const inserted = fixture.apply(fixture.state.tr.insert(firstEnd, paragraph));
  assert.equal(inserted, "first\r\n\r\nnew\r\n\r\n* last\r\n");
  assert.equal(fixture.apply(fixture.state.tr.delete(firstEnd, firstEnd + paragraph.nodeSize)), "first\r\n\r\n* last\r\n");
});

test("NBSP, entity and excess blank paragraphs survive edits in another block", () => {
  const original = "left\u00a0right\r\n\r\n\r\n\r\nlast\r\n";
  const fixture = setup(original);
  const at = textPosition(fixture.state.doc, "last");
  assert.equal(fixture.apply(fixture.state.tr.insertText("!", at + 4)), original.replace("last", "last!"));
});

test("hundreds of repeated CRLF blocks preserve positional source identity", () => {
  const original = `${Array.from({ length: 600 }, (_, i) => `same${i % 2 ? "  " : ""}`).join("\r\n\r\n")}\r\n`;
  const fixture = setup(original);
  const at = textPosition(fixture.state.doc, "same", 301);
  const actual = fixture.apply(fixture.state.tr.insertText("X", at));
  const expected = original.split("\r\n\r\n");
  expected[301] = "Xsame  ";
  assert.equal(actual, expected.join("\r\n\r\n"));
});

test("the initial raw document remains recoverable after snapshot cache eviction", () => {
  const original = "Title\r\n=====\r\n\r\n* untouched\r\n";
  const fixture = setup(original);
  for (let i = 0; i < 80; i++) fixture.apply(fixture.state.tr.insertText("x", 1));
  assert.equal(fixture.apply(fixture.state.tr.delete(1, 81)), original);
});

test("an 8 MiB image description has bounded alignment work and is preserved", { timeout: 10000 }, () => {
  const alt = "a".repeat(8 * 1024 * 1024);
  const original = `![${alt}](https://example.test/image.png)\r\n\r\nlast\r\n`;
  const doc = schema.nodes.doc!.create(null, [
    schema.nodes.image!.create({ src: "https://example.test/image.png", alt }),
    schema.nodes.paragraph!.create(null, schema.text("last")),
  ]);
  const ledger = new MarkdownSourceLedger(original, doc, serialize);
  const state = EditorState.create({ doc });
  const at = textPosition(state.doc, "last");
  assert.equal(ledger.update(state.tr.insertText("!", at + 4)), original.replace("last", "last!"));
});

test("explicit source segments handle serializer output with no recoverable source anchors", () => {
  const doc = parse("one\n\ntwo");
  const ledger = new MarkdownSourceLedger("RAW1|RAW2", doc, serialize, () => [{ from: 0, to: 4 }, { from: 5, to: 9 }]);
  const state = EditorState.create({ doc });
  assert.equal(ledger.update(state.tr.insertText("!", 2)), "o!ne|RAW2");
  assert.throws(() => new MarkdownSourceLedger("raw", doc, serialize, () => [{ from: 2, to: 1 }]), /segment/i);
});
