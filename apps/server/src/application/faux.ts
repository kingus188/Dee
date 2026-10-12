import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
// faux 剧本：按最后一条用户消息之后助手已经回了几次，依次列待办、等待、勾完、回答
export function fauxScript(context: TranscriptContext) {
	const messages = context.messages;
	const lastUser = messages.findLastIndex((m) => m.role === "user");
	const replies = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
	const steps = ["第一步：查资料", "第二步：等待 10 秒", "第三步：整理结论"];
	const toolUse = { stopReason: "toolUse" } as const;
	if (replies === 0) return fauxAssistantMessage(steps.map((text) => fauxToolCall("todo", { action: "add", text })), toolUse);
	if (replies === 1) return fauxAssistantMessage([fauxToolCall("wait_seconds", { seconds: 10, reason: "演示长任务" })], toolUse);
	if (replies === 2) return fauxAssistantMessage(steps.map((text) => fauxToolCall("todo", { action: "done", text })), toolUse);
	return fauxAssistantMessage("演示任务完成。");
}
