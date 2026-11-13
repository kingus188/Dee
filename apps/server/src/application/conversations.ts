import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { Index, conversationStatus } from "@assistant/runtime";
import type { ConversationItem } from "@assistant/runtime";
import { Goals, Schedules, Reminders, BackgroundJobs } from "@assistant/features";
import { WechatState } from "@assistant/channel-wechat";
import { HttpError } from "../errors.js";
import type { AppContext } from "./context.js";
import { needsConversationTitle } from "../conversation-titles.js";
export function createConversations({ harness, root, ctx, redact, episodeStore }: AppContext) {
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
		if (!item || !needsConversationTitle(item) || !title) return;
		const wechat = await tx.doc(WechatState);
		if (!Object.values(wechat.bindings).some(binding => Number(binding.conversationId) === Number(id))) item.title = title;
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
			if (item.status === "cancelled") {
				if (item.jobId != null) ids.push(item.jobId);
				continue;
			}
			if (item.status !== "active" && item.status !== "paused") continue;
			item.status = "cancelled";
			item.revision = (item.revision ?? 0) + 1;
			if (item.jobId != null) ids.push(item.jobId);
		}
		for (const item of (await tx.doc(Reminders, conversation.id)).items) {
			if (item.status !== "scheduled" && item.status !== "cancelled") continue;
			item.status = "cancelled";
			if (item.id != null) ids.push(item.id);
		}
		for (const item of (await tx.doc(BackgroundJobs, conversation.id)).items) {
			if ((item.status !== "running" && item.status !== "cancelled") || item.taskId == null) continue;
			item.status = "cancelled";
			ids.push(item.taskId);
		}
        for (const goal of (await tx.doc(Goals)).items) {
          if (goal.conversationId !== conversation.id || goal.status === "completed") continue;
          if (goal.status !== "cancelled") {
            goal.status = "cancelled"; goal.revision += 1; goal.wakeAt = null; goal.updatedAt = Date.now();
          }
          if (goal.taskId != null) ids.push(goal.taskId as import("@earendil-works/pi-durable").TaskId);
        }
		const pending = [];
		for (const taskId of new Set(ids)) {
			const task = await tx.task(taskId);
			// Historical records can outlive their runtime task; nothing remains to stop.
			if (task && task.state.status !== "terminal") pending.push(taskId);
		}
		return pending;
	}, ctx);
	// Cancelled records retain task IDs so a failed stop can be retried after restart.
	let stopFailed = false;
	for (const taskId of taskIds) {
		try {
			await harness.abortTask(taskId, ctx);
		} catch (error) {
			stopFailed = true;
			console.error("停止会话任务失败：", redact(error instanceof Error ? error.message : error));
		}
	}
	if (stopFailed) throw new HttpError(503, "会话任务已标记取消，但停止执行尚未确认；会话未归档或移除，请重试。");
}

const operations = new Map<number, Promise<unknown>>();
async function withOperation<T>(id: number, operation: () => Promise<T>): Promise<T> {
  const previous = operations.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  operations.set(id, next);
  try { return await next; }
  finally { if (operations.get(id) === next) operations.delete(id); }
}
async function shelveConversation(id: number, action: string) {
  return withOperation(id, () => shelve(id, action));
}
async function shelve(id: number, action: string) {
	if (!["archive", "restore", "remove"].includes(action)) throw new HttpError(400, "会话操作无效");
	const index = await harness.snapshot(Index, ctx);
	if (!(index?.items ?? []).some((item) => sameConversation(item.id, id))) {
		throw new HttpError(400, "会话不在列表里");
	}
	const wechatState = await harness.snapshot(WechatState, ctx);
	const bound = Object.values(wechatState?.bindings ?? {}).some((binding) => sameConversation(binding?.conversationId, id));
	if (bound) throw new HttpError(400, "这是微信通道正在使用的会话，不能归档或删除。");
	// Write the durable privacy tombstone before any await that can fail or
	// leave an in-flight summary/notification running. Archive is not deletion.
	if (action === "remove") episodeStore.revokeSource(`conv:${id}`);
	if (action !== "restore") {
    // Persist intent before stopping: concurrent clients cannot submit new work during archival.
    await root.commit(async tx => {
      const item = (await tx.doc(Index)).items.find(item => sameConversation(item.id, id));
      if (!item) throw new HttpError(404, "会话不在列表里");
      item.archivingAt ??= new Date().toISOString();
    }, ctx);
    await quietConversation(id);
    try { await (await getConversation(id)).abort(ctx); }
    catch { throw new HttpError(503, "停止会话回复尚未确认；会话未归档，请重试归档或取消归档。"); }
  }
	return root.commit(async (tx) => {
		const items = (await tx.doc(Index)).items;
		const at = items.findIndex((item) => sameConversation(item.id, id));
		if (at < 0) throw new HttpError(400, "会话不在列表里");
		if (action === "remove") {
			const [removed] = items.splice(at, 1);
			return { id: removed.id, removed: true };
		}
		const item = items[at];
    item.archivingAt = null;
		if (action === "archive") {
			if (!item.archivedAt) item.archivedAt = new Date().toISOString();
		} else {
			item.archivedAt = null;
		}
		return { id: item.id, status: conversationStatus(item), archivedAt: item.archivedAt ?? null, archivingAt: null };
	}, ctx);
}


async function setStatus(id: number, status: unknown) {
  if (status !== "active" && status !== "waiting" && status !== "completed") throw new HttpError(400, "对话状态无效");
  return root.commit(async tx => {
    const item = (await tx.doc(Index)).items.find(item => sameConversation(item.id, id));
    if (!item) throw new HttpError(404, "会话不在列表里");
    item.status = status;
    return { ...item, status: conversationStatus(item) };
  }, ctx);
}
return { getConversation, registerIn, updateTitle, shelveConversation, setStatus, withOperation };
}
