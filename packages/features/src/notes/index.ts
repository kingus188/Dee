import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { defineDoc, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { resultText as text } from "../results.js";
export type NotesState = { todos: { text: string; done: boolean }[]; memos: string[]; applied: Record<string, string> };
export const Notes = defineDoc<NotesState>({
	kind: "app.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ todos: [], memos: [], applied: {} }),
});

async function applyOnce(api: ToolExecutionApi, callContext: Context, change: (notes: NotesState) => string) {
	return api.commit(async (tx) => {
		const notes = await tx.doc(Notes, api.conversationId);
		notes.applied ??= {};
		if (api.callId in notes.applied) return notes.applied[api.callId];
		const result = change(notes);
		notes.applied[api.callId] = result;
		return result;
	}, callContext);
}

export const todo = defineTool({
	name: "todo",
	description: "维护待办：add 新增一条，done 把匹配的一条标记完成",
	parameters: Type.Object({ action: Type.Union([Type.Literal("add"), Type.Literal("done")]), text: Type.String() }),
	replay: "safe",
	execute: async (args, api, callContext) => {
		const result = await applyOnce(api, callContext, (notes) => {
			if (args.action === "add") {
				notes.todos.push({ text: args.text, done: false });
				return `已添加：${args.text}`;
			}
			const item = notes.todos.find((t) => !t.done && t.text === args.text) ?? notes.todos.find((t) => !t.done && t.text.includes(args.text));
			if (!item) return `没找到待办：${args.text}`;
			item.done = true;
			return `已完成：${item.text}`;
		});
		return text(result);
	},
});

export const memo = defineTool({
	name: "memo",
	description: "记在当前会话的备忘。不会带到别的会话；跨会话事实请用 propose_memory，并等用户批准",
	parameters: Type.Object({ text: Type.String() }),
	replay: "safe",
	execute: async (args, api, callContext) => {
		const result = await applyOnce(api, callContext, (notes) => {
			notes.memos.push(args.text);
			return `已记下：${args.text}`;
		});
		return text(result);
	},
});
