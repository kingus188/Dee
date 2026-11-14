import { SearchMessage } from "./SearchMessage.js";
import { lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ConversationItem } from "@assistant/contracts";
import type { CardGroup } from "../chat/cards.js";
import { useConversation } from "../chat/useConversation.js";
import { Composer } from "../chat/Composer.js";
import { chatTurns } from "../chat/turns.js";
import { ChatThread } from "../chat/ChatThread.js";
import type { ChatRecord } from "../chat/TeamsRecords.js";
import { CardPanel } from "../tasks/CardPanel.js";
import { Icon } from "./Icon.js";
import { WorkspaceBrand } from "./WorkspaceBrand.js";
import { ModelSettings } from "../settings/ModelSettings.js";
import { MailNotifications } from "../mail/MailNotifications.js";
import { PageLoad } from "./PageLoad.js";
import { mascotStatus } from "./mascot.js";
import { WorkspaceData } from "../workspace/WorkspaceData.js";
import { WorkspaceNavigation } from "./WorkspaceNavigation.js";
import { ExternalConversationPanel } from "./ExternalConversationPanel.js";
import { ConversationHistory } from "./ConversationHistory.js";
import { readWorkspaceRoute, workspaceHash } from "./navigation.js";
import type { WorkspaceRoute } from "./navigation.js";
import { TodayPage } from "../today/TodayPage.js";
import { ActivityPage } from "../today/ActivityPage.js";
import { useDesktopConversation } from "../desktop/useDesktopConversation.js";
import { DesktopAgent, DesktopAgentControls } from "../desktop/DesktopAgent.js";
import { showToast } from "./toast.js";
const TeamsConversations = lazy(() => import("../teams/TeamsConversations.js").then(module => ({ default: module.TeamsConversations })));
const DaylightPage = lazy(() => import("../daylight/DaylightPage.js"));
const DailyReports = lazy(() => import("../daily-reports/DailyReports.js").then(module => ({ default: module.DailyReports })));

const groupLabels: Record<CardGroup, string> = { tasks: "任务与提醒", memory: "长期记忆", notes: "笔记", skills: "本机技能" };
const groupDescriptions: Record<CardGroup, string> = {
  skills: "浏览这台电脑上的技能目录，按来源查找和管理。",
  memory: "查看小 D 记住的偏好与背景，决定哪些继续保留。",
  notes: "整理个人笔记与决定。",
  tasks: "查看这段对话的安排与执行状态。跨对话进展在「通知」中查看。",
};
const pageLabels = { home: "今日", chat: "与小 D 对话", teams: "Teams", daylight: "待办", activity: "通知中心", reports: "每日日报", settings: "连接与设置", data: "个人内容" };

