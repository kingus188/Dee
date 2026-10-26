import test from "node:test";
import assert from "node:assert/strict";
import { textareaMarkdownEdit } from "../dist/editor/live-markdown-source-input.js";

test("源码显示与文末输入只改变用户输入，保留混合 EOL 与尾部空格", () => {
  const original = "# H\r\nfirst  \rsecond\nlast\r\n";
  const shown = original.replace(/\r\n?/g, "\n");
  assert.equal(textareaMarkdownEdit(original, shown), original);
  assert.equal(textareaMarkdownEdit(original, shown + "X"), original + "X");
  assert.equal(textareaMarkdownEdit(original, shown.replace("second", "新版")), original.replace("second", "新版"));
});

test("重复正文通过原始选区识别目标，新换行沿用既有方式", () => {
  assert.equal(textareaMarkdownEdit("same\r\nsame\nlast\r\n", "same\nlast\n", { from: 0, to: 5, inputType: "deleteByCut" }), "same\nlast\r\n");
  assert.equal(textareaMarkdownEdit("a\r\nb\rc", "a\n\nb\nc", { from: 1, to: 1, inputType: "insertLineBreak" }), "a\r\n\r\nb\rc");
  assert.equal(textareaMarkdownEdit("a\r\nb\rc", "ab\nc", { from: 2, to: 2, inputType: "deleteContentBackward" }), "ab\rc");
});
