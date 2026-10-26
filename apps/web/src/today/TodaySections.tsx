import type { DaylightSnapshot, PersonalData, WorkspaceActivities, WorkspaceMail } from "@assistant/contracts";
import type { CardGroup } from "../chat/cards.js";
import { localDate } from "../daylight/domain/todo.js";
import { Icon } from "../ui/Icon.js";
import { ActivityRecord } from "./ActivityRecord.js";
import { ResourceFeedback } from "./ResourceFeedback.js";
import { activityKey, activityPhase, dateTime, selectTodayTasks } from "./model.js";
import type { PageResource } from "./usePageResource.js";

export function TodayTasks({ resource, onDaylight }: { resource: PageResource<DaylightSnapshot>; onDaylight: (taskId?: string) => void }) {
  const summary = resource.data ? selectTodayTasks(resource.data) : null;
  const projects = new Map(resource.data?.projects.map(project => [project.id, project.name]));
  return <section className="today-panel today-panel-tasks" aria-labelledby="today-tasks-title">
    <div className="today-panel-heading"><div><span className="today-kicker">把注意力放在这里</span><h2 id="today-tasks-title">今日待办</h2></div><Icon name="list-todo" /></div>
    <ResourceFeedback resource={resource} label="待办" />
    {summary && <>
      <div className="today-task-totals"><span><strong>{summary.today}</strong> 今日到期</span><span className={summary.overdue > 0 ? "today-overdue" : undefined}><strong>{summary.overdue}</strong> 已逾期</span></div>
      {summary.due.length === 0 ? <div className="today-empty"><strong>{resource.data!.tasks.length === 0 ? "还没有待办，留一个想法给今天。" : "今天没有到期或逾期待办。"}</strong><p>可以去 Daylight 查看所有项目、安排下一步。</p></div> : <ul className="today-task-list" aria-label="今日到期与逾期待办">
        {summary.due.slice(0, 6).map(task => <li key={task.id}>
          <button type="button" className="today-task-button" onClick={() => onDaylight(task.id)}>
            <span className="today-task-mark" aria-hidden="true"><Icon name={task.status === "review" ? "check" : task.status === "doing" ? "clock-3" : "square"} /></span>
            <span className="today-task-copy"><strong>{task.title}</strong><span>Daylight · {projects.get(task.projectId) ?? "项目记录已缺失"}</span></span>
            <span className={`today-task-due${task.dueDate! < localDate() ? " today-overdue" : ""}`}><time dateTime={task.dueDate!}>{task.dueDate === localDate() ? "今天" : task.dueDate}</time>{task.dueDate! < localDate() && <small>已逾期</small>}</span>
          </button>
        </li>)}
      </ul>}
      <div className="today-task-footer"><span>进行中 {summary.doing} · 待确认 {summary.review}</span><button type="button" className="today-text-button" onClick={() => onDaylight()}>{summary.due.length > 6 ? `查看全部 ${summary.due.length} 项` : "打开 Daylight"}<Icon name="arrow-up-right" /></button></div>
    </>}
  </section>;
}

export function TodayProgress({ resource, onActivities, onConversation }: { resource: PageResource<WorkspaceActivities>; onActivities: () => void; onConversation: (id: number) => void }) {
  const items = resource.data?.items ?? [];
  const failed = items.filter(item => item.status === "failed");
  const running = items.filter(item => activityPhase(item) === "running");
  const pending = items.filter(item => activityPhase(item) === "pending");
  const visible = [...failed, ...running, ...pending].slice(0, 4);
  return <section className="today-panel today-panel-progress" aria-labelledby="today-progress-title">
    <div className="today-panel-heading"><div><span className="today-kicker">跨会话的事情，一处看见</span><h2 id="today-progress-title">正在推进</h2></div><Icon name="clock-3" /></div>
    <ResourceFeedback resource={resource} label="任务进展" />
    {resource.data && <>
      <p className="today-progress-summary">{resource.data.truncated ? "已加载记录中：" : ""}<strong>{running.length}</strong> 项执行中 · <strong>{pending.length}</strong> 项待处理</p>
      {failed.length > 0 && <p className="today-progress-attention" role="status"><Icon name="circle-alert" /><span>{resource.data.truncated ? "已加载记录中有 " : "有 "}<strong>{failed.length}</strong> 项执行失败，请查看来源会话。</span></p>}
      {visible.length === 0 ? <div className="today-empty"><strong>{resource.data.truncated ? "已加载记录中暂无执行中或待处理事项。" : "目前没有执行中或待处理事项。"}</strong><p>已结束的提醒、计划和后台结果都在统一进展中。</p></div> : <div className="today-progress-list">{visible.map(item => <ActivityRecord key={activityKey(item)} item={item} onConversation={onConversation} compact />)}</div>}
      {resource.data.truncated && <p className="today-note">列表已截断，前往统一进展查看加载范围。</p>}
      <button type="button" className="today-text-button today-panel-link" onClick={onActivities}>查看统一进展 <Icon name="arrow-up-right" /></button>
    </>}
  </section>;
}

