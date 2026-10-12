import type { Conversation } from "@earendil-works/pi-durable";
import type { Management } from "@assistant/contracts";
import { Schedules, BackgroundJobs, Reminders } from "@assistant/features";
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
 return { get, exportMarkdown, schedule, manageSchedule, cancelReminder, background, stopBackground };
}
