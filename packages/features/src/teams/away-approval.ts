// 自动代回先保存不可变预览，再由本会话用户批准；工具参数不能自行扩展授权。
import type { Context } from "@earendil-works/chord";
import type { EntryRecord, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { splitUserContent } from "../attachments/index.js";
import { awayConfirmation, awayReplyIntent } from "./authorization.js";
export type AwayStatus = { status: string; reply: string; since: string; until: string; version: number };
export type AwayPort = {
	get(): AwayStatus | undefined;
	set(input: { status: string; reply: string; until: string }): void;
	clear(expected: AwayStatus): boolean;
};

const DRAFT = "assistant.teams-away-draft";
const APPROVAL = "assistant.teams-away-approval";
const STOP = "assistant.teams-away-stop";
const TTL = 30 * 60_000;
export const AWAY_SCOPE = "命中重要性规则的 Teams 私聊待处理消息（最近 24 小时内、尚未推送且未回复）；群聊不回；每个聊天在本次状态期间只回一次";
type Input = { status: string; reply: string; until: string };
type Draft = Input & { sourceEntryId: number; createdAt: number; scope: string };
type RecordedDraft = Draft & { id: number };
const object = (data: EntryRecord["data"]) => data !== null && typeof data === "object" && !Array.isArray(data) ? data : {};
async function history(tx: Tx, api: ToolExecutionApi) {
	// scanEntries 会包含分支祖先，不能继承另一个会话的授权。
	return (await tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, 100)).items
		.filter(entry => entry.conversationId === api.conversationId);
}
function userOf(entry: EntryRecord | undefined) {
	const message = entry?.model?.[0];
	return entry?.kind === "pi.user" && message?.role === "user" ? splitUserContent(message.content).text.trim() : "";
}
function latestUser(items: readonly EntryRecord[]) {
	const entry = items.find(item => item.kind === "pi.user");
	const text = userOf(entry);
	if (!entry || !text || /^[\[<「『“"‘']/.test(text)) throw new Error("没有可核对的用户原话；引用、附件和第三方消息不能授权自动代回。");
	return { id: entry.id, text };
}
function draftOf(entry: EntryRecord | undefined): RecordedDraft | undefined {
	if (!entry || entry.kind !== DRAFT) return;
	const data = object(entry.data);
	if (typeof data.status !== "string" || typeof data.reply !== "string" || typeof data.until !== "string"
		|| typeof data.sourceEntryId !== "number" || typeof data.createdAt !== "number" || data.scope !== AWAY_SCOPE) return;
	return { id: entry.id, status: data.status, reply: data.reply, until: data.until, sourceEntryId: data.sourceEntryId, createdAt: data.createdAt, scope: data.scope };
}
export const awayPreview = (draft: RecordedDraft) => [
	`自动回复草稿 ${draft.id}`,
	`状态：${draft.status}`,
	`范围：${draft.scope}`,
	`截止时间：${draft.until}（UTC；确认后不会顺延）`,
	`全文：\n${draft.reply}`,
].join("\n");
function shownBefore(items: readonly EntryRecord[], userId: number, draft: RecordedDraft) {
	return items.some(entry => entry.kind === "pi.assistant" && entry.id > draft.id && entry.id < userId
		&& entry.model?.some(message => {
			if (message.role !== "assistant") return false;
			if (Array.isArray(message.content) && message.content.some(part => part.type === "toolCall")) return false;
			return splitUserContent(message.content).text.includes(awayPreview(draft));
		}));
}

export async function prepareAwayReply(input: Input, api: ToolExecutionApi, context: Context) {
	return api.commit(async tx => {
		const items = await history(tx, api);
		const latest = latestUser(items);
		const intent = awayReplyIntent(latest.text);
		if (awayConfirmation(latest.text) !== null) throw new Error("用户正在确认已有草稿，请调用 confirm_away_reply 批准原编号，不要修改正文或有效期。");
		if (intent === "stop") throw new Error("用户要求停止自动代回，请调用 clear_away_reply；不能开启。");
		if (intent !== "enable") throw new Error("用户没有明确要求开启自动代回；询问、否定或仅提及关键词都不算开启请求。");
		const previous = draftOf(items.find(entry => entry.kind === DRAFT || entry.kind === STOP || entry.kind === APPROVAL));
		if (previous?.sourceEntryId === latest.id && previous.status === input.status && previous.reply === input.reply
			&& previous.until === input.until && Date.now() - previous.createdAt < TTL) return previous;
		const draft: Draft = { ...input, sourceEntryId: latest.id, createdAt: Date.now(), scope: AWAY_SCOPE };
		const entry = await tx.appendEntry(api.conversationId, { kind: DRAFT, data: draft });
		return { ...draft, id: entry.id };
	}, context);
}

export async function confirmAwayReply(draftId: number, port: AwayPort, api: ToolExecutionApi, context: Context) {
	const draft = await api.commit(async tx => {
		const items = await history(tx, api);
		const latest = latestUser(items);
		if (awayConfirmation(latest.text) !== draftId) throw new Error(`需要用户单独回复「确认开启自动回复 草稿 ${draftId}」；否定、提问或附加修改要求不授权。`);
		// 只批准最新的一版；停止和已经消费的确认都会使旧草稿失效。
		const draft = draftOf(items.find(entry => entry.kind === DRAFT || entry.kind === STOP || entry.kind === APPROVAL));
		if (!draft || draft.id !== draftId || draft.sourceEntryId >= latest.id) throw new Error("这份草稿已被替换、取消或批准，请重新提出开启请求并展示新草稿。");
		if (Date.now() - draft.createdAt >= TTL || Date.parse(draft.until) <= Date.now() || !Number.isFinite(Date.parse(draft.until))) throw new Error("草稿已超过 30 分钟或有效期已结束，请重新展示并确认。");
		if (items.some(entry => entry.id > draft.sourceEntryId && entry.id < latest.id
			&& ["stop", "decline", "enable"].includes(awayReplyIntent(userOf(entry))))) throw new Error("草稿之后用户已停止、否定或更改开启请求，请重新展示并确认。");
		if (!shownBefore(items, latest.id, draft)) throw new Error("确认前尚未完整展示这版草稿的范围、截止时间与全文，请原样展示后再确认。");
		await tx.appendEntry(api.conversationId, { kind: APPROVAL, data: { draftEntryId: draft.id, confirmationEntryId: latest.id } });
		return draft;
	}, context);
	// 先持久消费确认，故障不自动复用旧确认；重放不能重新开启或延长有效期。
	port.set({ status: draft.status, reply: draft.reply, until: draft.until });
	return draft;
}

const sameStatus = (left: AwayStatus, right: AwayStatus) => left.version === right.version && left.since === right.since
	&& left.status === right.status && left.reply === right.reply && left.until === right.until;
function stopTarget(data: EntryRecord["data"]): AwayStatus | null {
	const target = object(data).target;
	if (target === null) return null;
	if (typeof target !== "object" || Array.isArray(target) || !target || typeof target.version !== "number"
		|| typeof target.since !== "string" || typeof target.status !== "string" || typeof target.reply !== "string" || typeof target.until !== "string") {
		throw new Error("旧停止记录缺少目标版本，请用户重新发送停止指令，不能误停后来开启的设置。");
	}
	return { version: target.version, since: target.since, status: target.status, reply: target.reply, until: target.until };
}
export async function stopAwayReply(port: AwayPort, api: ToolExecutionApi, context: Context) {
	const target = await api.commit(async tx => {
		const items = await history(tx, api);
		const latest = latestUser(items);
		if (awayReplyIntent(latest.text) !== "stop") throw new Error("用户没有明确要求停止；询问状态、否定停止或第三方消息都不能改变设置。");
		const previous = items.find(entry => entry.kind === STOP && object(entry.data).sourceEntryId === latest.id);
		// STOP 是可恢复的停止意图，不是已经完成的标记；崩溃后继续处理原快照。
		if (previous) return stopTarget(previous.data);
		const target = port.get() ?? null;
		await tx.appendEntry(api.conversationId, { kind: STOP, data: { sourceEntryId: latest.id, target } });
		return target;
	}, context);
	const current = port.get();
	if (!current) return target ?? undefined;
	if (!target || !sameStatus(current, target)) throw new Error("本条停止指令已处理或目标已被新版替换，没有改变后来新开启的设置。");
	// 数据库 CAS 只关闭已授权的版本；旧停止重放不能影响后来新开的状态。
	if (!port.clear(target) && port.get()) throw new Error("目标状态已改变，没有停止新版本；如需停止当前状态，请用户重新发出指令。");
	return target;
}
