import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { Index } from "@assistant/runtime";
import type { ConversationItem } from "@assistant/runtime";
import { Schedules, Reminders, BackgroundJobs } from "@assistant/features";
import { WechatState } from "@assistant/channel-wechat";
import { HttpError } from "../errors.js";
import type { AppContext } from "./context.js";
export function createConversations({ harness, root, ctx, redact }: AppContext) {
async function getConversation(id: number) {
	const conversation = Number.isInteger(id) && id !== root.id ? await harness.conversation(id as ConversationId, ctx) : undefined;
	if (!conversation) throw new HttpError(404, "会话不存在");
	return conversation;
}

// 建会话和登记会话列表放在同一个事务里，不会出现列表里看不到的会话
const registerIn = (item: Omit<ConversationItem, "id" | "createdAt">) => async (tx: Tx, conversationId: ConversationId) => {
	(await tx.doc(Index)).items.push({ id: conversationId, createdAt: new Date().toISOString(), ...item });
};

async function updateTitle(id: ConversationId, title: string) {
	await root.commit(async (tx) => {
		const item = (await tx.doc(Index)).items.find((i) => i.id === id);
		if (item && item.title === "新对话") item.title = title;
	}, ctx);
}

const sameConversation = (a: unknown, b: unknown) => Number(a) === Number(b);

// 归档或移出列表前，先停掉这个会话还没做完的提醒、计划和后台任务。
// 列表改动放在这之后：停失败时，会话仍留在当前列表里。
async function quietConversation(id: number) {
	const conversation = await getConversation(id);
	const taskIds = await conversation.commit(async (tx) => {
		const ids = [];
		for (const item of (await tx.doc(Schedules, conversation.id)).items) {
			if (item.status !== "active" && item.status !== "paused") continue;
			item.status = "cancelled";
			item.revision = (item.revision ?? 0) + 1;
			if (item.jobId != null) ids.push(item.jobId);
		}
		for (const item of (await tx.doc(Reminders, conversation.id)).items) {
			if (item.status !== "scheduled") continue;
			item.status = "cancelled";
			if (item.id != null) ids.push(item.id);
		}
		for (const item of (await tx.doc(BackgroundJobs, conversation.id)).items) {
			if (item.status !== "running" || item.taskId == null) continue;
			item.status = "cancelled";
			ids.push(item.taskId);
		}
		return ids;
	}, ctx);
	for (const taskId of taskIds) {
		try {
			await harness.abortTask(taskId, ctx);
		} catch (error) {
			console.error("停止会话任务失败：", redact(error instanceof Error ? error.message : error));
		}
	}
}

async function shelveConversation(id: number, action: string) {
	const index = await harness.snapshot(Index, ctx);
	if (!(index?.items ?? []).some((item) => sameConversation(item.id, id))) {
		throw new HttpError(400, "会话不在列表里");
	}
	const wechatState = await harness.snapshot(WechatState, ctx);
	const bound = Object.values(wechatState?.bindings ?? {}).some((binding) => sameConversation(binding?.conversationId, id));
	if (bound) throw new HttpError(400, "这是微信通道正在使用的会话，不能归档或删除。");
	if (action !== "restore") await quietConversation(id);
	return root.commit(async (tx) => {
		const items = (await tx.doc(Index)).items;
		const at = items.findIndex((item) => sameConversation(item.id, id));
		if (at < 0) throw new HttpError(400, "会话不在列表里");
		if (action === "remove") {
			const [removed] = items.splice(at, 1);
			return { id: removed.id, removed: true };
		}
		const item = items[at];
		if (action === "archive") {
			if (!item.archivedAt) item.archivedAt = new Date().toISOString();
		} else {
			item.archivedAt = null;
		}
		return { id: item.id, archivedAt: item.archivedAt ?? null };
	}, ctx);
}


return { getConversation, registerIn, updateTitle, shelveConversation };
}
