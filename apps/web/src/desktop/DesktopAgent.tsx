import { useEffect, useRef, useState } from "react";
import type { DesktopAgentSnapshot } from "@assistant/contracts";
import { renderMarkdown } from "../chat/markdown.js";
import { Icon } from "../ui/Icon.js";
import { desktopAgentBridge } from "./bridge.js";
import { ExternalAgentSettings } from "./ExternalAgentSettings.js";
import { AgentRequests } from "./AgentRequests.js";
import { AgentPicker, agentNames } from "./AgentPicker.js";
import { WorkspaceNavigation } from "../ui/WorkspaceNavigation.js";
import { workspaceHash, type WorkspaceRoute } from "../ui/navigation.js";
import { DesktopSidebar, useDesktopSidebar } from "./DesktopSidebar.js";

const executionStates = { idle: "就绪", running: "正在执行", waiting: "等待你处理", done: "已完成", failed: "未完成", cancelled: "已取消", interrupted: "上次执行已中断" };
const localRoute: WorkspaceRoute = { page: "chat", group: null };

export function DesktopAgent() {
  const bridge = desktopAgentBridge();
  const sidebar = useDesktopSidebar();
  const [snapshot, setSnapshot] = useState<DesktopAgentSnapshot | null>(null);
  const [pollError, setPollError] = useState(""), [error, setError] = useState("");
  const [draft, setDraft] = useState(""), [sending, setSending] = useState(false);
  const [modelOpen, setModelOpen] = useState(false), [pending, setPending] = useState<string[]>([]);
  const locks = useRef(new Set<string>()), sendingLock = useRef(false);
  const request = useRef<{ id: string; text: string } | null>(null);
  const scroll = useRef<HTMLElement>(null), follow = useRef(true);
  const help = useRef<HTMLDialogElement>(null);
  const agentKind = snapshot?.agent ?? "pi";

  useEffect(() => {
    if (!bridge) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    // Schedule only after settlement so slow IPC never overlaps the next poll.
    async function poll() {
      try {
        const next = await bridge!.snapshot();
        if (!stopped) {
          setSnapshot(next); setPollError("");
        }
      } catch (cause) {
        if (!stopped) setPollError(cause instanceof Error ? cause.message : "无法读取本机状态，请重试。");
      } finally { if (!stopped) timer = setTimeout(() => void poll(), 1000); }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [bridge]);

  const messages = snapshot?.messages;
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, snapshot?.busy]);

  async function action(id: string, run: () => Promise<void>) {
    if (locks.current.has(id)) return false;
    locks.current.add(id); setPending([...locks.current]); setError("");
    try { await run(); if (bridge) setSnapshot(await bridge.snapshot()); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作未完成，请重试。"); return false; }
    finally { locks.current.delete(id); setPending([...locks.current]); }
  }

  async function send() {
    const text = draft.trim();
    if (!bridge || !snapshot?.configured || snapshot.busy || pollError || sendingLock.current || !text) return;
    sendingLock.current = true; setSending(true); setError(""); follow.current = true;
    try {
      // Keep the ID on an unconfirmed retry, not just for the lifetime of one click.
      if (request.current?.text !== text) request.current = { id: crypto.randomUUID(), text };
      await bridge.send(request.current);
      setDraft(""); request.current = null;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "发送结果未确认，请重试。"); }
    finally { sendingLock.current = false; setSending(false); }
  }

  if (!bridge) return <p role="alert">本机 Agent 连接不可用。</p>;
  const busy = !!snapshot?.busy || sending;
  const connectionWarning = error || pollError || snapshot?.error || (snapshot && !snapshot.serverConnected ? "服务器未连接" : "");
  const jobs = snapshot?.jobs ?? [];
  const showSettings = modelOpen && agentKind !== "pi";
  const showPanel = showSettings || jobs.length > 0;
  const newDisabled = busy || !snapshot || pending.includes("new-session");
  const newSession = () => {
    void action("new-session", () => bridge.newSession()).then(created => {
      if (!created) return;
      setDraft(""); request.current = null; follow.current = true;
      if (sidebar.narrow && sidebar.open) sidebar.close();
      document.querySelector<HTMLTextAreaElement>(".desktop-agent .chat-textarea")?.focus();
    });
  };
  const status = { queued: "等待批准", running: "正在执行", done: "已完成", failed: "未完成" };
  function navigate(route: WorkspaceRoute) {
    if (route.page === "chat") { scroll.current?.focus(); return; }
    void action("server", () => bridge!.openServer(workspaceHash(route)));
  }
  return <div className="app-layout desktop-agent" id="mascot-card" data-view="chat" data-desktop={bridge.platform}>
    <WorkspaceNavigation inert={sidebar.narrow && sidebar.open} route={localRoute} onNavigate={navigate} onHelp={() => help.current?.showModal()} onSearch={sidebar.open ? undefined : sidebar.toggleOpen} onNew={newSession} newDisabled={newDisabled} />
    <main className="workspace-frame">
      <DesktopSidebar sidebar={sidebar} snapshot={snapshot} onOpen={() => requestAnimationFrame(() => scroll.current?.focus())} onTeams={() => { void action("server", () => bridge.openServer("#teams")); }} onNew={newSession} newDisabled={newDisabled} />
      <div className="workspace-frame desktop-agent-content" inert={sidebar.narrow && sidebar.open}>
      <div className="chat-column" id="workspace" data-view="chat">
        <header className="conversation-header desktop-agent-header">
          <div className="conversation-heading"><span className="workspace-brand" aria-hidden="true">D</span><h1 className="conversation-title">小 D</h1></div>
          <div className="conversation-header-actions desktop-agent-controls">
            <button className="icon-button" type="button" aria-label="新对话" title="新对话" disabled={newDisabled} onClick={newSession}><Icon name="square-pen" /></button>
            {connectionWarning ? <span className="desktop-agent-warning" role="alert" aria-label={connectionWarning} title={connectionWarning} tabIndex={0}><Icon name="circle-alert" /></span> : <span className="desktop-agent-server" role="status"><span className="status-dot" data-connected={snapshot?.serverConnected === true} />{snapshot?.serverConnected ? snapshot.collaboration === "ready" ? "双端已连接" : "服务器已连接" : "正在连接"}</span>}
            {agentKind !== "pi" && <button className="header-button" type="button" aria-expanded={showSettings} aria-controls="desktop-agent-model" onClick={() => setModelOpen(value => !value)}>Agent 设置</button>}
            <button className="header-button" type="button" disabled={pending.includes("server")} onClick={() => void action("server", () => bridge.openServer())}>服务器<Icon name="arrow-up-right" /></button>
            <button className="icon-button" type="button" aria-label="连接设置" title="连接设置" disabled={pending.includes("connection")} onClick={() => void action("connection", () => bridge.openConnection())}><Icon name="settings" /></button>
          </div>
        </header>
        <section className="messages-container" ref={scroll} tabIndex={-1} aria-label="与本机小 D 的对话" onScroll={() => { const element = scroll.current!; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
          {!snapshot && <p role="status">正在读取本机状态…</p>}
          <div id="message-history" aria-live="polite" aria-relevant="additions text">
            {messages?.map(message => <section className="chat-turn" key={message.id}>{message.role === "user" ? <div className="message-row user-row"><div className="user-bubble"><div className="user-text-body">{message.text}</div></div></div> : <div className="assistant-turn"><div className="message-row assistant-row"><div className="assistant-wrapper response-card"><div className="assistant-identity"><strong>{agentKind === "pi" ? "小 D" : agentNames[agentKind]}</strong></div><div className="assistant-bubble md" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} /></div></div></div>}</section>)}
          </div>
          {snapshot?.external && <AgentRequests activities={snapshot.external.activities} approvals={snapshot.external.approvals} answer={async input => { await bridge.answerApproval(input); setSnapshot(await bridge.snapshot()); }} />}
          {(busy || snapshot?.external) && <p className="turn-loading desktop-agent-busy" role="status">{busy && snapshot?.external?.status !== "waiting" && <span className="activity-spinner" aria-hidden="true" />}{snapshot?.external ? executionStates[snapshot.external.status] : "正在处理…"}</p>}
        </section>
        <footer className="input-container">
          {snapshot && !snapshot.configured && agentKind !== "pi" && <button className="text-button desktop-agent-configure" type="button" onClick={() => setModelOpen(true)}>设置 Agent 后开始对话</button>}
          <form className="input-box-wrapper" onSubmit={event => { event.preventDefault(); void send(); }}>
            <div className="desktop-agent-composer">
              <textarea className="chat-textarea" aria-label="发送给本机小 D" placeholder="发消息给小 D" rows={2} value={draft} disabled={!snapshot?.configured || sending} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
            </div>
            <div className="desktop-agent-composer-options">
              <AgentPicker snapshot={snapshot} disabled={!snapshot || busy || pending.includes("agent")} select={kind => action("agent", () => bridge.selectAgent({ kind }))} settings={() => setModelOpen(true)} />
              <div className="composer-actions">{busy ? <button type="button" className="text-button btn-abort" disabled={pending.includes("abort")} onClick={() => void action("abort", () => bridge.abort())}><Icon name="square" />停止</button> : <button className="btn-send" type="submit" aria-label="发送消息" disabled={!snapshot?.configured || !!pollError || !draft.trim()}><Icon name="arrow-up" /></button>}</div>
            </div>
          </form>
        </footer>
      </div>
      {showPanel && <aside className="related-tasks-panel desktop-agent-panel" aria-label="本机设置与委托任务">
        {showSettings && <section id="desktop-agent-model"><header><h2>{agentNames[agentKind]}</h2><button type="button" className="icon-button" aria-label="关闭 Agent 设置" onClick={() => setModelOpen(false)}><Icon name="x" /></button></header>{snapshot && <ExternalAgentSettings key={agentKind} snapshot={snapshot} bridge={bridge} busy={busy} saved={async () => setSnapshot(await bridge.snapshot())} />}</section>}
        {jobs.length > 0 && <section className="desktop-agent-jobs" aria-labelledby="desktop-agent-jobs-title"><header><h2 id="desktop-agent-jobs-title">委托任务</h2></header>{jobs.map(job => {
          const incoming = job.target === snapshot?.nodeId && (job.source === "server" || job.source === snapshot.nodeId);
          return <article className="desktop-agent-job" key={job.id}>
          <header><strong>{job.sourceSession ? agentNames[job.sourceSession.agent] : job.source} → {job.targetSession ? agentNames[job.targetSession.agent] : job.target}</strong><span data-status={job.status}>{job.status === "queued" && job.approved ? "等待空闲" : job.status === "queued" && !incoming ? job.target === "server" ? "等待服务器" : "等待目标节点" : status[job.status]}</span></header>
          {job.targetSession && <code>{job.targetSession.sessionId}</code>}
          <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(job.task) }} />
          {job.result && <details open={job.status === "failed"}><summary>查看结果</summary><div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(job.result) }} /></details>}
          {job.deliveryError && <p role="status">{job.deliveryError}</p>}
          {job.status === "queued" && incoming && <div className="desktop-agent-job-actions">{!job.approved && <button type="button" className="header-button" disabled={pending.includes(job.id) || ((!job.targetSession || job.targetSession.agent === "pi") && !(snapshot?.piConfigured ?? snapshot?.configured)) || !!pollError} onClick={() => void action(job.id, () => bridge.approve(job.id))}>批准 {agentNames[job.targetSession?.agent ?? "pi"]} 执行</button>}<button type="button" className="header-button" disabled={pending.includes(job.id) || !!pollError} onClick={() => void action(job.id, () => bridge.reject(job.id))}>拒绝</button></div>}
        </article>; })}</section>}
      </aside>}
      </div>
    </main>
    <dialog ref={help} className="help-dialog" aria-labelledby="desktop-help-title"><form method="dialog"><button className="icon-button close-help" aria-label="关闭使用指南"><Icon name="x" /></button></form><h2 id="desktop-help-title">使用指南</h2><ul><li>对话使用本机选择的 Agent，其配置与登录由对应 Agent 管理。</li><li>待办、通知及「更多」中的个人内容在服务器窗口打开，本机对话继续保留。</li><li>服务器请求使用本机资源时，需要先在本机批准委托任务。</li></ul></dialog>
  </div>;
}
