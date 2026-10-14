export type KnowledgeConfig = { OBSIDIAN_ROOT?: string; OBSIDIAN_ALLOW?: string };
// Obsidian 只读检索。权威内容留在仓库里，这里只返回带来源的片段。
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

export const DEFAULT_ALLOW = [
	"My-VPS/我的VPS/AI学习",
	"My-VPS/我的VPS/X灵感",
	"My-VPS/我的VPS/VPS小白教程",
];

const MAX_FILES = 600;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_READ_CHARS = 6200;
const CACHE_MS = 5000;

const DENY_SEGMENT = /^(?:my-info|secrets?|\.env|credentials|\.git|node_modules)$/i;
const DENY_TEXT = /财务|密钥|服务器资产/;

type KnowledgeFile = { path: string; status: "current" | "archived" | "draft"; revision: string; text: string };
let cache: { key: string; at: number; files: KnowledgeFile[] } | null = null;

export function clearKnowledgeCache() {
	cache = null;
}

export function normalizeRel(input: unknown) {
	const raw = String(input ?? "").replaceAll("\\", "/").trim().replace(/^\.\//, "").replace(/^\/+/, "");
	if (!raw) throw new Error("路径不能为空");
	const parts = [];
	for (const part of raw.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") throw new Error("路径不能跳出知识库");
		parts.push(part);
	}
	if (parts.length === 0) throw new Error("路径不能为空");
	return parts.join("/");
}

export function allowList(env: KnowledgeConfig = {}) {
	const extra = String(env.OBSIDIAN_ALLOW || "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
		.map(normalizeRel);
	return [...DEFAULT_ALLOW, ...extra];
}

export function classifyStatus(rel: string): KnowledgeFile["status"] {
	const parts = rel.split("/");
	if (parts.some((part) => /归档|历史快照|archive/i.test(part))) return "archived";
	if (parts.some((part) => /草稿|draft/i.test(part))) return "draft";
	return "current";
}

function denied(rel: string) {
	return rel.split("/").some((part) => DENY_SEGMENT.test(part) || DENY_TEXT.test(part));
}

function insideAllow(rel: string, allow: string[]) {
	if (denied(rel)) return false;
	if (rel === "AGENTS.md") return true;
	if (rel.endsWith("/AGENTS.md")) {
		const dir = rel.slice(0, -"/AGENTS.md".length);
		return allow.some((prefix) => dir === prefix || dir.startsWith(`${prefix}/`));
	}
	return allow.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

function shouldDescend(rel: string, allow: string[]) {
	if (!rel || denied(rel)) return false;
	return allow.some((prefix) => prefix === rel || prefix.startsWith(`${rel}/`) || rel.startsWith(`${prefix}/`));
}

export function knowledgeStatus(env: KnowledgeConfig = {}) {
	const root = String(env.OBSIDIAN_ROOT || "").trim();
	if (!root) return { enabled: false, reason: "未设置 OBSIDIAN_ROOT", allow: allowList(env) };
	return { enabled: true, root, allow: allowList(env) };
}

async function rootReal(env: KnowledgeConfig) {
	const status = knowledgeStatus(env);
	if (!status.enabled) throw new Error(status.reason);
	try {
		return await realpath(status.root!);
	} catch {
		throw new Error("OBSIDIAN_ROOT 不存在或无法读取");
	}
}

async function walk(dir: string, rel: string, allow: string[], out: KnowledgeFile[]) {
	if (out.length >= MAX_FILES) return;
	let entries: import("node:fs").Dirent[] = [];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (out.length >= MAX_FILES) return;
		if (entry.name.startsWith(".")) continue;
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (denied(childRel)) continue;
		const child = join(dir, entry.name);
		let stat;
		try {
			stat = await lstat(child);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			if (shouldDescend(childRel, allow)) await walk(child, childRel, allow, out);
			continue;
		}
		if (!stat.isFile() || !childRel.endsWith(".md") || !insideAllow(childRel, allow)) continue;
		if (stat.size > MAX_FILE_BYTES) continue;
		let text = "";
		try {
			text = await readFile(child, "utf8");
		} catch {
			continue;
		}
		out.push({
			path: childRel,
			status: classifyStatus(childRel),
			revision: `${Math.trunc(stat.mtimeMs)}:${stat.size}`,
			text,
		});
	}
}

async function corpus(env: KnowledgeConfig = {}) {
	const root = await rootReal(env);
	const allow = allowList(env);
	const key = `${root}\0${allow.join("\0")}`;
	if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return { root, files: cache.files };
	const files: KnowledgeFile[] = [];
	for (const prefix of allow) {
		const parts = prefix.split("/");
		let dir = root;
		let blocked = false;
		for (const part of parts) {
			dir = join(dir, part);
			let stat;
			try {
				stat = await lstat(dir);
			} catch {
				blocked = true;
				break;
			}
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				blocked = true;
				break;
			}
		}
		if (!blocked) await walk(dir, prefix, allow, files);
	}
	const agents = join(root, "AGENTS.md");
	try {
		const stat = await lstat(agents);
		if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_FILE_BYTES && !files.some((file) => file.path === "AGENTS.md")) {
			files.push({
				path: "AGENTS.md",
				status: "current",
				revision: `${Math.trunc(stat.mtimeMs)}:${stat.size}`,
				text: await readFile(agents, "utf8"),
			});
		}
	} catch {
		// 根目录没有 AGENTS.md 时照常检索白名单。
	}
	const unique = [];
	const seen = new Set();
	for (const file of files) {
		if (seen.has(file.path)) continue;
		seen.add(file.path);
		unique.push(file);
	}
	cache = { key, at: Date.now(), files: unique };
	return { root, files: unique };
}

