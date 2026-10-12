import { setTimeout as sleep } from "node:timers/promises";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { resultText as text } from "../results.js";
export const waitSeconds = defineTool({
	name: "wait_seconds",
	description: "等待一段时间再继续（1 到 120 秒），用于定时、隔一会儿再检查之类的任务",
	parameters: Type.Object({ seconds: Type.Number(), reason: Type.Optional(Type.String()) }),
	replay: "safe",
	execute: async (args, api, callContext) => {
		const seconds = Math.min(120, Math.max(1, Math.round(args.seconds)));
		// 截止时间存进任务备忘：崩溃重启后按原截止时间接着等，而不是从头等
		const deadline = await api.memo("deadline", Date.now() + seconds * 1000, callContext);
		while (Date.now() < deadline) {
			api.output(`还剩 ${Math.ceil((deadline - Date.now()) / 1000)} 秒\n`);
			// 点“停止”时立即结束等待
			await sleep(Math.min(1000, deadline - Date.now()), undefined, { signal: callContext.abortSignal });
		}
		return text(`已等待 ${seconds} 秒`);
	},
});

export const currentTime = defineTool({
	name: "current_time",
	description: "获取当前北京时间",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => text(new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })),
});
