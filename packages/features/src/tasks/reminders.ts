import { setTimeout as sleep } from "node:timers/promises";
import { defineDoc, defineTask, defineTool } from "@earendil-works/pi-durable";
import type { ConversationId, TaskId, Tx } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { resultText as text } from "../results.js";
import type { NotifyEvent } from "./notifications.js";
import { normalizeRequestId } from "./parameters.js";
import { detach } from "../results.js";

export function normalizeReminder(input: { text?: unknown; minutesFromNow?: unknown }) {
	if (typeof input.text !== "string" || !input.text.trim() || input.text.trim().length > 1000) throw new Error("提醒内容必须是 1～1000 字");
	if (typeof input.minutesFromNow !== "number" || !Number.isFinite(input.minutesFromNow) || input.minutesFromNow < 0.25 || input.minutesFromNow > 1440) throw new Error("提醒时间必须在 0.25～1440 分钟内");
	return { text: input.text.trim(), at: Date.now() + Math.round(input.minutesFromNow * 60000) };
}
export type Reminder = { id: TaskId; text: string; at: number; status: "scheduled" | "cancelled" | "fired" };
export const Reminders = defineDoc<{ items: Reminder[]; applied: Record<string, string> }>({
	kind: "app.reminders",
	version: 1,
	scope: "conversation",
	// 旧版文档未设置 history；必须保留 undefined 才能重新打开已有 SQLite 数据。
	history: undefined as unknown as "latest",
	fork: "initial",
	initial: () => ({ items: [], applied: {} }),
});


export function createReminders(notifyEvent: NotifyEvent) {
const ReminderTask = defineTask<{ at: number; text: string }, { phase: "sleep" } | { phase: "fire" }, null>({
	name: "app.reminder",
	version: 1,
	initial: () => ({ phase: "sleep" }),
	phases: {
		sleep: async (task, runtime, taskContext) => {
			const ms = task.input.at - Date.now();
			if (ms > 0) await sleep(ms, undefined, { signal: runtime.signal });
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(Reminders, runtime.conversationId);
				const reminder = doc.items.find((item) => item.id === task.id);
				return reminder?.status === "cancelled"
					? { status: "terminal", outcome: { status: "aborted" } }
					: { status: "running", checkpoint: { phase: "fire" } };
			}, taskContext);
		},
		fire: async (task, runtime, taskContext) => {
			let cancelled = false;
			await runtime.commit(async (tx) => {
				const item = (await tx.doc(Reminders, runtime.conversationId)).items.find((i) => i.id === task.id);
				cancelled = !item || item.status === "cancelled";
				return cancelled ? { status: "terminal", outcome: { status: "aborted" } } : undefined;
			}, taskContext);
			if (cancelled) return;
			const conversation = await runtime.conversation(runtime.conversationId, taskContext);
			// requestId 保证重启后不会重复提醒
			await conversation!.submit(
				{ type: "input", content: `[定时提醒] ${task.input.text}`, whenBusy: "followUp", requestId: `reminder:${task.id}` },
				taskContext,
			);
			await notifyEvent({ id: "reminder:" + task.id, type: "reminder", text: "定时提醒：" + task.input.text });
			await runtime.commit(async (tx) => {
				const item = (await tx.doc(Reminders, runtime.conversationId)).items.find((i) => i.id === task.id);
				if (item) item.status = "fired";
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, taskContext);
		},
	},
	abort: (_task, runtime, taskContext) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

async function reminderInTx(tx: Tx, conversationId: ConversationId, input: { text?: unknown; minutesFromNow?: unknown }, rawRequestId: unknown) {
	const requestId = normalizeRequestId(rawRequestId);
	const doc = await tx.doc(Reminders, conversationId);
	if (requestId && Object.hasOwn(doc.applied, "user:" + requestId)) {
		const item = doc.items.find(entry => String(entry.id) === doc.applied["user:" + requestId]);
		if (item) return detach(item);
	}
	const normalized = normalizeReminder(input);
	const id = await tx.createTask(ReminderTask, normalized, { ownership: { kind: "conversation" }, background: true });
	const item: Reminder = { id, ...normalized, status: "scheduled" };
	doc.items.push(item);
	if (requestId) doc.applied["user:" + requestId] = String(id);
	return detach(item);
}

const remindMe = defineTool({
	name: "remind_me",
	description: "设一个定时提醒：到点后你会收到一条以 [定时提醒] 开头的消息，再去提醒用户。minutes 可以是小数，0.25 到 1440",
	parameters: Type.Object({ minutes: Type.Number(), text: Type.String({ description: "要提醒的事" }) }),
	replay: "safe",
	execute: async (args, api, callContext) => {
		const minutes = Math.min(1440, Math.max(0.25, args.minutes));
		const result = await api.commit(async (tx) => {
			const reminders = await tx.doc(Reminders, api.conversationId);
			if (api.callId in reminders.applied) return reminders.applied[api.callId];
			const at = Date.now() + Math.round(minutes * 60_000);
			// 后台任务：不算进当前回答，点“停止”也不会取消它
			const id = await tx.createTask(ReminderTask, { at, text: args.text }, { ownership: { kind: "conversation" }, background: true });
			reminders.items.push({ id, text: args.text, at, status: "scheduled" });
			const when = new Date(at).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
			return (reminders.applied[api.callId] = `已设好提醒：${when}（北京时间）提醒“${args.text}”`);
		}, callContext);
		return text(result);
	},
});


return { ReminderTask, remindMe, reminderInTx };
}
