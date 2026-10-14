import test from "node:test";
import assert from "node:assert/strict";
import { parseSummary, summaryHasSecret, summaryPrompt } from "@assistant/features";

test("摘要解析：JSON、带前后缀的 JSON、非 JSON 回退、空输出", () => {
  assert.deepEqual(parseSummary('{"summary":"已提交","openItems":["周五回复"]}'), { summary: "已提交", openItems: ["周五回复"] });
  assert.equal(parseSummary('好的：\n```json\n{"summary":"带围栏","openItems":[]}\n```')?.summary, "带围栏");
  assert.deepEqual(parseSummary("模型直接说了一段话"), { summary: "模型直接说了一段话", openItems: [] });
  assert.equal(parseSummary("  "), null);
  assert.equal(parseSummary(`{"summary":"x","openItems":${JSON.stringify(Array.from({ length: 20 }, (_, i) => `事项${i}`))}}`)?.openItems.length, 8, "待跟进事项数量有上限");
});

test("含凭据的摘要被识别；提示词声明内容不可信", () => {
  assert.equal(summaryHasSecret({ summary: "正常内容", openItems: ["token: abcdef123456789"] }), true);
  assert.equal(summaryHasSecret({ summary: "正常内容", openItems: [] }), false);
  assert.match(summaryPrompt("某聊天", "用户：你好"), /不可信/);
});
