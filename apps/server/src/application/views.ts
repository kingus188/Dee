import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId, ConversationView, InboxState, LiveState, UsageState } from "@earendil-works/pi-durable";
import type { ViewEntry, ConversationView as ClientView } from "@assistant/contracts";
import { Index } from "@assistant/runtime";
import { WechatState } from "@assistant/channel-wechat";
import { Notes, Reminders, Delegations, BackgroundJobs, Parents, splitUserContent, withQuote } from "@assistant/features";
import type { AppContext } from "./context.js";
import { enrichTeamsRecordView } from "../teams-records.js";
export function createViews({ harness, ctx, taskGraph, redact, teamsStore }: AppContext) {
const contentText = (content: Message["content"] | undefined) =>
	typeof content === "string" ? content : (content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");

// 把 Harness 的视图压成前端要的样子
async function simplifyView(conversationId: ConversationId, value: ConversationView): Promise<ClientView> {
	const entries: ViewEntry[] = [];
	for (const entry of value.entries ?? []) {
        if (entry.kind === "app.goal-report" && entry.data && typeof entry.data === "object" && "text" in entry.data && typeof entry.data.text === "string") {
          entries.push({ id: entry.id, kind: "assistant", text: entry.data.text });
          continue;
        }
		const message = entry.model?.[0];
		if (!message) continue;
		// Preserve recorded message time only; legacy entries must not inherit the current or conversation time.
		const time = Number.isFinite(message.timestamp) && Number.isFinite(new Date(message.timestamp).getTime())
			? { timestamp: message.timestamp } : {};
		if (entry.kind === "pi.user" && message.role === "user") {
			const split = splitUserContent(message.content);
			const { attachments } = split;
			for (const a of attachments) {
				if (a.kind === "image" && a.index !== undefined) a.url = `/api/conversations/${conversationId}/images/${entry.id}/${a.index}`;
			}
			entries.push({ id: entry.id, kind: "user", text: withQuote(split), attachments, ...time });
		} else if (entry.kind === "pi.assistant" && message.role === "assistant") {
			const parts = Array.isArray(message.content) ? message.content : [];
			entries.push({
				id: entry.id,
				kind: "assistant",
				...time,
				text: contentText(parts),
				toolCalls: parts.filter((p) => p.type === "toolCall").map((p) => ({ id: p.id, name: p.name, args: p.arguments })),
				error: message.stopReason === "error" ? redact(message.errorMessage || "模型调用失败") : undefined,
			});
		} else if (entry.kind === "pi.tool-result" && message.role === "toolResult") {
			entries.push({
				id: entry.id,
				kind: "tool",
				...time,
				toolCallId: message.toolCallId,
				name: message.toolName,
				// 去掉 Harness 给错误结果包的 <harness> 标签，前端只显示人话
        text: enrichTeamsRecordView(teamsStore.archive, message.toolName, contentText(message.content).replace(/<\/?harness>/g, "").replace(/^\s*\[error\]\s*/m, "").trim(),
          entries.flatMap(e => e.toolCalls ?? []).find(call => call.id === message.toolCallId)?.args, query => teamsStore.list(query)),
				isError: Boolean(message.isError),
			});
		}
	}
	const live = (value.docs?.["pi.live"] ?? {}) as LiveState;
	const notes = await harness.snapshot(Notes, conversationId, ctx);
	const reminders = (await harness.snapshot(Reminders, conversationId, ctx))?.items ?? [];
	const subagents = (await harness.snapshot(Delegations, conversationId, ctx))?.items ?? [];
	const backgroundChildren = (await harness.snapshot(BackgroundJobs, conversationId, ctx))?.items ?? [];
	const index = await harness.snapshot(Index, ctx);
	const children = index?.children ?? {};
	const wechat = await harness.snapshot(WechatState, ctx);
	// A binding still forwards assistant replies even if the legacy index lacks its source label.
	// Expose the source only: never include recipient IDs or credentials in the browser view.
	const wechatBound = Object.values(wechat?.bindings ?? {}).some(binding => Number(binding.conversationId) === Number(conversationId));
	const channel = wechatBound ? "wechat" : index?.items?.find(item => Number(item.id) === Number(conversationId))?.channel ?? "web";
	const v3Children = (await harness.snapshot(Parents, ctx))?.children ?? {};
	// 本会话和它派出的子会话里还活着的任务
	const mine = new Set([conversationId, ...subagents.map((a) => a.conversationId),
		...backgroundChildren.map((a) => a.conversationId).filter((id) => id != null)]);
	const tasks = Object.values(taskGraph.value?.tasks ?? {})
		.filter((t) => mine.has(t.conversationId))
		.map((t) => ({
			id: t.id,
			kind: t.kind,
			status: t.state.status,
			phase: "phase" in t.state ? t.state.phase : null,
			owner: t.owner ?? null,
			background: t.background,
			conversationId: t.conversationId,
			conversations: t.conversations,
		}));
	return {
		conversationId,
		channel,
		entries,
		live,
		busy: Object.keys(live).length > 0,
		inbox: (value.docs?.["pi.inbox"] as InboxState | undefined)?.items?.length ?? 0,
		notes: { todos: notes?.todos ?? [], memos: notes?.memos ?? [] },
		usage: (value.docs?.["pi.usage"] as UsageState | undefined) ?? null,
		tasks,
		reminders: [...reminders].sort((a, b) => a.at - b.at).map(({ id, text, at, status }) => ({ id, text, at, status })),
		subagents,
		parentId: children[conversationId] ?? v3Children[conversationId] ?? null,
	};
}


return { simplifyView };
}
