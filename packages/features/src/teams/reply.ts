// 向 Teams 回复：模型只能选择草稿，发送授权由代码核对用户原话。
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { splitUserContent } from "../attachments/index.js";
import { hasSecret } from "../personal/service.js";
import { resultText } from "../results.js";
import { chatName, explicitlyTargets, parseConfirmation, parseSendDirective, sameName } from "./authorization.js";
export { parseConfirmation } from "./authorization.js";

const TEXT_MAX = 2000;
export const DRAFT_TTL_MS = 30 * 60_000;
export type TeamsChatRef = { chatId: string; label: string };
// 老草稿没有 sourceEntryId，不能沿用新版授权，需重新起草。
export type TeamsDraft = TeamsChatRef & { id: number; text: string; explicit: boolean; sourceEntryId: number | null };
export type TeamsDraftInput = Omit<TeamsDraft, "id" | "sourceEntryId"> & { conversationId: number; sourceEntryId: number };
export type TeamsReplyPort = {
	findChats(name: string): TeamsChatRef[];
	saveDraft(draft: TeamsDraftInput): number;
	alreadyReplied(chatId: string): { text: string; at: string } | undefined;
	pendingDrafts(conversationId: number, maxAgeMs: number): TeamsDraft[];
	// 同时校验会话、有效期和最新版本，原子占用，防止重放或检查后被替换。
	claim(id: number, conversationId: number, maxAgeMs: number): boolean;
	release(id: number): void;
	send: ((chatId: string, text: string) => Promise<void>) | undefined;
};
export type ReplyInput = { id: number; text: string; shownDraftIds: readonly number[] };
export type SendOutcome = { sent: true; label: string } | { sent: false; reason: string };

export async function sendDraft(port: TeamsReplyPort, conversationId: number, draftId: number, latest: ReplyInput): Promise<SendOutcome> {
	if (!port.send) return { sent: false, reason: "未启用 Teams 发送" };
	if (latest.text.trim().startsWith("[")) return { sent: false, reason: "引用或第三方消息不能作为发送授权，请用户单独发出指令。" };
	const pending = port.pendingDrafts(conversationId, DRAFT_TTL_MS);
	const draft = pending.find(item => item.id === draftId);
	if (!draft) return { sent: false, reason: "草稿已发送、被新版本替代或超过 30 分钟，请勿改发其他旧稿。" };
	if (draft.sourceEntryId === null) return { sent: false, reason: "旧草稿缺少授权来源，请重新起草并展示。" };
	const name = chatName(draft.label);
	const directive = parseSendDirective(latest.text);
	const confirmation = directive ? null : parseConfirmation(latest.text);
	if (confirmation) {
		if (draft.sourceEntryId >= latest.id || !latest.shownDraftIds.includes(draft.id)) {
			return { sent: false, reason: "本次确认之前尚未展示这版草稿。请展示目标和全文，不能在确认后修改收件人或正文再发送。" };
		}
		const byId = confirmation.rest === `草稿 ${draft.id}`;
		const byName = sameName(confirmation.rest, name);
		if (!byId && !byName && confirmation.rest !== "") return { sent: false, reason: "确认语中的目标不匹配或带有附加要求，没有发送。" };
		if (!byId && (byName ? pending.filter(item => sameName(chatName(item.label), name)).length !== 1 : pending.length !== 1)) {
			return { sent: false, reason: `有多份待发送草稿，请展示目标和全文，让用户回复「确认发送 草稿 ${draft.id}」以指定这一份。` };
		}
		if (!byId && !byName && !draft.explicit) {
			return { sent: false, reason: `目标来自上下文推断，需要用户回复「确认发送 ${name}」或「确认发送 草稿 ${draft.id}」明确目标。` };
		}
	} else {
		if (!directive || !sameName(directive.name, name) || directive.text !== draft.text || draft.sourceEntryId !== latest.id) {
			return { sent: false, reason: "没有匹配的明确发送指令。请展示草稿等待确认；拟稿、讨论、否定或仅提及姓名和原文不算授权。" };
		}
		const targets = port.findChats(directive.name);
		if (targets.length !== 1 || targets[0].chatId !== draft.chatId) return { sent: false, reason: "收件人不能唯一确定，请先明确目标聊天。" };
	}
	if (!port.claim(draft.id, conversationId, DRAFT_TTL_MS)) return { sent: false, reason: "草稿已占用、发送、过期或被替换，没有重复发送。" };
	try {
		await port.send(draft.chatId, draft.text);
		return { sent: true, label: draft.label };
	} catch (error) {
		port.release(draft.id);
		return { sent: false, reason: `发送失败：${error instanceof Error ? error.message : String(error)}。草稿仍保留，可稍后再发。` };
	}
}

type TranscriptEntry = { id: number; kind: string; model?: readonly { role: string; content: unknown }[] };
export const latestUserTextOf = (items: readonly Omit<TranscriptEntry, "id">[]) => {
	const message = items.find(item => item.kind === "pi.user")?.model?.[0];
	return message?.role === "user" ? splitUserContent(message.content as never).text : "";
};

