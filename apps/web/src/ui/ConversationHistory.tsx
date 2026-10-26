import { useEffect, useState } from "react";
import type { ConversationItem } from "@assistant/contracts";
import { request } from "../api/request.js";
import { Icon } from "./Icon.js";

export function ConversationHistory({ active, currentId, onOpen, onClose }: { active: boolean; currentId: number | null; onOpen: (id: number) => void; onClose: () => void }) {
  const [items, setItems] = useState<ConversationItem[]>([]), [query, setQuery] = useState("");
  const [error, setError] = useState(""), [ready, setReady] = useState(false), [revision, refresh] = useState(0);
  useEffect(() => {
    if (!active) return;
    let current = true; setError("");
    void request<ConversationItem[]>("/api/conversations").then(data => { if (current) { setItems(data.filter(item => !item.archivedAt)); setReady(true); } }).catch(reason => { if (current) setError(reason instanceof Error ? reason.message : "历史记录读取失败"); });
    return () => { current = false; };
  }, [active, currentId, revision]);
  useEffect(() => {
    if (!active) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [active, onClose]);
  if (!active) return null;
  const found = items.filter(item => `${item.title} ${item.channel ?? "网页"} ${item.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <aside className="conversation-history" aria-label="历史对话"><header><h2>接着上次聊</h2><button className="icon-button" type="button" aria-label="关闭历史对话" onClick={onClose}><Icon name="x" /></button></header><label className="history-search"><Icon name="search" /><input aria-label="搜索历史对话" placeholder="搜索标题或来源" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="history-list">
    {!ready && !error && <p role="status">正在读取历史…</p>}
    {error && <p role="alert">{error}<button className="text-button" type="button" onClick={() => refresh(value => value + 1)}>重新读取</button></p>}
    {ready && !found.length && <p className="workspace-muted">{query ? "没有匹配的对话，试试其他关键词。" : "还没有历史对话，从一句话开始。"}</p>}
    {found.map(item => <a href={`#chat/${item.id}`} key={item.id} aria-current={currentId === item.id ? "true" : undefined} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpen(item.id); }}><span>{item.title || "未命名对话"}</span><small>{item.channel === "wechat" ? "微信" : item.channel === "teams" ? "Teams" : "网页"} · {new Date(item.createdAt).toLocaleDateString("zh-CN")} · #{item.id}</small><Icon name="arrow-up-right" /></a>)}
  </div><p className="history-footnote">切换对话会保留原有提醒与后台任务。</p></aside>;
}
