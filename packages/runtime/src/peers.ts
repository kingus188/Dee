import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { ConversationId, Extension } from "@earendil-works/pi-durable";
import type { Runtime } from "./runtime.js";
import { peerContinuation, piPeerSessions, readPiPeerSession, samePeerSession, validPeerSession } from "./peer-sessions.js";
import type { PeerSession, PeerSessionInfo, PeerTranscript } from "./peer-sessions.js";

import { peerRequirements, peerTaskPrompt, samePeerRequirements, validPeerRequirements, type PeerRequirements, type PeerCancellation } from "./peer-boundaries.js";
export { peerTaskPrompt } from "./peer-boundaries.js";

export type PeerJob = PeerRequirements & {
  id: string; source: string; target: string; task: string;
  status: "queued" | "running" | "done" | "failed";
  cancellation?: PeerCancellation; executionStartedAt?: string;
  result?: string; conversationId?: number; createdAt: string; updatedAt: string;
  sourceSession?: PeerSession; targetSession?: PeerSession; deliveryError?: string; resultDelivered?: boolean;
};
export type PeerSubmission = Pick<PeerJob, "id" | "source" | "target" | "task" | "sourceSession" | "targetSession" | "workspace" | "constraints" | "acceptanceCriteria">;
export type PeerCompletion = { status: "done" | "failed"; result: string; cancellationConfirmed?: boolean };
export type PeerService = {
  extension: Extension;
  bind(runtime: Runtime, ctx: Context): void;
  submit(input: PeerSubmission): Promise<PeerJob>;
  list(): Promise<PeerJob[]>;
  get(id: string): Promise<PeerJob | undefined>;
  complete(id: string, completion: PeerCompletion): Promise<PeerJob>;
  run(id: string): Promise<PeerJob>;
  requestCancel(id: string): Promise<PeerJob>;
  sessions(): Promise<PeerSessionInfo[]>;
  readSession(session: PeerSession): Promise<PeerTranscript>;
  close(): Promise<void>;
};
export type PeerOptions = {
  nodeId: string; configured: () => boolean;
  remote?: (job: PeerJob) => Promise<PeerJob>;
  cancelRemote?: (job: PeerJob) => Promise<PeerJob>;
  /** Must stop only this request, and return true only after confirmed termination. */
  cancelExecution?: (job: PeerJob) => Promise<boolean>;
  pollRemote?: (id: string) => Promise<PeerJob>;
  /** Server discovery only; never grants desktop execution authority. */
  devices?: () => Promise<string[]>;
  sessions?: () => Promise<PeerSessionInfo[]>;
  readSession?: (session: PeerSession) => Promise<PeerTranscript>;
  executeSession?: (job: PeerJob, started: () => Promise<void>) => Promise<PeerCompletion | undefined>;
  /** False keeps the continuation in PeerJobs until the source execution slot is available. */
  deliverResult?: (job: PeerJob) => Promise<boolean | void>;
  remoteSessions?: (node: string, session?: PeerSession) => Promise<PeerSessionInfo[] | PeerTranscript>;
  authorized?: (job: PeerJob) => Promise<boolean>;
  canAddressSession?: (session: PeerSession) => Promise<boolean>;
  report?: (error: unknown) => void;
};
const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export const PEER_JOB_ID = new RegExp(`^${uuid}$`);
export const PEER_DEVICE_ID = new RegExp(`^desktop-${uuid}$`);
export const PEER_TASK_LIMIT = 16_000;
export const PEER_RESULT_LIMIT = 16_000;
export const PeerJobs = defineDoc<{ items: PeerJob[] }>({ kind: "app.peer-jobs", version: 1, scope: "session", initial: () => ({ items: [] }) });
const terminal = (job: PeerJob) => job.status === "done" || job.status === "failed";
const copyJob = (job: PeerJob): PeerJob => JSON.parse(JSON.stringify(job)) as PeerJob;
const samePayload = (a: PeerSubmission, b: PeerSubmission) => a.id === b.id && a.source === b.source && a.target === b.target && a.task === b.task && samePeerRequirements(a, b) && samePeerSession(a.sourceSession, b.sourceSession) && samePeerSession(a.targetSession, b.targetSession);
export class PeerError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "PeerError"; }
}
export function validatePeerSubmission(input: PeerSubmission): void {
  if (!input || !validPeerRequirements(input)) throw new PeerError(400, "委派资源与约束无效");
  if (typeof input.id !== "string" || !PEER_JOB_ID.test(input.id)) throw new PeerError(400, "任务 ID 必须为 UUID");
  for (const node of [input.source, input.target]) if (typeof node !== "string" || (node !== "server" && !PEER_DEVICE_ID.test(node))) throw new PeerError(400, "节点 ID 无效");
  for (const session of [input.sourceSession, input.targetSession]) if (session !== undefined && !validPeerSession(session)) throw new PeerError(400, "Agent 会话地址无效");
  if (input.source === input.target && (!input.sourceSession || !input.targetSession || samePeerSession(input.sourceSession, input.targetSession))) throw new PeerError(400, "委派来源与目标会话不能相同");
  if ((input.source === "server" && input.sourceSession && input.sourceSession.agent !== "pi") || (input.target === "server" && input.targetSession && input.targetSession.agent !== "pi")) throw new PeerError(400, "服务器仅支持 Pi 会话");
  if (typeof input.task !== "string" || !input.task.trim() || input.task.length > PEER_TASK_LIMIT) throw new PeerError(400, "委派任务为空或超出长度限制");
}
export function validatePeerCompletion(value: PeerCompletion): void {
  if (value?.cancellationConfirmed !== undefined && (value.cancellationConfirmed !== true || value.status !== "failed")) throw new PeerError(400, "取消确认状态无效");
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
    return structuredClone((await runtime.harness.snapshot(PeerJobs, ctx))?.items ?? []);
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
      const doc = await tx.doc(PeerJobs), existing = doc.items.find(job => job.id === input.id);
      if (existing) {
        if (!samePayload(existing, input)) throw new PeerError(409, "任务 ID 与已有内容冲突");
        return copyJob(existing);
      }
      const now = new Date().toISOString();
      const job: PeerJob = { id: input.id, source: input.source, target: input.target, task: input.task, ...peerRequirements(input), ...(input.sourceSession ? { sourceSession: { agent: input.sourceSession.agent, sessionId: input.sourceSession.sessionId } } : {}), ...(input.targetSession ? { targetSession: { agent: input.targetSession.agent, sessionId: input.targetSession.sessionId } } : {}), status: "queued", createdAt: now, updatedAt: now };
      doc.items.push(job);
      return copyJob(job);
    }, ctx);
  }
  async function complete(id: string, value: PeerCompletion, preserveTerminal = false): Promise<PeerJob> {
    validatePeerCompletion(value);
    const { runtime, ctx } = state();
    const result = await runtime.root.commit(async tx => {
      const job = (await tx.doc(PeerJobs)).items.find(item => item.id === id);
      if (!job) throw new PeerError(404, "委派任务不存在");
      if (terminal(job)) {
        if (preserveTerminal && (job.status !== value.status || job.result !== value.result)) {
          if (job.status === "failed" && value.cancellationConfirmed && job.cancellation) job.cancellation.confirmedAt ??= new Date().toISOString();
          return copyJob(job);
        }
        if (job.status !== value.status || job.result !== value.result) throw new PeerError(409, "已完成任务的结果冲突");
      } else { job.status = value.status; job.result = value.result; job.updatedAt = new Date().toISOString(); }
      if (value.cancellationConfirmed) {
        if (!job.cancellation) throw new PeerError(409, "任务没有取消请求");
        job.cancellation.confirmedAt ??= new Date().toISOString();
      }
      return copyJob(job);
    }, ctx);
    await deliverResult(result);
    return (await get(id))!;
  }
  // Internal execution and cancellation may settle concurrently; the first terminal result wins.
  const settle = (id: string, value: PeerCompletion) => complete(id, value, true);
  async function requestCancel(id: string): Promise<PeerJob> {
    const { runtime, ctx } = state();
    const job = await runtime.root.commit(async tx => {
      const item = (await tx.doc(PeerJobs)).items.find(value => value.id === id);
      if (!item) throw new PeerError(404, "委派任务不存在");
      if (!terminal(item)) { item.cancellation ??= { requestedAt: new Date().toISOString() }; item.updatedAt = new Date().toISOString(); }
      return copyJob(item);
    }, ctx);
    return terminal(job) ? job : stopRequested(job);
  }
  async function stopRequested(job: PeerJob): Promise<PeerJob> {
    if (!job.cancellation || terminal(job)) return job;
    if (job.target !== options.nodeId) {
      const remote = await options.cancelRemote?.(job);
      if (!remote) return job;
      if (!samePayload(job, remote)) throw new PeerError(409, "远端任务内容冲突");
      return terminal(remote) ? settle(job.id, { status: remote.status as "done" | "failed", result: remote.result ?? "", ...(remote.cancellation?.confirmedAt ? { cancellationConfirmed: true } : {}) }) : job;
    }
    const { runtime, ctx } = state();
    let confirmed = false;
    if (job.targetSession && job.targetSession.agent !== "pi") {
      // An adapter must address this exact request; never abort the current unrelated session.
      confirmed = await options.cancelExecution?.(job) ?? false;
    } else if (!job.conversationId && !job.executionStartedAt) {
      confirmed = !running.has(job.id);
    } else if (job.conversationId) {
      const id = job.conversationId as ConversationId;
      const record = await runtime.root.commit(tx => tx.submissionByRequest(id, `peer:${job.id}`), ctx);
      if (record?.status === "queued") confirmed = await runtime.harness.abortSubmission(record.id, ctx, id) === "aborted";
      else if (record?.status === "placed" && !job.targetSession) {
        // Only a dedicated child belongs exclusively to this job. Shared sessions are left pending.
        const child = await runtime.harness.conversation(id, ctx);
        if (child) { await child.abort(ctx); confirmed = true; }
      } else if (record?.status === "unanswered") confirmed = true;
    }
    const current = (await get(job.id))!;
    if (current.status === "done") return current; // Work won the cancellation race; do not relabel success.
    if (!confirmed) return current;
    return settle(job.id, { status: "failed", result: current.status === "failed" ? current.result ?? "" : "Execution cancelled; inspect any effects already produced.", cancellationConfirmed: true });
  }
  async function sessions() {
    const { runtime, ctx } = state();
    const items = [...await piPeerSessions(runtime, ctx), ...await options.sessions?.() ?? []];
    return options.canAddressSession ? (await Promise.all(items.map(async item => await options.canAddressSession!(item) ? item : undefined))).filter((item): item is PeerSessionInfo => item !== undefined) : items;
  }
  async function readSession(session: PeerSession): Promise<PeerTranscript> {
    if (!validPeerSession(session)) throw new PeerError(400, "Agent 会话地址无效");
    if (options.canAddressSession && !await options.canAddressSession(session)) throw new PeerError(404, "Agent 会话不可执行");
    const { runtime, ctx } = state();
    const result = session.agent === "pi" ? await readPiPeerSession(runtime, session, ctx) : await options.readSession?.(session);
    if (!result) throw new PeerError(404, "Agent 会话不存在或不可用");
    return result;
  }
  async function deliverResult(job: PeerJob) {
    if (job.source !== options.nodeId || !job.sourceSession || job.resultDelivered) return;
    const { runtime, ctx } = state();
    let admitted = false;
    try {
      if (job.sourceSession.agent !== "pi") {
        if (!options.deliverResult) throw new PeerError(409, "来源 Agent 不支持接收结果");
        admitted = await options.deliverResult(job) !== false;
      } else if (options.configured()) {
        await readSession(job.sourceSession);
        const source = (await runtime.harness.conversation(Number(job.sourceSession.sessionId.slice(3)) as ConversationId, ctx))!;
        let requestId = `peer-result:${job.id}`;
        const previous = await runtime.root.commit(tx => tx.submissionByRequest(source.id, requestId), ctx);
        // Older releases used this key for a passive write; its SDK identity cannot change type.
        if (previous?.type === "write") requestId += ":continuation";
        await source.submit({ type: "input", requestId, whenBusy: "followUp", content: peerContinuation(job), entry: { kind: "app.peer-result", data: { jobId: job.id, source: job.target, targetSession: job.targetSession ?? null, status: job.status, result: job.result ?? "" } } }, ctx);
        admitted = true;
      }
    } catch (error) {
      await runtime.root.commit(async tx => { const item = (await tx.doc(PeerJobs)).items.find(item => item.id === job.id)!; if (!item.resultDelivered) item.deliveryError = "协作已完成，来源续跑尚未受理，将使用原请求重试"; }, ctx);
      throw error;
    }
    await runtime.root.commit(async tx => {
      const item = (await tx.doc(PeerJobs)).items.find(item => item.id === job.id)!;
      if (admitted) { item.resultDelivered = true; delete item.deliveryError; }
      else if (!item.resultDelivered) item.deliveryError = "协作已完成，等待来源模型配置或 Agent 空闲后续跑";
    }, ctx);
  }
  async function execute(id: string): Promise<PeerJob> {
    const job = await get(id);
    if (!job) throw new PeerError(404, "委派任务不存在");
    if (terminal(job)) { await deliverResult(job); return job; }
    if (job.cancellation) {
      if (job.target === options.nodeId && !job.conversationId && !job.executionStartedAt && (!job.targetSession || job.targetSession.agent === "pi")) return settle(id, { status: "failed", result: "Execution cancelled before admission.", cancellationConfirmed: true });
      return stopRequested(job);
    }
    if (job.target !== options.nodeId) {
      // ponytail: one fixed target, no leases or fallback execution after a disconnect.
      const remote = job.status === "running" && options.pollRemote ? await options.pollRemote(id) : await options.remote?.(job);
      if (!remote) return job;
      if (!samePayload(job, remote)) throw new PeerError(409, "远端任务内容冲突");
      if (remote.cancellation) {
        // A target may receive cancellation through its own UI. Mirror its request before confirmation.
        const { runtime, ctx } = state();
        await runtime.root.commit(async tx => {
          const current = (await tx.doc(PeerJobs)).items.find(item => item.id === id)!;
          if (!terminal(current)) current.cancellation ??= { requestedAt: remote.cancellation!.requestedAt };
        }, ctx);
      }
      if (terminal(remote)) return settle(id, { status: remote.status as "done" | "failed", result: remote.result ?? "", ...(remote.cancellation?.confirmedAt ? { cancellationConfirmed: true } : {}) });
      if (!["queued", "running"].includes(remote.status)) throw new PeerError(400, "远端任务状态无效");
      const { runtime, ctx } = state();
      return runtime.root.commit(async tx => {
        const current = (await tx.doc(PeerJobs)).items.find(item => item.id === id)!;
        if (!terminal(current) && remote.status === "running") { current.status = "running"; current.updatedAt = new Date().toISOString(); }
        return copyJob(current);
      }, ctx);
    }
    if (options.authorized && !await options.authorized(job)) return job;
    if (job.targetSession?.agent !== undefined && job.targetSession.agent !== "pi") {
      if (!options.executeSession) return settle(id, { status: "failed", result: "目标 Agent 不支持在本节点执行" });
      const completion = await options.executeSession(job, async () => {
        const { runtime, ctx } = state();
        await runtime.root.commit(async tx => { const current = (await tx.doc(PeerJobs)).items.find(item => item.id === id)!; if (!terminal(current)) { current.status = "running"; current.executionStartedAt ??= new Date().toISOString(); current.updatedAt = new Date().toISOString(); } }, ctx);
        const current = (await get(id))!;
        if (current.cancellation) await stopRequested(current);
      });
      const current = (await get(id))!;
      return terminal(current) ? current : completion ? settle(id, completion) : current;
    }
    if (!options.configured()) throw new PeerError(409, "请先配置本节点模型");
    const { runtime, ctx } = state();
    if (job.targetSession) await readSession(job.targetSession);
    const conversationId = await runtime.root.commit(async tx => {
      const current = (await tx.doc(PeerJobs)).items.find(item => item.id === id)!;
      if (terminal(current) || current.cancellation) return undefined;
      if (!current.conversationId) {
        // Child identity and job linkage commit together; resubmission has a stable requestId.
        if (job.targetSession) current.conversationId = Number(job.targetSession.sessionId.slice(3));
        else {
          const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await configure(tx, child.id, { model: runtime.agentModel, extensions: { remove: [extension] }, instructions: "你是同一个小D在当前节点执行的委派子会话。只完成收到的任务，使用当前节点已有业务工具，不跨端再次委派。服务器不能访问桌面本机文件；没有资源就明确说明。" });
          current.conversationId = child.id;
        }
      }
      current.status = "running"; current.executionStartedAt ??= new Date().toISOString(); current.updatedAt = new Date().toISOString();
      return current.conversationId as ConversationId;
    }, ctx);
    if (conversationId === undefined) { const current = (await get(id))!; return terminal(current) ? current : settle(id, { status: "failed", result: "Execution cancelled before admission.", cancellationConfirmed: true }); }
    const child = await runtime.harness.conversation(conversationId, ctx);
    if (!child) throw new PeerError(500, "委派子会话不存在");
    const beforeSubmit = (await get(id))!;
    if (beforeSubmit.cancellation) {
      const previous = await runtime.root.commit(tx => tx.submissionByRequest(conversationId, `peer:${id}`), ctx);
      if (!previous) return settle(id, { status: "failed", result: "Execution cancelled before admission.", cancellationConfirmed: true });
      return stopRequested(beforeSubmit);
    }
    const submission = await child.submit({ type: "input", content: peerTaskPrompt(job), requestId: `peer:${id}`, whenBusy: "followUp" }, ctx);
    const afterSubmit = (await get(id))!;
    if (afterSubmit.cancellation) await stopRequested(afterSubmit);
    const settled = await submission.wait(ctx);
    const afterWait = (await get(id))!;
    if (terminal(afterWait)) return afterWait;
    if (settled.status !== "done" || settled.type !== "input") return settle(id, { status: "failed", result: "委派执行未完成：" + settled.status });
    const answer = await runtime.root.commit(async tx => (await tx.entry(AssistantEntry, settled.answer))?.model?.[0]?.content ?? [], ctx);
    const result = typeof answer === "string" ? answer : answer.filter(part => part.type === "text").map(part => part.text).join("");
    return settle(id, { status: "done", result: (result || "任务已完成，无文字结果").slice(0, PEER_RESULT_LIMIT) });
  }
  function run(id: string): Promise<PeerJob> {
    state();
    const active = running.get(id);
    if (active) return active;
    const promise = execute(id).then(async job => {
      const { runtime, ctx } = state();
      await runtime.root.commit(async tx => { const item = (await tx.doc(PeerJobs)).items.find(item => item.id === id); if (item && (!terminal(item) || item.source !== options.nodeId || !item.sourceSession || item.resultDelivered)) delete item.deliveryError; }, ctx);
      return (await get(job.id))!;
    }).catch(async error => {
      const job = !closed ? await get(id) : undefined;
      if (job && !terminal(job) && !job.cancellation && error instanceof PeerError && [400, 404].includes(error.status)) return complete(id, { status: "failed", result: error.message });
      if (!closed) { const { runtime, ctx } = state(); await runtime.root.commit(async tx => { const job = (await tx.doc(PeerJobs)).items.find(item => item.id === id); if (job && !job.resultDelivered) job.deliveryError = "协作执行或送达未确认，将使用原请求重试"; }, ctx); }
      throw error;
    }).finally(() => { running.delete(id); });
    running.set(id, promise);
    return promise;
  }
  const extension = defineExtension({
    name: "peers",
    sections: [section("peer-resources", () => options.nodeId === "server"
      ? "你现在运行在服务器。已有服务器业务工具直接使用，不要把所有任务转发。只有必须使用用户桌面本机文件、应用或本机资源时才 delegate_to_peer；target 必须选择当前在线的 desktop-UUID。可先省略 target 查询设备。任务在桌面逐项确认后才执行，离线只等待，不改派。"
      : "你现在运行在用户桌面，模型由本机独立配置。本机文件和应用任务留在本机；只有需要服务器业务数据、常驻任务或服务器工具时才 delegate_to_peer(target=server)。不要把所有任务转发。")],
    tools: [defineTool({
      name: "peer_sessions", description: "列出指定节点已有的 Agent/会话地址。远端桌面记录为最近同步的快照，离线不保证可执行。省略 node 查询当前节点。", parameters: Type.Object({ node: Type.Optional(Type.String()) }), replay: "safe",
      execute: async args => {
        const node = args.node ?? options.nodeId;
        if (node !== "server" && !PEER_DEVICE_ID.test(node)) throw new PeerError(400, "节点 ID 无效");
        const items = node === options.nodeId ? await sessions() : await options.remoteSessions?.(node);
        if (!items) throw new PeerError(409, "远端会话目录不可用");
        return { output: [{ type: "text", text: JSON.stringify({ node, items }) }] };
      },
    }), defineTool({
      name: "read_peer_session", description: "读取明确 Agent/会话的最近两百条消息，不切换当前会话，不执行。", parameters: Type.Object({ node: Type.String(), agent: Type.Union([Type.Literal("pi"), Type.Literal("codex"), Type.Literal("claude"), Type.Literal("acp")]), sessionId: Type.String() }), replay: "safe",
      execute: async args => {
        const session = { agent: args.agent, sessionId: args.sessionId };
        if (!validPeerSession(session)) throw new PeerError(400, "Agent 会话地址无效");
        const item = args.node === options.nodeId ? await readSession(session) : await options.remoteSessions?.(args.node, session);
        if (!item) throw new PeerError(404, "远端会话不可用");
        return { output: [{ type: "text", text: JSON.stringify(item) }] };
      },
    }), defineTool({
      name: "send_to_peer_session", description: "向明确节点的已有 Agent/会话异步发送任务，在原上下文排队执行；不打断当前任务、不切换界面。桌面入站仍须用户批准，完成后自动回到本来源会话继续执行；peer_task_status 可查询进度。", parameters: Type.Object({ target: Type.String(), agent: Type.Union([Type.Literal("pi"), Type.Literal("codex"), Type.Literal("claude"), Type.Literal("acp")]), sessionId: Type.String(), task: Type.String({ minLength: 1, maxLength: PEER_TASK_LIMIT }), workspace: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })), constraints: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })), acceptanceCriteria: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })) }), replay: "safe",
      execute: async (args, api, callContext) => {
        const id = await api.memo<string>("peer-session-job", randomUUID(), callContext);
        const job = await submit({ id, source: options.nodeId, sourceSession: { agent: "pi", sessionId: `pi-${api.conversationId}` }, target: args.target, targetSession: { agent: args.agent, sessionId: args.sessionId }, task: args.task, ...peerRequirements(args) });
        // Do not wait on the destination: a relay back to this busy source must be able to queue.
        void run(id).catch(error => { if (options.report) options.report(error); else console.error("协作任务尚未确认，请检查持久化队列状态"); });
        return { output: [{ type: "text", text: JSON.stringify(job) }] };
      },
    }), defineTool({
      name: "delegate_to_peer", description: options.nodeId === "server" ? "委派必须使用桌面资源的任务；target 选择在线 desktop-UUID。省略 target 查询当前可选设备，不自动选择。" : "仅将需要服务器资源的任务交给服务器；本机任务不要转发。异步提交后用 peer_task_status 查询。",
      parameters: Type.Object({ target: Type.Optional(Type.String({ maxLength: 44 })), task: Type.String({ minLength: 1, maxLength: PEER_TASK_LIMIT }), workspace: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })), constraints: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })), acceptanceCriteria: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })) }), replay: "safe",
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
        const job = await submit({ id, source: options.nodeId, target, task: args.task, ...peerRequirements(args), sourceSession: existing ? existing.sourceSession : { agent: "pi", sessionId: `pi-${api.conversationId}` } });
        // Remote IO may fail after admission; status/retry retains this same job ID.
        if (options.remote) await run(job.id);
        return { output: [{ type: "text", text: JSON.stringify(await get(job.id)) }] };
      },
    }), defineTool({ name: "cancel_peer_task", description: "请求停止本来源会话的委派任务。取消请求不代表已停止；离线或不支持精确取消时保留待确认，不换节点执行。", parameters: Type.Object({ id: Type.String({ pattern: PEER_JOB_ID.source }) }), replay: "safe",
      execute: async (args, api) => {
        const job = await get(args.id);
        if (!job || job.source !== options.nodeId || job.sourceSession?.agent !== "pi" || job.sourceSession.sessionId !== `pi-${api.conversationId}`) throw new PeerError(404, "本来源会话没有该协作任务");
        return { output: [{ type: "text", text: JSON.stringify(await requestCancel(args.id)) }] };
      },
    }), defineTool({ name: "peer_task_status", description: "查询委派任务的持久化状态与结果，不执行本机入站任务。", parameters: Type.Object({ id: Type.String({ pattern: PEER_JOB_ID.source }) }), replay: "safe",
      execute: async args => {
        const job = await get(args.id);
        if (!job) throw new PeerError(404, "委派任务不存在");
        const item = job.source === options.nodeId && (terminal(job) || (job.target !== options.nodeId && options.remote)) ? await run(job.id) : job;
        const targetOnline = options.nodeId === "server" && item.target !== "server" ? (await options.devices?.() ?? []).includes(item.target) : undefined;
        return { output: [{ type: "text", text: JSON.stringify({ ...item, ...(targetOnline === undefined ? {} : { targetOnline }) }) }] };
      },
    })],
  });
  return { extension, submit, list, get, complete, run, requestCancel, sessions, readSession,
    bind(runtime, ctx) {
      if (bound || closed) throw new PeerError(409, "双端委派已绑定或已关闭");
      const cancellable = withCancel(ctx); cancel = cancellable.cancel;
      bound = { runtime, ctx: cancellable.context };
      unsubscribe = runtime.harness.subscribeClose(() => { closed = true; cancel?.(); });
    },
    async close() { closed = true; cancel?.(); unsubscribe?.(); await Promise.allSettled([...running.values()]); },
  };
}
