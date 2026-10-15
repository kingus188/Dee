// 把排查分支合并回仓库当前分支：只做本地合并，不推送；是否合并由用户在聊天里用固定句式确认，由代码校验。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const git = promisify(execFile);
const out = async (cwd: string, ...args: string[]) => (await git("git", ["-C", cwd, ...args])).stdout.trim();

// 「确认合并 <任务ID>」，整条消息只能是这句；Teams 等注入的消息（以 [ 开头）不会匹配。
export function parseMergeConfirmation(text: string): string | null {
	return /^确认合并\s+([0-9a-f]{12})[\s。.!！]*$/.exec(text.trim())?.[1] ?? null;
}

export async function mergeBranch(repo: string, tree: string, branch: string, base: string) {
	if (await out(repo, "status", "--porcelain", "--untracked-files=no")) throw new Error("仓库当前有未提交的改动，先处理后再合并");
	if (await out(tree, "status", "--porcelain")) throw new Error("排查 worktree 里有未提交的改动，需要人工查看");
	if (Number(await out(repo, "rev-list", "--count", `${base}..${branch}`)) === 0) throw new Error("分支上没有提交，无需合并");
	const before = await out(repo, "rev-parse", "--short", "HEAD");
	try {
		await out(repo, "merge", "--no-ff", "-m", `merge: ${branch}`, branch);
	} catch (error) {
		await out(repo, "merge", "--abort").catch(() => undefined);
		throw new Error(`合并冲突或失败，已还原：${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
	}
	await out(repo, "worktree", "remove", tree);
	return { before, after: await out(repo, "rev-parse", "--short", "HEAD"), onBranch: await out(repo, "rev-parse", "--abbrev-ref", "HEAD") };
}
