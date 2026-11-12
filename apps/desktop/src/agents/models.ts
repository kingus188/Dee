import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openCodexRpc } from "./codex-rpc.js";
import { resolveAgentExecutable } from "./process.js";
import { object, string } from "./types.js";
import type { ExternalAgentConfig } from "@assistant/contracts";

export async function readAgentModels(kind: string, config: ExternalAgentConfig, cwd: string, searchPath?: string, env?: NodeJS.ProcessEnv) {
  if (kind === "codex") {
    const rpc = openCodexRpc({ executable: config.executable, cwd, searchPath, env, notify() {}, request: async () => { throw new Error("模型查询不接受工具请求"); }, failed() {} });
    try {
      await rpc.request("initialize", { clientInfo: { name: "dee", version: "0.1.0" }, capabilities: {} });
      rpc.notify("initialized");
      const settings = object(object(await rpc.request("config/read", { cwd, includeLayers: false })).config);
      const result = object(await rpc.request("model/list", {}));
      const rows = (Array.isArray(result.data) ? result.data : []).map(object);
      rows.sort((a, b) => Number(b.model === settings.model || (!settings.model && b.isDefault === true)) - Number(a.model === settings.model || (!settings.model && a.isDefault === true)));
      return rows.map(value => {
        const model = object(value);
        return { id: string(model.model), name: string(model.displayName) || string(model.model), efforts: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).map(value => string(object(value).reasoningEffort)).filter(Boolean) };
      });
    } finally { await rpc.close(); }
  }
  if (kind !== "claude") throw new Error("该 Agent 不支持模型查询");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  async function* prompt(): AsyncGenerator<SDKUserMessage> { await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true })); }
  const session = query({ prompt: prompt(), options: { cwd, env, abortController: controller, pathToClaudeCodeExecutable: resolveAgentExecutable(config.executable, searchPath), settingSources: ["user", "project", "local"], persistSession: false } });
  try { return (await session.supportedModels()).map(model => ({ id: model.value, name: model.displayName, efforts: model.supportedEffortLevels ?? [] })); }
  finally { clearTimeout(timer); controller.abort(); session.close(); }
}
