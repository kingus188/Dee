import { nativeRuns, nativeRequestResults } from "./runs.js";
import { agentCapabilities } from "./capabilities.js";
import { randomUUID } from "node:crypto";
import type { AgentApproval, AgentApprovalAnswer, DesktopAgentKind, ExternalAgentConfig } from "@assistant/contracts";
import { openCodex } from "./codex.js";
import { openAcp } from "./acp.js";
import { openOmp } from "./omp.js";
import { openAgentSessionStore, type StoredAgentSession } from "./store.js";
import type { AgentDriver, DriverOptions, AgentEvent } from "./types.js";
import { PeerError, peerContinuation, peerTranscript, validPeerSession } from "@assistant/runtime";
import type { PeerSession, PeerJob, PeerCompletion } from "@assistant/runtime";
import { openPeerTools, type PeerToolHandler } from "./peer-tools.js";

type ExternalKind = Exclude<DesktopAgentKind, "pi">;
export type ExternalBinding = { kind: ExternalKind; cwd: string; config: ExternalAgentConfig };
export type DriverFactory = (kind: ExternalKind, options: DriverOptions) => Promise<AgentDriver>;
const factories: Record<ExternalKind, (options: DriverOptions) => Promise<AgentDriver>> = { codex: openCodex, claude: async options => (await import("./claude.js")).openClaude(options), acp: openAcp, omp: openOmp };

