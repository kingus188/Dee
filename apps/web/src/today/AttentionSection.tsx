import type { WorkspaceAttention } from "@assistant/contracts";
import { usePageResource } from "./usePageResource.js";
import { ResourceFeedback } from "./ResourceFeedback.js";
import { Icon } from "../ui/Icon.js";

const reasons = new Set(["Waiting", "Archive pending", "Failed", "Interrupted", "Review pending", "Delivery unknown", "Delivery failed", "Stop pending"]);
export function isWorkspaceAttention(value: unknown): value is WorkspaceAttention {
  if (!value || typeof value !== "object") return false;
  const data = value as WorkspaceAttention;
  return Array.isArray(data.items) && Number.isSafeInteger(data.total) && data.total >= data.items.length && typeof data.truncated === "boolean"
    && data.items.every(item => item && typeof item.id === "string" && Number.isSafeInteger(item.conversationId) && item.conversationId > 0
      && typeof item.conversationTitle === "string" && typeof item.text === "string" && ["conversation", "tasks"].includes(item.target)
      && Array.isArray(item.reasons) && item.reasons.length > 0 && item.reasons.every(reason => reasons.has(reason))
      && (item.at === null || Number.isFinite(item.at)));
}
export function AttentionSection({ active, onConversation, onManage }: { active: boolean; onConversation: (id: number) => void; onManage: (id: number) => void }) {
  const resource = usePageResource<WorkspaceAttention>("/api/workspace/attention", active, isWorkspaceAttention);
  return <section className="inbox-section" aria-labelledby="attention-title">
    <h2 id="attention-title">需要我处理{resource.data && <span>{resource.data.total}</span>}</h2>
    <ResourceFeedback resource={resource} label="待处理事项" scope="activity" />
    {resource.data && resource.data.items.length === 0 && <p className="workspace-muted">当前服务端私人对话没有待处理事项。</p>}
    {resource.data?.items.map(item => <button type="button" className="inbox-approval-link" key={item.id}
      onClick={() => item.target === "tasks" ? onManage(item.conversationId) : onConversation(item.conversationId)}>
      <Icon name="circle-alert" /><span><strong>{item.conversationTitle || `Conversation #${item.conversationId}`}</strong><small>{item.reasons.join(" · ")}</small><small>{item.text}</small></span><span>Review<Icon name="chevron-right" /></span>
    </button>)}
    {resource.data?.truncated && <p role="status">显示最近 {resource.data.items.length} / {resource.data.total} 项，请进入原会话查看全部记录。</p>}
    <button type="button" className="text-button" disabled={resource.loading} onClick={resource.refresh}>刷新待处理事项</button>
  </section>;
}