export function App() {
  const local = useDesktopConversation();
  const [execution, setExecution] = useState<"local" | "server">(() => local.bridge && (!window.location.hash || readWorkspaceRoute(window.location.hash).execution === "local") ? "local" : "server");
  const localChat = execution === "local" && !!local.bridge;
  const [route, setRoute] = useState(() => {
    const next = readWorkspaceRoute(typeof window === "undefined" ? "" : window.location.hash);
    return localChat && next.page === "chat" ? { page: "chat" as const, group: null, execution: "local" as const } : next;
  });
  const { page, group } = route;
  const dataLabel = group === "skills" && route.skillSource === "remote" ? "远程技能" : group ? groupLabels[group] : "个人内容";
  const dataDescription = group === "skills" && route.skillSource === "remote" ? "查看和批准远程小 D 的技能记录。" : group ? groupDescriptions[group] : "";
  const server = useConversation(route.conversationId);
  const { connection, info, recoveredUntil, connectDirectChat, newConversation, openConversation } = server;
  const view = localChat ? local.view : server.view;
  const pendingMessages = localChat ? [] : server.pendingMessages;
  const send = localChat ? local.send : server.send;
  const [teamsOpened, setTeamsOpened] = useState(page === "teams");
  const [historyItems, setHistoryItems] = useState<ConversationItem[]>([]);
  const [reportsOpened, setReportsOpened] = useState(page === "reports"), [daylightOpened, setDaylightOpened] = useState(page === "daylight");
  const [draft, setDraft] = useState(""), [routeError, setRouteError] = useState("");
  const [quotes, setQuotes] = useState(new Map<number, ChatRecord>());
  const [narrow, setNarrow] = useState(() => window.matchMedia?.("(max-width: 900px)").matches ?? false);
  const [historyExpanded, setHistoryExpanded] = useState(() => {
    try { return (window.localStorage.getItem("dee.history.collapsed") ?? window.localStorage.getItem("dee.sidebar.collapsed")) !== "true"; }
    catch { return true; }
  });
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [relatedNarrow, setRelatedNarrow] = useState(() => window.matchMedia?.("(max-width: 1199px)").matches ?? false);
  const [relatedExpanded, setRelatedExpanded] = useState(() => {
    try { return window.localStorage.getItem("dee.related.collapsed") !== "true"; } catch { return true; }
  });
  const [relatedDrawer, setRelatedDrawer] = useState(false), [relatedHost, setRelatedHost] = useState<HTMLDivElement | null>(null);
  const [relatedStats, setRelatedStats] = useState<{ owner: number | null; count: number }>({ owner: null, count: 0 });
  const relatedOwner = route.conversationId ?? view?.conversationId ?? null;
  const reportRelatedCount = useCallback((count: number) => setRelatedStats({ owner: relatedOwner, count }), [relatedOwner]);
  const relatedCount = relatedStats.owner === relatedOwner ? relatedStats.count : 0;
  const relatedOpen = page === "chat" && view?.channel !== "wechat" && relatedCount > 0 && (relatedNarrow ? relatedDrawer : relatedExpanded);
  const relatedModal = relatedOpen && relatedNarrow;
  const relatedPanel = useRef<HTMLElement>(null), relatedToggle = useRef<HTMLButtonElement>(null), relatedReturnFocus = useRef<HTMLElement | null>(null);
  const restoreRelatedFocus = useRef(false);
  function setRelatedOpen(open: boolean) {
    if (relatedNarrow) { setRelatedDrawer(open); if (open) setMobileHistoryOpen(false); }
    else { setRelatedExpanded(open); try { window.localStorage.setItem("dee.related.collapsed", String(!open)); } catch { /* Optional preference. */ } }
  }
  function openRelatedDetails() {
    relatedReturnFocus.current = document.activeElement as HTMLElement;
    setRelatedOpen(true);
    requestAnimationFrame(() => relatedPanel.current?.querySelector<HTMLElement>(".related-panel-close")?.focus());
  }
  function closeRelatedDetails() {
    restoreRelatedFocus.current = true;
    setRelatedOpen(false);
  }
  useLayoutEffect(() => {
    if (relatedOpen || !restoreRelatedFocus.current) return;
    restoreRelatedFocus.current = false;
    const previous = relatedReturnFocus.current;
    // The background must no longer be inert before browsers can restore focus.
    (previous?.isConnected && !previous.closest("[hidden], [inert]") ? previous : relatedToggle.current)?.focus();
  }, [relatedOpen]);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 1199px)");
    if (!media) return;
    const resize = () => {
      if (relatedPanel.current?.contains(document.activeElement)) restoreRelatedFocus.current = true;
      setRelatedNarrow(media.matches); setRelatedDrawer(false);
    };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  useEffect(() => { setRelatedDrawer(false); }, [page, relatedOwner]);
  useEffect(() => {
    if (!relatedModal) return;
    relatedPanel.current?.querySelector<HTMLElement>(".related-panel-close")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRelatedDetails(); return; }
      if (event.key !== "Tab") return;
      const controls = [...relatedPanel.current?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), select, summary") ?? []].filter(element => !element.closest("[hidden]") && !element.closest("details:not([open]) > :not(summary)"));
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !relatedPanel.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !relatedPanel.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => document.removeEventListener("keydown", trap);
  }, [relatedModal]);
  const [historyRevision, refreshHistory] = useState(0);
  useEffect(() => { refreshHistory(value => value + 1); }, [server.view?.conversationId, server.view?.archivedAt, server.view?.archivingAt, server.view?.status]);
  const historyOpen = narrow ? mobileHistoryOpen : historyExpanded;
  function setHistoryOpen(open: boolean) {
    if (narrow) setMobileHistoryOpen(open);
    else {
      setHistoryExpanded(open);
      try { window.localStorage.setItem("dee.history.collapsed", String(!open)); }
      catch { /* The history panel still works without browser storage. */ }
    }
  }
  function closeHistory() { setHistoryOpen(false); historyToggle.current?.focus(); }
  function toggleHistory() {
    setHistoryOpen(!historyOpen);
    if (!historyOpen) requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".history-search input")?.focus());
  }
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 900px)");
    if (!media) return;
    const resize = () => { setNarrow(media.matches); setMobileHistoryOpen(false); };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    if (!narrow || !historyOpen || page !== "chat") return;
    const closeOrTrap = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeHistory(); return; }
      if (event.key !== "Tab") return;
      const controls = [...document.querySelectorAll<HTMLElement>(".conversation-sidebar a[href], .conversation-sidebar button:not(:disabled), .conversation-sidebar input, .conversation-sidebar select, .conversation-sidebar summary")].filter(element => !element.closest("[hidden]") && !element.closest("details:not([open]) > :not(summary)"));
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !document.querySelector(".conversation-sidebar")?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", closeOrTrap);
    return () => document.removeEventListener("keydown", closeOrTrap);
  }, [narrow, historyOpen, page]);
  useEffect(() => {
    if (historyOpen) return;
    const search = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault(); setHistoryOpen(true);
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".history-search input")?.focus());
    };
    document.addEventListener("keydown", search);
    return () => document.removeEventListener("keydown", search);
  }, [historyOpen, narrow]);
  const [, tick] = useState(0);
  const historyToggle = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLElement>(null), autoScroll = useRef(true), help = useRef<HTMLDialogElement>(null), service = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => { if (route.entryId && scroll.current) scroll.current.scrollTop = 0; }, [route.conversationId, route.entryId]);
  const draftValue = useRef(draft); draftValue.current = draft;
  const drafts = useRef(new Map<number | null, string>()), draftOwner = useRef<number | null>(route.conversationId ?? null);
  const lastTeamsChat = useRef(route.page === "teams" ? route.chatId : undefined);
  if (page === "teams") lastTeamsChat.current = route.chatId;
  const currentDestination = useRef({ route, execution }); currentDestination.current = { route, execution };
  const settingsOrigin = useRef<WorkspaceRoute>({ page: "home", group: null });
  function navigate(next: WorkspaceRoute, replace = false) {
    if (next.page === "chat") {
      const target = next.conversationId ? "server" : next.execution ?? execution;
      next = target === "local" && local.bridge ? { page: "chat", group: null, execution: "local" } : { ...next, execution: undefined };
      setExecution(target === "local" && local.bridge ? "local" : "server");
    }
    if (next.page === "settings" && page !== "settings") settingsOrigin.current = route;
    setRoute(next); setRouteError(""); setMobileHistoryOpen(false);
    const hash = workspaceHash(next);
    if (window.location.hash !== hash) window.history[replace ? "replaceState" : "pushState"](null, "", hash);
  }
  useEffect(() => {
    const restore = () => { const next = readWorkspaceRoute(window.location.hash); if (next.page === "chat") setExecution(next.execution === "local" && local.bridge ? "local" : "server"); setRoute(next); setRouteError(""); setMobileHistoryOpen(false); };
    window.addEventListener("hashchange", restore); window.addEventListener("popstate", restore);
    return () => { window.removeEventListener("hashchange", restore); window.removeEventListener("popstate", restore); };
  }, []);
  useEffect(() => {
    if (page === "teams") setTeamsOpened(true);
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
    if (page === "chat" && !route.conversationId && !localChat) navigate({ page: "chat", group: null, conversationId: view.conversationId }, true);
  }, [view?.conversationId, page, localChat]);
  useEffect(() => { const timer = setInterval(() => tick(value => value + 1), 1000); return () => clearInterval(timer); }, []);
  useLayoutEffect(() => { if (page === "chat" && !route.entryId && autoScroll.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [view, page, pendingMessages, route.entryId]);
  useEffect(() => {
    const closeOutside = (event: Event) => { if (service.current?.open && !service.current.contains(event.target as Node)) service.current.open = false; };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && service.current?.open) { service.current.open = false; service.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", closeOutside); document.addEventListener("focusin", closeOutside); document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("focusin", closeOutside); document.removeEventListener("keydown", closeOnEscape); };
  }, []);
  useEffect(() => { if (service.current) service.current.open = false; }, [route]);
  const mascot = mascotStatus({ currentViewData: view, isDisconnected: connection !== "connected", isRecovered: recoveredUntil > Date.now(), recoveredUntil });
  function prompt(text: string) { setRelatedDrawer(false); setDraft(text); navigate({ page: "chat", group: null, ...(localChat ? { execution: "local" as const } : { conversationId: view?.conversationId }) }); setTimeout(() => document.getElementById("chat-textarea")?.focus(), 0); }
  function openGroup(next: CardGroup) { navigate({ page: "data", group: next, ...(next === "skills" ? { skillSource: "remote" as const } : {}), ...(next === "tasks" && server.view ? { conversationId: server.view.conversationId } : {}) }); }
  function openChat(id: number) { setMobileHistoryOpen(false); autoScroll.current = true; navigate({ page: "chat", group: null, conversationId: id }); if (narrow) requestAnimationFrame(() => document.getElementById("chat-textarea")?.focus()); }
  async function startChat() {
    const origin = currentDestination.current;
    if (localChat) {
      await local.newConversation(); drafts.current.delete(-1);
      if (currentDestination.current.route !== origin.route || currentDestination.current.execution !== origin.execution) return;
      setDraft(""); setMobileHistoryOpen(false);
      navigate({ page: "chat", group: null, execution: "local" });
      requestAnimationFrame(() => document.getElementById("chat-textarea")?.focus());
      return;
    }
    const nextId = await newConversation();
    if (currentDestination.current.route !== origin.route || currentDestination.current.execution !== origin.execution) return;
    autoScroll.current = true; setMobileHistoryOpen(false);
    navigate({ page: "chat", group: null, conversationId: nextId });
    requestAnimationFrame(() => document.getElementById("chat-textarea")?.focus());
  }
  function selectExecution(target: "local" | "server") {
    if (target === execution || target === "local" && !local.bridge) return;
    drafts.current.set(draftOwner.current, draftValue.current);
    const owner = target === "local" ? -1 : server.view?.conversationId ?? null;
    draftOwner.current = owner; setDraft(drafts.current.get(owner) ?? "");
    setExecution(target);
    navigate(target === "local" ? { page: "chat", group: null, execution: "local" } : { page: "chat", group: null, execution: "server", conversationId: server.view?.conversationId });
  }
  function switchConversationSource(next: "chat" | "teams") {
    navigate(next === "teams" ? { page: "teams", group: null, chatId: lastTeamsChat.current } : localChat ? { page: "chat", group: null, execution: "local" } : { page: "chat", group: null, conversationId: view?.conversationId });
    requestAnimationFrame(() => document.getElementById("workspace")?.focus());
  }
  const settings = () => navigate({ page: "settings", group: null });
  const emptyChat = !view?.busy && !view?.inbox && !Object.keys(view?.live ?? {}).length && chatTurns(view?.entries ?? []).length === 0;
  const conversationPending = !!route.conversationId && view?.conversationId !== route.conversationId;
  const wechatConversation = !conversationPending && view?.channel === "wechat";
  const quote = conversationPending ? undefined : quotes.get(view?.conversationId ?? -1);
  function quoteRecord(record: ChatRecord) {
    if (conversationPending || !view) return;
    setQuotes(previous => new Map(previous).set(view.conversationId, record));
    requestAnimationFrame(() => document.getElementById("chat-textarea")?.focus());
  }
  function clearQuote(record: ChatRecord) {
    const owner = view?.conversationId;
    if (owner === undefined) return;
    setQuotes(previous => {
      if (previous.get(owner) !== record) return previous;
      const next = new Map(previous); next.delete(owner); return next;
    });
  }
  const historyItem = !localChat ? historyItems.find(item => item.id === (route.conversationId ?? view?.conversationId)) : undefined;
  const archivedConversation = !localChat && !!(historyItem?.archivedAt || view?.archivedAt);
  const archivingConversation = !localChat && !!(historyItem?.archivingAt || view?.archivingAt);
  const conversationTitle = historyItems.find(item => item.id === (route.conversationId ?? view?.conversationId))?.title?.trim() || view?.entries.find(entry => entry.kind === "user" && entry.text.trim())?.text.trim().split("\n")[0] || "与小 D 对话";
  const relatedAction = !wechatConversation && relatedCount > 0 && <button ref={relatedToggle} className="icon-button related-panel-toggle" type="button" aria-label={relatedOpen ? "收起关联任务" : "展开关联任务"} title="关联任务" aria-expanded={relatedOpen} aria-controls="related-tasks-panel" onClick={() => { if (relatedOpen) closeRelatedDetails(); else openRelatedDetails(); }}><Icon name="panel-right" /><span className="related-panel-count">{relatedCount}</span></button>;
  const executionControl = local.bridge && <><select className="header-button" aria-label="对话执行模式" value={execution} onChange={event => selectExecution(event.target.value === "local" ? "local" : "server")}><option value="server">服务器</option><option value="local">本机</option></select>{localChat && <DesktopAgentControls local={local} />}</>;
  const localHistory = local.bridge ? { title: local.snapshot?.messages.find(message => message.role === "user")?.text.split("\n")[0]?.slice(0, 80) || "本机对话", current: localChat, busy: !!local.snapshot?.busy, status: local.snapshot?.external?.status === "idle" ? undefined : local.snapshot?.external?.status, detail: local.snapshot?.workspace?.split(/[\\/]/).filter(Boolean).at(-1), open: () => { selectExecution("local"); navigate({ page: "chat", group: null, execution: "local" }); } } : undefined;
  const serviceLabel = localChat ? local.snapshot?.configured ? "本机已就绪" : "本机待配置" : connection !== "connected" ? "连接中" : info?.configured === false ? "模型待配置" : "已连接";
  const serviceHealthy = localChat ? local.snapshot?.configured === true && !local.warning : connection === "connected" && info?.configured === true;
  const headerActions = <div className="header-actions management-actions"><details ref={service} className="service-menu"><summary className="header-button" aria-label={`服务状态：${serviceLabel}`} title={`服务状态：${serviceLabel}`} data-healthy={serviceHealthy}><span className="status-dot" />{!serviceHealthy && <span>{serviceLabel}</span>}</summary><div className="service-popover"><strong>小 D 的状态</strong><p role="status">{mascot.text}</p><p>服务连接：{connection === "connected" ? "正常" : "正在重连"}</p><p>{info?.configured ? "当前模型：" + info.model : "模型尚未就绪，可先整理待办与个人内容。"}</p><button className="text-button" type="button" onClick={settings}>管理连接与设置<Icon name="arrow-up-right" /></button></div></details></div>;
  return <>
    <a className="workspace-skip" href="#workspace" onClick={event => { event.preventDefault(); document.getElementById("workspace")?.focus(); }}>跳到主要内容</a>
    <MailNotifications />
    {connection !== "connected" && !localChat && <div id="reconnect-banner" className="reconnect-banner" style={{ display: "flex" }} role="status"><div className="reconnect-spinner" /><span>{connection === "connecting" ? "正在连接小 D…" : "与服务器断开，正在重连…"}</span></div>}
    <div className="app-layout" id="mascot-card" data-state={mascot.state} data-view={page} data-desktop={window.desktopServer?.platform ?? local.bridge?.platform} data-external-conversation={page === "teams"}>
      {window.desktopServer?.platform && <div className="desktop-titlebar" aria-hidden="true" />}
      <WorkspaceNavigation inert={relatedModal || page === "chat" && narrow && historyOpen} route={route} onNavigate={navigate} onHelp={() => help.current?.showModal()} onSearch={historyOpen ? undefined : toggleHistory} onNew={() => { void startChat().catch(error => showToast(error.message, "error")); }} newDisabled={!!view?.busy || !!view?.inbox || !!Object.keys(view?.live ?? {}).length} />
      <main className="workspace-frame">
      {page === "chat" && narrow && historyOpen && <button className="history-backdrop" aria-label="关闭历史对话遮罩" onClick={closeHistory} />}
      <div className="conversation-sidebar" inert={relatedModal} hidden={narrow && page !== "chat"} data-expanded={historyOpen} role={narrow && historyOpen ? "dialog" : undefined} aria-modal={narrow && historyOpen ? true : undefined} aria-label="历史对话侧栏">
        <ConversationHistory source={page === "teams" ? "teams" : "assistant"} onAssistant={() => switchConversationSource("chat")} local={localHistory} load={!narrow || page === "chat" && !!route.conversationId} onItems={setHistoryItems} onTeams={() => switchConversationSource("teams")} refreshKey={historyRevision} active={(!narrow || page === "chat") && historyOpen} autoFocus={false} currentId={view?.conversationId ?? route.conversationId ?? null} workingId={view && (view.busy || Object.keys(view.live).length > 0) ? view.conversationId : undefined} onOpen={openChat} onClose={closeHistory} onNew={() => { void startChat().catch(error => showToast(error.message, "error")); }} newDisabled={!!view?.busy || !!view?.inbox || !!Object.keys(view?.live ?? {}).length} />
        <button ref={historyToggle} className="sidebar-toggle" type="button" aria-label={historyOpen ? "收起历史对话" : "展开历史对话"} title={historyOpen ? "收起历史对话" : "展开历史对话"} aria-expanded={historyOpen} aria-controls="conversation-history" onClick={toggleHistory}><Icon name={historyOpen ? "chevron-left" : "chevron-right"} /></button>
      </div>
      <div inert={relatedModal || page === "chat" && narrow && historyOpen} className="chat-column" id="workspace" data-view={page} data-empty-chat={emptyChat} tabIndex={-1}>
        {page !== "chat" && page !== "teams" && page !== "daylight" && !(page === "data" && group === "notes") && <header className="workspace-header management-header"><div className="workspace-header-identity"><WorkspaceBrand /><div className="workspace-location"><strong>{page === "data" && group ? dataLabel : pageLabels[page]}</strong></div></div>{headerActions}</header>}
        {routeError && <p className="workspace-route-error" role="alert">{routeError}<a href="#activity" onClick={event => { event.preventDefault(); navigate({ page: "activity", group: null }); }}>返回动态</a></p>}
        <TodayPage active={page === "home"} onPrompt={prompt} onGroup={openGroup} onDaylight={taskId => navigate({ page: "daylight", group: null, taskId })} onActivities={() => navigate({ page: "activity", group: null })} onSettings={settings} onConversation={openChat} />
        <ActivityPage onGroup={openGroup} active={page === "activity"} onConversation={openChat} onManage={id => navigate({ page: "data", group: "tasks", conversationId: id })} onSettings={() => { settings(); requestAnimationFrame(() => document.getElementById("notifications-title")?.scrollIntoView({ block: "start" })); }} />
        {page === "settings" && <ModelSettings onBack={() => navigate(settingsOrigin.current)} />}
        {teamsOpened && <ExternalConversationPanel active={page === "teams"} id="teams-external-message-panel" label="Teams"><PageLoad><TeamsConversations active={page === "teams"} chatId={page === "teams" ? route.chatId : lastTeamsChat.current} onSelectChat={chatId => navigate({ page: "teams", group: null, chatId })} onAssistant={() => switchConversationSource("chat")} onDaylight={taskId => navigate({ page: "daylight", group: null, taskId })} onSettings={settings} /></PageLoad></ExternalConversationPanel>}
        {reportsOpened && <div className="page-load-host" hidden={page !== "reports"}><PageLoad><DailyReports active={page === "reports"} /></PageLoad></div>}
        {daylightOpened && <div className="page-load-host" hidden={page !== "daylight"}><PageLoad><DaylightPage active={page === "daylight"} taskId={route.taskId} headerActions={page === "daylight" ? headerActions : null} /></PageLoad></div>}
        <ExternalConversationPanel active={page === "chat" || page === "data"} compact={false} id="assistant-conversation-panel" label="与 Dee 对话">
        {page === "chat" && !emptyChat && <header className="conversation-header"><div className="conversation-heading"><WorkspaceBrand /><div className="conversation-heading-copy"><h1 className="conversation-title" title={conversationTitle}>{conversationTitle}</h1>{wechatConversation && <span className="conversation-channel-label"><Icon name="message-circle" />微信里的 Dee</span>}</div></div><div className="conversation-header-actions">{relatedAction}{!historyOpen && <button className="icon-button conversation-header-new" type="button" aria-label="新对话" title="新对话" disabled={!!view?.busy || !!view?.inbox || !!Object.keys(view?.live ?? {}).length} onClick={() => { void startChat().catch(error => showToast(error.message, "error")); }}><Icon name="plus" /></button>}{headerActions}</div></header>}
        {page === "chat" && emptyChat && <div className="conversation-toolbar"><WorkspaceBrand />{!historyOpen && <button className="icon-button conversation-new-button" type="button" aria-label="新对话" title="新对话" disabled={!!view?.busy || !!view?.inbox || !!Object.keys(view?.live ?? {}).length} onClick={() => { void startChat().catch(error => showToast(error.message, "error")); }}><Icon name="plus" /><span>新对话</span></button>}{relatedAction}{headerActions}</div>}
        <section ref={scroll} hidden={page !== "chat" && page !== "data"} className={page === "data" ? group === "notes" ? "data-panel data-panel-notes" : "data-panel" : "messages-container"} id="messages-container" aria-label={page === "data" && group ? dataLabel : "与小 D 的对话"} onScroll={() => { if (page !== "chat") return; const el = scroll.current!; autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {page === "data" ? <header className="data-panel-heading"><div><h1>{dataLabel}</h1><p>{dataDescription}</p></div>{group === "tasks" && <button className="text-button" type="button" onClick={() => navigate({ page: "activity", group: null })}>全部动态<Icon name="arrow-up-right" /></button>}</header> : <div id="message-history" aria-live="polite">{route.conversationId && route.entryId && <SearchMessage conversationId={route.conversationId} entryId={route.entryId} />}<ChatThread view={view} pendingMessages={pendingMessages} onRetry={draft.trim() ? undefined : prompt} onSettings={settings} onQuote={conversationPending ? undefined : quoteRecord} /></div>}
          {localChat && <DesktopAgent local={local} />}
          <div hidden={page !== "chat" || localChat}><CardPanel view={conversationPending || localChat ? null : view} onPrompt={prompt} compactTasks={!wechatConversation} detailsHost={relatedHost} onRelatedCount={reportRelatedCount} onOpenDetails={openRelatedDetails} /></div>
          <WorkspaceData skillSource={route.skillSource} onSkillSourceChange={remote => navigate({ page: "data", group: "skills", ...(remote ? { skillSource: "remote" as const } : {}) })} group={page === "data" ? group : null} owner={route.conversationId ?? server.view?.conversationId ?? null} connect={connectDirectChat} headerActions={page === "data" && group === "notes" ? headerActions : null} />
        </section>
        <footer className="input-container" hidden={page !== "chat"}>{archivingConversation ? <p className="workspace-muted" role="status">Archive pending · 请在历史列表重试或取消归档</p> : archivedConversation ? <p className="workspace-muted" role="status">Archived · 从历史列表恢复后继续</p> : view?.readOnly ? <p className="workspace-muted" role="status">本机对话历史 · 在原本机 Agent 中继续</p> : <><Composer execution={executionControl} localExecution={localChat ? { ready: !!local.snapshot?.configured && !local.pollError && local.pending.length === 0, abort: async () => { if (local.bridge && !await local.action("abort", () => local.bridge!.abort())) throw new Error("停止未完成，请重试。"); } } : undefined} draft={draft} setDraft={setDraft} view={view} conversationPending={conversationPending} quote={quote} onClearQuote={clearQuote} connect={connectDirectChat} send={send} onSendStart={() => { autoScroll.current = true; }} onSent={() => { refreshHistory(value => value + 1); autoScroll.current = true; }} onNewConversation={startChat} onRelated={relatedCount > 0 && !wechatConversation ? openRelatedDetails : undefined} /><div className="composer-footer">{localChat ? local.snapshot?.configured === false && <span role="status">请在对应 Agent 中完成配置</span> : info?.configured === false ? <button className="text-button" type="button" onClick={settings}>配置模型后开始对话</button> : <span className="keyboard-hint">Enter 发送 · Shift + Enter 换行</span>}</div></>}</footer>
        </ExternalConversationPanel>
      </div>
      {relatedModal && <button className="related-panel-backdrop" aria-label="关闭关联任务遮罩" tabIndex={-1} onClick={closeRelatedDetails} />}
      <aside ref={relatedPanel} id="related-tasks-panel" className="related-tasks-panel" hidden={!relatedOpen} role={relatedModal ? "dialog" : undefined} aria-modal={relatedModal || undefined} aria-labelledby="related-tasks-heading">
        <header><h2 id="related-tasks-heading">关联任务</h2><button type="button" className="icon-button related-panel-close" aria-label="收起关联任务" onClick={closeRelatedDetails}><Icon name="x" /></button></header>
        <div ref={setRelatedHost} className="related-panel-content" />
      </aside>
      </main>
    </div>
    <dialog ref={help} className="help-dialog" aria-labelledby="help-title"><form method="dialog"><button className="icon-button close-help" aria-label="关闭使用指南"><Icon name="x" /></button></form><div className="help-mark"><Icon name="sparkles" /></div><h2 id="help-title">你好，我是小 D</h2><p>一起整理今天，也把交代的事情继续做完。</p><ul><li>对话、待办与通知在主导航；对话侧栏可切换小 D 助手与 Teams；「更多」中可查看今日概览、个人内容与设置。</li><li>在对话中发送文字、图片或文件，用「历史对话」接着上次聊。</li><li>本机技能按目录浏览和导入；记忆和笔记先查看，新增或编辑时再填写内容。远程小 D 提议的内容经你批准后生效。</li><li>输入 / 使用快捷指令，/new 新建、/help 查看说明、/stop 停止回复。</li></ul><p className="help-note">后台任务由独立服务端运行。关闭网页或桌面客户端后，服务端保持在线即可继续执行。</p></dialog>
  </>;
}
