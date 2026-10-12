import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bestLine, clearKnowledgeCache, readKnowledge, searchKnowledge } from "@assistant/features";

async function vault() {
	const root = await mkdtemp(join(tmpdir(), "pi-kb-"));
	const allow = join(root, "My-VPS/我的VPS/AI学习");
	await mkdir(join(allow, "归档"), { recursive: true });
	await mkdir(join(allow, "my-info"), { recursive: true });
	await writeFile(join(root, "AGENTS.md"), "# 根规则\n写 Pi 时先核对现行笔记。\n");
	await writeFile(join(allow, "现行.md"), "# 总览\n\nPi Durable 的现行写法是先列步骤。\n");
	await writeFile(join(allow, "归档", "旧.md"), "以前的 Pi Durable 文章在这里。\n");
	await writeFile(join(allow, "my-info", "秘密.md"), "银行卡密码不要被检索到。\n");
	await writeFile(join(root, "外面.md"), "仓库外的秘密句子。\n");
	await symlink(join(root, "外面.md"), join(allow, "链接.md"));
	const long = ["命中这行短句。", ...Array.from({ length: 80 }, (_, i) => `第${i}行` + "甲".repeat(90))].join("\n");
	await writeFile(join(allow, "长文.md"), long);
	return { root, allow, env: { OBSIDIAN_ROOT: root } };
}

test("检索只返回白名单里的现行笔记，并带来源行号", async () => {
	const fixture = await vault();
	try {
		clearKnowledgeCache();
		const found = await searchKnowledge("Pi Durable 的现行写法", { env: fixture.env });
		assert.equal(found.hits[0].path, "My-VPS/我的VPS/AI学习/现行.md");
		assert.equal(found.hits[0].status, "current");
		assert.equal(found.hits[0].line, 3);
		assert.equal(found.hits.some((hit) => hit.status === "archived" || hit.path.includes("my-info")), false);
		const hidden = await searchKnowledge("以前的 Pi Durable", { env: fixture.env });
		assert.equal(hidden.hits.length, 0);
		const past = await searchKnowledge("以前的 Pi Durable", { env: fixture.env, includeHistorical: true });
		assert.equal(past.hits[0].status, "archived");
		const leaked = await searchKnowledge("银行卡密码", { env: fixture.env, includeHistorical: true });
		assert.equal(leaked.hits.length, 0);
		const agents = await searchKnowledge("根规则", { env: fixture.env });
		assert.equal(agents.hits[0].path, "AGENTS.md");
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("阅读拒绝越权、符号链接，并按实际保留的行报告结尾", async () => {
	const fixture = await vault();
	try {
		clearKnowledgeCache();
		await assert.rejects(() => readKnowledge("../外面.md", 1, fixture.env), /跳出|允许/);
		await assert.rejects(() => readKnowledge("My-VPS/我的VPS/AI学习/链接.md", 1, fixture.env), /符号链接/);
		await assert.rejects(() => readKnowledge("My-VPS/我的VPS/AI学习/my-info/秘密.md", 1, fixture.env), /允许/);
		const page = await readKnowledge("My-VPS/我的VPS/AI学习/长文.md", 1, fixture.env);
		const source = await readFile(join(fixture.allow, "长文.md"), "utf8");
		const expected = source.split("\n").slice(page.startLine - 1, page.endLine).join("\n");
		assert.equal(page.text, expected);
		assert.equal(page.truncated, true);
		assert.ok(page.endLine < source.split("\n").length);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("标题加分不能压过真正命中的行", () => {
	const text = ["# 无关标题", "", "这里才有 needleword"].join("\n");
	assert.equal(bestLine(text, "needleword").line, 3);
});
