import test from "node:test";
import assert from "node:assert/strict";
import { decideMemoryInTx, editMemoryInTx, proposeMemoryInTx, normalizeMemoryText, normalizeSkill, selectMemoryForPrompt } from "@assistant/features";

test("记忆和技能有字数边界", () => {
	assert.equal(normalizeMemoryText("  记住   这件事  "), "记住   这件事");
	assert.throws(() => normalizeMemoryText(""), /记忆必须/);
	assert.throws(() => normalizeMemoryText("甲".repeat(281)), /记忆必须/);
	assert.throws(() => normalizeMemoryText("我的 key 是 sk-abcdefghijklmnopqrstuv"), /不能包含密码/);
	assert.throws(() => normalizeMemoryText("password: hunter2hunter2"), /不能包含密码/);
	assert.equal(normalizeMemoryText("喜欢用 token 计费的方案"), "喜欢用 token 计费的方案");
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

test("记忆提交去重、限制已批准总字数、并裁剪已拒绝条目", async () => {
	const doc = { items: [] as any[], applied: {} as Record<string, string> };
	const tx = { doc: async () => doc } as any;
	const first = await proposeMemoryInTx(tx, { text: "喜欢简洁回答" });
	assert.equal((await proposeMemoryInTx(tx, { text: "喜欢简洁回答" })).id, first.id);
	assert.equal(doc.items.length, 1);

	for (let i = 0; i < 6; i++) await proposeMemoryInTx(tx, { text: String(i).repeat(280), approved: true });
	await assert.rejects(proposeMemoryInTx(tx, { text: "超预算".repeat(50), approved: true }), /总字数已满/);
	await assert.rejects(decideMemoryInTx(tx, first.id, "approve").then(() => proposeMemoryInTx(tx, { text: "x".repeat(280), approved: true })), /总字数已满/);

	for (let i = 0; i < 30; i++) {
		const item = await proposeMemoryInTx(tx, { text: "拒绝" + i });
		await decideMemoryInTx(tx, item.id, "reject");
	}
	await proposeMemoryInTx(tx, { text: "触发裁剪" });
	assert.ok(doc.items.filter((item) => item.status === "rejected").length <= 20);
});

test("可以修改记忆，并保持去重与总字数限制", async () => {
	const doc = { items: [] as any[], applied: {} as Record<string, string> };
	const tx = { doc: async () => doc } as any;
	const a = await proposeMemoryInTx(tx, { text: "甲", approved: true });
	await proposeMemoryInTx(tx, { text: "乙", approved: true });
	assert.equal((await editMemoryInTx(tx, a.id, "  丙  ")).text, "丙");
	assert.equal(doc.items[0].status, "approved");
	await assert.rejects(editMemoryInTx(tx, a.id, "乙"), /已有相同记忆/);
	await assert.rejects(editMemoryInTx(tx, a.id, "甲".repeat(281)), /记忆必须/);
	await assert.rejects(editMemoryInTx(tx, "nope", "x"), /记忆不存在/);
	for (let i = 0; i < 6; i++) await proposeMemoryInTx(tx, { text: String(i).repeat(280), approved: true }).catch(() => {});
	await assert.rejects(editMemoryInTx(tx, a.id, "丙".repeat(280)), /总字数已满/);
});
