import test from "node:test";
import assert from "node:assert/strict";
import { reconcileRichMarkdown } from "../dist/editor/lane/raw-markdown.js";

const normalized = (value: string) => value.replace(/\r\n?/g, "\n");

test("rich reconciliation keeps unchanged mixed endings, trailing spaces, and empty documents", () => {
  const original = "# H\r\nfirst  \rsecond\nlast\r\n";
  assert.equal(reconcileRichMarkdown(original, normalized(original)), original);
  assert.equal(reconcileRichMarkdown("", ""), "");
  assert.equal(reconcileRichMarkdown("", "new\nline"), "new\nline");
  assert.equal(reconcileRichMarkdown("old\nline", "new\nline\n"), "new\nline\n");
  assert.equal(reconcileRichMarkdown(original, ""), "");
});

test("multiline wrapping preserves every interior ending", () => {
  const original = "a\r\nb\nc\rd";
  for (const marker of ["**", "*", "~~", "`", "=="]) {
    assert.equal(reconcileRichMarkdown(original, marker + normalized(original) + marker), marker + original + marker);
  }
});

test("list and heading formatting retain endings even when every line changes", () => {
  const original = "first\r\nsecond\nthird\rfourth\r\n";
  assert.equal(reconcileRichMarkdown(original, "- first\n- second\n- third\n- fourth\n"), "- first\r\n- second\n- third\r- fourth\r\n");
  assert.equal(reconcileRichMarkdown(original, "# first\n## second\n### third\n#### fourth\n"), "# first\r\n## second\n### third\r#### fourth\r\n");
  assert.equal(reconcileRichMarkdown("- a\r\n- b\n- c", "a\nb\nc"), "a\r\nb\nc");
});

test("two distant edits preserve untouched body endings when inserting a footnote", () => {
  const original = "Intro\r\n\r\nfirst body\nsecond body\r\nlast body";
  const value = "Intro[^note]\n\nfirst body\nsecond body\nlast body\n\n[^note]: detail";
  assert.equal(reconcileRichMarkdown(original, value), "Intro[^note]\r\n\r\nfirst body\nsecond body\r\nlast body\r\n\r\n[^note]: detail");
  const surrounded = "preface\n\n" + normalized(original) + "\n\nepilogue";
  assert.equal(reconcileRichMarkdown(original, surrounded), "preface\r\n\r\n" + original + "\r\n\r\nepilogue");
});

test("insertions, deletions, and modified lines keep surrounding line endings", () => {
  const original = "one\r\ntwo\nthree\rfour\r\nfive";
  assert.equal(reconcileRichMarkdown(original, "one\ninserted\ntwo\nthree\nfour\nfive"), "one\r\ninserted\r\ntwo\nthree\rfour\r\nfive");
  assert.equal(reconcileRichMarkdown(original, "one\nthree\nfour\nfive"), "one\r\nthree\rfour\r\nfive");
  assert.equal(reconcileRichMarkdown(original, "ONE\ntwo\nthree\nfour\nFIVE"), "ONE\r\ntwo\nthree\rfour\r\nFIVE");
});

test("repeated lines use deterministic prefix/suffix alignment without duplicating content", () => {
  assert.equal(reconcileRichMarkdown("same\r\nsame\nlast\r\n", "same\nlast\n"), "same\r\nlast\r\n");
  assert.equal(reconcileRichMarkdown("a\r\n\r\nb\n\nc", "**a\n\nb\n\nc**"), "**a\r\n\r\nb\n\nc**");
});

test("adding and removing a final newline preserves the requested normalized value", () => {
  assert.equal(reconcileRichMarkdown("a\r\nb", "a\nb\n"), "a\r\nb\r\n");
  assert.equal(reconcileRichMarkdown("a\r\nb\n", "a\nb"), "a\r\nb");
  assert.equal(reconcileRichMarkdown("a\rb", "a\nb\nc"), "a\rb\rc");
});

test("clearing a line cannot collapse adjacent CR and LF endings into one newline", () => {
  assert.equal(reconcileRichMarkdown("a\rb\nc", "a\n\nc"), "a\r\r\nc");
});

test("many changed lines and a large wrapped paragraph avoid character-level quadratic diff", () => {
  const count = 30_000, endings = ["\r\n", "\n", "\r"];
  const original = Array.from({ length: count }, (_, index) => `line ${index}${endings[index % 3]}`).join("");
  const expected = Array.from({ length: count }, (_, index) => `- line ${index}${endings[index % 3]}`).join("");
  assert.equal(reconcileRichMarkdown(original, normalized(expected)), expected);
  const paragraph = "甲".repeat(500_000) + "\r\n" + "乙".repeat(500_000) + "\nend";
  assert.equal(reconcileRichMarkdown(paragraph, "**" + normalized(paragraph) + "**"), "**" + paragraph + "**");
});

test("arbitrary line insertion, removal, wrapping and reordering always preserve normalized content", () => {
  let seed = 17;
  const random = (max: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
  for (let sample = 0; sample < 500; sample++) {
    const lines = Array.from({ length: random(25) + 1 }, () => ["", "repeat", "甲乙", "body", "# title"][random(5)]!);
    const original = lines.map((line, index) => line + (index === lines.length - 1 ? "" : ["\r\n", "\r", "\n"][random(3)])).join("");
    const edited = [...lines];
    edited.splice(random(edited.length), random(3), "inserted", "");
    if (sample % 2) edited.reverse();
    const value = "**" + edited.join("\n") + "**";
    assert.equal(normalized(reconcileRichMarkdown(original, value)), value);
  }
});
