import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { Cursor, Harness, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { DaylightPort, DaylightProject, DaylightTask } from "@assistant/contracts";
import { Notes } from "../notes/index.js";
import { resultText } from "../results.js";

const status = Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("review"), Type.Literal("done")]);
const color = Type.Union([Type.Literal("peach"), Type.Literal("lavender"), Type.Literal("mint"), Type.Literal("sky"), Type.Literal("rose")]);
const id = Type.String({ format: "uuid" });
const fields = {
	projectId: id,
	title: Type.String({ minLength: 1, maxLength: 160 }),
	description: Type.String({ description: "Markdown notes; at most 8 MiB in UTF-8" }),
	status,
	priority: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
	color,
	dueDate: Type.Union([Type.String(), Type.Null()]),
	tags: Type.Array(Type.String({ minLength: 1, maxLength: 24 }), { maxItems: 8 }),
	checklist: Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 80 }), title: Type.String({ minLength: 1, maxLength: 160 }), done: Type.Boolean() }, { additionalProperties: false }), { maxItems: 50 }),
};
const taskChanges = Type.Partial(Type.Object(fields, { additionalProperties: false, minProperties: 1 }));
const projectFields = { name: Type.String({ minLength: 1, maxLength: 80 }), description: Type.String(), color };
const objectOptions = { additionalProperties: false };
const json = (value: unknown) => resultText(JSON.stringify(value));
const once = <T>(port: DaylightPort, api: ToolExecutionApi, action: (port: DaylightPort) => Promise<T>) => port.replayAction(`tool:${api.callId}`, action);

function validatePatch(changes: object, allowed: object) {
	const keys = Object.keys(changes);
	if (!keys.length) throw new Error("请提供需要修改的字段。");
	for (const key of keys) if (!Object.hasOwn(allowed, key)) throw new Error(`不支持修改字段：${key}`);
}

