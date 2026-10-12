import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId, ConversationView, InboxState, LiveState, UsageState } from "@earendil-works/pi-durable";
import type { ViewEntry, ConversationView as ClientView } from "@assistant/contracts";
import { Index } from "@assistant/runtime";
import { Notes, Reminders, Delegations, BackgroundJobs, Parents, splitUserContent } from "@assistant/features";
import type { AppContext } from "./context.js";
export function createViews({ harness, ctx, taskGraph, redact }: AppContext) {
const contentText = (content: Message["content"] | undefined) =>
	typeof content === "string" ? content : (content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");

// 把 Harness 的视图压成前端要的样子
async function simplifyView(conversationId: ConversationId, value: ConversationView): Promise<ClientView> {
	const entries: ViewEntry[] = [];
	for (const entry of value.entries ?? []) {
		const message = entry.model?.[0];
		if (!message) continue;
		if (entry.kind === "pi.user" && message.role === "user") {
			const { text, attachments } = splitUserContent(message.content);
			for (const a of attachments) {
				if (a.kind === "image" && a.index !== undefined) a.url = `/api/conversations/${conversationId}/images/${entry.id}/${a.index}`;
			}
			entries.push({ id: entry.id, kind: "user", text, attachments });
		} else if (entry.kind === "pi.assistant" && message.role === "assistant") {
			const parts = Array.isArray(message.content) ? message.content : [];
			entries.push({
				id: entry.id,
				kind: "assistant",
				text: contentText(parts),
				toolCalls: parts.filter((p) => p.type === "toolCall").map((p) => ({ id: p.id, name: p.name, args: p.arguments })),
				error: message.stopReason === "error" ? redact(message.errorMessage || "模型调用失败") : undefined,
			});
		} else if (entry.kind === "pi.tool-result" && message.role === "toolResult") {
			entries.push({
				id: entry.id,
				kind: "tool",
				toolCallId: message.toolCallId,
				name: message.toolName,
				// 去掉 Harness 给错误结果包的 <harness> 标签，前端只显示人话
				text: contentText(message.content).replace(/<\/?harness>/g, "").replace(/^\s*\[error\]\s*/m, "").trim(),
				isError: Boolean(message.isError),
			});
		}
	}
	const live = (value.docs?.["pi.live"] ?? {}) as LiveState;
	const notes = await harness.snapshot(Notes, conversationId, ctx);
	const reminders = (await harness.snapshot(Reminders, conversationId, ctx))?.items ?? [];
	const subagents = (await harness.snapshot(Delegations, conversationId, ctx))?.items ?? [];
	const backgroundChildren = (await harness.snapshot(BackgroundJobs, conversationId, ctx))?.items ?? [];
	const children = (await harness.snapshot(Index, ctx))?.children ?? {};
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
