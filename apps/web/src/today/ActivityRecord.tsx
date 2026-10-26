import type { WorkspaceActivity } from "@assistant/contracts";
import { Icon } from "../ui/Icon.js";
import { activityKind, activityPhase, activityStatus, activityTime, dateTime } from "./model.js";

export function ActivityRecord({ item, onConversation, onManage, compact = false, read, onRead }: {
  item: WorkspaceActivity;
  onConversation: (id: number) => void;
  onManage?: (id: number) => void;
  compact?: boolean;
  read?: boolean;
  onRead?: () => void;
}) {
  const time = activityTime(item);
  return <article className={`activity-record${compact ? " activity-record-compact" : ""}`} data-read={read} data-status={item.status}>
    {read !== undefined && <div className={`inbox-record-icon inbox-record-icon-${item.kind}`}>{item.kind === "reminder" ? <Icon name="bell" /> : item.kind === "schedule" ? <Icon name="calendar-clock" /> : <Icon name="sparkles" />}{!read && <span className="inbox-unread-dot" aria-label="未读" />}</div>}
    <div className="activity-record-body">
    <div className="activity-record-topline">
      <span className="activity-record-kind">{activityKind(item)}</span>
      <span className={`activity-record-state activity-record-state-${item.status === "failed" ? "failed" : activityPhase(item)}`}>{activityStatus(item)}</span>
    </div>
    <p className="activity-record-text">{item.text}</p>
    <div className="activity-record-meta">
      <button type="button" className="activity-source-button" onClick={() => { if (read === false) onRead?.(); onConversation(item.conversationId); }} aria-label={`进入来源会话：${item.conversationTitle || `会话 #${item.conversationId}`}`}>
        <Icon name="message-circle" /><span>{item.conversationTitle || `会话 #${item.conversationId}`}</span><Icon name="arrow-up-right" />
      </button>
      <span>{time.label} <time dateTime={time.value !== null && !Number.isNaN(new Date(time.value).getTime()) ? new Date(time.value).toISOString() : undefined}>{dateTime(time.value)}</time></span>
    </div>
    {!compact && <p className="activity-record-created">{item.kind === "reminder" ? "来源会话创建于" : "记录创建于"} {dateTime(item.createdAt)}</p>}
    {!compact && item.result && <details className="activity-record-result">
      <summary>查看结果 <Icon name="chevron-down" /></summary>
      <pre>{item.result}</pre>
    </details>}
    {onManage && <div className="activity-record-actions"><button type="button" className="activity-text-button" onClick={() => onManage(item.conversationId)}>在原会话管理 <Icon name="chevron-right" /></button></div>}
    </div>
    {onRead && <button type="button" className="inbox-read-button icon-button" aria-label={read ? `标为未读：${item.text}` : `标为已读：${item.text}`} title={read ? "标为未读" : "标为已读"} onClick={onRead}>{read ? <Icon name="mail" /> : <Icon name="mail-open" />}</button>}
  </article>;
}
