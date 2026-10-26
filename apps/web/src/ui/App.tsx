import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CardGroup } from "../chat/cards.js";
import { useConversation } from "../chat/useConversation.js";
import { Composer } from "../chat/Composer.js";
import { ChatThread } from "../chat/ChatThread.js";
import { CardPanel } from "../tasks/CardPanel.js";
import { Icon } from "./Icon.js";
import { ModelSettings } from "../settings/ModelSettings.js";
import { MailNotifications } from "../mail/MailNotifications.js";
import { DailyReports } from "../daily-reports/DailyReports.js";
import { mascotStatus } from "./mascot.js";
import { WorkspaceData } from "../workspace/WorkspaceData.js";
import { WorkspaceNavigation } from "./WorkspaceNavigation.js";
import { ConversationHistory } from "./ConversationHistory.js";
import { readWorkspaceRoute, workspaceHash } from "./navigation.js";
import type { WorkspaceRoute } from "./navigation.js";
import { TodayPage } from "../today/TodayPage.js";
import { ActivityPage } from "../today/ActivityPage.js";
import { showToast } from "./toast.js";
const DaylightPage = lazy(() => import("../daylight/DaylightPage.js"));

const groupLabels: Record<CardGroup, string> = { tasks: "任务与提醒", memory: "长期记忆", notes: "笔记", skills: "本机技能" };
const groupDescriptions: Record<CardGroup, string> = {
  skills: "浏览这台电脑上的技能目录，按来源查找和管理。",
  memory: "查看小 D 记住的偏好与背景，决定哪些继续保留。",
  notes: "回看这段对话中的想法与决定，需要时再补充。",
  tasks: "查看这段对话的安排与执行状态。跨对话进展在「通知」中查看。",
};
const pageLabels = { home: "今日", chat: "与小 D 对话", daylight: "待办", activity: "通知中心", reports: "每日日报", settings: "连接与设置", data: "个人内容" };

