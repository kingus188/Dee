// 编码 Agent 适配层：每个 Agent 只需实现 AgentRunner（在 job.cwd 里完成 job.prompt，返回结果文本）。
// 新增 Agent（如 pi）= 在这里加一个 runner 并登记到 AGENT_NAMES，调用方不用改。
import { spawn } from "node:child_process";
import { runCodex } from "./acp.js";

export const AGENT_NAMES = ["codex", "claude"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
export type AgentJob = { cwd: string; prompt: string; test?: string; timeoutMs: number };
export type AgentResult = { ok: boolean; text: string; error?: string };
export type AgentRunner = (job: AgentJob) => Promise<AgentResult>;
export type AgentBins = { codexBin: string; claudeBin: string };

const BUDGET_USD = "5";
const TOOLS = "Read,Grep,Glob,Edit,Write,Bash";
// Bash 只放行查看和提交，加上该仓库配置的测试命令。
const ALLOWED = ["Read", "Grep", "Glob", "Edit", "Write", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git add:*)", "Bash(git commit:*)"];

const codex = (bin: string): AgentRunner => async (job) => {
	const result = await runCodex({ bin, ...job });
	return { ok: result.stopReason === "end_turn", text: result.text, error: result.stopReason === "end_turn" ? undefined : `停止原因：${result.stopReason}` };
};

// ponytail: 进程由本服务持有，重启会中断；要跨重启存活需改回脱离服务的后台进程加 exit 文件。
const claude = (bin: string): AgentRunner => (job) => new Promise((resolve) => {
	const allowed = job.test ? [...ALLOWED, `Bash(${job.test}:*)`] : ALLOWED;
	const child = spawn(bin, ["-p", "--permission-mode", "acceptEdits", "--tools", TOOLS, "--allowedTools", allowed.join(","),
		"--max-budget-usd", BUDGET_USD, "--disable-slash-commands"], { cwd: job.cwd, stdio: ["pipe", "pipe", "pipe"], timeout: job.timeoutMs });
	let out = "";
	let err = "";
	child.stdout.on("data", (chunk: Buffer) => (out += chunk));
	child.stderr.on("data", (chunk: Buffer) => (err = (err + chunk).slice(-1500)));
	child.on("error", (error) => resolve({ ok: false, text: out, error: error.message }));
	child.on("close", (code) => resolve({ ok: code === 0, text: out, error: code === 0 ? undefined : `退出码 ${code}：${err}` }));
	child.stdin.end(job.prompt);
});

export const createRunners = (bins: AgentBins): Record<AgentName, AgentRunner> => ({ codex: codex(bins.codexBin), claude: claude(bins.claudeBin) });
