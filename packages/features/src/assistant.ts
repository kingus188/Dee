import { defineExtension, section } from "@earendil-works/pi-durable";
import { Notes, todo, memo } from "./notes/index.js";
import { fetchPage } from "./browsing/index.js";
import { waitSeconds, currentTime } from "./tasks/clock.js";
import { createReminders } from "./tasks/reminders.js";
import type { NotifyEvent } from "./tasks/notifications.js";
export function createAssistant(notifyEvent: NotifyEvent) {
const { ReminderTask, remindMe } = createReminders(notifyEvent);
return defineExtension({
	name: "assistant",
	tools: [fetchPage, waitSeconds, todo, memo, currentTime, remindMe],
	tasks: [ReminderTask],
	sections: [
		section(
			"preamble",
			() =>
				[
					"你是“小墨的 Durable 助手”，用简体中文简洁回答。",
					"遇到多步骤任务，先用 todo 列出步骤，做完一步标记一步。",
					"当场等一会儿再继续用 wait_seconds；几分钟以后才要做的事用 remind_me 设提醒，不要用 wait_seconds 干等。",
					"收到以 [定时提醒] 开头的消息时，那是你之前设的提醒到点了，用一两句话提醒用户这件事。",
					"能独立完成、步骤较多的调研可以用 delegate 派给子 Agent；需要后台独立运行用 delegate_background。",
					"有周期性或延迟执行的需求用 schedule_task，按固定分钟间隔执行。",
					"当前会话的备忘用 memo。跨会话要记住的稳定事实用 propose_memory，那只是候选，用户批准后才会在以后的会话出现。",
					"已批准的技能先用 read_skill 读全文再执行，不要凭名称编造步骤。新流程用 propose_skill 提交，批准前不能当已生效。",
					"用户自己的笔记用 search_knowledge 和 read_knowledge，回答要带路径和行号。查不到就说没找到。归档不能说成现行决定。没配置知识库时不要假装查过。",
					"查公开网页用 fetch_page。",
				].join("\n"),
			{ tag: false },
		),
		section("notes", async (input, renderContext) => {
			const notes = await input.read.snapshot(Notes, input.conversationId, renderContext);
			if (!notes || (notes.todos.length === 0 && notes.memos.length === 0)) return undefined;
			const todos = notes.todos.map((t) => `${t.done ? "[x]" : "[ ]"} ${t.text}`);
			const memos = notes.memos.map((m) => `- ${m}`);
			return ["当前记事本：", ...todos, ...memos].join("\n");
		}),
	],
});


}
