import type { Context } from "@earendil-works/chord";
import type { ConversationId, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { defineDoc, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { resultText as text } from "../results.js";
import { EditConflictError } from "../errors.js";
export type EditableNotes = { todos: { text: string; done: boolean }[]; memos: string[] };
export type NotesState = { todos: { text: string; done: boolean }[]; memos: string[]; applied: Record<string, string> };
export const Notes = defineDoc<NotesState>({
	kind: "app.notes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ todos: [], memos: [], applied: {} }),
});

export function normalizeNotes(input: unknown): EditableNotes {
	if (!input || typeof input !== "object" || !("todos" in input) || !("memos" in input) || !Array.isArray(input.todos) || !Array.isArray(input.memos)) {
		throw new Error("笔记必须包含 todos 和 memos 数组");
	}
	if (input.todos.length + input.memos.length > 1000) throw new Error("笔记最多 1000 条");
	let chars = 0;
	const checkedText = (value: unknown) => {
		if (typeof value !== "string" || value.length > 16000) throw new Error("笔记每条必须是不超过 16000 字的字符串");
		chars += value.length;
		if (chars > 128000) throw new Error("笔记总正文不能超过 128000 字");
		return value;
	};
	const todos = input.todos.map((item: unknown) => {
		if (!item || typeof item !== "object" || !("text" in item) || !("done" in item) || typeof item.done !== "boolean") throw new Error("待办必须包含文本和布尔完成状态");
		return { text: checkedText(item.text), done: item.done };
	});
	return { todos, memos: input.memos.map(checkedText) };
}

export async function editNotesInTx(tx: Tx, conversationId: ConversationId, input: unknown, base: unknown) {
	const notes = normalizeNotes(input), expected = normalizeNotes(base);
	if (notes.todos.length) throw new Error("待办已迁移到全局 Daylight，请在任务看板中编辑");
	const current = await tx.doc(Notes, conversationId);
	if (current.todos.length !== expected.todos.length || current.memos.length !== expected.memos.length
		|| current.todos.some((item, index) => item.text !== expected.todos[index].text || item.done !== expected.todos[index].done)
		|| current.memos.some((item, index) => item !== expected.memos[index])) throw new EditConflictError("笔记已被其他页面或助手修改，请重新载入后再保存");
	current.todos = notes.todos;
	current.memos = notes.memos;
	return notes;
}

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