/** Global tasks deliberately do not rewind or fork with a conversation. */
export function createDaylight(port: DaylightPort) {
	return defineExtension({
		name: "daylight",
		tools: [
			defineTool({ name: "list_projects", description: "List active global Daylight projects. Use a project ID when creating tasks.", replay: "safe", parameters: Type.Object({}, objectOptions), execute: async () => json({ projects: (await port.snapshot()).projects }) }),
			defineTool({
				name: "list_tasks", description: "Search global tasks by project, status or text in title, Markdown notes and tags. Returns summaries; get_task includes notes and checklist. Page with offset and limit.", replay: "safe",
				parameters: Type.Object({ projectId: Type.Optional(id), status: Type.Optional(status), query: Type.Optional(Type.String({ maxLength: 160 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 4294967295 })) }, objectOptions),
				execute: async (args) => {
					const limit = args.limit ?? 50, offset = args.offset ?? 0;
					if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 4294967295 || [...(args.query ?? "")].length > 160) throw new Error("无效的搜索或分页参数。");
					const needle = (args.query ?? "").toLowerCase();
					const tasks = (await port.snapshot()).tasks.filter(task => (!args.projectId || task.projectId === args.projectId) && (!args.status || task.status === args.status) && (!needle || `${task.title} ${task.description} ${JSON.stringify(task.tags)}`.toLowerCase().includes(needle)))
						.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).slice(offset, offset + limit)
						.map(({ id, projectId, title, status, priority, color, dueDate, tags, createdAt }) => ({ id, projectId, title, status, priority, color, dueDate, tags, createdAt }));
					return json({ tasks, nextOffset: tasks.length === limit && offset + limit <= 4294967295 ? offset + limit : null });
				},
			}),
			defineTool({ name: "get_task", description: "Read a global task including Markdown notes, tags and checklist.", replay: "safe", parameters: Type.Object({ id }, objectOptions), execute: async args => json(await port.getTask(args.id)) }),
			defineTool({
				name: "create_task", description: "Create a task in an existing project. Defaults: todo, medium priority, lavender, no due date. Returns the saved task with generated ID.", replay: "safe",
				parameters: Type.Object({ ...taskChanges.properties, projectId: id, title: fields.title }, objectOptions),
				execute: async (args, api) => json(await once(port, api, async tx => {
					const now = Date.now();
					const task: DaylightTask = { id: randomUUID(), description: "", status: "todo", priority: "medium", color: "lavender", dueDate: null, tags: [], checklist: [], createdAt: now, position: -now, ...args };
					await tx.saveTask(task);
					return tx.getTask(task.id);
				})),
			}),
			defineTool({ name: "update_task", description: "Update only supplied task fields; omitted fields are preserved. Arrays replace their previous contents.", replay: "safe", parameters: Type.Object({ id, changes: taskChanges }, objectOptions), execute: async (args, api) => json(await once(port, api, async tx => { validatePatch(args.changes, fields); return tx.patchTask(args.id, args.changes); })) }),
			defineTool({ name: "mark_task", description: "Set status to todo, doing, review or done. Individual checklist items stay unchanged.", replay: "safe", parameters: Type.Object({ id, status }, objectOptions), execute: async (args, api) => json(await once(port, api, tx => tx.patchTask(args.id, { status: args.status }))) }),
			defineTool({ name: "mark_checklist_item", description: "Check or uncheck one checklist item without replacing other items or changing parent status.", replay: "safe", parameters: Type.Object({ id, itemId: Type.String({ minLength: 1, maxLength: 80 }), done: Type.Boolean() }, objectOptions), execute: async (args, api) => json(await once(port, api, async tx => {
				const task = await tx.getTask(args.id);
				const item = task.checklist.find(item => item.id === args.itemId);
				if (!item) throw new Error("子任务已不存在。");
				item.done = args.done;
				return tx.patchTask(task.id, { checklist: task.checklist });
			})) }),
			defineTool({ name: "delete_task", description: "Delete a global Daylight task.", replay: "safe", parameters: Type.Object({ id }, objectOptions), execute: async (args, api) => json(await once(port, api, async tx => { await tx.deleteTask(args.id); return { deleted: true, id: args.id }; })) }),
			defineTool({ name: "create_project", description: "Create a global Daylight project. Defaults to lavender and empty description.", replay: "safe", parameters: Type.Object({ name: projectFields.name, description: Type.Optional(projectFields.description), color: Type.Optional(color) }, objectOptions), execute: async (args, api) => json(await once(port, api, async tx => {
				const project: DaylightProject = { id: randomUUID(), description: "", color: "lavender", ...args };
				await tx.saveProject(project);
				return (await tx.snapshot()).projects.find(item => item.id === project.id)!;
			})) }),
			defineTool({ name: "update_project", description: "Update supplied project fields only; omitted fields stay unchanged.", replay: "safe", parameters: Type.Object({ id, changes: Type.Partial(Type.Object(projectFields, { additionalProperties: false, minProperties: 1 })) }, objectOptions), execute: async (args, api) => json(await once(port, api, async tx => {
				validatePatch(args.changes, projectFields);
				const current = (await tx.snapshot()).projects.find(project => project.id === args.id);
				if (!current) throw new Error("项目已不存在。");
				await tx.saveProject({ ...current, ...args.changes });
				return (await tx.snapshot()).projects.find(project => project.id === args.id)!;
			})) }),
			defineTool({ name: "delete_project", description: "Delete a global Daylight project and all of its tasks.", replay: "safe", parameters: Type.Object({ id }, objectOptions), execute: async (args, api) => json(await once(port, api, async tx => { await tx.deleteProject(args.id); return { deleted: true, id: args.id }; })) }),
			defineTool({ name: "todo", description: "维护全局 Daylight 待办：add 加到收件箱；done 完成标题匹配的第一条未完成任务。项目、字段和清单操作请用 Daylight 专用工具。", replay: "safe", parameters: Type.Object({ action: Type.Union([Type.Literal("add"), Type.Literal("done")]), text: Type.String() }, objectOptions), execute: async (args, api) => resultText(await once(port, api, async tx => {
				if (args.action === "add") {
					const now = Date.now(), project = await tx.ensureDefaultProject();
					await tx.saveTask({ id: randomUUID(), projectId: project.id, title: [...args.text.trim()].slice(0, 160).join(""), description: args.text, status: "todo", priority: "medium", color: "lavender", dueDate: null, tags: [], checklist: [], createdAt: now, position: -now });
					return `已添加：${args.text}`;
				}
				const tasks = (await tx.snapshot()).tasks.filter(task => task.status !== "done");
				const task = tasks.find(task => task.title === args.text || task.description === args.text) ?? tasks.find(task => task.title.includes(args.text) || task.description.includes(args.text));
				if (!task) return `没找到待办：${args.text}`;
				await tx.patchTask(task.id, { status: "done" });
				return `已完成：${task.title}`;
			})) }),
		],
		sections: [section("daylight", () => "Daylight 是跨会话共享的项目与任务看板，不随聊天回退或分叉。先 list_projects / list_tasks 查询，按 ID 修改；完成任务不会自动勾选子任务。备忘仍用当前会话的 memo。")],
	});
}

/** Import before clearing; a crash between stores safely repeats the idempotent import. */
export async function migrateLegacyTodos(harness: Pick<Harness, "commit">, port: DaylightPort, context: Context) {
	let cursor: Cursor | undefined;
	do {
		cursor = await harness.commit(async tx => {
			const page = await tx.scanConversations({}, 100, cursor);
			for (const conversation of page.items) {
				const notes = await tx.doc(Notes, conversation.id);
				if (notes.todos.length) await port.importLegacy(conversation.id, notes.todos);
				for (const [callId, result] of Object.entries(notes.applied ?? {})) {
					if (/^(已添加：|已完成：|没找到待办：)/.test(result)) await port.replayAction(`tool:${callId}`, async () => result);
				}
				notes.todos = [];
			}
			return page.next;
		}, context);
	} while (cursor !== undefined);
}
