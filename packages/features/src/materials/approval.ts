// 资料批准只采用原生会话中的用户原话；路径由模型选择，授权和版本由代码核对。
import type { Context } from "@earendil-works/chord";
import type { EntryRecord, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { splitUserContent } from "../attachments/index.js";
import { approveMaterial, readDraftSnapshot, saveMaterial } from "./write.js";

const DRAFT = "assistant.material-draft";
const APPROVAL = "assistant.material-approval";
const HISTORY_LIMIT = 100;
type Draft = { root: string; path: string; version: string; title: string; content: string; sourceEntryId: number };
type RecordedDraft = Draft & { id: number };

const object = (data: EntryRecord["data"]) => data !== null && typeof data === "object" && !Array.isArray(data) ? data : {};
const clean = (text: string) => text.trim().replace(/[。.!！\s]+$/, "");
const confirmation = (text: string) => /^(?:确认入库|确认保存|确认|同意入库|入库|记下来)(?:[\s:：,，]+(.+))?$/.exec(clean(text));
function directive(text: string) {
	const match = /^(?:请(?:帮我)?|帮我|麻烦(?:帮我)?)?\s*(?:记入资料|保存资料|记下来)\s+([^：:\n]+?)\s*[：:]\s*([\s\S]+)$/.exec(text.trim());
	if (!match || /(?:先别|不要|暂不|这样记|这样写|可以吗|合适吗|[?？]\s*$)/.test(match[2])) return null;
	return { title: match[1].trim(), content: match[2].trim() };
}

async function history(tx: Tx, api: ToolExecutionApi) {
	// scanEntries 含分支祖先；授权必须属于当前实际会话，不能继承祖先确认。
	return (await tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, HISTORY_LIMIT)).items
		.filter(entry => entry.conversationId === api.conversationId);
}
function latestUser(items: readonly EntryRecord[]) {
	const entry = items.find(item => item.kind === "pi.user");
	const message = entry?.model?.[0];
	if (!entry || message?.role !== "user") throw new Error("没有可核对的当前用户消息，请用户直接说明资料要求。");
	const text = splitUserContent(message.content).text.trim();
	if (!text || text.startsWith("[") || text.startsWith("<")) throw new Error("附件、引用或第三方消息不构成资料批准，请用户直接确认。");
	return { id: entry.id, text };
}
function draftsOf(items: readonly EntryRecord[], root: string): RecordedDraft[] {
	const seen = new Set<string>();
	const out: RecordedDraft[] = [];
	for (const entry of items) {
		const data = object(entry.data);
		if (entry.kind !== DRAFT || data.root !== root || typeof data.path !== "string" || seen.has(data.path)) continue;
		seen.add(data.path);
		if (typeof data.version !== "string" || typeof data.title !== "string" || typeof data.content !== "string" || typeof data.sourceEntryId !== "number") continue;
		if (items.some(item => item.kind === APPROVAL && object(item.data).draftEntryId === entry.id)) continue;
		out.push({ id: entry.id, root, path: data.path, version: data.version, title: data.title, content: data.content, sourceEntryId: data.sourceEntryId });
	}
	return out;
}
function shownBefore(items: readonly EntryRecord[], userId: number, draft: RecordedDraft) {
	return items.some(entry => entry.kind === "pi.assistant" && entry.id > draft.id && entry.id < userId
		&& entry.model?.some(message => {
			if (message.role !== "assistant" || !Array.isArray(message.content) || message.content.some(part => part.type === "toolCall")) return false;
			const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
			return text.includes(draft.path) && text.includes(draft.title) && text.includes(draft.content);
		}));
}

export async function saveMaterialDraft(root: string, input: Parameters<typeof saveMaterial>[1], api: ToolExecutionApi, context: Context) {
	return api.commit(async tx => {
		const latest = latestUser(await history(tx, api));
		if (!directive(latest.text) && confirmation(latest.text)) throw new Error("用户正在确认已有资料，请直接批准原路径，不要重新保存或改写正文。");
		const path = await saveMaterial(root, input);
		const snapshot = await readDraftSnapshot(root, path);
		const title = /^# (.*)\n/.exec(snapshot.body)![1];
		const content = snapshot.body.split("\n\n").slice(2).join("\n\n").trimEnd();
		const draft: Draft = { root: snapshot.root, path, version: snapshot.version, title, content, sourceEntryId: latest.id };
		await tx.appendEntry(api.conversationId, { kind: DRAFT, data: draft });
		return { path, title, content, direct: directive(latest.text)?.title === title && directive(latest.text)?.content === content };
	}, context);
}

export async function approveMaterialDraft(root: string, path: string, api: ToolExecutionApi, context: Context) {
	const version = await api.commit(async tx => {
		const items = await history(tx, api);
		const latest = latestUser(items);
		if (items.some(entry => entry.kind === APPROVAL && object(entry.data).confirmationEntryId === latest.id)) {
			throw new Error("本条用户确认已消费，请勿重复批准或用它批准其他资料。");
		}
		const snapshot = await readDraftSnapshot(root, path);
		const pending = draftsOf(items, snapshot.root);
		const draft = pending.find(item => item.path === snapshot.path);
		if (!draft || draft.version !== snapshot.version) throw new Error("草稿缺少本会话版本记录或已被修改，请重新保存、展示并确认。");
		const direct = directive(latest.text);
		if (direct) {
			if (draft.sourceEntryId !== latest.id || direct.title !== draft.title || direct.content !== draft.content) throw new Error("用户口述的标题和完整原文与本版草稿不匹配，请展示资料等待确认。");
		} else {
			const confirm = confirmation(latest.text);
			if (!confirm || draft.sourceEntryId >= latest.id || !shownBefore(items, latest.id, draft)) throw new Error("没有匹配的用户确认或确认前的完整资料展示，请展示路径、标题和全文再等待确认。");
			const target = confirm[1]?.trim() ?? "";
			if (target && target !== draft.path && target !== draft.title) throw new Error("确认目标不匹配或带有附加要求，没有入库。");
			if (target !== draft.path) {
				const live = await Promise.all(pending.filter(item => !target || item.title === target).map(async item => {
					try { return (await readDraftSnapshot(root, item.path)).version === item.version; }
					catch { return false; } // 已删除或替换的版本不再是待确认候选。
				}));
				if (live.filter(Boolean).length !== 1) throw new Error(`存在多篇待确认资料，请回复「确认入库 ${draft.path}」指定这一篇。`);
			}
		}
		// 在 Session 串行提交线上先持久占用，再写文件；故障也不自动复用旧确认。
		await tx.appendEntry(api.conversationId, { kind: APPROVAL, data: {
			root: snapshot.root, path: draft.path, version: draft.version, draftEntryId: draft.id, confirmationEntryId: latest.id,
		} });
		return snapshot.version;
	}, context);
	return approveMaterial(root, path, version);
}
