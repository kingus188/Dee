import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Editor } from "@tiptap/core";
import "@tiptap/markdown";
import { EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { createDocumentExtensions } from "../dist/editor/tiptap/extensions.js";
import { parseDocument } from "../dist/editor/tiptap/parse-document.js";
import { createSourceSegments } from "../dist/editor/tiptap/document-segments.js";
import { MarkdownSourceLedger } from "../dist/editor/tiptap/source-ledger.js";

function model(t: TestContext): Editor {
  const editor = new Editor({ element: null, extensions: createDocumentExtensions(), content: { type: "doc", content: [{ type: "paragraph" }] } });
  t.after(() => editor.destroy());
  return editor;
}

function parse(editor: Editor, source: string): PMNode {
  return editor.schema.nodeFromJSON(parseDocument(editor, source));
}

function verify(editor: Editor, source: string, definitions = "") {
  const doc = parse(editor, source);
  if (doc.childCount) doc.check();
  const ranges = createSourceSegments(editor)(source, doc);
  assert.equal(ranges.length, doc.childCount, JSON.stringify(source));
  let end = 0;
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]!;
    assert.ok(Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to));
    assert.ok(range.from >= end && range.to >= range.from && range.to <= source.length, JSON.stringify({ source, range, end }));
    const raw = source.slice(range.from, range.to);
    const node = doc.child(index);
    if (!raw) {
      assert.equal(node.type.name, "paragraph");
      assert.equal(node.content.size, 0);
    } else {
      assert.ok(!/^[\r\n]|[\r\n]$/u.test(raw), JSON.stringify(raw));
      const fragment = parse(editor, definitions ? `${raw}\n\n${definitions}` : raw);
      assert.equal(fragment.childCount, 1, JSON.stringify(raw));
      assert.ok(fragment.child(0).eq(node), JSON.stringify({ raw, actual: fragment.toJSON(), expected: node.toJSON() }));
    }
    end = range.to;
  }
  return { doc, ranges, blocks: ranges.map(range => source.slice(range.from, range.to)) };
}

function editFirst(editor: Editor, source: string) {
  const { doc, ranges } = verify(editor, source);
  assert.equal(doc.firstChild?.type.name, "paragraph");
  const ledger = new MarkdownSourceLedger(source, doc, value => editor.markdown!.serialize(value.toJSON()), createSourceSegments(editor));
  const state = EditorState.create({ doc });
  const actual = ledger.update(state.tr.insertText("X", 1));
  const first = ranges[0]!;
  assert.equal(actual.slice(0, first.from), source.slice(0, first.from));
  assert.equal(actual.slice(actual.length - (source.length - first.to)), source.slice(first.to));
  assert.ok(parse(editor, actual).eq(state.tr.insertText("X", 1).doc), JSON.stringify(actual));
  return actual;
}

test("token ranges resolve the minimal hr/Setext ambiguous boundary and retain untouched spelling", t => {
  const editor = model(t);
  const source = "plain\n\n---\na\n---";
  const { doc, ranges, blocks } = verify(editor, source);
  // This is the original red run: canonical/raw alignment has no exact boundary.
  assert.throws(() => new MarkdownSourceLedger(source, doc, value => editor.markdown!.serialize(value.toJSON())), /Ambiguous Markdown source boundary/u);
  assert.deepEqual(ranges, [{ from: 0, to: 5 }, { from: 7, to: 10 }, { from: 11, to: 16 }]);
  assert.deepEqual(blocks, ["plain", "---", "a\n---"]);
  assert.equal(editFirst(editor, source), "Xplain\n\n---\na\n---");
});

test("CRLF, mixed EOL, BOM, Setext syntax and trailing spaces retain original offsets", t => {
  const editor = model(t);
  const source = "\ufeffplain  \r\n\r\nTitle\n=====  \r\n\n---\r\n\r\na\r---  \r\n\r\nlast  \n";
  const { blocks } = verify(editor, source);
  assert.deepEqual(blocks, ["\ufeffplain  ", "Title\n=====  ", "---", "a\r---  ", "last  "]);
  const changed = editFirst(editor, source);
  assert.ok(changed.endsWith(source.slice(source.indexOf("\r\n"))));
});

test("mixed bullet/task lists map contiguous item groups including nested and loose items", t => {
  const editor = model(t);
  for (const list of [
    "- one\n- two\n- [ ] task\n- [x] done\n- three",
    "* one\n  * nested\n* [ ] task\n  - [x] nested task\n* last",
    "- one\n\n- [ ] task\n\n- last",
    "- [ ] first\n- plain\n- [x] last",
    "3) first\n4) second",
  ]) {
    for (const eol of ["\n", "\r\n"]) {
      const source = `editable\n\n${list}\n\nlast  \n`.replaceAll("\n", eol);
      verify(editor, source);
      editFirst(editor, source);
    }
  }
  const { blocks } = verify(editor, "- a\r\n- [ ] b\r\n- c");
  assert.deepEqual(blocks, ["- a", "- [ ] b", "- c"]);
});

test("frontmatter and footnotes are complete blocks while ordinary reference definitions remain gaps", t => {
  const editor = model(t);
  const source = '---\r\ntitle: "raw"  \r\n---\r\n\r\nbody[^n]  \r\n\r\n[^n]: first\r\n    continuation  \r\n\r\nlast\n';
  const { doc, blocks } = verify(editor, source);
  assert.equal(doc.firstChild?.attrs.kind, "frontmatter");
  assert.deepEqual(blocks, ['---\r\ntitle: "raw"  \r\n---', "body[^n]  ", "[^n]: first\r\n    continuation  ", "last"]);
  const defs = '[id]: https://example.test/path "Title"';
  const references = `[unused]: /unused\r\n\r\nfirst\r\n\r\n[used][id]\r\n\r\n${defs}\r\n`;
  const reference = verify(editor, references, defs);
  assert.deepEqual(reference.blocks, ["first", "[used][id]"]);
  const ledger = new MarkdownSourceLedger(references, reference.doc, value => editor.markdown!.serialize(value.toJSON()), createSourceSegments(editor));
  const state = EditorState.create({ doc: reference.doc });
  assert.equal(ledger.update(state.tr.insertText("X", 1)), references.replace("first", "Xfirst"));
});

