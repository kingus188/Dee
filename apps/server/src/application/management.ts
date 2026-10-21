import type { Conversation } from "@earendil-works/pi-durable";
import type { Management } from "@assistant/contracts";
import { Schedules, BackgroundJobs, Reminders, normalizeSchedule, normalizeReminder } from "@assistant/features";
import { HttpError } from "../errors.js";
import type { AppContext } from "./context.js";
import type { createViews } from "./views.js";

export function createManagement(context: AppContext, { simplifyView }: ReturnType<typeof createViews>) {
 const { harness, ctx, tasks } = context;
 async function get(conversation: Conversation): Promise<Management> {
			const [schedules, background, reminders] = await Promise.all([
				harness.snapshot(Schedules, conversation.id, ctx),
				harness.snapshot(BackgroundJobs, conversation.id, ctx),
				harness.snapshot(Reminders, conversation.id, ctx),
			]);
			// Durable Task 异常终结时，不应继续向用户展示为“运行中”。
			const backgroundItems = await Promise.all((background?.items ?? []).map(async (item) => {
				if (item.status !== "running" || item.taskId == null) return item;
				const task = await harness.getTask(item.taskId, ctx);
				if (task?.state.status !== "terminal") return item;
				if (task.state.outcome?.status === "completed") {
					const fresh = (await harness.snapshot(BackgroundJobs, conversation.id, ctx))?.items?.find((j) => j.id === item.id);
					if (fresh?.status !== "running") return fresh ?? item;
				}
				return { ...item, status: "failed" as const, result: item.result || "后台任务异常终止；请检查服务日志" };
			}));
			const scheduleItems = await Promise.all((schedules?.items ?? []).map(async (item) => {
				if (item.status !== "active" || item.jobId == null) return item;
				const task = await harness.getTask(item.jobId, ctx);
				if (task?.state.status !== "terminal") return item;
				if (task.state.outcome?.status === "completed") {
					const fresh = (await harness.snapshot(Schedules, conversation.id, ctx))?.items?.find((j) => j.id === item.id);
					if (fresh?.status !== "active" || fresh?.jobId !== item.jobId) return fresh ?? item;
				}
				return { ...item, status: "failed" as const };
			}));
			return {
				schedules: scheduleItems,
				background: backgroundItems,
				reminders: reminders?.items ?? [],
			};
 }
 async function exportMarkdown(conversation: Conversation) {
   const view = await conversation.viewState(ctx);
   try {
     const entries = (await simplifyView(conversation.id, view.value)).entries;
     return ["# Pi Durable 会话 " + conversation.id, "", ...entries.filter(e => e.kind === "user" || e.kind === "assistant")
       .map(e => "## " + (e.kind === "user" ? "用户" : "助手") + "\n\n" + e.text + "\n")].join("\n");
   } finally { view.dispose(); }
 }
 async function schedule(conversation: Conversation, body: Record<string, unknown>) {
   return conversation.commit(tx => tasks.scheduleInTx(tx, conversation.id, body, body.requestId ?? null), ctx);
 }
 async function manageSchedule(conversation: Conversation, id: string, action: string) {
   const item = await conversation.commit(tx => tasks.manageScheduleInTx(tx, conversation.id, id, action), ctx);
   if (action !== "resume") await harness.abortTask(item.jobId!, ctx);
   return item;
 }
 async function editSchedule(conversation: Conversation, id: string, body: Record<string, unknown>) {
   if (typeof body.revision !== "number" || !Number.isInteger(body.revision) || body.revision < 1) throw new HttpError(400, "计划版本 revision 必须是正整数");
   if (typeof body.text !== "string" || typeof body.minutesFromNow !== "number" || (body.everyMinutes !== undefined && typeof body.everyMinutes !== "number")) throw new HttpError(400, "计划内容和执行时间格式不正确");
   const normalized = normalizeSchedule(body);
   const reserved = await conversation.commit(async tx => {
     const item = (await tx.doc(Schedules, conversation.id)).items.find(entry => entry.id === id);
     if (!item) throw new HttpError(404, "计划任务不存在");
     if (item.revision !== body.revision || !["active", "paused"].includes(item.status)) throw new HttpError(409, "计划已更新或结束，请重新载入");
     const previousStatus = item.status;
     item.status = "paused";
     item.revision += 1;
     return { ...item, previousStatus };
   }, ctx);
   // 先让旧任务失效，再 signal/join；替换失败时保留暂停，绝不显示虚假的运行状态。
   if (reserved.jobId != null) await harness.abortTask(reserved.jobId, ctx);
   return conversation.commit(async tx => {
     const item = (await tx.doc(Schedules, conversation.id)).items.find(entry => entry.id === id);
     if (!item || item.revision !== reserved.revision || item.status !== "paused") throw new HttpError(409, "计划已更新，请重新载入");
     item.text = normalized.text;
     item.nextAt = normalized.at;
     item.everyMinutes = normalized.everyMinutes;
     item.status = reserved.previousStatus;
     if (item.status === "active") item.jobId = await tx.createTask(tasks.ScheduleTask, {
       scheduleId: item.id, text: item.text, at: normalized.at, revision: item.revision,
     }, { ownership: { kind: "conversation" }, background: true });
     return { ...item };
   }, ctx);
 }
 async function reminder(conversation: Conversation, body: Record<string, unknown>) {
   return conversation.commit(tx => tasks.reminderInTx(tx, conversation.id, body, body.requestId ?? null), ctx);
 }
 async function editReminder(conversation: Conversation, id: string, body: Record<string, unknown>) {
   if (typeof body.at !== "number" || !Number.isSafeInteger(body.at)) throw new HttpError(400, "提醒版本 at 必须是时间戳");
   normalizeReminder(body);
   const previous = await conversation.commit(async tx => {
     const item = (await tx.doc(Reminders, conversation.id)).items.find(entry => String(entry.id) === id);
     if (!item) throw new HttpError(404, "提醒不存在");
     if (item.at !== body.at || item.status !== "scheduled") throw new HttpError(409, "提醒已更新或结束，请重新载入");
     item.status = "cancelled";
     return { ...item };
   }, ctx);
   // 提醒任务的输入不可变：停止并 join 原任务，再真实创建一个新 id 的提醒。
   await harness.abortTask(previous.id, ctx);
   return conversation.commit(tx => tasks.reminderInTx(tx, conversation.id, body, null), ctx);
 }
 async function cancelReminder(conversation: Conversation, id: string) {
   const item = await conversation.commit(async tx => {
     const reminder = (await tx.doc(Reminders, conversation.id)).items.find(it => String(it.id) === id);
     if (!reminder || reminder.status !== "scheduled") throw new HttpError(400, "提醒已结束或不存在");
     reminder.status = "cancelled";
     return { id: reminder.id, text: reminder.text, status: reminder.status, at: reminder.at };
   }, ctx);
   await harness.abortTask(item.id, ctx);
   return item;
 }
 async function background(conversation: Conversation, body: Record<string, unknown>) {
   return conversation.commit(tx => tasks.backgroundInTx(tx, conversation.id, body, body.requestId ?? null), ctx);
 }
 async function stopBackground(conversation: Conversation, id: string) {
   const item = await conversation.commit(async tx => {
     const job = (await tx.doc(BackgroundJobs, conversation.id)).items.find(it => it.id === id);
     if (!job || job.status !== "running") throw new HttpError(400, "任务已结束或不存在");
     job.status = "cancelled";
     return { ...job };
   }, ctx);
   await harness.abortTask(item.taskId!, ctx);
   return item;
 }
 return { get, exportMarkdown, schedule, manageSchedule, editSchedule, reminder, editReminder, cancelReminder, background, stopBackground };
}