export function openExternalAgents(options: { directory: string; binding(): ExternalBinding | undefined; factory?: DriverFactory; searchPath?: string; env?: NodeJS.ProcessEnv; peerTools?: (session: PeerSession) => PeerToolHandler }) {
  const store = openAgentSessionStore(options.directory);
  let resumeCapability: boolean | undefined;
  let pendingWrite: ReturnType<typeof setTimeout> | undefined;
  function persist(session: StoredAgentSession) {
    clearTimeout(pendingWrite); pendingWrite = undefined;
    store.persist(session);
  }
  function persistText(session: StoredAgentSession) {
    if (pendingWrite) return;
    pendingWrite = setTimeout(() => {
      pendingWrite = undefined;
      try { store.persist(session); } catch (error) {
        rejectExecution?.(error instanceof Error ? error : new Error("无法保存 Agent 输出"));
      }
    }, 250);
    pendingWrite.unref();
  }
  const approvals = new Map<string, { request: AgentApproval; resolve(value: AgentApprovalAnswer): void }>();
  let active: Promise<void> | undefined, controller: AbortController | undefined, driver: AgentDriver | undefined;
  let boundKey: string | undefined, closed = false;
  let requestId = "", rejectExecution: ((error: Error) => void) | undefined, driverController: AbortController | undefined;
  let driverFailed = false;
  let driverGeneration = 0;
  let transition: Promise<void> | undefined;
  let peerTools: Awaited<ReturnType<typeof openPeerTools>> | undefined;
  const key = (binding: ExternalBinding) => JSON.stringify(binding);
  function current() { const binding = options.binding(); return binding ? store.get(key(binding)) : undefined; }
  function emit(session: StoredAgentSession, requestId: string, event: AgentEvent) {
    if (event.type === "capabilities") { resumeCapability = event.nativeResume; return; }
    if (event.type === "session") session.nativeId = event.id;
    if (event.type === "text") {
      const id = `${requestId}:${event.id}`;
      const start = session.messages.findIndex(message => message.role === "user" && message.id === requestId);
      if (start < 0) throw new Error("Agent 输出没有对应请求");
      const end = session.messages.findIndex((message, index) => index > start && message.role === "user");
      let message = session.messages.slice(start + 1, end < 0 ? undefined : end).find(message => message.id === id && message.role === "assistant");
      if (!message) { message = { id, role: "assistant", text: "" }; session.messages.push(message); }
      const text = event.delta ? message.text + event.text : event.text;
      if (text.length > 1_000_000) throw new Error("Agent 回复超过长度限制");
      message.text = text;
    }
    if (event.type === "activity") {
      const index = session.activities.findIndex(item => item.id === event.activity.id);
      if (index < 0) session.activities.push(event.activity); else {
        const previous = session.activities[index]!;
        session.activities[index] = { ...previous, ...event.activity, title: event.activity.title === "工具调用" ? previous.title : event.activity.title, detail: event.activity.detail ?? previous.detail };
      }
      if (session.activities.length > 200) session.activities.shift();
    }
    if (event.type === "text") persistText(session); else persist(session);
  }
  async function ask(session: StoredAgentSession, request: Omit<AgentApproval, "id">, signal?: AbortSignal): Promise<AgentApprovalAnswer> {
    if (!controller || controller.signal.aborted || signal?.aborted) return { id: "", allow: false };
    const id = randomUUID();
    session.status = "waiting"; persist(session);
    return new Promise(resolve => {
      const deny = () => finish({ id, allow: false });
      const timer = setTimeout(deny, 5 * 60_000); timer.unref();
      const localSignal = controller!.signal;
      function finish(value: AgentApprovalAnswer) {
        if (!approvals.delete(id)) return;
        clearTimeout(timer); localSignal.removeEventListener("abort", deny); signal?.removeEventListener("abort", deny);
        if (!localSignal.aborted && !approvals.size && session.status === "waiting") session.status = "running";
        resolve(value);
      }
      approvals.set(id, { request: { ...request, id }, resolve: finish });
      localSignal.addEventListener("abort", deny, { once: true }); signal?.addEventListener("abort", deny, { once: true });
    });
  }
  async function detach() { resumeCapability = undefined; const previous = driver; driver = undefined; boundKey = undefined; driverGeneration++; driverController?.abort(); driverController = undefined; try { await previous?.close(); } finally { await peerTools?.close(); peerTools = undefined; } }
  async function change(action: () => Promise<void>) {
    if (closed || active || transition) throw new Error("请先等待当前操作结束或停止任务");
    transition = Promise.resolve().then(action);
    try { await transition; } finally { transition = undefined; }
  }
  function addressed(address: PeerSession) {
    if (!validPeerSession(address) || address.agent === "pi") throw new PeerError(400, "外部 Agent 会话地址无效");
    const session = store.byId(address.sessionId);
    if (!session || (JSON.parse(session.binding) as ExternalBinding).kind !== address.agent) throw new PeerError(404, "目标 Agent 会话不存在");
    return session;
  }
  const service = {
    get busy() { return Boolean(active); },
    history: store.history,
    sessions() { return store.list().map(session => ({ agent: session.agent, sessionId: session.id, status: session.status })); },
    readSession(address: PeerSession) { const session = addressed(address); return peerTranscript({ ...address, status: session.status }, session.messages); },
    async deliverResult(job: PeerJob) {
      const session = addressed(job.sourceSession!);
      const id = `peer-result:${job.id}`;
      const existing = session.messages.find(message => message.id === id && message.role === "user");
      if (existing) { if (existing.text !== peerContinuation(job)) throw new PeerError(409, "续跑请求与已有内容冲突"); return true; }
      if (active || transition) return false;
      // Admission persists native execution intent; never await the source turn from a peer completion.
      await service.send({ id, text: peerContinuation(job) }, job.sourceSession);
      return true;
    },
    snapshot() {
      const session = current();
      return { runs: nativeRuns(session, options.binding()?.kind ?? "codex"), capabilities: agentCapabilities(options.binding()?.kind ?? "codex", resumeCapability), messages: session?.messages ?? [], error: store.error ?? session?.error,
        external: { status: session?.status ?? "idle", sessionId: session?.nativeId, activities: session?.activities ?? [], approvals: [...approvals.values()].map(item => item.request) } };
    },
    async send(input: { id: string; text: string }, address?: PeerSession) {
      if (closed) throw new Error("外部 Agent 已关闭");
      if (transition) throw new Error("Agent 会话正在切换");
      if (store.error) throw new Error(store.error);
      const target = address ? addressed(address) : undefined;
      const binding: ExternalBinding | undefined = target ? JSON.parse(target.binding) as ExternalBinding : options.binding(); if (!binding) throw new Error("请先选择外部 Agent 和工作目录");
      const session = target ?? store.get(key(binding)) ?? store.create(key(binding));
      const bindingKey = `${key(binding)}:${session.id}`;
      const existing = session.messages.find(message => message.role === "user" && message.id === input.id);
      if (existing) { if (existing.text !== input.text) throw new Error("消息 ID 与已有内容冲突"); return; }
      if (active) throw new Error("Agent 正在执行，请先停止");
      const previous = { messages: session.messages, status: session.status, error: session.error, activities: session.activities, requests: session.requests };
      // Replace an older display-only peer receipt when admitting its first native continuation.
      session.messages = [...session.messages.filter(message => !(input.id.startsWith("peer-result:") && message.id === input.id && message.role === "assistant")), { id: input.id, role: "user", text: input.text }];
      session.status = "running"; session.error = undefined; session.activities = [];
      session.requests = { ...session.requests, [input.id]: { status: "running" } };
      try { persist(session); } catch (error) { Object.assign(session, previous); throw error; }
      controller = new AbortController();
      const signal = controller.signal;
      let fail!: (error: Error) => void;
      const failure = new Promise<never>((_, reject) => { fail = reject; });
      requestId = input.id; rejectExecution = fail;
      // A process can fail during startup, before its driver promise settles.
      void failure.catch(() => {});
      const abort = () => fail(new Error("执行已取消"));
      signal.addEventListener("abort", abort, { once: true });
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; fail(new Error("Agent 执行超过 30 分钟")); controller?.abort(); }, 30 * 60_000); timeout.unref();
      active = (async () => {
        try {
          if (boundKey !== bindingKey || driverFailed) await detach();
          if (!driver) {
            if (options.peerTools) peerTools = await openPeerTools(options.peerTools({ agent: binding.kind, sessionId: session.id }));
            driverController = new AbortController();
            const generation = ++driverGeneration;
            const opening = (options.factory ?? ((kind, value) => factories[kind](value)))(binding.kind, {
              cwd: binding.cwd, config: binding.config, sessionId: session.nativeId, signal: driverController.signal, searchPath: options.searchPath, env: options.env,
              peerMcp: peerTools?.config,
              emit: event => { if (generation === driverGeneration && controller && !controller.signal.aborted) emit(session, requestId, event); },
              ask: (request, requestSignal) => generation === driverGeneration ? ask(session, request, requestSignal) : Promise.resolve({ id: "", allow: false }),
              failed: error => { if (generation === driverGeneration) { driverFailed = true; rejectExecution?.(error); } },
            });
            const startup = setTimeout(() => fail(new Error("Agent 启动超过 20 秒，请检查安装和认证")), 20000); startup.unref();
            try { driver = await Promise.race([opening, failure]); boundKey = bindingKey; driverFailed = false; } finally { clearTimeout(startup); }
          }
          await Promise.race([driver.send(input.text, input.id), failure]);
          session.status = signal.aborted ? "cancelled" : "done";
        } catch (error) {
          session.status = timedOut ? "failed" : signal.aborted ? "cancelled" : "failed";
          session.error = timedOut ? "Agent 执行超过 30 分钟，已请求停止，请核对工作区" : signal.aborted ? "执行已取消，请核对已产生的文件改动" : error instanceof Error ? error.message : "Agent 执行失败";
          try { await detach(); } catch { session.status = "interrupted"; session.error = "无法确认 Agent 已停止，请核对工作区和本机进程"; }
        } finally {
          clearTimeout(timeout); signal.removeEventListener("abort", abort);
          for (const approval of [...approvals.values()]) approval.resolve({ id: approval.request.id, allow: false });
          for (const activity of session.activities) if (activity.status === "running") activity.status = "failed";
          session.requests![input.id] = { status: session.status === "done" ? "done" : session.status === "cancelled" ? "cancelled" : session.status === "interrupted" ? "interrupted" : "failed" };
          persist(session);
        }
      })().finally(() => { active = undefined; controller = undefined; rejectExecution = undefined; });
      // send acknowledges persisted intent; snapshot carries the eventual execution result.
      void active.catch(() => { session.status = "failed"; session.error = "无法保存 Agent 执行结果，记录文件已保留"; });
    },
    async runSession(job: PeerJob, started: () => Promise<void> = async () => {}): Promise<PeerCompletion | undefined> {
      const session = addressed(job.targetSession!);
      const input = { id: `peer:${job.id}`, text: job.task };
      const existing = session.messages.find(message => message.role === "user" && message.id === input.id);
      if (existing && existing.text !== input.text) throw new PeerError(409, "请求 ID 与已有内容冲突");
      if (!existing) {
        if (active || transition) return;
        await service.send(input, job.targetSession);
      }
      if (session.requests?.[input.id]?.status === "running") await started();
      if (session.requests?.[input.id]?.status === "running") await active;
      const status = session.requests?.[input.id]?.status;
      if (status !== "done") return { status: "failed", result: status === "interrupted" || !status ? "原生 Agent 上次执行结果未知，未自动重放；请核对原会话后使用新请求继续" : "原生 Agent 执行失败或取消，请核对原会话与权限" };
      const result = nativeRequestResults(session).get(input.id) ?? "";
      return { status: "done", result: (result || "任务已完成，无文字结果").slice(0, 16000) };
    },
    answer(input: AgentApprovalAnswer) {
      if (!input || typeof input.id !== "string" || typeof input.allow !== "boolean" || (input.answers !== undefined && (!input.answers || typeof input.answers !== "object" || Array.isArray(input.answers) || Object.values(input.answers).some(answer => typeof answer !== "string" || answer.length > 16000)))) throw new Error("审批响应无效");
      const pending = approvals.get(input.id); if (!pending) throw new Error("审批已结束或过期");
      if (input.allow && pending.request.questions?.some(question => !input.answers?.[question.id]?.trim())) throw new Error("请填写所有问题的回答");
      pending.resolve(input);
    },
    async newSession() { return change(async () => { await detach(); const binding = options.binding(); if (!binding) throw new Error("请先选择外部 Agent 和工作目录"); store.create(key(binding)); }); },
    async abort() { controller?.abort(); await active; await detach(); if (current()?.status === "interrupted") throw new Error("无法确认 Agent 已停止，请核对本机进程"); },
    async detach() { return change(detach); },
    async close() { closed = true; await transition; controller?.abort(); await active; await detach(); },
  };
  return service;
}
