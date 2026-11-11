import { useEffect, useRef, useState } from "react";
import type { SubmitEvent } from "react";
import type { DesktopAgentSnapshot } from "@assistant/contracts";
import { renderMarkdown } from "../chat/markdown.js";
import { Icon } from "../ui/Icon.js";
import { desktopAgentBridge } from "./bridge.js";
import type { DesktopAgentBridge } from "./bridge.js";
import { ExternalAgentSettings } from "./ExternalAgentSettings.js";
import { AgentRequests } from "./AgentRequests.js";
import { AgentPicker, agentNames } from "./AgentPicker.js";

const executionStates = { idle: "就绪", running: "正在执行", waiting: "等待你处理", done: "已完成", failed: "未完成", cancelled: "已取消", interrupted: "上次执行已中断" };

interface ModelFormProps {
  bridge: DesktopAgentBridge;
  model: DesktopAgentSnapshot["model"];
  busy: boolean;
}

function ModelForm({ bridge, model, busy }: ModelFormProps) {
  const [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || busy) return;
    const form = event.currentTarget, values = new FormData(form);
    const contextWindow = Number(values.get("contextWindow")), maxTokens = Number(values.get("maxTokens"));
    if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || contextWindow < maxTokens) {
      setError("上下文窗口和最大输出必须是正整数，且最大输出不能超过上下文窗口。"); return;
    }
    lock.current = true; setSaving(true); setError(""); setFeedback("");
    const apiKey = String(values.get("apiKey") ?? "");
    try {
      const result = await bridge.saveModel({
        api: String(values.get("api")).trim(), baseUrl: String(values.get("baseUrl")).trim(),
        model: String(values.get("model")).trim(), contextWindow, maxTokens,
        ...(apiKey ? { apiKey } : {}),
      });
      setFeedback(result.persistedKey ? "模型已保存，密钥已安全保存。" : "模型已保存，本次未持久保存新密钥。");
    } catch {
      // Native errors may contain request credentials. Never echo them into the page.
      setError("模型保存失败，请检查接口、模型和密钥后重试。");
    } finally {
      const keyInput = form.elements.namedItem("apiKey");
      if (keyInput instanceof HTMLInputElement) keyInput.value = "";
      lock.current = false; setSaving(false);
    }
  }
  return <form className="settings-form desktop-model-form" onSubmit={event => void save(event)} aria-label="本机模型设置" aria-busy={saving}>
    <fieldset disabled={saving || busy}>
      <label>接口协议<input name="api" defaultValue={model.api} required autoComplete="off" /></label>
      <label>Base URL<input name="baseUrl" type="url" defaultValue={model.baseUrl} required autoComplete="off" /></label>
      <label>模型<input name="model" defaultValue={model.model} required autoComplete="off" /></label>
      <label>API Key<input name="apiKey" type="password" autoComplete="new-password" placeholder={model.hasApiKey ? "已配置，留空保留" : "未配置"} /></label>
      <label>上下文窗口<input name="contextWindow" type="number" min="1" step="1" defaultValue={model.contextWindow} required /></label>
      <label>最大输出<input name="maxTokens" type="number" min="1" step="1" defaultValue={model.maxTokens} required /></label>
    </fieldset>
    {error && <p className="settings-error" role="alert">{error}</p>}
    {feedback && <p className="settings-feedback" role="status">{feedback}</p>}
    <button className="settings-save" type="submit" disabled={saving || busy}>{saving ? "正在保存…" : "保存模型"}</button>
  </form>;
}

