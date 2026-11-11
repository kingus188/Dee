import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { ConversationId, Extension } from "@earendil-works/pi-durable";
import type { Runtime } from "./runtime.js";

export type PeerJob = {
  id: string; source: string; target: string; task: string;
  status: "queued" | "running" | "done" | "failed";
  result?: string; conversationId?: number; createdAt: string; updatedAt: string;
};
export type PeerSubmission = Pick<PeerJob, "id" | "source" | "target" | "task">;
export type PeerCompletion = { status: "done" | "failed"; result: string };
export type PeerService = {
  extension: Extension;
  bind(runtime: Runtime, ctx: Context): void;
  submit(input: PeerSubmission): Promise<PeerJob>;
  list(): Promise<PeerJob[]>;
  get(id: string): Promise<PeerJob | undefined>;
  complete(id: string, completion: PeerCompletion): Promise<PeerJob>;
  run(id: string): Promise<PeerJob>;
  close(): Promise<void>;
};
export type PeerOptions = {
  nodeId: string; configured: () => boolean;
  remote?: (job: PeerJob) => Promise<PeerJob>;
  pollRemote?: (id: string) => Promise<PeerJob>;
  /** Server discovery only; never grants desktop execution authority. */
  devices?: () => Promise<string[]>;
};
const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export const PEER_JOB_ID = new RegExp(`^${uuid}$`);
export const PEER_DEVICE_ID = new RegExp(`^desktop-${uuid}$`);
export const PEER_TASK_LIMIT = 16_000;
export const PEER_RESULT_LIMIT = 16_000;
const Jobs = defineDoc<{ items: PeerJob[] }>({ kind: "app.peer-jobs", version: 1, scope: "session", initial: () => ({ items: [] }) });
const terminal = (job: PeerJob) => job.status === "done" || job.status === "failed";
const samePayload = (a: PeerSubmission, b: PeerSubmission) => a.id === b.id && a.source === b.source && a.target === b.target && a.task === b.task;
export class PeerError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "PeerError"; }
}
export function validatePeerSubmission(input: PeerSubmission): void {
  if (typeof input.id !== "string" || !PEER_JOB_ID.test(input.id)) throw new PeerError(400, "任务 ID 必须为 UUID");
  for (const node of [input.source, input.target]) if (typeof node !== "string" || (node !== "server" && !PEER_DEVICE_ID.test(node))) throw new PeerError(400, "节点 ID 无效");
  if (input.source === input.target) throw new PeerError(400, "委派来源与目标不能相同");
  if (typeof input.task !== "string" || !input.task.trim() || input.task.length > PEER_TASK_LIMIT) throw new PeerError(400, "委派任务为空或超出长度限制");
}
export function validatePeerCompletion(value: PeerCompletion): void {
  if (!value || !["done", "failed"].includes(value.status) || typeof value.result !== "string" || value.result.length > PEER_RESULT_LIMIT) throw new PeerError(400, "任务结果状态或长度无效");
}

