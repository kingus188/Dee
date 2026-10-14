// 项目自己维护的生产资料：数据目录里的 Markdown 文件，只读检索，回答必须引用来源。
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { classifyStatus, normalizeRel, sliceLines } from "../knowledge/index.js";
import { resultText } from "../results.js";

const MAX_FILES = 600;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOKENS = 8;
const STALE_DAYS = 180;
const CACHE_MS = 5000;

type Status = "current" | "archived" | "draft";
type MaterialFile = { path: string; status: Status; modifiedAt: number; text: string };
let cache: { root: string; at: number; files: MaterialFile[] } | null = null;

export function clearMaterialsCache() {
	cache = null;
}

// 「待确认」是 agent 提议、尚未被用户认可的资料，按草稿处理。
const statusOf = (rel: string): Status => (rel.split("/").some((part) => part === "待确认") ? "draft" : classifyStatus(rel));

async function walk(dir: string, rel: string, out: MaterialFile[]) {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (out.length >= MAX_FILES) return;
		if (entry.name.startsWith(".")) continue;
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		const child = join(dir, entry.name);
		const stat = await lstat(child).catch(() => null);
		if (!stat || stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) await walk(child, childRel, out);
		else if (stat.isFile() && childRel.endsWith(".md") && stat.size <= MAX_FILE_BYTES) {
			const text = await readFile(child, "utf8").catch(() => null);
			if (text !== null) out.push({ path: childRel, status: statusOf(childRel), modifiedAt: stat.mtimeMs, text });
		}
	}
}

export async function loadMaterials(root: string) {
	if (cache && cache.root === root && Date.now() - cache.at < CACHE_MS) return cache.files;
	const real = await realpath(root).catch(() => null);
	if (!real) throw new Error("生产资料目录不存在");
	const files: MaterialFile[] = [];
	await walk(real, "", files);
	cache = { root, at: Date.now(), files };
	return files;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const staleNote = (ms: number) => (Date.now() - ms > STALE_DAYS * 86_400_000 ? "，可能已过期" : "");

// 关键词按空格或标点拆开，命中越多越靠前；中文问句要先提炼成 2～4 个关键词。
export function searchMaterials(files: readonly MaterialFile[], query: string, includeHistorical = false) {
	const q = query.trim().toLowerCase();
	if (!q || q.length > 200) throw new Error("检索词必须是 1～200 字");
	const tokens = [...new Set(q.split(/[\s,，、;；]+/).filter(Boolean))].slice(0, MAX_TOKENS);
	const hits = [];
	for (const file of files) {
		if (!includeHistorical && file.status === "archived") continue;
		const lines = file.text.split(/\r?\n/);
		const lower = lines.map((line) => line.toLowerCase());
		const matched = tokens.filter((token) => lower.some((line) => line.includes(token)) || file.path.toLowerCase().includes(token));
		if (!matched.length) continue;
		const score = matched.length * 3 + (lower.some((line) => line.includes(q)) ? 5 : 0) + tokens.filter((token) => file.path.toLowerCase().includes(token)).length * 2;
		const perLine = lower.map((line) => matched.filter((token) => line.includes(token)).length);
		const line = Math.max(1, perLine.indexOf(Math.max(...perLine)) + 1);
		const excerpt = sliceLines(file.text, line).text.split(/\r?\n/).slice(0, 8).join("\n");
		hits.push({ path: file.path, status: file.status, modifiedAt: file.modifiedAt, line, excerpt, score, matched: matched.length, total: tokens.length });
	}
	return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "zh")).slice(0, 5);
}

export async function readMaterial(root: string, rel: unknown, line = 1) {
	const real = await realpath(root).catch(() => null);
	if (!real) throw new Error("生产资料目录不存在");
	const normal = normalizeRel(rel);
	let current = real;
	for (const part of normal.split("/")) {
		current = join(current, part);
		const stat = await lstat(current).catch(() => null);
		if (!stat) throw new Error("找不到这篇资料");
		if (stat.isSymbolicLink()) throw new Error("拒绝读取符号链接");
	}
	const stat = await lstat(current);
	if (!stat.isFile() || !normal.endsWith(".md")) throw new Error("只能阅读 Markdown 文件");
	if (stat.size > MAX_FILE_BYTES) throw new Error("资料超过 256KB，请拆分后再读");
	if (!current.startsWith(real + sep)) throw new Error("路径不能跳出资料目录");
	const slice = sliceLines(await readFile(current, "utf8"), Number(line) || 1);
	return { path: normal, status: statusOf(normal), modifiedAt: stat.mtimeMs, ...slice };
}

const statusWarning = (status: Status) =>
	status === "archived" ? "这是归档资料，不能当作现行依据。\n" : status === "draft" ? "这是草稿或待确认资料，不是已确认事实。\n" : "";

export function createMaterials(root: string) {
	return defineExtension({
		name: "materials",
		tools: [
			defineTool({
				name: "search_materials",
				replay: "safe",
				description: "在用户维护的生产资料（产品/系统说明、流程、常见问答、职责、决策）里检索，返回路径、行号、修改日期和片段。检索词用 2～4 个关键词，空格分隔，不要整句；搜不到时换同义词再试一次。默认不含归档。",
				parameters: Type.Object({ query: Type.String(), includeHistorical: Type.Optional(Type.Boolean()) }),
				execute: async (args) => {
					try {
						const hits = searchMaterials(await loadMaterials(root), args.query, args.includeHistorical === true);
						if (!hits.length) return resultText(`生产资料里没有找到「${args.query}」。这表示没有资料依据，不要凭印象回答。`);
						return resultText(["检索到这些资料，回答时附上路径和行号；只有 [current] 可作为依据：", ...hits.map((hit) => {
							const end = hit.line + hit.excerpt.split("\n").length - 1;
							return `- ${hit.path}:${hit.line === end ? hit.line : `${hit.line}-${end}`} [${hit.status}] 修改于 ${day(hit.modifiedAt)}${staleNote(hit.modifiedAt)}，命中 ${hit.matched}/${hit.total} 个关键词\n${hit.excerpt}`;
						})].join("\n"));
					} catch (error) {
						return resultText(`无法检索生产资料：${error instanceof Error ? error.message : String(error)}`);
					}
				},
			}),
			defineTool({
				name: "read_materials",
				replay: "safe",
				description: "按相对路径阅读一篇生产资料，从指定行开始。草稿、待确认和归档不能当作现行依据。",
				parameters: Type.Object({ path: Type.String(), line: Type.Optional(Type.Number()) }),
				execute: async (args) => {
					try {
						const page = await readMaterial(root, args.path, args.line);
						return resultText(`${statusWarning(page.status)}${page.path}:${page.startLine}-${page.endLine} [${page.status}] 修改于 ${day(page.modifiedAt)}${staleNote(page.modifiedAt)}${page.truncated ? "（已截断）" : ""}\n${page.text}`);
					} catch (error) {
						return resultText(`无法阅读资料：${error instanceof Error ? error.message : String(error)}`);
					}
				},
			}),
		],
	});
}
