import { useEffect, useRef, useState } from "react";
import type { ConversationItem } from "@assistant/contracts";
import { request } from "../api/request.js";
import { ConversationSource } from "./ConversationSource.js";
import { Icon } from "./Icon.js";

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
  const needle = query.trim().toLocaleLowerCase();
  const found = items.filter(item => `${item.title} ${item.channel === "wechat" ? "微信" : item.channel === "teams" ? "Teams" : "网页"} ${item.id}`.toLocaleLowerCase().includes(needle));
  const visible = needle || older ? found : found.slice(0, 6);
  return <aside ref={panel} id="conversation-history" className="conversation-history" hidden={!active} aria-label="历史对话">
    <header><a className="history-brand" href="#chat" onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !currentId) return; event.preventDefault(); onOpen(currentId); }} aria-label="Dee 对话">Dee</a><button className="icon-button history-close" type="button" aria-label="关闭历史对话" onClick={onClose}><Icon name="x" /></button></header>
    {onTeams && <ConversationSource source="assistant" onAssistant={() => {}} onTeams={onTeams} />}
    {onNew && <button className="conversation-new-button" type="button" disabled={newDisabled} onClick={onNew}><Icon name="plus" /><span>新对话</span></button>}
    <label className="history-search"><Icon name="search" /><input aria-label="搜索历史对话" placeholder="搜索对话" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <h2 className="history-heading">{needle ? "搜索结果" : "最近对话"}</h2>
    <div className="history-list">
      {!ready && !error && <p role="status">正在读取历史…</p>}
      {error && <p role="alert">{error}<button className="text-button" type="button" onClick={() => refresh(value => value + 1)}>重新读取</button></p>}
      {ready && !found.length && <p className="workspace-muted">{needle ? "没有匹配的对话，试试其他关键词。" : "还没有历史对话，从一句话开始。"}</p>}
      {visible.map(item => {
        const meta = `${item.channel === "wechat" ? "微信" : item.channel === "teams" ? "Teams" : "网页"} · ${new Date(item.createdAt).toLocaleDateString("zh-CN")} · #${item.id}`;
        return <a href={`#chat/${item.id}`} key={item.id} title={`${item.title || "未命名对话"}\n${meta}`} aria-current={currentId === item.id ? "true" : undefined} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpen(item.id); }}><span>{item.title || "未命名对话"}</span><small>{meta}</small></a>;
      })}
      {!needle && found.length > 6 && <button className="history-older" type="button" aria-expanded={older} onClick={() => setOlder(value => !value)}>{older ? "收起较早对话" : "更早的对话"}{older ? <Icon name="chevron-up" /> : <Icon name="chevron-down" />}</button>}
    </div>
  </aside>;
}
