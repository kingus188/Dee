import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMemoryText, normalizeSkill, selectMemoryForPrompt } from "@assistant/features";

test("记忆和技能有字数边界", () => {
	assert.equal(normalizeMemoryText("  记住   这件事  "), "记住 这件事");
	assert.throws(() => normalizeMemoryText(""), /记忆必须/);
	assert.throws(() => normalizeMemoryText("甲".repeat(281)), /记忆必须/);
	assert.throws(() => normalizeSkill({ name: "a/b", description: "何时用", body: "步骤" }), /斜杠/);
	assert.equal(normalizeSkill({ name: "部署", description: "发布前", body: "先跑测试" }).name, "部署");
});

test("提示里的记忆按预算保留较新的条目", () => {
	const items = [
		{ status: "approved", text: "甲".repeat(100) },
		{ status: "pending", text: "不该出现" },
		{ status: "approved", text: "乙".repeat(100) },
		{ status: "rejected", text: "也不该出现" },
	];
	const selected = selectMemoryForPrompt(items, 100);
	assert.deepEqual(selected.map((item) => item.text[0]), ["乙"]);
});
