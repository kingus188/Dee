import { openCodexRpc } from "./codex-rpc.js";
import { object, questions, string } from "./types.js";
import type { AgentDriver, DriverOptions } from "./types.js";

export async function openCodex(options: DriverOptions): Promise<AgentDriver> {
  options.signal.throwIfAborted();
  let threadId = options.sessionId, turnId: string | undefined;
  let settle: { resolve(): void; reject(error: Error): void } | undefined;
  let starting = false;
  let turnReady: Promise<void> | undefined, releaseStart = () => {};
  const queued: Array<{ method: string; params: Record<string, unknown> }> = [];
  function notify(method: string, params: Record<string, unknown>) {
    if (!settle || params.threadId !== threadId) return;
    if (starting) { if (queued.length >= 1000) throw new Error("Codex 启动事件过多"); queued.push({ method, params }); return; }
    const item = object(params.item), turn = object(params.turn);
    if (!turnId || (string(params.turnId) || string(turn.id)) !== turnId) return;
    if (method === "item/agentMessage/delta") options.emit({ type: "text", id: string(params.itemId), text: string(params.delta), delta: true });
    if (method === "item/completed" && item.type === "agentMessage") options.emit({ type: "text", id: string(item.id), text: string(item.text) });
    if (["item/started", "item/completed"].includes(method) && ["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(string(item.type))) {
      options.emit({ type: "activity", activity: { id: string(item.id), title: string(item.command) || string(item.tool) || string(item.type), status: item.status === "failed" ? "failed" : method === "item/completed" ? "done" : "running", detail: string(item.aggregatedOutput).slice(-4000) } });
    }
    if (method === "turn/completed") {
      if (turn.status === "completed") settle.resolve();
      else settle.reject(new Error(turn.status === "interrupted" ? "Codex 执行已中断" : "Codex 执行失败，请检查原生会话"));
    }
  }
  const rpc = openCodexRpc({ executable: options.config.executable, cwd: options.cwd, searchPath: options.searchPath, env: options.env,
    failed: error => { settle?.reject(error); options.failed(error); },
    notify,
    async request(method, params) {
      if (starting) await turnReady;
      if (params.threadId !== threadId || params.turnId !== turnId || !settle) throw new Error("会话请求已过期");
      if (method === "mcpServer/elicitation/request") {
        const meta = object(params._meta), schema = object(params.requestedSchema);
        // Codex 0.167.1 encodes single MCP tool approval as an empty form; other elicitations need their own UI.
        const emptyForm = schema.type === "object" && schema.properties !== null && typeof schema.properties === "object" && !Array.isArray(schema.properties) && Object.keys(schema.properties).length === 0 && (schema.required === undefined || (Array.isArray(schema.required) && schema.required.length === 0));
        if (params.mode !== "form" || meta.codex_approval_kind !== "mcp_tool_call" || !string(params.serverName) || !string(meta.tool_name) || !emptyForm) return { action: "decline" };
        const answer = await options.ask({ title: "Codex 请求 MCP 工具审批", detail: JSON.stringify(params, null, 2).slice(0, 12000) });
        return answer.allow && settle && params.turnId === turnId ? { action: "accept", content: {} } : { action: "decline" };
      }
      if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(method)) {
        const answer = await options.ask({ title: method.includes("commandExecution") ? "Codex 请求执行命令" : "Codex 请求文件或额外权限", detail: JSON.stringify(params, null, 2).slice(0, 12000) });
        return method === "item/permissions/requestApproval" ? { permissions: answer.allow ? object(params.permissions) : {}, scope: "turn" } : { decision: answer.allow ? "accept" : "decline" };
      }
      if (method === "item/tool/requestUserInput") {
        const qs = questions(params.questions), answer = await options.ask({ title: "Codex 需要补充信息", detail: "", questions: qs });
        if (!answer.allow) throw new Error("用户取消");
        return { answers: Object.fromEntries(qs.map(q => [q.id, { answers: [answer.answers?.[q.id] ?? ""] }])) };
      }
      throw new Error("当前不支持该 Codex 请求");
    },
  });
  const cancel = () => { settle?.reject(new Error("Codex 执行已取消")); void rpc.close().catch(options.failed); };
  options.signal.addEventListener("abort", cancel, { once: true });
  try {
    await rpc.request("initialize", { clientInfo: { name: "dee", title: "Dee", version: "0.1.0" }, capabilities: {} });
    rpc.notify("initialized");
    const response = object(await rpc.request(threadId ? "thread/resume" : "thread/start", { ...(threadId ? { threadId } : {}), cwd: options.cwd, approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "workspace-write", ...(options.peerMcp ? { config: { mcp_servers: { dee_peers: options.peerMcp } } } : {}) }));
    threadId = string(object(response.thread).id);
    if (!threadId) throw new Error("Codex 未返回会话标识");
    options.emit({ type: "session", id: threadId });
  } catch (error) { await rpc.close(); options.signal.removeEventListener("abort", cancel); throw error; }
  return {
    async send(text, requestId) {
      if (settle) throw new Error("Codex 正在执行");
      starting = true;
      turnReady = new Promise(resolve => { releaseStart = resolve; });
      const completion = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
      // Observe early terminal events while turn/start is still awaiting its response.
      void completion.catch(() => {});
      try {
        const response = object(await rpc.request("turn/start", { threadId, input: [{ type: "text", text }], clientUserMessageId: requestId }));
        turnId = string(object(response.turn).id);
        if (!turnId) throw new Error("Codex 未返回执行轮次");
        starting = false;
        releaseStart();
        for (const event of queued.splice(0)) notify(event.method, event.params);
        await completion;
      } finally { releaseStart(); settle = undefined; turnId = undefined; starting = false; turnReady = undefined; queued.length = 0; }
    },
    async abort() { if (turnId) await rpc.request("turn/interrupt", { threadId, turnId }); await rpc.close(); settle?.reject(new Error("Codex 执行已取消")); },
    async close() { options.signal.removeEventListener("abort", cancel); settle?.reject(new Error("Codex 连接已关闭")); await rpc.close(); },
  };
}
