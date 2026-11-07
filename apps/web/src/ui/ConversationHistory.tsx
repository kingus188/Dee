import { useEffect, useRef, useState } from "react";
import type { ConversationItem } from "@assistant/contracts";
import { request } from "../api/request.js";
import { ConversationSource } from "./ConversationSource.js";
import { Icon } from "./Icon.js";
import { historyGroups, historyTime } from "./history-groups.js";

const shortcut = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";

export function ConversationHistory({ active, currentId, onOpen, onClose, onNew, newDisabled = false, autoFocus = true, refreshKey = 0, load = false, onItems, onTeams }: {
  active: boolean; currentId: number | null; onOpen: (id: number) => void; onClose: () => void;
  load?: boolean; onItems?: (items: ConversationItem[]) => void; onTeams?: () => void;
  onNew?: () => void; newDisabled?: boolean; autoFocus?: boolean; refreshKey?: number;
}) {
  const panel = useRef<HTMLElement>(null);
  const [items, setItems] = useState<ConversationItem[]>([]), [query, setQuery] = useState("");
  const [older, setOlder] = useState(false);
  const [error, setError] = useState(""), [ready, setReady] = useState(false), [revision, refresh] = useState(0);
  useEffect(() => {
    if (!active && !load) return;
    let current = true; setError("");
    void request<ConversationItem[]>("/api/conversations").then(data => { if (current) { const next = data.filter(item => !item.archivedAt); setItems(next); onItems?.(next); setReady(true); } }).catch(reason => { if (current) setError(reason instanceof Error ? reason.message : "历史记录读取失败"); });
    return () => { current = false; };
  }, [active, load, currentId, revision, refreshKey, onItems]);
  useEffect(() => { if (active && autoFocus) panel.current?.querySelector<HTMLInputElement>("input")?.focus(); }, [active]);
  useEffect(() => {
    if (!active) return;
    const close = (event: KeyboardEvent) => {
      // Do not dismiss the sidebar when Escape belongs to the composer or another menu.
      if (event.key === "Escape" && !event.defaultPrevented && panel.current?.contains(document.activeElement)) onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [active, onClose]);
  useEffect(() => {
    if (!active) return;
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault(); panel.current?.querySelector<HTMLInputElement>(".history-search input")?.focus();
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, [active]);
  const needle = query.trim().toLocaleLowerCase();
  const sourceLabel = (item: ConversationItem) => item.channel === "wechat" ? "微信里的 Dee" : item.channel === "teams" ? "Teams" : "网页";
  const found = items.filter(item => `${item.title} ${sourceLabel(item)} ${item.id}`.toLocaleLowerCase().includes(needle));
  const visible = needle || older ? found : found.slice(0, 6);
  return <aside ref={panel} id="conversation-history" className="conversation-history" hidden={!active} aria-label="历史对话">
    <header><a className="history-brand" href="#chat" onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !currentId) return; event.preventDefault(); onOpen(currentId); }} aria-label="Dee 对话">Dee</a><button className="icon-button history-close" type="button" aria-label="关闭历史对话" onClick={onClose}><Icon name="x" /></button></header>
    {onTeams && <ConversationSource source="assistant" onAssistant={() => {}} onTeams={onTeams} />}
    {onNew && <button className="conversation-new-button" type="button" disabled={newDisabled} onClick={onNew}><Icon name="plus" /><span>新对话</span></button>}
    <label className="history-search"><Icon name="search" /><input aria-label="搜索历史对话" placeholder="搜索" value={query} onChange={event => setQuery(event.target.value)} /><kbd aria-hidden="true">{shortcut}</kbd></label>
    <div className="history-list">
      {!ready && !error && <p role="status">正在读取历史…</p>}
      {error && <p role="alert">{error}<button className="text-button" type="button" onClick={() => refresh(value => value + 1)}>重新读取</button></p>}
      {ready && !found.length && <p className="workspace-muted">{needle ? "没有匹配的对话，试试其他关键词。" : "还没有历史对话，从一句话开始。"}</p>}
      {historyGroups(visible, needle ? "搜索结果" : undefined).map(group => <section key={group.label} aria-label={group.label}>
        <h2 className="history-heading">{group.label}</h2>
        {group.items.map(item => {
          const meta = `${sourceLabel(item)} · ${new Date(item.createdAt).toLocaleDateString("zh-CN")} · #${item.id}`;
          const syncHint = item.channel === "wechat" ? "\nDee 的回复可能同步到此会话绑定的微信接收方" : "";
          const badge = item.channel === "wechat" ? "微信" : item.channel === "teams" ? "Teams" : "";
          return <a href={`#chat/${item.id}`} key={item.id} title={`${item.title || "未命名对话"}\n${meta}${syncHint}`} aria-current={currentId === item.id ? "true" : undefined} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpen(item.id); }}>
            <span>{badge && <em className="history-channel">{badge}</em>}{item.title || "未命名对话"}</span><time dateTime={item.createdAt}>{historyTime(item.createdAt)}</time>
          </a>;
        })}
      </section>)}
      {!needle && found.length > 6 && <button className="history-older" type="button" aria-expanded={older} onClick={() => setOlder(value => !value)}>{older ? "收起更早的对话" : "显示更早的对话"}</button>}
    </div>
  </aside>;
}
