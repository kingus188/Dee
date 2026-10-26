import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeRel } from "../knowledge/index.js";
import { hasSecret } from "../personal/service.js";
import { clearMaterialsCache, resolveInside } from "./fs.js";

const PENDING = "待确认";
const RESERVED = new Set([PENDING, "归档", "草稿"]);
const CONTENT_MAX = 8000;
const TITLE_MAX = 60;
const SOURCE_MAX = 100;

const today = () => new Date().toISOString().slice(0, 10);
const exists = async (path: string) => !!(await lstat(path).catch(() => null));

function category(input: unknown) {
	const rel = normalizeRel(input);
	if (rel.split("/").length > 2 || rel.split("/").some((part) => RESERVED.has(part) || part.startsWith("."))) throw new Error("分类最多两级，且不能使用「待确认」「归档」「草稿」");
	return rel;
}

function fileName(title: unknown) {
	const name = String(title ?? "").replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
	if (!name || name.length > TITLE_MAX) throw new Error(`标题必须是 1～${TITLE_MAX} 字`);
	return name;
}

// 待确认文件的相对路径必须在「待确认/」下，返回它转正后的路径。
function pendingTarget(path: unknown) {
	const rel = normalizeRel(path);
	if (!rel.startsWith(`${PENDING}/`) || !rel.endsWith(".md")) throw new Error("只能处理「待确认」目录下的 Markdown 资料");
	return { pending: rel, target: rel.slice(PENDING.length + 1) };
}

// 存入「待确认」区。同一分类和标题重复保存会覆盖待确认稿，不会碰现行资料。
export async function saveMaterial(root: string, input: { category: unknown; title: unknown; content: unknown; source: unknown }) {
	// 标题由工具生成，去掉正文开头重复的一级标题。
	const content = String(input.content ?? "").trim().replace(/^#\s+.*\n+/, "");
	if (!content || content.length > CONTENT_MAX) throw new Error(`资料内容必须是 1～${CONTENT_MAX} 字`);
	const title = fileName(input.title);
	const source = String(input.source ?? "").replace(/\s+/g, " ").trim().slice(0, SOURCE_MAX) || "未注明";
	if (hasSecret(`${title}\n${source}\n${content}`)) throw new Error("资料里不能包含密码、密钥或令牌");
	const { path, absolute } = await resolveInside(root, `${PENDING}/${category(input.category)}/${title}.md`);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, `# ${title}\n\n更新日期：${today()}\n来源：${source}\n\n${content}\n`);
	clearMaterialsCache();
	return path;
}

// 同一正文重新保存也构成新版本，防止确认后替换再换回原文。
export async function readDraftSnapshot(root: string, rawPath: unknown) {
	const { pending } = pendingTarget(rawPath);
	const { path, absolute } = await resolveInside(root, pending);
	const before = await lstat(absolute, { bigint: true });
	if (!before.isFile() || before.size > 256n * 1024n) throw new Error("待确认资料必须是 256KB 内的普通 Markdown 文件");
	const body = await readFile(absolute, "utf8");
	const after = await lstat(absolute, { bigint: true });
	const stamp = (stat: typeof before) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
	if (stamp(before) !== stamp(after)) throw new Error("读取期间草稿已修改，请重新展示并确认");
	return { root: await realpath(root), path, body, version: createHash("sha256").update(stamp(after)).update("\n").update(body).digest("hex") };
}

// 待确认转为现行；已有同名现行资料先归档。两参数保留宿主辅助接口的幂等语义；工具必须传入已核对的版本。
export async function approveMaterial(root: string, rawPath: unknown, expectedVersion?: string) {
	const { pending, target } = pendingTarget(rawPath);
	const from = await resolveInside(root, pending);
	const to = await resolveInside(root, target);
	if (!(await exists(from.absolute))) {
		if (expectedVersion === undefined && await exists(to.absolute)) return { path: target, archived: null };
		throw new Error("找不到这篇待确认资料");
	}
	const snapshot = expectedVersion === undefined ? undefined : await readDraftSnapshot(root, pending);
	if (snapshot && snapshot.version !== expectedVersion) throw new Error("确认后草稿已修改，没有入库，请重新展示并确认");
	const body = (snapshot?.body ?? await readFile(from.absolute, "utf8")).replace(/^更新日期：.*$/m, `更新日期：${today()}`);
	let archived: string | null = null;
	if (await exists(to.absolute) && (await readFile(to.absolute, "utf8")) !== body) {
		const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
		const base = target.slice(0, -3);
		const archive = await resolveInside(root, `${dirname(target) === "." ? "" : `${dirname(target)}/`}归档/${base.split("/").pop()}-${stamp}.md`);
		await mkdir(dirname(archive.absolute), { recursive: true });
		await rename(to.absolute, archive.absolute);
		archived = archive.path;
	}
	await mkdir(dirname(to.absolute), { recursive: true });
	await writeFile(to.absolute, body);
	await rm(from.absolute, { force: true });
	clearMaterialsCache();
	return { path: target, archived };
}

export async function discardMaterial(root: string, rawPath: unknown) {
	const { pending } = pendingTarget(rawPath);
	await rm((await resolveInside(root, pending)).absolute, { force: true });
	clearMaterialsCache();
	return pending;
}