export function createPeerService(options: PeerOptions): PeerService {
  if (options.nodeId !== "server" && !PEER_DEVICE_ID.test(options.nodeId)) throw new PeerError(400, "节点 ID 无效");
  let bound: { runtime: Runtime; ctx: Context } | undefined;
  let cancel: (() => void) | undefined, unsubscribe: (() => void) | undefined;
  let closed = false;
  const running = new Map<string, Promise<PeerJob>>();
  function state() {
    if (!bound || closed) throw new PeerError(503, "双端委派尚未就绪或已关闭");
    return bound;
  }
  async function list(): Promise<PeerJob[]> {
    const { runtime, ctx } = state();
    return structuredClone((await runtime.harness.snapshot(Jobs, ctx))?.items ?? []);
  }
  async function get(id: string): Promise<PeerJob | undefined> {
    if (!PEER_JOB_ID.test(id)) throw new PeerError(400, "任务 ID 必须为 UUID");
    return (await list()).find(job => job.id === id);
  }
  async function submit(input: PeerSubmission): Promise<PeerJob> {
    validatePeerSubmission(input);
    if (input.source !== options.nodeId && input.target !== options.nodeId) throw new PeerError(400, "任务必须由本节点参与");
    const { runtime, ctx } = state();
    return runtime.root.commit(async tx => {
      const doc = await tx.doc(Jobs), existing = doc.items.find(job => job.id === input.id);
      if (existing) {
        if (!samePayload(existing, input)) throw new PeerError(409, "任务 ID 与已有内容冲突");
        return { ...existing };
      }
      const now = new Date().toISOString();
      const job: PeerJob = { id: input.id, source: input.source, target: input.target, task: input.task, status: "queued", createdAt: now, updatedAt: now };
      doc.items.push(job);
      return { ...job };
    }, ctx);
  }
  async function complete(id: string, value: PeerCompletion): Promise<PeerJob> {
    validatePeerCompletion(value);
    const { runtime, ctx } = state();
    return runtime.root.commit(async tx => {
      const job = (await tx.doc(Jobs)).items.find(item => item.id === id);
      if (!job) throw new PeerError(404, "委派任务不存在");
      if (terminal(job)) {
        if (job.status !== value.status || job.result !== value.result) throw new PeerError(409, "已完成任务的结果冲突");
      } else { job.status = value.status; job.result = value.result; job.updatedAt = new Date().toISOString(); }
      return { ...job };
    }, ctx);
  }
  async function execute(id: string): Promise<PeerJob> {
    const job = await get(id);
    if (!job) throw new PeerError(404, "委派任务不存在");
    if (terminal(job)) return job;
    if (job.target !== options.nodeId) {
      // ponytail: one fixed target, no leases or fallback execution after a disconnect.
      const remote = job.status === "running" && options.pollRemote ? await options.pollRemote(id) : await options.remote?.(job);
      if (!remote) return job;
      if (!samePayload(job, remote)) throw new PeerError(409, "远端任务内容冲突");
      if (terminal(remote)) return complete(id, remote as PeerJob & PeerCompletion);
      if (!["queued", "running"].includes(remote.status)) throw new PeerError(400, "远端任务状态无效");
      const { runtime, ctx } = state();
      return runtime.root.commit(async tx => {
        const current = (await tx.doc(Jobs)).items.find(item => item.id === id)!;
        if (!terminal(current) && remote.status === "running") { current.status = "running"; current.updatedAt = new Date().toISOString(); }
        return { ...current };
      }, ctx);
    }
    if (!options.configured()) throw new PeerError(409, "请先配置本节点模型");
    const { runtime, ctx } = state();
    const conversationId = await runtime.root.commit(async tx => {
      const current = (await tx.doc(Jobs)).items.find(item => item.id === id)!;
      if (!current.conversationId) {
        // Child identity and job linkage commit together; resubmission has a stable requestId.
        const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await configure(tx, child.id, { model: runtime.agentModel, extensions: { remove: [extension] }, instructions: "你是同一个小D在当前节点执行的委派子会话。只完成收到的任务，使用当前节点已有业务工具，不跨端再次委派。服务器不能访问桌面本机文件；没有资源就明确说明。" });
        current.conversationId = child.id;
      }
      current.status = "running"; current.updatedAt = new Date().toISOString();
      return current.conversationId as ConversationId;
    }, ctx);
    const child = await runtime.harness.conversation(conversationId, ctx);
    if (!child) throw new PeerError(500, "委派子会话不存在");
    const submission = await child.submit({ type: "input", content: job.task, requestId: `peer:${id}` }, ctx);
    const settled = await submission.wait(ctx);
    if (settled.status !== "done" || settled.type !== "input") return complete(id, { status: "failed", result: "委派执行未完成：" + settled.status });
    const answer = await runtime.root.commit(async tx => (await tx.entry(AssistantEntry, settled.answer))?.model?.[0]?.content ?? [], ctx);
    const result = typeof answer === "string" ? answer : answer.filter(part => part.type === "text").map(part => part.text).join("");
    return complete(id, { status: "done", result: (result || "任务已完成，无文字结果").slice(0, PEER_RESULT_LIMIT) });
  }
  function run(id: string): Promise<PeerJob> {
    state();
    const active = running.get(id);
    if (active) return active;
    const promise = execute(id).finally(() => { running.delete(id); });
    running.set(id, promise);
    return promise;
  }
  const extension = defineExtension({
    name: "peers",
    sections: [section("peer-resources", () => options.nodeId === "server"
      ? "你现在运行在服务器。已有服务器业务工具直接使用，不要把所有任务转发。只有必须使用用户桌面本机文件、应用或本机资源时才 delegate_to_peer；target 必须选择当前在线的 desktop-UUID。可先省略 target 查询设备。任务在桌面逐项确认后才执行，离线只等待，不改派。"
      : "你现在运行在用户桌面，模型由本机独立配置。本机文件和应用任务留在本机；只有需要服务器业务数据、常驻任务或服务器工具时才 delegate_to_peer(target=server)。不要把所有任务转发。")],
    tools: [defineTool({
      name: "delegate_to_peer", description: options.nodeId === "server" ? "委派必须使用桌面资源的任务；target 选择在线 desktop-UUID。省略 target 查询当前可选设备，不自动选择。" : "仅将需要服务器资源的任务交给服务器；本机任务不要转发。异步提交后用 peer_task_status 查询。",
      parameters: Type.Object({ target: Type.Optional(Type.String({ maxLength: 44 })), task: Type.String({ minLength: 1, maxLength: PEER_TASK_LIMIT }) }), replay: "safe",
      execute: async (args, api, callContext) => {
        const id = await api.memo<string>("peer-job", randomUUID(), callContext);
        const existing = await get(id);
        let target = args.target ?? (options.nodeId === "server" ? undefined : "server");
        if (!existing && options.nodeId === "server") {
          const devices = await options.devices?.() ?? [];
          if (!devices.length) throw new PeerError(409, "没有在线桌面设备，请先配对并打开桌面端");
          if (!target) return { output: [{ type: "text", text: JSON.stringify({ devices }) }] };
          if (!devices.includes(target)) throw new PeerError(409, "目标桌面设备未在线登记，请先配对");
        }
        target ??= existing?.target;
        if (!target || (options.nodeId !== "server" && target !== "server")) throw new PeerError(400, "委派目标无效");
        const job = await submit({ id, source: options.nodeId, target, task: args.task });
        // Remote IO may fail after admission; status/retry retains this same job ID.
        if (options.remote) await run(job.id);
        return { output: [{ type: "text", text: JSON.stringify(await get(job.id)) }] };
      },
    }), defineTool({ name: "peer_task_status", description: "查询委派任务的持久化状态与结果，不执行本机入站任务。", parameters: Type.Object({ id: Type.String({ pattern: PEER_JOB_ID.source }) }), replay: "safe",
      execute: async args => {
        const job = await get(args.id);
        if (!job) throw new PeerError(404, "委派任务不存在");
        const item = job.source === options.nodeId && options.remote && !terminal(job) ? await run(job.id) : job;
        return { output: [{ type: "text", text: JSON.stringify(item) }] };
      },
    })],
  });
  return { extension, submit, list, get, complete, run,
    bind(runtime, ctx) {
      if (bound || closed) throw new PeerError(409, "双端委派已绑定或已关闭");
      const cancellable = withCancel(ctx); cancel = cancellable.cancel;
      bound = { runtime, ctx: cancellable.context };
      unsubscribe = runtime.harness.subscribeClose(() => { closed = true; cancel?.(); });
    },
    async close() { closed = true; cancel?.(); unsubscribe?.(); await Promise.allSettled([...running.values()]); },
  };
}
