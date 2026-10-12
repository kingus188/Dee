import { AssistantEntry, configure, defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ConversationId, Extension } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { Index } from "@assistant/runtime";
import { resultText as text } from "../results.js";
export type Delegation = { conversationId: ConversationId; task: string; status: "running" | "done" };

export const Delegations = defineDoc<{ items: Delegation[] }>({
	kind: "app.delegations",
	version: 1,
	scope: "conversation",
	// 旧版文档未设置 history；必须保留 undefined 才能重新打开已有 SQLite 数据。
	history: undefined as unknown as "latest",
	fork: "initial",
	initial: () => ({ items: [] }),
});

export const Delegate: Extension = defineExtension({
	name: "delegate",
	tools: [
		defineTool({
			name: "delegate",
			description: "派一个子 Agent 独立完成一件事（比如调研一个网页），等它做完拿回结果。适合可以单独完成、步骤较多的任务",
			parameters: Type.Object({ task: Type.String({ description: "交给子 Agent 的完整任务说明" }) }),
			replay: "safe",
			execute: async (args, api, callContext) => {
				const childId = await api.commit(async (tx) => {
					// 重放时找回已经建过的子会话，不会重复建
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					await configure(tx, created.id, {
						extensions: { remove: [Delegate] },
						instructions: "你是主 Agent 派出的子 Agent，只负责完成交给你的这一件事，完成后用简短中文汇报结果。",
					});
					(await tx.doc(Delegations, api.conversationId)).items.push({ conversationId: created.id, task: args.task, status: "running" });
					const index = await tx.doc(Index);
					index.children ??= {};
					index.children[created.id] = api.conversationId;
					return created.id;
				}, callContext);
				await api.details({ conversationId: childId }, callContext);
				const child = await api.conversation(childId, callContext);
				const submission = await child!.submit({ type: "input", content: args.task, requestId: `delegate:${api.taskId}` }, callContext);
				const settled = await submission.wait(callContext);
				const answer = await api.commit(async (tx) => {
					const item = (await tx.doc(Delegations, api.conversationId)).items.find((i) => i.conversationId === childId);
					if (item) item.status = "done";
					if (settled.status !== "done" || settled.type !== "input") return `子 Agent 没有完成：${("reason" in settled ? settled.reason : undefined) ?? settled.status}`;
					const content = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0]?.content ?? [];
					return (typeof content === "string" ? content : content.filter((c) => c.type === "text").map((c) => c.text).join("")) || "子 Agent 完成了，但没有文字结果";
				}, callContext);
				return text(answer);
			},
		}),
	],
});
