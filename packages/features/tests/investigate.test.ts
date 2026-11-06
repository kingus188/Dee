import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodex } from "../dist/investigate/acp.js";
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

		const ext = createInvestigator({ repos: { demo: { path: repo } }, dir: join(root, "runs"), agent: "claude", codexBin: "codex-acp", claudeBin: bin }) as unknown as { tools: { name: string; execute: (a: unknown, api: { conversationId: number }) => Promise<{ output: { text: string }[] }> }[] };
		const tool = (name: string) => ext.tools.find((t) => t.name === name)!;
		const text = async (name: string, args: unknown) => (await tool(name).execute(args, { conversationId: 17 })).output[0].text;

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

test("ACP 不因命令名称、引号或仓库测试配置而自动批准额外权限", () => {
	const commands = [
		"git add .", 'git commit -m "fix"', "git status", "git diff --cached --check", "git log --oneline",
		"echo done", "printf '%s\\n' done", "npm test", "node test.js", "npm test --script-shell=/tmp/attacker-shell",
		"git log --output=/tmp/acp-write", "git diff --ext-diff", "git constructor", "git __proto__", "git constructor anything",
		'echo "$(touch /tmp/acp-bypass)"', 'git commit -m "`touch /tmp/acp-bypass`"', '"echo \'$(touch /tmp/acp-bypass)\'"',
		"echo safe & touch /tmp/acp-bypass", "printf -v PATH /tmp", "printf '%n' PATH", "", '"unterminated',
	];
	for (const command of commands) {
		assert.equal(commandAllowed(command, "npm test"), false, command);
		assert.equal(commandAllowed(command, command), false, "即使仓库配置完全匹配，也不能授权升权");
	}
});

async function fakeAcp(scenario: { commands?: string[]; failMode?: boolean; noRejectOption?: boolean }, run: (bin: string, root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "pi-acp-permissions-"));
	try {
		const bin = join(root, "fake-acp.mjs");
		await writeFile(bin, `#!${process.execPath}
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const scenario = ${JSON.stringify(scenario)};
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
const responses = [];
let promptId, index = 0;
const next = () => {
  if (index < (scenario.commands?.length ?? 0)) {
    send({ id: "permission-" + index, method: "session/request_permission", params: {
      sessionId: "fixture", toolCall: { toolCallId: "tool-" + index, kind: index % 2 ? "edit" : "execute", rawInput: { command: scenario.commands[index] } },
      options: [{ optionId: "yes", kind: "allow_once", name: "Allow" }, { optionId: "always", kind: "allow_always", name: "Always" },
        ...(scenario.noRejectOption ? [] : [{ optionId: "no", kind: "reject_once", name: "Reject" }])]
    } });
  } else {
    send({ method: "session/update", params: { sessionId: "fixture", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "sandbox work: " + JSON.stringify(responses) } } } });
    send({ id: promptId, result: { stopReason: "end_turn" } });
  }
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) { responses.push(message.result); index++; next(); return; }
  appendFileSync("protocol.log", message.method + "\\n");
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "fixture" } });
  else if (message.method === "session/set_mode") {
    if (scenario.failMode || message.params.modeId !== "workspace-write") send({ id: message.id, error: { code: -32602, message: "mode rejected" } });
    else send({ id: message.id, result: {} });
  } else if (message.method === "session/prompt") { promptId = message.id; next(); }
});
`);
		await chmod(bin, 0o755);
		await run(bin, root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("ACP 协议对敏感操作始终选择拒绝，并在结果中说明限制", async () => {
	await fakeAcp({ commands: ["npm test", 'git commit -m "fix"', "git diff --ext-diff", "echo done"] }, async (bin, root) => {
		const result = await runCodex({ bin, cwd: root, prompt: "test", test: "npm test", timeoutMs: 5000 });
		assert.equal(result.stopReason, "end_turn");
		assert.match(result.text, /已拒绝 4 次额外权限请求/);
		assert.match(result.text, /没有人工审批入口/);
		assert.deepEqual(JSON.parse(result.text.split("sandbox work: ")[1]), Array(4).fill({ outcome: { outcome: "selected", optionId: "no" } }));
	});
});

test("ACP 没有拒绝选项时取消，不回退到任何允许选项", async () => {
	await fakeAcp({ commands: ["npm test"], noRejectOption: true }, async (bin, root) => {
		const result = await runCodex({ bin, cwd: root, prompt: "test", test: "npm test", timeoutMs: 5000 });
		assert.deepEqual(JSON.parse(result.text.split("sandbox work: ")[1]), [{ outcome: { outcome: "cancelled" } }]);
	});
});

test("ACP 保留无需审批的正常流程，设置 workspace-write 失败则不发送任务", async () => {
	await fakeAcp({}, async (bin, root) => {
		const result = await runCodex({ bin, cwd: root, prompt: "test", timeoutMs: 5000 });
		assert.equal(result.text, "sandbox work: []");
		assert.equal(result.stopReason, "end_turn");
	});
	await fakeAcp({ failMode: true }, async (bin, root) => {
		await assert.rejects(runCodex({ bin, cwd: root, prompt: "test", timeoutMs: 5000 }), /mode rejected/);
		assert.doesNotMatch(await readFile(join(root, "protocol.log"), "utf8"), /session\/prompt/);
	});
});