export function TodayApprovals({ resource, onGroup }: { resource: PageResource<PersonalData>; onGroup: (group: CardGroup) => void }) {
  const memory = resource.data?.memory.filter(item => item.status === "pending");
  const skills = resource.data?.skills.filter(item => item.status === "pending");
  return <section className="today-panel today-panel-approvals" aria-labelledby="today-approvals-title">
    <div className="today-panel-heading"><div><span className="today-kicker">由你决定，才会留下</span><h2 id="today-approvals-title">待你批准</h2></div><Icon name="shield-check" /></div>
    <ResourceFeedback resource={resource} label="记忆与技能" />
    {memory && skills && <>
      {memory.length === 0 && skills.length === 0 && <p className="today-approval-empty">没有待批准的候选。之后提出的新记忆和技能会在这里等你。</p>}
      <div className="today-approval-links">
        <button type="button" onClick={() => onGroup("memory")} className="today-approval-link"><Icon name="brain" /><span><strong>长期记忆</strong><small>{memory.length > 0 ? `${memory.length} 条等待批准` : "查看已保存的记忆"}</small></span><b>{memory.length}</b><Icon name="chevron-right" /></button>
        <button type="button" onClick={() => onGroup("skills")} className="today-approval-link"><Icon name="sparkles" /><span><strong>我的技能</strong><small>{skills.length > 0 ? `${skills.length} 项等待批准` : "查看已有技能"}</small></span><b>{skills.length}</b><Icon name="chevron-right" /></button>
      </div>
    </>}
  </section>;
}

function mailConnection(status: WorkspaceMail["status"]): string {
  if (!status.enabled) return "未启用";
  if (status.offline) return "离线，显示缓存";
  if (status.syncing) return "同步中";
  return status.connected ? "已连接" : "未连接";
}

export function TodayMail({ resource, onSettings }: { resource: PageResource<WorkspaceMail>; onSettings: () => void }) {
  return <section className="today-panel today-panel-mail" aria-labelledby="today-mail-title">
    <div className="today-panel-heading"><div><span className="today-kicker">Outlook · 最近 6 封缓存</span><h2 id="today-mail-title">最近邮件</h2></div><button type="button" className="today-icon-button" aria-label="打开邮件设置" onClick={onSettings}><Icon name="settings" /></button></div>
    <ResourceFeedback resource={resource} label="邮件" />
    {resource.data && <>
      <div className="today-mail-status"><span className="today-connection-state">{mailConnection(resource.data.status)}</span><span>{resource.data.status.lastSuccessAt ? `上次同步 ${dateTime(resource.data.status.lastSuccessAt)}` : "尚无成功同步记录"}</span></div>
      {resource.data.status.error && <p className="today-mail-error" role="status">同步状态：{resource.data.status.error}</p>}
      {resource.data.messages.length === 0 ? <div className="today-empty"><strong>{resource.data.status.enabled ? "当前缓存还没有邮件。" : "连接邮箱，让最近邮件出现在这里。"}</strong><p>邮件以只读方式展示，连接与同步可在设置中管理。</p><button type="button" className="today-text-button" onClick={onSettings}>打开邮件设置 <Icon name="arrow-up-right" /></button></div> : <ul className="today-mail-list" aria-label="最近邮件缓存">
        {resource.data.messages.slice(0, 6).map(mail => <li key={mail.id}>
          <div className="today-mail-envelope"><strong>{mail.sender || mail.address || "发件人未提供"}</strong><time dateTime={mail.receivedAt}>{dateTime(mail.receivedAt)}</time></div>
          <h3>{mail.subject || "（无主题）"}{mail.hasAttachments && <span className="today-mail-attachment" aria-label="含附件"><Icon name="paperclip" /></span>}</h3>
          <p>{mail.preview || "这封邮件没有缓存预览。"}</p>
        </li>)}
      </ul>}
    </>}
  </section>;
}
