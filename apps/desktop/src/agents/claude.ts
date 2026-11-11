import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { resolveAgentExecutable, spawnAgent, stopAgent } from "./process.js";
import { object, questions, string } from "./types.js";
import type { AgentDriver, DriverOptions } from "./types.js";

export async function openClaude(options: DriverOptions, runQuery = query): Promise<AgentDriver> {
  options.signal.throwIfAborted();
  const executable = resolveAgentExecutable(options.config.executable, options.searchPath);
  let sessionId = options.sessionId, active: Query | undefined, turnAbort: AbortController | undefined;
  let child: ReturnType<typeof spawnAgent> | undefined;
  async function stop() { turnAbort?.abort(); active?.close(); if (child) await stopAgent(child); }
  return {
    async send(text) {
      if (active) throw new Error("Claude 正在执行");
      turnAbort = new AbortController();
      const abort = () => turnAbort?.abort();
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
      let completed = false, messageId = "reply";
      try {
        active = runQuery({ prompt: text, options: {
          cwd: options.cwd, pathToClaudeCodeExecutable: executable, abortController: turnAbort,
          env: options.env,
          ...(sessionId ? { resume: sessionId } : {}), persistSession: true,
          permissionMode: "default", permissionPromptToolName: undefined,
          settingSources: ["user", "project", "local"], includePartialMessages: true,
          systemPrompt: { type: "preset", preset: "claude_code" },
          spawnClaudeCodeProcess: input => {
            const process = spawnAgent(input.command, input.args, input.cwd ?? options.cwd, options.searchPath, input.env);
            child = process;
            const stop = () => { void stopAgent(process).catch(options.failed); };
            input.signal.addEventListener("abort", stop, { once: true });
            process.once("close", () => input.signal.removeEventListener("abort", stop));
            return process;
          },
          canUseTool: async (tool, input, context) => {
            const qs = tool === "AskUserQuestion" ? questions(input.questions) : undefined;
            const answer = await options.ask({ title: qs ? "Claude 需要补充信息" : `Claude 请求使用 ${tool}`, detail: qs ? "" : JSON.stringify(input, null, 2).slice(0, 12000), questions: qs }, context.signal);
            return answer.allow ? { behavior: "allow", updatedInput: qs ? { ...input, answers: answer.answers ?? {} } : input } : { behavior: "deny", message: "用户未授权此操作" };
          },
        } });
        for await (const message of active) {
          if (message.session_id && message.session_id !== sessionId) { sessionId = message.session_id; options.emit({ type: "session", id: sessionId }); }
          if (message.type === "stream_event") {
            const event = object(message.event), block = object(event.content_block), delta = object(event.delta);
            if (event.type === "message_start") messageId = string(object(event.message).id) || "reply";
            if (event.type === "content_block_delta" && delta.type === "text_delta") options.emit({ type: "text", id: messageId, text: string(delta.text), delta: true });
            if (event.type === "content_block_start" && block.type === "tool_use") options.emit({ type: "activity", activity: { id: string(block.id), title: string(block.name), status: "running" } });
          }
          if (message.type === "assistant") {
            const content = message.message.content;
            const text = content.filter(part => part.type === "text").map(part => part.text).join("");
            if (text) options.emit({ type: "text", id: message.message.id, text });
            for (const part of content) if (part.type === "tool_use") options.emit({ type: "activity", activity: { id: part.id, title: part.name, status: "running", detail: JSON.stringify(part.input).slice(0, 4000) } });
          }
          if (message.type === "user" && Array.isArray(message.message.content)) {
            for (const part of message.message.content) if (part.type === "tool_result") options.emit({ type: "activity", activity: { id: part.tool_use_id, title: "工具调用", status: part.is_error ? "failed" : "done" } });
          }
          if (message.type === "result") {
            if (message.subtype !== "success" || message.is_error) throw new Error("Claude 执行未成功，请检查原生会话、登录或任务限制");
            completed = true;
          }
        }
        if (!completed) throw new Error("Claude 未返回完成结果");
      } catch { throw new Error(turnAbort.signal.aborted ? "Claude 执行已取消" : "Claude 执行失败，请检查本机登录、原生会话和权限配置"); }
      finally { options.signal.removeEventListener("abort", abort); active?.close(); if (child) await stopAgent(child); active = undefined; turnAbort = undefined; child = undefined; }
    },
    abort: stop,
    close: stop,
  };
}
