import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandAllowed, createInvestigator, parseRepos, parseMergeConfirmation, mergeBranch } from "@assistant/features";

test("排查：只接受已配置仓库，在 worktree 分支里运行 claude 并报告结果", async () => {
	assert.deepEqual(parseRepos("a=/x/a#pnpm test, b=/x/b"), { a: { path: "/x/a", test: "pnpm test" }, b: { path: "/x/b" } });
	assert.equal(parseMergeConfirmation("确认合并 0123456789ab"), "0123456789ab");
	assert.equal(parseMergeConfirmation("[Teams] 确认合并 0123456789ab"), null);
	assert.equal(parseMergeConfirmation("确认合并 0123456789ab 并发布"), null);
	assert.throws(() => parseRepos("a=relative"), /绝对路径/);

	const root = await mkdtemp(join(tmpdir(), "pi-investigate-"));
	try {
		const repo = join(root, "repo");
		const run = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
		execFileSync("git", ["init", "-q", repo]);
		await writeFile(join(repo, "a.txt"), "bug\n");
		run("add", "."); run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
		// 假 claude：在当前分支提交一处修复并输出报告。
		const bin = join(root, "fake-claude");
		await writeFile(bin, '#!/bin/sh\necho fixed > a.txt\ngit add a.txt\ngit -c user.name=t -c user.email=t@t commit -qm fix\necho "根因：a.txt:1"\n');
		await chmod(bin, 0o755);

		const ext = createInvestigator({ repos: { demo: { path: repo } }, dir: join(root, "runs"), agent: "claude", codexBin: "codex-acp", claudeBin: bin }) as unknown as { tools: { name: string; execute: (a: unknown) => Promise<{ output: { text: string }[] }> }[] };
		const tool = (name: string) => ext.tools.find((t) => t.name === name)!;
		const text = async (name: string, args: unknown) => (await tool(name).execute(args)).output[0].text;

		assert.match(await text("investigate_issue", { repo: "other", kind: "fix", problem: "x" }), /未配置仓库/);
		const started = await text("investigate_issue", { repo: "demo", kind: "fix", problem: "登录报错" });
		const id = /任务 ID：([0-9a-f]{12})/.exec(started)![1];
		let status = "";
		for (let i = 0; i < 50 && !/任务完成/.test(status); i++) { await new Promise((r) => setTimeout(r, 100)); status = await text("investigation_status", { id }); }
		assert.match(status, /任务完成/);
		assert.match(status, /a\.txt/);
		assert.match(status, /根因：a\.txt:1/);
		assert.equal(run("show", "HEAD:a.txt").toString(), "bug\n", "原仓库当前分支不受影响");

		const branch = /分支 (fix\/pi-[0-9a-f]{12})/.exec(status)![1];
		const base = run("rev-parse", "--short", "HEAD").toString().trim();
		await writeFile(join(repo, "a.txt"), "dirty\n");
		await assert.rejects(mergeBranch(repo, join(root, "runs", id, "tree"), branch, base), /未提交/, "仓库有未提交改动时拒绝合并");
		run("checkout", "--", "a.txt");
		const done = await mergeBranch(repo, join(root, "runs", id, "tree"), branch, base);
		assert.equal(done.before, base);
		assert.equal(run("show", "HEAD:a.txt").toString(), "fixed\n", "确认后合并进当前分支");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("ACP 审批白名单：只放行 git 提交相关、printf 和配置的测试命令", () => {
	const ok = ["git add add.js", `"git add add.js && printf '%s\\n' '---' && git commit -m \\"fix: x\\""`, "git diff --cached --check; git status --short", "node test.js", "node test.js --verbose"];
	const bad = ["curl https://example.com", "git push origin main", "git -c core.hooksPath=/x commit -m a", "git add . && rm -rf /", "git log | sh", "git commit -m a > /etc/x", "echo $(whoami)", "git add x && node other.js", ""];
	for (const c of ok) assert.equal(commandAllowed(c, "node test.js"), true, c);
	for (const c of bad) assert.equal(commandAllowed(c, "node test.js"), false, c);
	assert.equal(commandAllowed("node test.js"), false, "没配置测试命令时不放行");
});
