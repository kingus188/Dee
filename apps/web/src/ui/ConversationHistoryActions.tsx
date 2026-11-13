import { useRef, useState } from "react";
import type { ConversationItem } from "@assistant/contracts";
import { request } from "../api/request.js";
import { Icon } from "./Icon.js";

const labels = { active: "Active", waiting: "Waiting", completed: "Completed" };
export function ConversationHistoryActions({ item, onSaved, onRefresh }: { item: ConversationItem; onSaved: (item: ConversationItem) => void; onRefresh: () => void }) {
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const busy = useRef(false), menu = useRef<HTMLDetailsElement>(null);
  const status = item.status ?? "active";
  async function change(action: "status" | "archive" | "restore", nextStatus?: keyof typeof labels) {
    if (busy.current) return;
    if (action === "archive" && !window.confirm("归档此对话会停止其未完成的任务、计划和提醒，保留聊天记录。继续归档？")) return;
    busy.current = true; setPending(true); setError("");
    try {
      await request(`/api/conversations/${item.id}/${action}`, action === "status" ? { status: nextStatus } : {});
      onSaved({ ...item, ...(action === "status" ? { status: nextStatus } : { archivedAt: action === "archive" ? new Date().toISOString() : null, archivingAt: null }) });
      if (menu.current) menu.current.open = false;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "更新对话失败，请重试。"); onRefresh(); }
    finally { busy.current = false; setPending(false); }
  }
  return <details ref={menu} className="history-conversation-actions" onKeyDown={event => {
    if (event.key === "Escape" && menu.current?.open) { event.preventDefault(); event.stopPropagation(); menu.current.open = false; menu.current.querySelector<HTMLElement>("summary")?.focus(); }
  }}>
    <summary aria-label={`管理对话：${item.title || "未命名对话"}`} title="管理对话"><Icon name="ellipsis" /></summary>
    <div className="history-conversation-controls">
      <label>对话状态<select aria-label={`对话状态：${item.title || "未命名对话"}`} value={status} disabled={pending || !!item.archivedAt || !!item.archivingAt} onChange={event => { void change("status", event.target.value as keyof typeof labels); }}>
        {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <button type="button" disabled={pending} onClick={() => { void change(item.archivedAt ? "restore" : "archive"); }}>{pending ? "Saving…" : item.archivedAt ? "Restore" : item.archivingAt ? "Retry archive" : "Archive"}</button>
      {item.archivingAt && <button type="button" disabled={pending} title="已停止的任务不会自动恢复" onClick={() => { void change("restore"); }}>Cancel archive</button>}
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}

export const conversationStatusLabel = (item: ConversationItem) => item.archivedAt ? "Archived" : item.archivingAt ? "Archive pending" : labels[item.status ?? "active"];
