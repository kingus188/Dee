// 通过 ACP 驱动 Codex：请求 workspace-write，所有额外权限请求默认拒绝，不以命令白名单绕过沙箱。
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

// 保留原有查询接口，但不再通过命令字符串自动批准额外权限。
// 测试脚本、Git hooks/filters 等来自可写仓库，静态命令白名单不能证明升权安全。
export function commandAllowed(_raw: string, _test?: string): boolean {
	return false;
}

export type AcpOptions = { bin: string; cwd: string; prompt: string; test?: string; timeoutMs: number };
export type AcpResult = { stopReason: string; text: string };

export async function runCodex(options: AcpOptions): Promise<AcpResult> {
	const child = spawn(options.bin, [], { cwd: options.cwd, stdio: ["pipe", "pipe", "ignore"] });
	const timer = setTimeout(() => child.kill(), options.timeoutMs);
	let deniedPermissions = 0;
	try {
		const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
		return await acp.client({ name: "pi-durable-assistant" })
			.onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
				// ACP allow_once 会授权实际操作，不保证仍受原 workspace-write 限制。
				// 当前后台流程没有人工审批入口，不能把仓库配置或工具标题当作用户批准。
				deniedPermissions++;
				const option = ctx.params.options.find((o) => o.kind === "reject_once");
				return option ? { outcome: { outcome: "selected" as const, optionId: option.optionId } } : { outcome: { outcome: "cancelled" as const } };
			})
			.connectWith(stream, async (ctx) => {
				await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
				return ctx.buildSession(options.cwd).withSession(async (session) => {
					// 默认模式是「自动审批」，必须改成工作区写入；设置失败就不运行。
					await ctx.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId: "workspace-write" });
					session.prompt(`${options.prompt}\n\n安全限制：额外权限请求会被拒绝。请在 workspace-write 允许的范围内继续；无法运行的测试或提交必须在报告中说明，不要尝试绕过。`);
					let text = "";
					for (;;) {
						const message = await session.nextUpdate();
						if (message.kind === "stop") {
							const notice = deniedPermissions ? `安全限制：已拒绝 ${deniedPermissions} 次额外权限请求。当前后台任务没有人工审批入口；受限的测试、提交或其他操作可能未完成，请核对报告与工作区。\n\n` : "";
							return { stopReason: message.response.stopReason, text: notice + text };
						}
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
