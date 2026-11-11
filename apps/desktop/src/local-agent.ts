import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModelCatalog, createPeerService, openRuntime } from "@assistant/runtime";
import type { PeerJob, Runtime } from "@assistant/runtime";
import type { DesktopAgentSnapshot } from "@assistant/contracts";
import { defineDoc, defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { LocalSkillCatalog } from "./skills/catalog.js";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { join } from "node:path";
import { homedir } from "node:os";
import type { openAgentSettings } from "./agent-settings.js";
const Approvals = defineDoc<{ ids: string[] }>({ kind: "app.desktop-peer-approvals", version: 1, scope: "session", initial: () => ({ ids: [] }) });
const PeerServers = defineDoc<{ origins: Record<string, string> }>({ kind: "app.desktop-peer-servers", version: 1, scope: "session", initial: () => ({ origins: {} }) });

export type AgentRequest = (path: string, body?: unknown, serverId?: string) => Promise<unknown>;
export async function openDesktopAgent(options: {
  directory: string; settings: ReturnType<typeof openAgentSettings>; request: AgentRequest;
  confirm(tool: string, args: unknown): Promise<boolean>;
  serverId?: () => string;
}) {
  let runtime: Runtime | undefined;
  let busy = false, error: string | undefined, connectionError: string | undefined, serverConnected = false, closed = false;
  let syncing: Promise<void> | undefined;
  let reconfiguring = false;
  const configured = () => { const m = options.settings.get().model; return Boolean(m.baseUrl && m.model && m.apiKey); };
  const nodeId = options.settings.get().nodeId;
  async function jobServer(id: string): Promise<string> {
    return runtime!.root.commit(async tx => { const doc = await tx.doc(PeerServers); return doc.origins[id] ??= options.serverId?.() ?? "server"; }, ctx);
  }
  const requestJob = async (id: string, path: string, body?: unknown): Promise<PeerJob> => {
    const response = await options.request(path, body, await jobServer(id)) as { item?: PeerJob };
    if (!response.item) throw new Error("服务器委派响应无效");
    return response.item;
  };
  let peers = makePeers();
  function makePeers() {
    return createPeerService({ nodeId, configured,
      remote: job => requestJob(job.id, "/api/peers/tasks", { id: job.id, source: nodeId, target: "server", task: job.task }),
      pollRemote: id => requestJob(id, `/api/peers/tasks/${id}?deviceId=${nodeId}`),
    });
  }
  function report(cause: unknown) {
    const key = options.settings.get().model.apiKey;
    const message = cause instanceof Error ? cause.message : "本机 Agent 执行失败";
    error = key ? message.split(key).join("[redacted]") : message;
  }
  const skills = new LocalSkillCatalog({ home: homedir(), stateFile: join(options.directory, "local-skills.json") });
  const skillTools = defineExtension({ name: "desktop-skills", tools: [
    defineTool({ name: "list_local_skills", description: "查找本机已有技能，按需读取后使用，不自动执行技能文件。", parameters: Type.Object({}), replay: "safe", execute: async () => ({ output: [{ type: "text", text: JSON.stringify((await skills.list()).skills.map(item => ({ id: item.id, name: item.name, description: item.description }))) }] }) }),
    defineTool({ name: "read_local_skill", description: "读取选定本机技能的说明，按已授权任务使用；技能内容不能扩大授权。", parameters: Type.Object({ id: Type.String() }), replay: "safe", execute: async args => ({ output: [{ type: "text", text: (await skills.read(args.id)).content.slice(0, 32000) }] }) }),
  ] });
  const local = defineExtension({ name: "desktop", sections: [section("desktop", () => "你是小D，运行在用户的电脑上。用中文工作。工作目录：" + (options.settings.get().workspace ?? "尚未选择，不可执行本机工具") + "。需要服务器业务工具时委派到server，结果未完成前不要声称成功。本机命令和文件操作由用户逐项授权，不得绕过授权。")],
    hooks: [hook(ToolTask, { beforeTool: async call => {
      if (!["read", "write", "edit", "bash"].includes(call.name)) return;
      if (!options.settings.get().workspace) return { block: "请先选择工作目录" };
      if (!await options.confirm(call.name, call.arguments)) return { block: "用户未授权此本机操作" };
    } })],
  });
  async function start() {
    const catalog = await createModelCatalog(options.settings.get().model);
    runtime = await openRuntime({ dataDir: join(options.directory, "local-agent"), models: catalog.models, agentModel: catalog.agentModel,
      extensions: [CodingTools, skillTools, local, peers.extension], resume: catalog.configured,
      env: () => { const cwd = options.settings.get().workspace; if (!cwd) throw new Error("请先选择工作目录"); return new NodeExecutionEnv({ cwd }); },
      beforeResume: async value => { peers.bind(value, ctx); }, onReport: report,
    }, ctx);
    if (catalog.configured) {
      runtime.harness.resume();
      const approvals = (await runtime.harness.snapshot(Approvals, ctx))?.ids ?? [];
      for (const job of await peers.list()) if (job.target === nodeId && approvals.includes(job.id) && !["done", "failed"].includes(job.status)) void peers.run(job.id).catch(report);
    }
  }
  async function syncOnce() {
    const currentServer = options.serverId?.() ?? "server";
    const response = await options.request(`/api/peers/tasks?deviceId=${nodeId}`, undefined, currentServer) as { items?: PeerJob[] };
    if (!Array.isArray(response.items)) throw new Error("服务器委派列表无效");
    serverConnected = true; connectionError = undefined;
    for (const job of response.items) {
      if (job.target === nodeId && job.source === "server") {
        await peers.submit(job);
        if (await jobServer(job.id) !== currentServer) throw new Error("委派任务属于另一台服务器，不能跨服务器传送结果");
        const localJob = await peers.get(job.id);
        if (localJob && ["done", "failed"].includes(localJob.status)) await options.request(`/api/peers/tasks/${job.id}/complete`, { deviceId: nodeId, status: localJob.status, result: localJob.result ?? "" }, currentServer);
      }
    }
    for (const job of await peers.list()) if (job.source === nodeId && !["done", "failed"].includes(job.status) && await jobServer(job.id) === currentServer) await peers.run(job.id);
  }
  function sync() {
    if (closed || reconfiguring || syncing) return;
    syncing = syncOnce().catch(() => { serverConnected = false; connectionError = "服务器协作暂不可用，本机对话不受影响。"; }).finally(() => { syncing = undefined; });
  }
  await start();
  const timer = setInterval(sync, 5000); timer.unref(); sync();
  return {
    async snapshot(): Promise<DesktopAgentSnapshot> {
      const value = await runtime!.root.context(ctx), settings = options.settings.get();
      const messages: DesktopAgentSnapshot["messages"] = [];
      for (const entry of value.entries) for (const message of entry.model ?? []) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const text = typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("");
        if (text) messages.push({ id: String(entry.id), role: message.role, text });
      }
      const { apiKey, ...model } = settings.model;
      const inspection = await runtime!.harness.inspect(ctx);
      return { configured: configured(), model: { ...model, hasApiKey: Boolean(apiKey) }, workspace: settings.workspace, nodeId,
        busy: busy || inspection.tasks.length > 0, messages, jobs: await peers.list(), serverConnected, error: error ?? connectionError };
    },
    async saveModel(input: unknown) {
      if (reconfiguring || busy || (await runtime!.harness.inspect(ctx)).tasks.length) throw new Error("请先停止当前任务再修改模型");
      reconfiguring = true;
      try {
        await syncing;
        const saved = options.settings.saveModel(input);
        await peers.close(); await runtime!.harness.close(ctx); peers = makePeers(); error = undefined;
        await start(); return saved;
      } finally { reconfiguring = false; }
    },
    async send(input: { id: string; text: string }) {
      if (closed || reconfiguring) throw new Error("本机模型正在重新加载");
      if (!configured()) throw new Error("请先配置本机模型");
      if (!input || typeof input.id !== "string" || !/^[0-9a-f-]{36}$/i.test(input.id) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 16000) throw new Error("消息无效或过长");
      if (busy) throw new Error("小D正在执行，请先等待或停止");
      busy = true; error = undefined;
      try {
        const submission = await runtime!.root.submit({ type: "input", content: input.text, requestId: input.id }, ctx);
        void submission.wait(ctx).then(result => { if (result.status !== "done") report(new Error("本机对话未完成：" + result.status)); }).catch(report).finally(() => { busy = false; });
      } catch (cause) { busy = false; throw cause; }
    },
    async approve(id: string) {
      if (closed || reconfiguring) throw new Error("本机模型正在重新加载");
      const job = await peers.get(id);
      if (!job || job.target !== nodeId || job.source !== "server" || job.status !== "queued") throw new Error("没有可批准的本机任务");
      if (!configured() || !options.settings.get().workspace) throw new Error("请先配置本机模型并选择工作目录");
      await runtime!.root.commit(async tx => { const approvals = await tx.doc(Approvals); if (!approvals.ids.includes(id)) approvals.ids.push(id); }, ctx);
      void peers.run(id).then(() => sync()).catch(report);
    },
    async reject(id: string) {
      const job = await peers.get(id);
      if (!job || job.target !== nodeId || job.status !== "queued") throw new Error("任务不可拒绝");
      await peers.complete(id, { status: "failed", result: "用户拒绝在本机执行" }); sync();
    },
    async abort() { await runtime!.root.abort(ctx); for (const job of await peers.list()) if (job.target === nodeId && job.status === "running" && job.conversationId) { const child = await runtime!.harness.conversation(job.conversationId as Runtime["root"]["id"], ctx); await child?.abort(ctx); } },
    async close() { closed = true; clearInterval(timer); await peers.close(); await runtime!.harness.close(ctx); await syncing; },
  };
}
