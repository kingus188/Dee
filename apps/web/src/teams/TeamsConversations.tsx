import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TeamsConversation, TeamsConversationList, TeamsConversationMessage, TeamsConversationMessages, TeamsTriageAction, TeamsTriageItem } from "@assistant/contracts";
import { request } from "../api/request.js";
import { Icon } from "../ui/Icon.js";
import { ConversationSource } from "../ui/ConversationSource.js";
import { MediaItems } from "../chat/TeamsMedia.js";
import { isTeamsTriageActionResult, teamsSourceUrl } from "./data.js";
import { isTeamsConversationList, isTeamsConversationMessages, mergeTeamsMessages, sanitizeTeamsMessage } from "./conversation-data.js";
import { useTeamsPages } from "./useTeamsPages.js";

const mergeChats = (previous: TeamsConversationList, next: TeamsConversationList) => ({ ...next, items: [...new Map([...previous.items, ...next.items].map(item => [item.id, item])).values()] });
const mergePages = (previous: TeamsConversationMessages, next: TeamsConversationMessages) => ({ ...next, items: mergeTeamsMessages(previous.items, next.items) });
const time = (at: string) => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
const date = (at: string) => new Date(at).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
const kindLabel = { oneOnOne: "私聊", group: "群聊", meeting: "会议聊天", unknown: "Teams 会话" };
const sourceKey = (item: TeamsTriageItem) => JSON.stringify([item.id, item.revision]);
type Props = { active: boolean; chatId?: string; onSelectChat: (id: string) => void; onAssistant: () => void; onDaylight: (id?: string) => void; onSettings: () => void; onListOpenChange?: (open: boolean) => void };