export function bestLine(text: string, query: string) {
	const lines = String(text).split(/\r?\n/);
	const phrase = query.trim().toLowerCase();
	const tokens = [...new Set(phrase.split(/\s+/).filter(Boolean))];
	const blob = lines.join("\n").toLowerCase();
	if (tokens.length === 0 || tokens.some((token) => !blob.includes(token))) return { line: 1, score: 0 };
	let best = { line: 1, score: 0 };
	for (let i = 0; i < lines.length; i++) {
		const lower = lines[i].toLowerCase();
		let score = 0;
		if (lower.includes(phrase)) score += 5;
		for (const token of tokens) if (lower.includes(token)) score += 3;
		if (score > best.score) best = { line: i + 1, score };
	}
	if (best.score === 0) {
		const index = lines.findIndex((line) => tokens.some((token) => line.toLowerCase().includes(token)));
		return { line: index + 1 || 1, score: 1 };
	}
	return best;
}

export function sliceLines(text: string, startLine: number) {
	const lines = String(text).split(/\r?\n/);
	const start = Math.min(Math.max(1, startLine), Math.max(lines.length, 1));
	const picked = [];
	let chars = 0;
	let end = start - 1;
	let truncated = false;
	for (let i = start - 1; i < lines.length; i++) {
		const addition = (picked.length ? 1 : 0) + lines[i].length;
		if (chars + addition > MAX_READ_CHARS) {
			truncated = true;
			if (picked.length === 0) {
				picked.push(lines[i].slice(0, MAX_READ_CHARS));
				end = i + 1;
			}
			break;
		}
		picked.push(lines[i]);
		chars += addition;
		end = i + 1;
	}
	if (end < start) end = start;
	return { startLine: start, endLine: end, text: picked.join("\n"), truncated };
}

export async function searchKnowledge(query: unknown, options: { includeHistorical?: boolean; env?: KnowledgeConfig } = {}) {
	const q = String(query ?? "").trim();
	if (!q || q.length > 200) throw new Error("检索词必须是 1～200 字");
	const includeHistorical = options.includeHistorical === true;
	const { files } = await corpus(options.env);
	const hits = [];
	for (const file of files) {
		if (!includeHistorical && file.status === "archived") continue;
		const found = bestLine(file.text, q);
		if (found.score <= 0) continue;
		const excerpt = sliceLines(file.text, found.line);
		const short = sliceLines(excerpt.text, 1);
		const clipped = short.text.split(/\r?\n/).slice(0, 8).join("\n");
		hits.push({
			path: file.path,
			status: file.status,
			revision: file.revision,
			line: found.line,
			endLine: found.line + clipped.split(/\r?\n/).length - 1,
			excerpt: clipped,
			score: found.score,
		});
	}
	hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "zh"));
	return { query: q, includeHistorical, hits: hits.slice(0, 5) };
}

async function readChecked(rel: unknown, env: KnowledgeConfig) {
	const root = await rootReal(env);
	const allow = allowList(env);
	const normal = normalizeRel(rel);
	if (!insideAllow(normal, allow)) throw new Error("该路径不在允许阅读的范围内");
	const parts = normal.split("/");
	let dir = root;
	for (let i = 0; i < parts.length; i++) {
		dir = join(dir, parts[i]);
		const stat = await lstat(dir).catch(() => null);
		if (!stat) throw new Error("找不到这篇笔记");
		if (stat.isSymbolicLink()) throw new Error("拒绝读取符号链接");
		const last = i === parts.length - 1;
		if (last && !stat.isFile()) throw new Error("只能阅读 Markdown 文件");
		if (!last && !stat.isDirectory()) throw new Error("找不到这篇笔记");
		if (last && stat.size > MAX_FILE_BYTES) throw new Error("笔记超过 256KB，请缩小阅读范围");
		if (sep === "\\" && dir.includes("..")) throw new Error("路径不能跳出知识库");
	}
	if (!dir.startsWith(root + sep) && dir !== root) throw new Error("路径不能跳出知识库");
	const stat = await lstat(dir);
	return {
		path: normal,
		status: normal === "AGENTS.md" ? "current" : classifyStatus(normal),
		revision: `${Math.trunc(stat.mtimeMs)}:${stat.size}`,
		text: await readFile(dir, "utf8"),
	};
}

export async function readKnowledge(rel: unknown, line = 1, env: KnowledgeConfig = {}) {
	const file = await readChecked(rel, env);
	const slice = sliceLines(file.text, Number(line) || 1);
	return {
		path: file.path,
		status: file.status,
		revision: file.revision,
		startLine: slice.startLine,
		endLine: slice.endLine,
		text: slice.text,
		truncated: slice.truncated,
	};
}