test("blank space follows official boundary/internal empty paragraph counts", t => {
  const editor = model(t);
  for (const source of ["", " ", "\t", "\n", "\r\n", "\r", " \r\n \n", "\n\n", "\r\n\r\n\r\n\r\n", "\n\n\n\nfirst\n\n\n\nlast\n\n", "first\n\n\n\n\n\nlast", "first\n \n\n\nlast", "# heading\n\n\n\n\n\nlast"]) verify(editor, source);
  const { doc, ranges, blocks } = verify(editor, "\r\n\r\n\r\n\r\nfirst\r\n\r\n\r\n\r\nlast\r\n\r\n");
  assert.equal(doc.childCount, 6);
  assert.deepEqual(blocks, ["", "", "first", "", "last", ""]);
  assert.deepEqual(ranges.slice(0, 2), [{ from: 0, to: 0 }, { from: 4, to: 4 }]);
  assert.deepEqual(createSourceSegments(editor)("", editor.state.doc), [{ from: 0, to: 0 }]);
});

test("absorbed whitespace and definition-adjacent blank paragraphs use the parser's exact rules", t => {
  const editor = model(t);
  for (const source of [
    "# heading\n\n\n\nlast\n\n",
    "<div>x</div>\n\n\n\nlast",
    "Title\n===\n\n\n\nlast",
    "[unused]: /target\n\n\n\nfirst",
    "first\n\n\n\n[unused]: /target\n\n",
    "\n\n[unused]: /target\n\n\n\n",
  ]) verify(editor, source);
});

test("large base64 images use sparse offsets before, inside and after mixed-EOL blocks", { timeout: 15000 }, t => {
  const editor = model(t);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWQAAAAASUVORK5CYII=", "base64");
  const payload = `data:image/png;base64,${Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]).toString("base64")}`;
  for (const image of [`![embedded](${payload})`, `before ![inline](${payload}) after`, `> ![nested](${payload})`, `- item ![nested](${payload})\n- [ ] task`]) {
    const source = `editable\r\n\r\n${image}\n\n![second](${payload})\r\n\r\nlast  \r\n`;
    const { doc, blocks } = verify(editor, source);
    let images = 0;
    doc.descendants(node => { if (node.type.name === "image" && node.attrs.src === payload) images++; });
    assert.ok(images >= 2);
    assert.ok(blocks.some(block => block.includes(payload)));
    assert.equal(blocks.at(-1), "last  ");
    assert.equal(editFirst(editor, source), source.replace("editable", "Xeditable"));
  }
});

test("editing a middle block retains both edges, definitions, empty paragraphs and literal syntax", t => {
  const editor = model(t);
  const source = '---\r\ntitle: "keep"  \r\n---\r\n\r\n# Before  \r\n\r\n\r\n\r\neditable\n\n* untouched  \r\n* list\r\n\r\n[unused]: /keep\r\n\r\n<div data-raw="yes">after</div>\r\n';
  const { doc } = verify(editor, source);
  let position = -1;
  doc.descendants((node, pos) => { if (node.isText && node.text === "editable") position = pos; });
  assert.ok(position >= 0);
  const ledger = new MarkdownSourceLedger(source, doc, value => editor.markdown!.serialize(value.toJSON()), createSourceSegments(editor));
  const tr = EditorState.create({ doc }).tr.insertText("X", position + 4);
  const actual = ledger.update(tr);
  assert.equal(actual, source.replace("editable", "editXable"));
  assert.ok(parse(editor, actual).eq(tr.doc));
});

test("unrecognized Markdown stays in raw paragraph blocks and survives edits elsewhere", t => {
  const editor = model(t);
  const source = "editable\r\n\r\n:::unknown{raw}\r\n!custom syntax  \r\n:::\r\n\r\n[undefined][reference]\r\n\r\nlast";
  const { blocks } = verify(editor, source);
  assert.ok(blocks.includes(":::unknown{raw}\r\n!custom syntax  \r\n:::"));
  assert.equal(editFirst(editor, source), source.replace("editable", "Xeditable"));
});

test("common block pair matrix maps each parsed node and preserves every untouched raw suffix", { timeout: 20000 }, t => {
  const editor = model(t);
  const fragments = [
    "plain  ", "Title\n===", "a\n---", "---", "***", "# Heading",
    "* one\n* two", "- one\n- [ ] task\n- last", "3) one\n4) two", "- [ ] task",
    "> quote\n> continuation", "~~~js\nconst x = 1;\n~~~", "    code\n    more",
    "| a | b |\n|---|---|\n| c | d |", "[^n]: note\n    continuation", "text[^n]",
    "<div data-value='raw'>literal</div>", "$$\nx^2\n$$", "![alt](https://example.test/image.png)",
    ":::unknown\ncontent\n:::",
  ];
  let checked = 0;
  for (const left of fragments) for (const right of fragments) for (const eol of ["\n", "\r\n"]) {
    const source = `editable\n\n${left}\n\n${right}\n\n# tail  \n`.replaceAll("\n", eol);
    editFirst(editor, source);
    checked++;
  }
  assert.equal(checked, 800);
});
