import test from "node:test";
import assert from "node:assert/strict";
import { createDaylight, editNotesInTx, migrateLegacyTodos, Notes } from "@assistant/features";
import type { NotesState } from "@assistant/features";
import type { DaylightPort, DaylightProject, DaylightSnapshot } from "@assistant/contracts";
import type { ConversationId, Cursor, Extension, Harness, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

function fixture() {
	const state: DaylightSnapshot = { projects: [], tasks: [] };
	const applied = new Map<string, unknown>();
	const imports: number[] = [];
	let replaying = false;
	const transaction: DaylightPort = {
		snapshot: async () => structuredClone(state),
		getTask: async (id: string) => { const task = state.tasks.find(item => item.id === id); if (!task) throw new Error("任务已不存在"); return structuredClone(task); },
		saveProject: async project => { const index = state.projects.findIndex(item => item.id === project.id); if (index < 0) state.projects.push(project); else state.projects[index] = project; },
		saveTask: async task => { const index = state.tasks.findIndex(item => item.id === task.id); if (index < 0) state.tasks.push(task); else state.tasks[index] = task; },
		patchTask: async (id, patch) => { const task = { ...await transaction.getTask(id), ...patch }; await transaction.saveTask(task); return structuredClone(task); },
		moveTask: async (id, status, position) => { await transaction.patchTask(id, { status, ...(position === undefined ? {} : { position }) }); },
		deleteTask: async (id: string) => { state.tasks = state.tasks.filter(task => task.id !== id); },
		deleteProject: async (id: string) => { state.projects = state.projects.filter(project => project.id !== id); state.tasks = state.tasks.filter(task => task.projectId !== id); },
		ensureDefaultProject: async () => { const project: DaylightProject = { id: "00000000-0000-5000-8000-000000000001", name: "收件箱", description: "", color: "lavender" }; const found = state.projects.find(item => item.id === project.id); if (found) return found; await transaction.saveProject(project); return project; },
		replayAction: async <T>(key: string, action: (port: DaylightPort) => Promise<T>): Promise<T> => {
			if (applied.has(key)) return structuredClone(applied.get(key)) as T;
			const before = structuredClone(state);
			replaying = true;
			try { const value = await action(transaction); applied.set(key, structuredClone(value)); return value; }
			catch (error) { Object.assign(state, before); throw error; }
			finally { replaying = false; }
		},
		importLegacy: async id => { imports.push(id); return { projects: 1, tasks: 1 }; },
	};
	// Root access during replay would escape the database transaction in production.
	const port = new Proxy(transaction, { get(target, key, receiver) {
		const method = Reflect.get(target, key, receiver);
		return typeof method === "function" ? (...args: unknown[]) => { assert.equal(replaying, false, "tool must use its transaction-bound port"); return Reflect.apply(method, target, args); } : method;
	} });
	async function invoke(name: string, args: Record<string, unknown>, callId: string = crypto.randomUUID(), extension: Extension = createDaylight(port)) {
		const tool = extension.tools!.find(item => item.name === name);
		assert.ok(tool, name);
		// These tools only read callId; the runtime normally supplies the remaining API.
		const api = { callId, conversationId: 7 } as unknown as ToolExecutionApi;
		const result = await tool.execute(args, api, BACKGROUND_CONTEXT);
		return (result.output ?? []).map(part => part.type === "text" ? part.text : "").join("");
	}
	return { state, port, invoke, imports };
}

test("source MCP tool names, global project/task CRUD and partial updates", async () => {
	const { invoke, state } = fixture();
	const project = JSON.parse(await invoke("create_project", { name: "工作" }));
	const task = JSON.parse(await invoke("create_task", { projectId: project.id, title: "首项", description: "notes", checklist: [{ id: "one", title: "检查", done: false }] }));
	assert.equal(task.status, "todo");
	assert.equal(task.priority, "medium");
	assert.equal(task.color, "lavender");
	await invoke("update_task", { id: task.id, changes: { priority: "high", dueDate: null } });
	assert.equal(state.tasks[0].description, "notes");
	await invoke("mark_task", { id: task.id, status: "done" });
	assert.equal(state.tasks[0].checklist[0].done, false);
	await invoke("mark_checklist_item", { id: task.id, itemId: "one", done: true });
	assert.equal(state.tasks[0].status, "done");
	assert.equal(JSON.parse(await invoke("get_task", { id: task.id })).checklist[0].done, true);
	await invoke("update_project", { id: project.id, changes: { name: "生活" } });
	assert.equal(JSON.parse(await invoke("list_projects", {})).projects[0].name, "生活");
	await invoke("delete_task", { id: task.id });
	assert.equal(state.tasks.length, 0);
	await invoke("delete_project", { id: project.id });
	assert.equal(state.projects.length, 0);
});

test("list_tasks searches notes/tags and returns source-compatible summaries and paging", async () => {
	const { invoke, port } = fixture();
	const project = await port.ensureDefaultProject();
	for (const title of ["a", "b"]) await invoke("create_task", { projectId: project.id, title, description: "UNIQUE", tags: ["tag"] });
	const page = JSON.parse(await invoke("list_tasks", { query: "unique", status: "todo", projectId: project.id, limit: 1 }));
	assert.equal(page.tasks.length, 1);
	assert.equal(page.nextOffset, 1);
	assert.equal("description" in page.tasks[0], false);
	assert.equal("checklist" in page.tasks[0], false);
	assert.equal(JSON.parse(await invoke("list_tasks", { query: "missing" })).nextOffset, null);
});

test("callId replay survives extension recreation and preserves saved results", async () => {
	const { invoke, state, port } = fixture();
	const project = await port.ensureDefaultProject();
	const first = await invoke("create_task", { projectId: project.id, title: "one" }, "create-call");
	const id = JSON.parse(first).id;
	await invoke("update_task", { id, changes: { title: "edited" } });
	assert.equal(await invoke("create_task", { projectId: project.id, title: "one" }, "create-call", createDaylight(port)), first);
	assert.equal(state.tasks.length, 1);
	assert.equal(state.tasks[0].title, "edited");
});

test("legacy todo tool now reads/writes global Daylight tasks only", async () => {
	const { invoke, state } = fixture();
	await invoke("todo", { action: "add", text: "shared" }, "add");
	await invoke("todo", { action: "add", text: "shared" }, "add");
	assert.equal(state.tasks.length, 1);
	assert.equal(await invoke("todo", { action: "done", text: "share" }, "done"), "已完成：shared");
	assert.equal(state.tasks[0].status, "done");
	assert.equal(await invoke("todo", { action: "done", text: "share" }, "done"), "已完成：shared");
});

test("invalid task patches cannot touch identity and missing checklist items fail", async () => {
	const { invoke, port } = fixture();
	const project = await port.ensureDefaultProject();
	const task = JSON.parse(await invoke("create_task", { projectId: project.id, title: "one" }));
	await assert.rejects(invoke("update_task", { id: task.id, changes: { id: "other" } }), /字段/);
	await assert.rejects(invoke("update_task", { id: task.id, changes: {} }), /字段/);
	await assert.rejects(invoke("mark_checklist_item", { id: task.id, itemId: "missing", done: true }), /子任务/);
});

test("migration pages the actual transaction index and clears only after successful import", async () => {
	const { port, imports } = fixture();
	const notes = new Map<number, NotesState>([[7, { todos: [{ text: "legacy", done: true }], memos: ["keep"], applied: { old: "result" } }], [8, { todos: [{ text: "child", done: false }], memos: [], applied: {} }]]);
	const cursors: (Cursor | undefined)[] = [];
	// The migration only uses the typed transaction's scan and doc surfaces.
	const tx = {
		scanConversations: async (_query: unknown, limit: number, cursor?: Cursor) => { assert.equal(limit, 100); cursors.push(cursor); return cursor ? { items: [{ id: 8 }] } : { items: [{ id: 7 }], next: { after: 7 } }; },
		doc: async (token: unknown, id: number) => { assert.equal(token, Notes); return notes.get(id); },
	} as unknown as Tx;
	const harness: Pick<Harness, "commit"> = { commit: async fn => fn(tx) };
	await migrateLegacyTodos(harness, port, BACKGROUND_CONTEXT);
	assert.deepEqual(imports, [7, 8]);
	assert.equal(cursors.length, 2);
	assert.deepEqual(notes.get(7), { todos: [], memos: ["keep"], applied: { old: "result" } });
	await migrateLegacyTodos(harness, port, BACKGROUND_CONTEXT);
	assert.deepEqual(imports, [7, 8]);
	notes.get(7)!.todos.push({ text: "not imported", done: false });
	port.importLegacy = async () => { throw new Error("disk full"); };
	await assert.rejects(migrateLegacyTodos(harness, port, BACKGROUND_CONTEXT), /disk full/);
	assert.equal(notes.get(7)!.todos[0].text, "not imported");
	port.importLegacy = async () => ({ projects: 0, tasks: 0 });
	notes.get(7)!.applied["legacy-call"] = "已添加：legacy";
	await migrateLegacyTodos(harness, port, BACKGROUND_CONTEXT);
	assert.equal(await port.replayAction("tool:legacy-call", async () => { throw new Error("must not rerun"); }), "已添加：legacy");
});

test("memos retain Notes identity and obsolete todo edits are rejected", async () => {
	const doc = { todos: [], memos: ["before"], applied: { old: "result" } };
	// The notes editor only needs document access from this transaction.
	const tx = { doc: async () => doc } as unknown as Tx;
	await assert.rejects(editNotesInTx(tx, 7 as ConversationId, { todos: [{ text: "no", done: false }], memos: [] }, { todos: [], memos: ["before"] }), /待办/);
	await editNotesInTx(tx, 7 as ConversationId, { todos: [], memos: ["after"] }, { todos: [], memos: ["before"] });
	assert.deepEqual(doc, { todos: [], memos: ["after"], applied: { old: "result" } });
});
