import type { ConversationId, Tx } from "@earendil-works/pi-durable";
// 跨会话记忆和技能。模型只能提交候选，用户批准后才进入提示。
import { randomUUID } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { normalizeRequestId } from "../tasks/parameters.js";

import { detach } from "../results.js";

const MEMORY_ITEM_MAX = 280;
const MEMORY_APPROVED_MAX = 30;
const MEMORY_PENDING_MAX = 40;
const MEMORY_PROMPT_CHARS = 1800;
const SKILL_NAME_MAX = 40;
const SKILL_DESC_MAX = 180;
const SKILL_BODY_MAX = 4000;
const SKILL_APPROVED_MAX = 20;
const SKILL_PENDING_MAX = 20;

type Decision = { id: string; status: "pending" | "approved" | "rejected"; source: "user" | "agent"; conversationId: ConversationId | null; createdAt: number; decidedAt: number | null };
export type MemoryItem = Decision & { text: string };
export type SkillItem = Decision & { name: string; description: string; body: string };
type DecisionDoc<T> = { items: T[]; applied: Record<string, string> };
type Proposal = { requestId?: unknown; source?: string; approved?: boolean; conversationId?: ConversationId | null };

export const MemoryDoc = defineDoc<DecisionDoc<MemoryItem>>({
	kind: "app.memory",
	version: 1,
	scope: "session",
	initial: () => ({ items: [], applied: {} }),
});

export const SkillsDoc = defineDoc<DecisionDoc<SkillItem>>({
	kind: "app.skills",
	version: 1,
	scope: "session",
	initial: () => ({ items: [], applied: {} }),
});

export function normalizeMemoryText(value: unknown) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	if (!text || text.length > MEMORY_ITEM_MAX) throw new Error(`记忆必须是 1～${MEMORY_ITEM_MAX} 字`);
	return text;
}

export function normalizeSkill(input: { name?: unknown; description?: unknown; body?: unknown } | null) {
	const name = String(input?.name ?? "").trim();
	const description = String(input?.description ?? "").trim();
	const body = String(input?.body ?? "").trim();
	if (!name || name.length > SKILL_NAME_MAX || /[/\n\r]/.test(name)) throw new Error(`技能名称必须是 1～${SKILL_NAME_MAX} 字，且不能包含斜杠`);
	if (!description || description.length > SKILL_DESC_MAX) throw new Error(`技能说明必须是 1～${SKILL_DESC_MAX} 字`);
	if (!body || body.length > SKILL_BODY_MAX) throw new Error(`技能正文必须是 1～${SKILL_BODY_MAX} 字`);
	return { name, description, body };
}

export function selectMemoryForPrompt<T extends { status: string; text: string }>(items: readonly T[] | undefined, budget = MEMORY_PROMPT_CHARS) {
	const approved = (items ?? []).filter((item) => item.status === "approved");
	const chosen = [];
	let used = 0;
	for (const item of [...approved].reverse()) {
		if (used + item.text.length > budget) continue;
		chosen.push(item);
		used += item.text.length;
	}
	return chosen.reverse();
}

function count(doc: { items: { status: string }[] }, status: string) {
	return doc.items.filter((item) => item.status === status).length;
}

function findApplied<T extends { id: string }>(doc: DecisionDoc<T>, requestId: string | null) {
	if (!requestId || !Object.hasOwn(doc.applied, requestId)) return null;
	return doc.items.find((item) => item.id === doc.applied[requestId]) ?? null;
}