export function TeamsConversations({ active, chatId, onSelectChat, onAssistant, onDaylight, onSettings, onListOpenChange }: Props) {
  const chats = useTeamsPages("/api/teams/conversations", active, isTeamsConversationList, mergeChats);
  const [query, setQuery] = useState(""), [mobileList, setMobileList] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null), sidebar = useRef<HTMLElement>(null);
  const shown = chats.data?.items.filter(item => `${item.title} ${item.preview ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  const selected = chats.data?.items.find(item => item.id === chatId);
  useEffect(() => { setMobileList(false); }, [active, chatId]);
  useEffect(() => { onListOpenChange?.(active && mobileList); return () => onListOpenChange?.(false); }, [active, mobileList, onListOpenChange]);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 760px)");
    const resize = () => { if (!media?.matches) setMobileList(false); };
    media?.addEventListener("change", resize); return () => media?.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    if (!mobileList) return;
    sidebar.current?.querySelector<HTMLInputElement>("input")?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setMobileList(false); toggle.current?.focus(); }
      if (event.key !== "Tab") return;
      const controls = [...(sidebar.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, a[href]') ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !sidebar.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", close); return () => document.removeEventListener("keydown", close);
  }, [mobileList]);
  return <section className="teams-workspace" hidden={!active} aria-label="Teams 会话" data-list-open={mobileList}>
    {mobileList && <button className="teams-list-backdrop" type="button" aria-label="关闭 Teams 会话列表" onClick={() => { setMobileList(false); toggle.current?.focus(); }} />}
    <aside ref={sidebar} className="teams-conversation-sidebar" aria-label="Teams 会话列表" role={mobileList ? "dialog" : undefined} aria-modal={mobileList ? true : undefined}>
      <div className="teams-sidebar-heading"><strong>Dee</strong><button type="button" className="icon-button teams-mobile-close" aria-label="关闭会话列表" onClick={() => { setMobileList(false); toggle.current?.focus(); }}><Icon name="x" /></button></div>
      <ConversationSource source="teams" onAssistant={onAssistant} onTeams={() => {}} />
      <label className="teams-conversation-search"><Icon name="search" /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索对话" aria-label="搜索已加载的 Teams 对话" /></label>
      {chats.error && <div className="teams-view-feedback" role="alert"><strong>会话读取失败</strong><p>{chats.error}</p><button className="text-button" type="button" onClick={chats.refresh}>重新读取</button></div>}
      {chats.loading && !chats.data && <p className="teams-view-feedback" role="status">正在读取会话…</p>}
      {chats.data && !chats.data.available && <div className="teams-view-feedback"><strong>Teams 尚未连接</strong><p>需要已登录且有聊天读取权限的 Teams 账号。</p><button className="text-button" type="button" onClick={onSettings}>查看连接与设置</button></div>}
      {chats.data?.available && <>
        <ul className="teams-conversation-list">{shown.map(item => <li key={item.id}><button type="button" className="teams-conversation-choice" aria-current={item.id === chatId ? "true" : undefined} onClick={() => { setMobileList(false); onSelectChat(item.id); }}>
          <span className="teams-avatar">{item.kind === "oneOnOne" ? item.title.slice(0, 1) : <Icon name="users" />}</span>
          <span className="teams-conversation-meta"><span className="teams-conversation-name">{item.title}</span><span className="teams-conversation-preview">{item.preview || kindLabel[item.kind]}</span></span>
          {item.updatedAt && <time title={`会话更新于 ${new Date(item.updatedAt).toLocaleString("zh-CN")}`} dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString() === new Date().toLocaleDateString() ? time(item.updatedAt) : new Date(item.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</time>}
        </button></li>)}</ul>
        {!shown.length && <p className="teams-view-feedback">{query ? "已加载的会话中没有匹配结果。" : "当前账号未返回可查看的会话。"}</p>}
        {chats.data.nextCursor && <button type="button" className="text-button teams-list-more" disabled={chats.loading} onClick={chats.more}>{chats.loading ? "正在加载…" : "加载更多会话"}</button>}
        <div className="teams-list-footer"><span>仅搜索已加载的会话</span><button type="button" className="icon-button" aria-label="刷新 Teams 会话列表" disabled={chats.loading} onClick={chats.refresh}><Icon name="rotate-ccw" /></button></div>
      </>}
    </aside>
    <section className="teams-conversation-detail" inert={mobileList} aria-label={selected?.title || "Teams 聊天记录"}>
      <header className="teams-conversation-header"><button ref={toggle} type="button" className="icon-button teams-mobile-toggle" aria-label="打开 Teams 会话列表" aria-expanded={mobileList} onClick={() => setMobileList(true)}><Icon name="panel-left" /></button><div><h1>{selected?.title || (chatId ? "Teams 会话" : "Teams")}</h1><span className="teams-conversation-provider"><span className="teams-provider-mark" aria-hidden="true">T</span>Teams</span></div>{teamsSourceUrl(selected?.sourceUrl) && <a className="teams-header-source" href={teamsSourceUrl(selected?.sourceUrl)} target="_blank" rel="noopener noreferrer"><Icon name="external-link" />查看原消息</a>}</header>
      {chats.data?.available && chatId ? <TeamsMessageThread key={chatId} active={active} chatId={chatId} onDaylight={onDaylight} /> : <div className="teams-view-empty"><Icon name="messages-square" /><h2>{chats.error ? "暂时无法读取 Teams" : chats.data?.available ? "选择一个会话" : chats.loading ? "正在连接 Teams" : "连接后查看 Teams 消息"}</h2><p>{chats.error ? "请重新读取会话，旧消息已隐藏。" : "按发送人和时间查看原消息，不会自动回复或创建待办。"}</p></div>}
    </section>
  </section>;
}

function TeamsMessageThread({ active, chatId, onDaylight }: { active: boolean; chatId: string; onDaylight: (id?: string) => void }) {
  const validate = useCallback((value: unknown): value is TeamsConversationMessages => isTeamsConversationMessages(value) && value.chatId === chatId, [chatId]);
  const messages = useTeamsPages(`/api/teams/conversations/messages?chatId=${encodeURIComponent(chatId)}`, active, validate, mergePages);
  const [confirmation, setConfirmation] = useState<TeamsTriageItem | null>(null), [pending, setPending] = useState("");
  const [notice, setNotice] = useState<{ text: string; error?: boolean; taskId?: string } | null>(null);
  const [settled, setSettled] = useState<string[]>([]);
  const generation = useRef(0), busy = useRef(false), alive = useRef(active); alive.current = active;
  const scroll = useRef<HTMLDivElement>(null), firstScroll = useRef(true), previousHeight = useRef<number | null>(null);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [active]);
  const items = (messages.data?.chatId === chatId ? messages.data.items : []).map(sanitizeTeamsMessage);
  useLayoutEffect(() => {
    if (!scroll.current || !items.length) return;
    if (previousHeight.current !== null) { scroll.current.scrollTop += scroll.current.scrollHeight - previousHeight.current; previousHeight.current = null; }
    else if (firstScroll.current) { scroll.current.scrollTop = scroll.current.scrollHeight; firstScroll.current = false; }
  }, [messages.data]);
  async function act(item: TeamsTriageItem, action: TeamsTriageAction["action"]) {
    if (!active || busy.current) return;
    const epoch = generation.current, key = sourceKey(item);
    busy.current = true; setPending(key); setNotice(null);
    try {
      const result = await request<unknown>("/api/teams/triage/act", { id: item.id, revision: item.revision, action } satisfies TeamsTriageAction);
      if (!alive.current || epoch !== generation.current) return;
      if (!isTeamsTriageActionResult(result) || action === "create" && !result.taskId) throw new Error("操作结果尚未确认，请重新读取核对，暂勿重复操作。");
      setSettled(previous => [...previous, key]); setConfirmation(null);
      setNotice({ text: action === "create" ? "待办已创建。" : "已稍后处理，2 小时后再查看建议。", taskId: result.taskId });
    } catch (error) {
      if (alive.current && epoch === generation.current) {
        setConfirmation(null); setNotice({ text: error instanceof Error ? error.message : "操作结果未确认，请重新读取核对。", error: true });
        messages.refresh();
      }
    } finally { if (epoch === generation.current) { busy.current = false; setPending(""); } }
  }
  return <>
    <div className="teams-thread-tools"><span>{messages.data ? `在线读取 · ${items.length} 条已加载${messages.data.nextCursor ? " · 还有更早消息" : ""}` : "在线读取聊天原文"}</span><button type="button" className="text-button" disabled={messages.loading || !!pending} onClick={() => { setConfirmation(null); messages.refresh(); }}><Icon name="rotate-ccw" />刷新消息</button></div>
    <div ref={scroll} className="teams-message-scroll" aria-label="Teams 消息时间线">
      {messages.error && <div className="teams-view-feedback teams-thread-error" role="alert"><strong>消息读取失败</strong><p>{messages.error}</p><p>旧原文和建议已隐藏，请重新读取后查看。</p><button type="button" className="text-button" onClick={messages.refresh}>重新读取消息</button></div>}
      {messages.loading && !messages.data && <p className="teams-view-feedback" role="status">正在读取原消息…</p>}
      {messages.data && <>
        {messages.data.nextCursor ? <button type="button" className="teams-load-earlier text-button" disabled={messages.loading || !!pending} onClick={() => { previousHeight.current = scroll.current?.scrollHeight ?? null; messages.more(); }}>{messages.loading ? "正在加载更早消息…" : "加载更早消息"}</button> : <p className="teams-history-start">已到当前可读取记录的起点</p>}
        {!items.length && <p className="teams-view-feedback">当前可读取范围内没有消息。</p>}
        <ol className="teams-message-list">{items.map((item, index) => <TeamsMessage key={item.id} item={item} day={index === 0 || new Date(items[index - 1].createdAt).toDateString() !== new Date(item.createdAt).toDateString()} suggestion={item.suggestion && !settled.includes(sourceKey(item.suggestion)) ? item.suggestion : undefined} pending={!!pending} confirming={confirmation && item.suggestion && sourceKey(confirmation) === sourceKey(item.suggestion) ? confirmation : null} onConfirm={setConfirmation} onAct={act} />)}</ol>
      </>}
    </div>
    {notice && <div className={`teams-action-notice${notice.error ? " is-error" : ""}`} role={notice.error ? "alert" : "status"}>{notice.text}{notice.taskId && <button className="text-button" type="button" onClick={() => onDaylight(notice.taskId)}>查看待办<Icon name="arrow-up-right" /></button>}</div>}
    <p className="teams-readonly-note">仅查看消息，回复请前往 Teams。附件只显示已归档内容。</p>
  </>;
}

function TeamsMessage({ item, day, suggestion, pending, confirming, onConfirm, onAct }: {
  item: TeamsConversationMessage; day: boolean; suggestion?: TeamsTriageItem; pending: boolean; confirming: TeamsTriageItem | null;
  onConfirm: (item: TeamsTriageItem | null) => void; onAct: (item: TeamsTriageItem, action: TeamsTriageAction["action"]) => Promise<void>;
}) {
  return <li className="teams-message-entry" data-message-id={item.id}>
    {day && <div className="teams-date-divider"><span>{date(item.createdAt)}</span></div>}
    <article className="teams-message" data-direction={item.direction} aria-label={`${item.direction === "out" ? "我" : item.senderName || "消息"} ${time(item.createdAt)}`}>
      {item.direction !== "out" && <span className="teams-avatar">{item.senderName.slice(0, 1) || <Icon name="message-circle" />}</span>}
      <div className="teams-message-content"><div className="teams-message-byline"><strong>{item.direction === "out" ? "我" : item.senderName || "消息"}</strong><time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString("zh-CN")}>{time(item.createdAt)}</time>{item.modifiedAt && <span title={`更新于 ${new Date(item.modifiedAt).toLocaleString("zh-CN")}`}>已编辑</span>}{item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label="在 Teams 查看这条原消息" title="查看原消息"><Icon name="external-link" /></a>}</div>
        <div className={`teams-message-bubble${item.deleted || item.unavailable ? " is-unavailable" : ""}`}><p>{item.deleted ? "此消息已删除" : item.unavailable ? "此消息来源已不可用" : item.text || "此消息没有可显示的文本。"}</p>{!!item.media.length && <div className="teams-message-media"><MediaItems media={item.media} /></div>}</div>
        {suggestion?.suggestTodo && <div className="teams-message-suggestion"><div className="teams-suggestion-bar"><Icon name="lightbulb" /><span>建议：{suggestion.suggestedTitle}</span><div><button type="button" disabled={pending} onClick={() => onConfirm(suggestion)}>创建待办</button><button type="button" disabled={pending} onClick={() => { void onAct(suggestion, "snooze"); }}>稍后处理</button></div></div>
          <details className="teams-suggestion-reason"><summary>建议依据与限制</summary><p>{suggestion.reason}</p><p>{suggestion.uncertainty}</p></details>
          {confirming && <section className="teams-todo-confirm" aria-label="确认创建 Teams 待办"><strong>创建到 Daylight 收件箱？</strong><p>{confirming.suggestedTitle}</p><p>创建前会重新核对原消息，不会发送 Teams 回复。</p><div><button type="button" disabled={pending} onClick={() => { void onAct(confirming, "create"); }}>{pending ? "正在核对来源…" : "确认创建待办"}</button><button type="button" disabled={pending} onClick={() => onConfirm(null)}>取消</button></div></section>}
        </div>}
      </div>
    </article>
  </li>;
}
