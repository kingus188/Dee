// 生产资料目录的读取与路径校验：Markdown 文件，不跟随符号链接，不跳出目录。
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { classifyStatus, normalizeRel, sliceLines } from "../knowledge/index.js";

const MAX_FILES = 600;
export const MAX_FILE_BYTES = 256 * 1024;
export const STALE_DAYS = 180;
const CACHE_MS = 5000;

export type Status = "current" | "archived" | "draft";
export type MaterialFile = { path: string; status: Status; modifiedAt: number; text: string };
let cache: { root: string; at: number; files: MaterialFile[] } | null = null;

export function clearMaterialsCache() {
	cache = null;
}

// 「待确认」是 agent 提议、尚未被用户认可的资料，按草稿处理。
export const statusOf = (rel: string): Status => (rel.split("/").some((part) => part === "待确认") ? "draft" : classifyStatus(rel));

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

// 解析资料目录内的相对路径：已存在的每一级都不能是符号链接，结果不能跳出资料目录。
export async function resolveInside(root: string, rel: unknown) {
	const real = await realpath(root).catch(() => null);
	if (!real) throw new Error("生产资料目录不存在");
	const normal = normalizeRel(rel);
	let current = real;
	for (const part of normal.split("/")) {
		current = join(current, part);
		const stat = await lstat(current).catch(() => null);
		if (stat?.isSymbolicLink()) throw new Error("拒绝读取符号链接");
	}
	if (!current.startsWith(real + sep)) throw new Error("路径不能跳出资料目录");
	return { path: normal, absolute: current };
}

export async function readMaterial(root: string, rel: unknown, line = 1) {
	const { path, absolute } = await resolveInside(root, rel);
	const stat = await lstat(absolute).catch(() => null);
	if (!stat) throw new Error("找不到这篇资料");
	if (!stat.isFile() || !path.endsWith(".md")) throw new Error("只能阅读 Markdown 文件");
	if (stat.size > MAX_FILE_BYTES) throw new Error("资料超过 256KB，请拆分后再读");
	const slice = sliceLines(await readFile(absolute, "utf8"), Number(line) || 1);
	return { path, status: statusOf(path), modifiedAt: stat.mtimeMs, ...slice };
}

