import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CardGroup } from "../chat/cards.js";
import { useConversation } from "../chat/useConversation.js";
import { Composer } from "../chat/Composer.js";
import { ChatThread } from "../chat/ChatThread.js";
import { CardPanel } from "../tasks/CardPanel.js";
import { Icon } from "./Icon.js";
import { Welcome } from "./Welcome.js";
import { ModelSettings } from "../settings/ModelSettings.js";
import { mascotStatus, ROBOT_SVG_CONTENT } from "./mascot.js";

const groups: { group: CardGroup; label: string; icon: string }[] = [
  { group: "tasks", label: "任务与提醒", icon: "list-todo" }, { group: "memory", label: "长期记忆", icon: "brain" },
  { group: "notes", label: "笔记与待办", icon: "notebook-pen" }, { group: "skills", label: "我的技能", icon: "sparkles" },
];
const prompts = [
  { icon: "sparkles", label: "安排今天的待办", text: "帮我列一个今天的待办清单，先问我有哪些事情要做" },
  { icon: "brain", label: "记住我的习惯", text: "请记住：我喜欢简洁、带要点的回答" },
  { icon: "globe", label: "一起读一篇文章", text: "帮我阅读一个公开网页并整理重点，请先问我要链接" },
];

export function App() {
  const { view, connection, info, recoveredUntil, connectDirectChat } = useConversation();
  const [page, setPage] = useState<"home" | "chat" | "settings">("home"), [group, setGroup] = useState<CardGroup | null>(null);
  const [draft, setDraft] = useState(""), [, tick] = useState(0), [moreOpen, setMoreOpen] = useState(false);
  const scroll = useRef<HTMLElement>(null), autoScroll = useRef(true), help = useRef<HTMLDialogElement>(null), more = useRef<HTMLDetailsElement>(null);
  const service = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (info?.configured === false) { setPage("settings"); setGroup(null); } }, [info?.configured]);
  useEffect(() => { const timer = setInterval(() => tick(value => value + 1), 1000); return () => clearInterval(timer); }, []);
  useLayoutEffect(() => { if (autoScroll.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [view, page]);
  useEffect(() => {
    const closeMore = (event: MouseEvent) => { if (!more.current?.contains(event.target as Node)) setMoreOpen(false); };
    document.addEventListener("click", closeMore);
    return () => document.removeEventListener("click", closeMore);
  }, []);
  useEffect(() => {
    const closeOutside = (event: Event) => {
      if (service.current?.open && !service.current.contains(event.target as Node)) service.current.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !service.current?.open) return;
      service.current.open = false;
      service.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
  useEffect(() => { if (service.current) service.current.open = false; }, [page, group]);
  const mascot = mascotStatus({ currentViewData: view, isDisconnected: connection !== "connected", isRecovered: recoveredUntil > Date.now(), recoveredUntil });
  function prompt(text: string) { setDraft(text); document.getElementById("chat-textarea")?.focus(); }
  function openGroup(next: CardGroup) { setGroup(next); setPage("chat"); setMoreOpen(false); }
  function navigate(next: "home" | "chat" | "settings") { setPage(next); setGroup(null); }
  return <>
    {connection !== "connected" && <div id="reconnect-banner" className="reconnect-banner" style={{ display: "flex" }} role="status"><div className="reconnect-spinner" /><span>{connection === "connecting" ? "正在连接小 D…" : "与服务器断开，正在重连…"}</span></div>}
    <div className="app-layout" id="mascot-card" data-state={mascot.state}>
      <aside className="sidebar" aria-label="主导航">
        <button className="brand-bot" type="button" onClick={() => navigate("home")} aria-label="小 D 首页"><svg className="mascot-svg" viewBox="0 0 100 100" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ROBOT_SVG_CONTENT }} /></button>
        <nav className="rail-navigation" aria-label="个人工作空间">
          <button className="rail-button" type="button" aria-current={page === "home" ? "page" : undefined} aria-label="首页" onClick={() => navigate("home")}><Icon name="plus" /><span>首页</span></button>
          <button className="rail-button" type="button" aria-current={page === "chat" && !group ? "page" : undefined} aria-label="继续对话" onClick={() => navigate("chat")}><Icon name="message-circle" /><span>对话</span></button>
          <div className="rail-divider" />
          {groups.map(item => <button key={item.group} className="rail-button" type="button" aria-label={item.label} aria-current={page === "chat" && group === item.group ? "page" : undefined} onClick={() => openGroup(item.group)}><Icon name={item.icon} /><span>{item.label.split("与")[0].replace("长期", "").replace("我的", "")}</span></button>)}
          <button className="rail-button" type="button" aria-label="模型设置" aria-current={page === "settings" ? "page" : undefined} onClick={() => navigate("settings")}><Icon name="settings" /><span>设置</span></button>
        </nav>
        <div className="rail-bottom"><button className="rail-button" type="button" aria-label="使用指南" onClick={() => help.current?.showModal()}><Icon name="circle-help" /><span>指南</span></button><div className="workspace-avatar" aria-label="个人空间">D<span /></div></div>
      </aside>
      <main className="chat-column" id="workspace" data-view={page} onClick={event => {
        const button = (event.target as Element).closest<HTMLButtonElement>("button[data-prompt],button[data-open-group]");
        if (button?.dataset.prompt) prompt(button.dataset.prompt);
        if (button?.dataset.openGroup) openGroup(button.dataset.openGroup as CardGroup);
      }}>
        <header className="workspace-header"><div className="prompt-strip" aria-label="试着这样问">{prompts.map(item => <button className="prompt-chip" type="button" key={item.label} onClick={() => prompt(item.text)}><Icon name={item.icon} /><span>{item.label}</span><Icon name="arrow-up-right" /></button>)}</div>
          <div className="header-actions"><details ref={service} className="service-menu"><summary className="header-button"><span className="status-dot" /><span>{connection === "connected" ? "已连接" : "连接中"}</span><Icon name="chevron-down" /></summary><div className="service-popover"><strong>小 D 的状态</strong><p role="status">{mascot.text}</p><p>{info ? "当前模型：" + info.model : "正在读取模型信息"}</p></div></details>
            <button className="header-button task-center-button" type="button" onClick={() => openGroup("tasks")}><Icon name="list-todo" /><span>任务中心</span></button><button className="icon-button header-help" type="button" aria-label="使用指南" onClick={() => help.current?.showModal()}><Icon name="ellipsis" /></button>
          </div>
        </header>
        <Welcome />
        {page === "settings" && <ModelSettings onBack={() => navigate("chat")} />}
        <section ref={scroll} className="messages-container" id="messages-container" aria-label="与小 D 的对话" onScroll={() => { const el = scroll.current!; autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          <div className="conversation-heading"><span><Icon name="message-circle" />与小 D 的对话</span><button className="text-button" type="button" onClick={() => navigate("home")}>回到首页<Icon name="arrow-up-right" /></button></div>
          <div id="message-history" aria-live="polite"><ChatThread view={view} /></div>
          <CardPanel view={view} group={group} setGroup={setGroup} onPrompt={prompt} />
        </section>
        <footer className="input-container"><Composer draft={draft} setDraft={setDraft} view={view} connect={connectDirectChat} onSent={() => { autoScroll.current = true; setPage("chat"); }} />
          <div className="composer-footer"><span className="composer-hint"><span>{info?.configured ? "已配置你的模型服务" : "请在设置中配置模型服务"}</span><span className="keyboard-hint">Enter 发送 · Shift + Enter 换行</span></span>
            <details ref={more} className="chat-more" open={moreOpen} onToggle={event => setMoreOpen(event.currentTarget.open)} onKeyDown={event => { if (event.key === "Escape") { setMoreOpen(false); more.current?.querySelector("summary")?.focus(); } }}><summary aria-label="查看全部能力">查看全部能力<Icon name="chevron-down" /></summary><div className="chat-more-menu"><nav className="conversation-card-tools" aria-label="在聊天中查看">{groups.map(item => <button key={item.group} type="button" aria-pressed={group === item.group} onClick={() => openGroup(item.group)}>{item.label}</button>)}</nav></div></details>
          </div>
        </footer>
      </main>
    </div>
    <dialog ref={help} className="help-dialog" aria-labelledby="help-title"><form method="dialog"><button className="icon-button close-help" aria-label="关闭使用指南"><Icon name="x" /></button></form><div className="help-mark"><Icon name="sparkles" /></div><h2 id="help-title">你好，我是小 D</h2><p>把想法写下来，或者交给我一件需要记住、整理和跟进的事。</p><ul><li>发送文字、图片或文件，继续同一段对话。</li><li>从左侧查看任务、记忆、技能和笔记。</li><li>记忆和技能会先请你确认，再保存使用。</li></ul><p className="help-note">使用前请配置真实模型。关闭整个桌面应用后，本地后台任务会暂停。</p></dialog>
  </>;
}
