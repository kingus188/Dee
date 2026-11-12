import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawnAgent, stopAgent } from "./process.js";
import { object, string } from "./types.js";
import type { AgentDriver, DriverOptions } from "./types.js";

export async function openAcp(options: DriverOptions): Promise<AgentDriver> {
  options.signal.throwIfAborted();
  const child = spawnAgent(options.config.executable, options.config.args, options.cwd, options.searchPath, options.env);
  let context: acp.ClientContext | undefined, sessionId = options.sessionId, closed = false;
  let release!: () => void;
  const lifetime = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void, failReady!: (error: unknown) => void;
  const started = new Promise<void>((resolve, reject) => { ready = resolve; failReady = reject; });
  const fail = () => { if (!closed) { const error = new Error("ACP 连接中断，请检查 Agent 原生会话"); failReady(error); options.failed(error); release(); } };
  child.on("error", fail); child.stdin.on("error", fail); child.on("close", fail);
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
  let loading = false, messageIndex = 0, messageOpen = false;
  const connection = acp.client({ name: "dee" })
    .onNotification(acp.methods.client.session.update, ctx => {
      if (loading || ctx.params.sessionId !== sessionId) return;
      const update = ctx.params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        if (!messageOpen) { messageOpen = true; messageIndex++; }
        options.emit({ type: "text", id: String(messageIndex), text: update.content.text, delta: true });
      }
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        messageOpen = false;
        const value = object(update);
        options.emit({ type: "activity", activity: { id: update.toolCallId, title: string(value.title) || "工具调用", status: update.status === "failed" ? "failed" : update.status === "completed" ? "done" : "running", detail: value.rawInput === undefined ? undefined : JSON.stringify(value.rawInput).slice(0, 4000) } });
      }
    })
    .onRequest(acp.methods.client.session.requestPermission, async ctx => {
      if (ctx.params.sessionId !== sessionId) return { outcome: { outcome: "cancelled" as const } };
      const answer = await options.ask({ title: ctx.params.toolCall.title || "ACP Agent 请求权限", detail: JSON.stringify(ctx.params.toolCall, null, 2).slice(0, 12000) });
      const option = ctx.params.options.find(option => option.kind === (answer.allow ? "allow_once" : "reject_once"));
      return option ? { outcome: { outcome: "selected" as const, optionId: option.optionId } } : { outcome: { outcome: "cancelled" as const } };
    })
    .connectWith(stream, async ctx => {
      context = ctx;
      const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      loading = true;
      if (sessionId && !init.agentCapabilities?.loadSession) throw new Error("该 ACP Agent 不支持恢复，请新建会话后继续");
      const mcpServers: acp.McpServer[] = options.peerMcp ? [{ name: "dee_peers", command: options.peerMcp.command, args: options.peerMcp.args, env: Object.entries(options.peerMcp.env).map(([name, value]) => ({ name, value })) }] : [];
      const session = sessionId ? await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: options.cwd, mcpServers }) : await ctx.request(acp.methods.agent.session.new, { cwd: options.cwd, mcpServers });
      if (!sessionId) sessionId = string(object(session).sessionId);
      if (!sessionId) throw new Error("ACP 未返回会话标识");
      const modes = session?.modes?.availableModes;
      if (modes?.length && !options.config.mode) throw new Error(`请在 ACP 设置指定模式 ID：${modes.map(mode => mode.id).join("、")}`);
      if (options.config.mode) await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: options.config.mode });
      loading = false; options.emit({ type: "session", id: sessionId }); ready();
      await lifetime;
    });
  void connection.catch(error => { failReady(error); if (!closed) options.failed(error instanceof Error ? error : new Error("ACP 协议失败")); }).finally(() => { closed = true; void stopAgent(child).catch(options.failed); });
  const cancel = () => { closed = true; failReady(new Error("ACP 连接已取消")); release(); void stopAgent(child).catch(options.failed); };
  options.signal.addEventListener("abort", cancel, { once: true });
  try { await started; } catch (error) { cancel(); options.signal.removeEventListener("abort", cancel); throw error; }
  return {
    async send(text) {
      if (!context || !sessionId || closed) throw new Error("ACP 会话已关闭");
      messageOpen = false;
      const result = await context.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
      if (result.stopReason !== "end_turn") throw new Error(`ACP 停止原因：${result.stopReason}`);
    },
    async abort() { if (context && sessionId && !closed) await context.notify(acp.methods.agent.session.cancel, { sessionId }); cancel(); },
    async close() { options.signal.removeEventListener("abort", cancel); cancel(); await stopAgent(child); await connection.catch(() => {}); },
  };
}
