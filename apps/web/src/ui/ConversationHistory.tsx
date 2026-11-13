import { useEffect, useRef, useState } from "react";
import type { ConversationItem } from "@assistant/contracts";
import { request } from "../api/request.js";
import { ConversationHistoryContent } from "./ConversationHistoryContent.js";
import { ConversationHistoryRow } from "./ConversationHistoryRow.js";
import { Icon } from "./Icon.js";
import { ConversationHistoryActions, conversationStatusLabel } from "./ConversationHistoryActions.js";
import { historyGroups } from "./history-groups.js";

export function ConversationHistory({ active, currentId, workingId, onOpen, onClose, onNew, newDisabled = false, autoFocus = true, refreshKey = 0, load = false, onItems, onTeams, onAssistant, source, local }: {
  active: boolean; currentId: number | null; onOpen: (id: number) => void; onClose: () => void;
  load?: boolean; onItems?: (items: ConversationItem[]) => void; onTeams?: () => void;
  source?: "assistant" | "teams"; onAssistant?: () => void;
  onNew?: () => void; newDisabled?: boolean; autoFocus?: boolean; refreshKey?: number;
  workingId?: number;
  local?: { title: string; current: boolean; busy: boolean; detail?: string; status?: "waiting" | "running" | "done" | "failed" | "cancelled" | "interrupted"; open(): void };
}) {
  const panel = useRef<HTMLElement>(null);
  const [items, setItems] = useState<ConversationItem[]>([]), [query, setQuery] = useState("");
  const [older, setOlder] = useState(false), [archived, setArchived] = useState(false);
  const generation = useRef(0);
  const [error, setError] = useState(""), [ready, setReady] = useState(false), [revision, refresh] = useState(0);
  useEffect(() => {
    if (!active && !load) return;
    let current = true; const version = ++generation.current; setError("");
    void request<ConversationItem[]>("/api/conversations").then(data => { if (!Array.isArray(data)) throw new Error("历史记录响应格式不正确，请重试。"); if (current && version === generation.current) { setItems(data); setReady(true); } }).catch(reason => { if (current && version === generation.current) setError(reason instanceof Error ? reason.message : "历史记录读取失败"); });
    return () => { current = false; };
  }, [active, load, currentId, revision, refreshKey, onItems]);
  useEffect(() => { if (ready) onItems?.(items); }, [items, ready, onItems]);
  function saved(item: ConversationItem) {
    generation.current++;
    setItems(previous => previous.map(value => value.id === item.id ? item : value));
    refresh(value => value + 1);
  }
  useEffect(() => { panel.current?.querySelectorAll<HTMLDetailsElement>(".history-conversation-actions[open]").forEach(menu => { menu.open = false; }); }, [currentId, archived, active]);
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
  const sourceLabel = (item: ConversationItem) => item.channel === "desktop" ? "本机" : item.channel === "wechat" ? "微信里的 Dee" : item.channel === "teams" ? "Teams" : "网页";
  const found = items.filter(item => !!item.archivedAt === archived && `${item.title} ${sourceLabel(item)} ${item.id}`.toLocaleLowerCase().includes(needle));
  const working = found.find(item => item.id === workingId);
  const history = found.filter(item => item.id !== workingId);
  const visible = needle || older ? history : history.slice(0, 6);
  function row(item: ConversationItem) {
    const date = new Date(item.createdAt);
    return <div key={item.id} className="history-conversation" data-conversation-id={item.id}><ConversationHistoryRow href={`#chat/${item.id}`} title={item.title || "未命名对话"} source={sourceLabel(item)}
      detail={`${conversationStatusLabel(item)} · ${Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" })}`} createdAt={item.createdAt}
      current={currentId === item.id} status={item.id === workingId ? "running" : undefined}
      hint={item.channel === "wechat" ? "Dee 的回复可能同步到此会话绑定的微信接收方" : undefined}
      onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpen(item.id); }} /><ConversationHistoryActions item={item} onSaved={saved} onRefresh={() => refresh(value => value + 1)} /></div>;
  }
  const localRow = local && <ConversationHistoryRow href="#chat/local" title={local.title} source="本机" detail={local.detail ?? ""} current={local.current} status={local.status ?? (local.busy ? "running" : undefined)} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); local.open(); }} />;
  const localFound = !archived && local && `${local.title} 本机 ${local.detail ?? ""}`.toLocaleLowerCase().includes(needle);
  return <aside ref={panel} id="conversation-history" className="conversation-history" hidden={!active} aria-label="历史对话">
    <ConversationHistoryContent query={query} onQuery={setQuery} onClose={onClose} source={source} onAssistant={onAssistant} onTeams={onTeams} onNew={onNew} newDisabled={newDisabled} bottom={<>
      {localFound && local?.busy && <details className="history-working" open><summary>{local.status === "waiting" ? "等待确认" : "运行中"}<span>1</span><Icon name="chevron-right" /></summary>{localRow}</details>}
      {working && <details className="history-working" open><summary>运行中<span>1</span><Icon name="chevron-right" /></summary>{row(working)}</details>}
      {!needle && history.length > 6 && <button className="history-older" type="button" aria-expanded={older} onClick={() => setOlder(value => !value)}><span>{older ? "收起更早的对话" : "显示更早的对话"}</span><span>{history.length - 6}</span><Icon name={older ? "chevron-down" : "chevron-right"} /></button>}
    </>}>
      <div className="history-archive-filter" role="group" aria-label="对话列表范围">
        <button type="button" aria-pressed={!archived} onClick={() => { setArchived(false); setOlder(false); }}>当前对话</button>
        <button type="button" aria-pressed={archived} onClick={() => { setArchived(true); setOlder(false); }}>Archived</button>
      </div>
      {localFound && !local?.busy && <section aria-label="本机对话"><h2 className="history-heading">本机</h2>{localRow}</section>}
      {!ready && !error && <p role="status">正在读取历史…</p>}
      {error && <p role="alert">{error}<button className="text-button" type="button" onClick={() => refresh(value => value + 1)}>重新读取</button></p>}
      {ready && !found.length && <p className="workspace-muted">{needle ? "没有匹配的对话，试试其他关键词。" : archived ? "没有已归档的对话。" : "还没有历史对话，从一句话开始。"}</p>}
      {historyGroups(visible, needle ? "搜索结果" : undefined).map(group => <section key={group.label} aria-label={group.label}>
        <h2 className="history-heading">{group.label}</h2>
        {group.items.map(row)}
      </section>)}
    </ConversationHistoryContent>
  </aside>;
}
