import test from "node:test";
import assert from "node:assert/strict";
import { decideMemoryInTx, editMemoryInTx, normalizeMemoryText, proposeMemoryInTx, selectMemoryForPrompt } from "@assistant/features";
import { mustAccept, normalizeCases, promptCases, scenarios, secretsMustReject } from "./memory-dataset.js";
import type { Step } from "./memory-dataset.js";

type Doc = { items: { id: string; status: string; text: string }[]; applied: Record<string, string> };
type Item = { id: string; status: string; text: string };

async function run(step: Step, tx: never, results: (Item | null)[]) {
	if (step.op === "propose") {
		return proposeMemoryInTx(tx, { text: step.text, approved: step.approved, requestId: step.requestId });
	}
	const id = results[step.ref]?.id;
	assert.ok(id, `ref ${step.ref} 没有对应条目`);
	return step.op === "decide" ? decideMemoryInTx(tx, id, step.action) : editMemoryInTx(tx, id, step.text);
}

function check(step: Step, item: Item, results: (Item | null)[]) {
	if (step.status) assert.equal(item.status, step.status);
	if (step.resultText) assert.equal(item.text, step.resultText);
	if (step.sameAs !== undefined) assert.equal(item.id, results[step.sameAs]?.id);
	if (step.differentFrom !== undefined) assert.notEqual(item.id, results[step.differentFrom]?.id);
}

for (const scenario of scenarios) {
	test(`记忆场景：${scenario.name}`, async () => {
		const doc: Doc = { items: [], applied: {} };
		const tx = { doc: async () => doc } as never;
		const results: (Item | null)[] = [];
		for (const [index, step] of scenario.steps.entries()) {
			const repeat = step.op === "propose" ? (step.repeat ?? 1) : 1;
			for (let i = 0; i < repeat; i++) {
				// repeat 时把文本开头替换为序号，保持字数不变且互不重复
				const varied = repeat > 1 && step.op === "propose" ? { ...step, text: String(i) + step.text.slice(String(i).length) } : step;
				if (step.error) {
					await assert.rejects(run(varied, tx, results), step.error, `第 ${index} 步`);
					results.push(null);
					continue;
				}
				const item = await run(varied, tx, results);
				check(step, item, results);
				results.push(item);
			}
		}
		for (const status of ["pending", "approved", "rejected"] as const) {
			const expected = scenario.finalCounts?.[status];
			if (expected !== undefined) assert.equal(doc.items.filter((item) => item.status === status).length, expected, status);
		}
	});
}

test("数据集：凭据必须拒绝，普通偏好必须放行", () => {
	for (const text of secretsMustReject) assert.throws(() => normalizeMemoryText(text), /不能包含密码/, text);
	for (const text of mustAccept) assert.equal(normalizeMemoryText(text), text);
});

test("数据集：文本规范化边界", () => {
	for (const item of normalizeCases) {
		if (item.error) assert.throws(() => normalizeMemoryText(item.input), item.error);
		else assert.equal(normalizeMemoryText(item.input), item.output);
	}
});

test("数据集：提示词记忆选择", () => {
	for (const item of promptCases) {
		assert.deepEqual(selectMemoryForPrompt(item.items, item.budget).map((entry) => entry.text), item.expect, item.name);
	}
});