export function App() {
  const [route, setRoute] = useState(() => readWorkspaceRoute(typeof window === "undefined" ? "" : window.location.hash));
  const { page, group } = route;
  const { view, connection, info, recoveredUntil, connectDirectChat, newConversation, openConversation } = useConversation(route.conversationId);
  const [reportsOpened, setReportsOpened] = useState(page === "reports"), [daylightOpened, setDaylightOpened] = useState(page === "daylight");
  const [draft, setDraft] = useState(""), [historyOpen, setHistoryOpen] = useState(false), [routeError, setRouteError] = useState("");
  const [, tick] = useState(0);
  const scroll = useRef<HTMLElement>(null), autoScroll = useRef(true), help = useRef<HTMLDialogElement>(null), service = useRef<HTMLDetailsElement>(null);
  const draftValue = useRef(draft); draftValue.current = draft;
  const drafts = useRef(new Map<number | null, string>()), draftOwner = useRef<number | null>(route.conversationId ?? null);
  const settingsOrigin = useRef<WorkspaceRoute>({ page: "home", group: null });
  function navigate(next: WorkspaceRoute, replace = false) {
    if (next.page === "settings" && page !== "settings") settingsOrigin.current = route;
    setRoute(next); setRouteError("");
    const hash = workspaceHash(next);
    if (window.location.hash !== hash) window.history[replace ? "replaceState" : "pushState"](null, "", hash);
  }
  useEffect(() => {
    const restore = () => { setRoute(readWorkspaceRoute(window.location.hash)); setRouteError(""); };
    window.addEventListener("hashchange", restore); window.addEventListener("popstate", restore);
    return () => { window.removeEventListener("hashchange", restore); window.removeEventListener("popstate", restore); };
  }, []);
  useEffect(() => {
    if (page === "reports") setReportsOpened(true);
    if (page === "daylight") setDaylightOpened(true);
    if (!route.conversationId) return;
    let current = true;
    void openConversation(route.conversationId).catch(error => { if (current) setRouteError(error instanceof Error ? error.message : "对话读取失败"); });
    return () => { current = false; };
  }, [page, route.conversationId]);
  useEffect(() => {
    if (!view) return;
    if (draftOwner.current !== view.conversationId) {
      drafts.current.set(draftOwner.current, draftValue.current);
      // 第一次连接前输入的文字属于当前打开的对话。
      setDraft(drafts.current.get(view.conversationId) ?? (draftOwner.current === null ? draftValue.current : ""));
      draftOwner.current = view.conversationId;
    }
    if (page === "chat" && !route.conversationId) navigate({ page: "chat", group: null, conversationId: view.conversationId }, true);
  }, [view?.conversationId, page]);
  useEffect(() => { const timer = setInterval(() => tick(value => value + 1), 1000); return () => clearInterval(timer); }, []);
  useLayoutEffect(() => { if (page === "chat" && autoScroll.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [view, page]);
  useEffect(() => {
    const closeOutside = (event: Event) => { if (service.current?.open && !service.current.contains(event.target as Node)) service.current.open = false; };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && service.current?.open) { service.current.open = false; service.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", closeOutside); document.addEventListener("focusin", closeOutside); document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("focusin", closeOutside); document.removeEventListener("keydown", closeOnEscape); };
  }, []);
  useEffect(() => { if (service.current) service.current.open = false; }, [page, group]);
  const mascot = mascotStatus({ currentViewData: view, isDisconnected: connection !== "connected", isRecovered: recoveredUntil > Date.now(), recoveredUntil });
  function prompt(text: string) { setDraft(text); navigate({ page: "chat", group: null, conversationId: view?.conversationId }); setTimeout(() => document.getElementById("chat-textarea")?.focus(), 0); }
  function openGroup(next: CardGroup) { navigate({ page: "data", group: next, ...(["tasks", "notes"].includes(next) && view ? { conversationId: view.conversationId } : {}) }); }
  function openChat(id: number) { setHistoryOpen(false); autoScroll.current = true; navigate({ page: "chat", group: null, conversationId: id }); }
  async function startChat() {
    const nextId = await newConversation(); autoScroll.current = true; setHistoryOpen(false);
    navigate({ page: "chat", group: null, conversationId: nextId });
  }
  const settings = () => navigate({ page: "settings", group: null });
  const headerActions = <div className="header-actions management-actions"><details ref={service} className="service-menu"><summary className="header-button" aria-label={`服务状态：${connection !== "connected" ? "连接中" : info?.configured === false ? "模型待配置" : "已连接"}`}><span className="status-dot" /><span>{connection !== "connected" ? "连接中" : info?.configured === false ? "模型待配置" : "已连接"}</span><Icon name="chevron-down" /></summary><div className="service-popover"><strong>小 D 的状态</strong><p role="status">{mascot.text}</p><p>服务连接：{connection === "connected" ? "正常" : "正在重连"}</p><p>{info?.configured ? "当前模型：" + info.model : "模型尚未就绪，可先整理待办与个人内容。"}</p><button className="text-button" type="button" onClick={settings}>管理连接与设置<Icon name="arrow-up-right" /></button></div></details><button className="icon-button header-help" type="button" aria-label="使用指南" onClick={() => help.current?.showModal()}><Icon name="circle-help" /></button></div>;
  return <>
    <a className="workspace-skip" href="#workspace" onClick={event => { event.preventDefault(); document.getElementById("workspace")?.focus(); }}>跳到主要内容</a>
    <MailNotifications />
    {connection !== "connected" && <div id="reconnect-banner" className="reconnect-banner" style={{ display: "flex" }} role="status"><div className="reconnect-spinner" /><span>{connection === "connecting" ? "正在连接小 D…" : "与服务器断开，正在重连…"}</span></div>}
    <div className="app-layout" id="mascot-card" data-state={mascot.state}>
      <WorkspaceNavigation route={route} onNavigate={navigate} onHelp={() => help.current?.showModal()} />
      <main className="chat-column" id="workspace" data-view={page} tabIndex={-1}>
        {page !== "daylight" && !(page === "data" && group === "notes") && <header className="workspace-header management-header"><div className="workspace-location"><span>我的空间</span><span aria-hidden="true">/</span><strong>{page === "data" && group ? groupLabels[group] : pageLabels[page]}</strong></div>{headerActions}</header>}
        {routeError && <p className="workspace-route-error" role="alert">{routeError}<a href="#activity" onClick={event => { event.preventDefault(); navigate({ page: "activity", group: null }); }}>返回动态</a></p>}
        <TodayPage active={page === "home"} onPrompt={prompt} onGroup={openGroup} onDaylight={taskId => navigate({ page: "daylight", group: null, taskId })} onActivities={() => navigate({ page: "activity", group: null })} onSettings={settings} onConversation={openChat} />
        <ActivityPage active={page === "activity"} onConversation={openChat} onManage={id => navigate({ page: "data", group: "tasks", conversationId: id })} onSettings={() => { settings(); requestAnimationFrame(() => document.getElementById("notifications-title")?.scrollIntoView({ block: "start" })); }} />
        {page === "settings" && <ModelSettings onBack={() => navigate(settingsOrigin.current)} />}
        {reportsOpened && <DailyReports active={page === "reports"} />}
        {daylightOpened && <Suspense fallback={<p role="status">正在读取待办界面…</p>}><DaylightPage active={page === "daylight"} taskId={route.taskId} headerActions={page === "daylight" ? headerActions : null} /></Suspense>}
        {page === "chat" && <div className="conversation-toolbar"><button className="header-button" type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}><Icon name="notebook-pen" /><span>历史对话</span></button><span>{view ? `对话 #${view.conversationId}` : "继续一段对话"}</span><button className="header-button" type="button" disabled={!!view?.busy} onClick={() => { void startChat().catch(error => showToast(error.message, "error")); }}><Icon name="plus" />新对话</button></div>}
        {page === "chat" && <ConversationHistory active={historyOpen} currentId={view?.conversationId ?? null} onOpen={openChat} onClose={() => setHistoryOpen(false)} />}
        <section ref={scroll} hidden={page !== "chat" && page !== "data"} className={page === "data" ? group === "notes" ? "data-panel data-panel-notes" : "data-panel" : "messages-container"} id="messages-container" aria-label={page === "data" && group ? groupLabels[group] : "与小 D 的对话"} onScroll={() => { if (page !== "chat") return; const el = scroll.current!; autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {page === "data" ? <header className="data-panel-heading"><div><h1>{group && groupLabels[group]}</h1><p>{group && groupDescriptions[group]}</p></div>{group === "tasks" && <button className="text-button" type="button" onClick={() => navigate({ page: "activity", group: null })}>全部动态<Icon name="arrow-up-right" /></button>}</header> : <div id="message-history" aria-live="polite"><ChatThread view={view} onRetry={draft.trim() ? undefined : prompt} onSettings={settings} /></div>}
          <div hidden={page !== "chat"}><CardPanel view={view} onPrompt={prompt} /></div>
          <WorkspaceData group={page === "data" ? group : null} owner={route.conversationId ?? view?.conversationId ?? null} connect={connectDirectChat} headerActions={page === "data" && group === "notes" ? headerActions : null} />
        </section>
        <footer className="input-container" hidden={page !== "chat"}><Composer draft={draft} setDraft={setDraft} view={view} connect={connectDirectChat} onSent={() => { autoScroll.current = true; navigate({ page: "chat", group: null, conversationId: view?.conversationId }); }} onNewConversation={startChat} /><div className="composer-footer"><span className="composer-hint">{info?.configured ? "小 D 会记得接下来要做的事" : "可先整理待办，服务器配置模型后开始对话"}</span><span className="keyboard-hint">Enter 发送 · Shift + Enter 换行</span></div></footer>
      </main>
    </div>
    <dialog ref={help} className="help-dialog" aria-labelledby="help-title"><form method="dialog"><button className="icon-button close-help" aria-label="关闭使用指南"><Icon name="x" /></button></form><div className="help-mark"><Icon name="sparkles" /></div><h2 id="help-title">你好，我是小 D</h2><p>一起整理今天，也把交代的事情继续做完。</p><ul><li>「今日」汇总待办、任务与邮件；「通知」查看跨对话进展。</li><li>在对话中发送文字、图片或文件，用「历史对话」接着上次聊。</li><li>本机技能按目录浏览和导入；记忆和笔记先查看，新增或编辑时再填写内容。远程小 D 提议的内容经你批准后生效。</li><li>输入 / 使用快捷指令，/new 新建、/help 查看说明、/stop 停止回复。</li></ul><p className="help-note">后台任务由独立服务端运行。关闭网页或桌面客户端后，服务端保持在线即可继续执行。</p></dialog>
  </>;
}