export async function proposeMemoryInTx(tx: Tx, input: Proposal & { text?: unknown }) {
	const requestId = normalizeRequestId(input.requestId);
	const doc = await tx.doc(MemoryDoc);
	const previous = findApplied(doc, requestId);
	if (previous) return detach(previous);
	const text = normalizeMemoryText(input.text);
	const status = input.approved ? "approved" : "pending";
	if (status === "pending" && count(doc, "pending") >= MEMORY_PENDING_MAX) throw new Error("待确认记忆已满，请先处理");
	if (status === "approved" && count(doc, "approved") >= MEMORY_APPROVED_MAX) throw new Error("已确认记忆已满，请先撤回一些");
	const now = Date.now();
	const item: MemoryItem = {
		id: randomUUID(),
		text,
		status,
		source: input.source === "user" ? "user" : "agent",
		conversationId: input.conversationId ?? null,
		createdAt: now,
		decidedAt: status === "approved" ? now : null,
	};
	doc.items.push(item);
	if (requestId) doc.applied[requestId] = item.id;
	return detach(item);
}

export async function decideMemoryInTx(tx: Tx, id: string, action: string) {
	const doc = await tx.doc(MemoryDoc);
	const item = doc.items.find((entry) => entry.id === id);
	if (!item) throw new Error("记忆不存在");
	const next = action === "approve" ? "approved" : "rejected";
	if (item.status === next) return detach(item);
	if (next === "approved" && item.status !== "approved" && count(doc, "approved") >= MEMORY_APPROVED_MAX) {
		throw new Error("已确认记忆已满，请先撤回一些");
	}
	item.status = next;
	item.decidedAt = Date.now();
	return detach(item);
}

export async function proposeSkillInTx(tx: Tx, input: Proposal & { name?: unknown; description?: unknown; body?: unknown }) {
	const requestId = normalizeRequestId(input.requestId);
	const doc = await tx.doc(SkillsDoc);
	const previous = findApplied(doc, requestId);
	if (previous) return detach(previous);
	const skill = normalizeSkill(input);
	if (doc.items.some((item) => item.name === skill.name && item.status !== "rejected")) {
		throw new Error("已有同名技能");
	}
	const status = input.approved ? "approved" : "pending";
	if (status === "pending" && count(doc, "pending") >= SKILL_PENDING_MAX) throw new Error("待确认技能已满，请先处理");
	if (status === "approved" && count(doc, "approved") >= SKILL_APPROVED_MAX) throw new Error("已确认技能已满，请先撤回一些");
	const now = Date.now();
	const item: SkillItem = {
		id: randomUUID(),
		...skill,
		status,
		source: input.source === "user" ? "user" : "agent",
		conversationId: input.conversationId ?? null,
		createdAt: now,
		decidedAt: status === "approved" ? now : null,
	};
	doc.items.push(item);
	if (requestId) doc.applied[requestId] = item.id;
	return detach(item);
}

export async function decideSkillInTx(tx: Tx, id: string, action: string) {
	const doc = await tx.doc(SkillsDoc);
	const item = doc.items.find((entry) => entry.id === id);
	if (!item) throw new Error("技能不存在");
	const next = action === "approve" ? "approved" : "rejected";
	if (item.status === next) return detach(item);
	if (next === "approved") {
		if (doc.items.some((entry) => entry.id !== item.id && entry.name === item.name && entry.status === "approved")) {
			throw new Error("已有同名技能");
		}
		if (count(doc, "approved") >= SKILL_APPROVED_MAX) throw new Error("已确认技能已满，请先撤回一些");
	}
	item.status = next;
	item.decidedAt = Date.now();
	return detach(item);
}

export function publicMemory(doc: { items: readonly MemoryItem[] } | undefined) {
	return (doc?.items ?? []).map(({ id, text, status, source, createdAt, decidedAt }) => ({ id, text, status, source, createdAt, decidedAt }));
}

export function publicSkills(doc: { items: readonly SkillItem[] } | undefined) {
	return (doc?.items ?? []).map(({ id, name, description, body, status, source, createdAt, decidedAt }) => ({
		id, name, description, body, status, source, createdAt, decidedAt,
	}));
}

export function personalError(error: unknown): error is Error {
	return /记忆|技能|requestId|路径|笔记|知识库|OBSIDIAN|符号链接|阅读|检索|跳出/.test(error instanceof Error ? error.message : "");
}