// 只把已提交的助手正文算作展示；工具结果、附件、第三方引用均不算用户看过草稿。
export function replyInputOf(items: readonly TranscriptEntry[], drafts: readonly TeamsDraft[] = []): ReplyInput {
	const userIndex = items.findIndex(item => item.kind === "pi.user");
	const id = items[userIndex]?.id ?? 0;
	const shownDraftIds = drafts.filter(draft => draft.sourceEntryId !== null && items.slice(userIndex + 1).some(entry => {
		if (entry.kind !== "pi.assistant" || entry.id <= draft.sourceEntryId!) return false;
		return entry.model?.some(message => {
			if (message.role !== "assistant") return false;
			const content = message.content;
			if (Array.isArray(content) && content.some(part => part.type === "toolCall")) return false;
			const text = splitUserContent(content as never).text;
			return text.includes(`草稿 ${draft.id}`) && text.includes(draft.label) && text.includes(draft.text);
		});
	})).map(draft => draft.id);
	return { id, text: latestUserTextOf(items), shownDraftIds };
}

export function createTeamsReply(port: TeamsReplyPort) {
	return defineExtension({
		name: "teams-reply",
		tools: [
			defineTool({
				name: "draft_teams_reply",
				replay: "safe",
				description: "保存 Teams 回复草稿，不发送。chat 是能唯一匹配的群名或私聊姓名。明确的「回复 姓名：原文」可保存后立即发送；拟稿或引用消息只能展示草稿。确认已有草稿时不要重新起草。",
				parameters: Type.Object({ chat: Type.String(), text: Type.String({ description: "纯文本回复内容，最多 2000 字" }) }),
				execute: async (args, api, context) => {
					const text = args.text.trim();
					if (!text || text.length > TEXT_MAX) return resultText(`回复内容必须是 1～${TEXT_MAX} 字。`);
					if (hasSecret(text)) return resultText("回复里不能包含密码、密钥或令牌，已拒绝。");
					const chats = port.findChats(args.chat.trim());
					if (!chats.length) return resultText(`没有找到名为「${args.chat}」的 Teams 聊天。`);
					if (chats.length > 1) return resultText(`「${args.chat}」对应多个聊天，请让用户指明是哪一个：${chats.map(chat => chat.label).join("、")}`);
					const [chat] = chats;
					const latest = await api.commit(async tx => replyInputOf((await tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, 100)).items), context);
					if (!latest.id) return resultText("没有可核对的用户消息，不能起草。");
					if (!parseSendDirective(latest.text) && parseConfirmation(latest.text)) return resultText("用户正在确认已有草稿，请用原草稿 ID 调用 send_teams_reply，不要重新起草或改写正文。");
					const name = chatName(chat.label);
					const explicit = explicitlyTargets(latest.text, name);
					const id = port.saveDraft({ ...chat, conversationId: api.conversationId, text, explicit, sourceEntryId: latest.id });
					const directive = parseSendDirective(latest.text);
					const direct = directive && sameName(directive.name, name) && directive.text === text;
					const replied = port.alreadyReplied(chat.chatId);
					return resultText([
						`草稿 ${id} 已保存，尚未发送。目标：${chat.label}。`,
						direct ? `用户已明确指定目标与完整原文，立即调用 send_teams_reply({draftId:${id}})，无需再确认。`
							: `请原样展示「草稿 ${id}」、目标「${chat.label}」和下面的全文。${explicit ? "只有这一份待发草稿时可回复「发吧」。" : `目标是推断的，需要回复「确认发送 ${name}」明确目标。`}有多份草稿时回复「确认发送 草稿 ${id}」。确认后直接发送此 ID，不再起草。`,
						replied ? `注意：用户已于 ${replied.at.slice(11, 16)}（UTC）自己回复过「${replied.text.slice(0, 30)}」，请提醒用户避免重复发送。` : "",
						`全文：\n${text}`,
					].filter(Boolean).join("\n"));
				},
			}),
			defineTool({
				name: "send_teams_reply",
				replay: "unsafe",
				description: "发送指定 ID 的 Teams 草稿，不能改目标或正文。用户明确「回复 姓名：原文」可直接发送；否则只能发送确认前已展示的草稿。多份草稿或推断目标需姓名/草稿 ID 消歧。代码校验授权、版本、有效期与防重。",
				parameters: Type.Object({ draftId: Type.Integer({ minimum: 1, description: "draft_teams_reply 返回的草稿 ID" }) }),
				execute: async (args, api, context) => {
					const latest = await api.commit(async tx => replyInputOf(
						(await tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, 100)).items,
						port.pendingDrafts(api.conversationId, DRAFT_TTL_MS),
					), context);
					const outcome = await sendDraft(port, api.conversationId, args.draftId, latest);
					return resultText(outcome.sent ? `已发送到 ${outcome.label}。` : `未发送：${outcome.reason}`);
				},
			}),
		],
	});
}
