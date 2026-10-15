// 通过 ACP 驱动 Codex：会话固定为 workspace-write（工作区内可写、其余需审批），审批请求由这里按白名单应答，其余一律拒绝。
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const GIT_SEGMENT = /^git (add|commit|diff|status|log)( |$)/;
const HARMLESS = /^(printf|echo) /;
// 引号、管道、重定向、命令替换都可能把命令变成别的东西，出现就不放行，让 Agent 换更简单的写法。
const UNSAFE = /[|<>`]|\$\(|\$\{/;

// Codex 展示的命令常被整体加了一层引号：`"git add x && ..."`。
const unwrap = (command: string) => (/^".*"$/s.test(command) ? command.slice(1, -1).replace(/\\(["\\])/g, "$1") : command);

// 只放行：git 的 add/commit/diff/status/log、printf/echo，以及该仓库配置的测试命令，用 && 或 ; 连接。
export function commandAllowed(raw: string, test?: string): boolean {
	const command = unwrap(raw.trim());
	if (!command || UNSAFE.test(command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ""))) return false;
	const segments = command.split(/\s*(?:&&|;|\n)\s*/).filter(Boolean);
	return segments.length > 0 && segments.every((s) => GIT_SEGMENT.test(s) || HARMLESS.test(s) || (!!test && (s === test || s.startsWith(`${test} `))));
}

export type AcpOptions = { bin: string; cwd: string; prompt: string; test?: string; timeoutMs: number };
export type AcpResult = { stopReason: string; text: string };

export async function runCodex(options: AcpOptions): Promise<AcpResult> {
	const child = spawn(options.bin, [], { cwd: options.cwd, stdio: ["pipe", "pipe", "ignore"] });
	const timer = setTimeout(() => child.kill(), options.timeoutMs);
	try {
		const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
		return await acp.client({ name: "pi-durable-assistant" })
			.onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
				const input = ctx.params.toolCall.rawInput as { command?: unknown } | undefined;
				const allow = ctx.params.toolCall.kind === "execute" && typeof input?.command === "string" && commandAllowed(input.command, options.test);
				const option = ctx.params.options.find((o) => o.kind === (allow ? "allow_once" : "reject_once"));
				return option ? { outcome: { outcome: "selected" as const, optionId: option.optionId } } : { outcome: { outcome: "cancelled" as const } };
			})
			.connectWith(stream, async (ctx) => {
				await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
				return ctx.buildSession(options.cwd).withSession(async (session) => {
					// 默认模式是「自动审批」，必须改成工作区写入；设置失败就不运行。
					await ctx.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId: "workspace-write" });
					session.prompt(options.prompt);
					let text = "";
					for (;;) {
						const message = await session.nextUpdate();
						if (message.kind === "stop") return { stopReason: message.response.stopReason, text };
						const update = message.notification.update;
						if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") text += update.content.text;
					}
				});
			});
	} finally {
		clearTimeout(timer);
		child.kill();
	}
}
