import { useState } from "react";
import type { WorkspaceActivities, WorkspaceActivity } from "@assistant/contracts";
import { Icon } from "../ui/Icon.js";
import { isWorkspaceActivities } from "./data.js";
import { ActivityRecord } from "./ActivityRecord.js";
import { ResourceFeedback } from "./ResourceFeedback.js";
import { activityFilters, activityKey, matchesActivityFilter, dateTime } from "./model.js";
import type { ActivityFilter } from "./model.js";
import { usePageResource } from "./usePageResource.js";
import { useNotificationReads } from "./notificationReads.js";

export type ActivityPageProps = {
  active: boolean;
  onConversation: (id: number) => void;
  onManage: (id: number) => void;
  onSettings?: () => void;
};

export function ActivityPage({ active, onConversation, onManage, onSettings }: ActivityPageProps) {
  const resource = usePageResource<WorkspaceActivities>("/api/workspace/activities", active, isWorkspaceActivities);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<WorkspaceActivity["kind"] | "all">("all");
  const reads = useNotificationReads(active);
  const all = resource.data?.items ?? [];
  const unread = all.filter(item => !reads.isRead(item)).length;
  const needle = query.trim().toLocaleLowerCase();
  const items = all.filter(item => matchesActivityFilter(item, filter)
    && (!unreadOnly || !reads.isRead(item)) && (kind === "all" || kind === item.kind)
    && (!needle || `${item.text} ${item.conversationTitle} ${item.result ?? ""}`.toLocaleLowerCase().includes(needle)));
  const sections = [
    { id: "attention", title: "需要关注", items: items.filter(item => item.status === "failed") },
    { id: "updates", title: "任务与提醒", items: items.filter(item => item.status !== "failed") },
  ].filter(section => section.items.length > 0);
  function reset() { setFilter("all"); setUnreadOnly(false); setQuery(""); setKind("all"); }

  return <div className="activity-page inbox-page" hidden={!active}>
    <header className="activity-page-header">
      <div><p className="activity-eyebrow"><Icon name="bell" />所有会话 · 一个收件箱</p><h1>通知中心{resource.data && unread > 0 && <span className="inbox-title-count">{unread}<span className="sr-only"> 条未读</span></span>}</h1><p className="activity-description">提醒有回音，进展有着落。</p></div>
      <div className="inbox-header-actions">{onSettings && <button type="button" className="icon-button" aria-label="通知投递设置" title="通知投递设置" onClick={onSettings}><Icon name="settings-2" /></button>}<button type="button" className="activity-refresh-button" disabled={resource.loading} onClick={resource.refresh}><Icon name="rotate-ccw" />{resource.loading ? "正在更新" : "刷新"}</button></div>
    </header>
    <div className="inbox-overview" aria-label="通知概览">
      <div><span className="inbox-overview-icon"><Icon name="inbox" /></span><p><strong>{resource.data ? unread ? `有 ${unread} 条未读进展` : "进展都已读过" : "正在收集进展"}</strong><span>{resource.data?.truncated ? "数量仅包含已加载记录" : "跨会话汇总提醒、计划与后台结果"}</span></p></div>
      {resource.data && <button type="button" className="activity-text-button" disabled={!items.some(item => !reads.isRead(item))} onClick={() => reads.mark(items, true)}><Icon name="check-check" />当前筛选标为已读</button>}
    </div>
    <div className="inbox-read-tabs" role="group" aria-label="按阅读状态筛选">
      <button type="button" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>全部通知<span>{resource.data ? all.length : "—"}</span></button>
      <button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>未读<span>{resource.data ? unread : "—"}</span></button>
      <p className="activity-update-time">{resource.updatedAt ? `更新于 ${dateTime(resource.updatedAt)}` : "等待读取记录"}</p>
    </div>
    <div className="activity-toolbar inbox-toolbar">
      <label className="inbox-search"><Icon name="search" /><input type="search" aria-label="搜索通知" placeholder="搜索通知或来源会话…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label className="inbox-kind"><span className="sr-only">通知类型</span><select aria-label="通知类型" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="all">全部类型</option><option value="reminder">提醒</option><option value="schedule">计划</option><option value="background">后台任务</option></select></label>
    </div>
    <div className="activity-filters" role="group" aria-label="按进展状态筛选">
      {[...activityFilters].sort((a, b) => Number(b.id === "all") - Number(a.id === "all")).map(option => <button type="button" key={option.id} className="activity-filter" aria-pressed={filter === option.id} onClick={() => setFilter(option.id)}>{option.label}{resource.data && <span>{all.filter(item => matchesActivityFilter(item, option.id)).length}</span>}</button>)}
    </div>
    <ResourceFeedback resource={resource} label="通知" scope="activity" />
    {resource.data && <>
      {resource.data.truncated && <p className="activity-truncation" role="status"><Icon name="circle-alert" />当前显示 {all.length} / {resource.data.total} 条记录，筛选和已读操作仅作用于已加载内容。</p>}
      <p className="activity-result-count">{resource.data.truncated ? "已加载内容中" : "个人空间中"}共 {all.length} 条记录 · 当前筛选 {items.length} 条</p>
      {items.length === 0 ? <div className="activity-empty"><span className="inbox-empty-mark">{unreadOnly ? <Icon name="check-check" /> : <Icon name="inbox" />}</span><h2>{all.length === 0 ? "新的进展，会在这里相见" : unreadOnly && !unread ? "未读通知，清空了" : "没有匹配的通知"}</h2><p>{all.length === 0 ? "在对话中创建提醒、计划或后台任务后，状态会自动出现在这里。" : "调整类型、状态或关键词，查看其他进展。"}</p>{all.length > 0 && <button type="button" className="activity-text-button" onClick={reset}>查看全部通知<Icon name="arrow-up-right" /></button>}</div> : <div className="activity-record-list" aria-label="跨会话进展记录">{sections.map(section => <section className="inbox-section" key={section.id} aria-labelledby={`inbox-${section.id}`}><h2 id={`inbox-${section.id}`}>{section.id === "attention" && <span className="inbox-attention-dot" />}{section.title}<span>{section.items.length}</span></h2>{section.items.map(item => <ActivityRecord key={activityKey(item)} item={item} read={reads.isRead(item)} onRead={() => reads.mark([item], !reads.isRead(item))} onConversation={onConversation} onManage={onManage} />)}</section>)}</div>}
    </>}
    {reads.error && <p className="activity-page-footnote" role="alert"><Icon name="circle-alert" />{reads.persistent ? reads.error : "阅读标记同步失败，浏览器存储也不可用，修改仅在当前页面保留。"}</p>}
    <p className="activity-page-footnote"><Icon name="monitor" />{reads.synced ? "阅读标记已与服务器同步，最多保留最近 500 个内容版本" : reads.persistent ? "阅读标记先保存在此浏览器，最多保留最近 500 条" : "浏览器存储不可用，阅读标记仅在当前页面保留"} · 任务状态与原会话同步 · 每 30 秒更新</p>
  </div>;
}