export function DesktopAgent() {
  const bridge = desktopAgentBridge();
  const [snapshot, setSnapshot] = useState<DesktopAgentSnapshot | null>(null);
  const [pollError, setPollError] = useState(""), [error, setError] = useState("");
  const [draft, setDraft] = useState(""), [sending, setSending] = useState(false);
  const [modelOpen, setModelOpen] = useState(false), [pending, setPending] = useState<string[]>([]);
  const locks = useRef(new Set<string>()), sendingLock = useRef(false);
  const request = useRef<{ id: string; text: string } | null>(null);
  const scroll = useRef<HTMLElement>(null), follow = useRef(true);
  const initialized = useRef(false);
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
          if (!initialized.current) { initialized.current = true; setModelOpen(!next.configured); }
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
  const jobs = snapshot?.jobs ?? [];
  const showPanel = modelOpen || jobs.length > 0;
  const status = { queued: "等待批准", running: "正在执行", done: "已完成", failed: "未完成" };
  return <div className="app-layout desktop-agent" id="mascot-card" data-view="chat" data-desktop={window.desktopServer?.platform}>
    <main className="workspace-frame">
      <div className="chat-column" id="workspace" data-view="chat">
        <header className="conversation-header desktop-agent-header">
          <div className="conversation-heading"><span className="workspace-brand" aria-hidden="true">D</span><h1 className="conversation-title">小 D</h1></div>
          <div className="conversation-header-actions desktop-agent-controls">
            <span className="desktop-agent-server" role="status"><span className="status-dot" data-connected={snapshot?.serverConnected === true} />{snapshot?.serverConnected ? "服务器已连接" : "服务器未连接"}</span>
            <button className="header-button" type="button" aria-expanded={modelOpen} aria-controls="desktop-agent-model" onClick={() => setModelOpen(value => !value)}>{agentKind === "pi" ? "本机模型" : "Agent 设置"}</button>
            <button className="header-button" type="button" disabled={pending.includes("server")} onClick={() => void action("server", () => bridge.openServer())}>服务器工作区<Icon name="arrow-up-right" /></button>
            <button className="icon-button" type="button" aria-label="连接设置" title="连接设置" disabled={pending.includes("connection")} onClick={() => void action("connection", () => bridge.openConnection())}><Icon name="settings" /></button>
          </div>
        </header>
        <div className="desktop-agent-workspace">
          <button className="text-button" type="button" disabled={!snapshot || busy || pending.includes("workspace")} title={snapshot?.workspace ?? undefined} onClick={() => void action("workspace", () => bridge.chooseWorkspace())}><Icon name="folder" /><span>{snapshot?.workspace || "选择工作目录"}</span></button>
          {agentKind !== "pi" && <button className="text-button" type="button" disabled={busy || !snapshot?.workspace || pending.includes("new-session")} onClick={() => void action("new-session", () => bridge.newSession())}>新会话</button>}
        </div>
        {(error || pollError || snapshot?.error) && <div className="desktop-agent-error" role="alert">{error || pollError || snapshot?.error}</div>}
        <section className="messages-container" ref={scroll} aria-label="与本机小 D 的对话" onScroll={() => { const element = scroll.current!; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
          {!snapshot && <p role="status">正在读取本机状态…</p>}
          <div id="message-history" aria-live="polite" aria-relevant="additions text">
            {messages?.map(message => <section className="chat-turn" key={message.id}>{message.role === "user" ? <div className="message-row user-row"><div className="user-bubble"><div className="user-text-body">{message.text}</div></div></div> : <div className="assistant-turn"><div className="message-row assistant-row"><div className="assistant-wrapper response-card"><div className="assistant-identity"><strong>{agentKind === "pi" ? "小 D" : agentNames[agentKind]}</strong></div><div className="assistant-bubble md" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} /></div></div></div>}</section>)}
          </div>
          {snapshot?.external && <AgentRequests activities={snapshot.external.activities} approvals={snapshot.external.approvals} answer={async input => { await bridge.answerApproval(input); setSnapshot(await bridge.snapshot()); }} />}
          {(busy || snapshot?.external) && <p className="turn-loading desktop-agent-busy" role="status">{busy && snapshot?.external?.status !== "waiting" && <span className="activity-spinner" aria-hidden="true" />}{snapshot?.external ? executionStates[snapshot.external.status] : "正在处理…"}</p>}
        </section>
        <footer className="input-container">
          {snapshot && !snapshot.configured && <button className="text-button desktop-agent-configure" type="button" onClick={() => setModelOpen(true)}>{agentKind === "pi" ? "配置本机模型后开始对话" : "设置 Agent 并选择工作目录"}</button>}
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
        {modelOpen && <section id="desktop-agent-model"><header><h2>{agentKind === "pi" ? "本机模型" : agentNames[agentKind]}</h2><button type="button" className="icon-button" aria-label="关闭本机模型设置" onClick={() => setModelOpen(false)}><Icon name="x" /></button></header>{snapshot && (agentKind === "pi" ? <ModelForm bridge={bridge} model={snapshot.model} busy={busy} /> : <ExternalAgentSettings key={agentKind} snapshot={snapshot} bridge={bridge} busy={busy} saved={async () => setSnapshot(await bridge.snapshot())} />)}</section>}
        {jobs.length > 0 && <section className="desktop-agent-jobs" aria-labelledby="desktop-agent-jobs-title"><header><h2 id="desktop-agent-jobs-title">委托任务</h2></header>{jobs.map(job => {
          const incoming = job.target === snapshot?.nodeId && job.source === "server";
          return <article className="desktop-agent-job" key={job.id}>
          <header><strong>{job.source} → {job.target}</strong><span data-status={job.status}>{job.status === "queued" && !incoming ? job.target === "server" ? "等待服务器" : "等待目标节点" : status[job.status]}</span></header>
          <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(job.task) }} />
          {job.result && <details open={job.status === "failed"}><summary>查看结果</summary><div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(job.result) }} /></details>}
          {job.status === "queued" && incoming && <div className="desktop-agent-job-actions"><button type="button" className="header-button" disabled={pending.includes(job.id) || busy || !(snapshot?.piConfigured ?? snapshot?.configured) || !!pollError} onClick={() => void action(job.id, () => bridge.approve(job.id))}>批准 Pi 执行</button><button type="button" className="header-button" disabled={pending.includes(job.id) || !!pollError} onClick={() => void action(job.id, () => bridge.reject(job.id))}>拒绝</button></div>}
        </article>; })}</section>}
      </aside>}
    </main>
  </div>;
}
