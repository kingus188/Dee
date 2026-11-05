import type { DaylightSnapshot, PersonalData, WorkspaceActivities, WorkspaceMail } from "@assistant/contracts";
import type { CardGroup } from "../chat/cards.js";
import { Icon } from "../ui/Icon.js";
import { isDaylightSnapshot, isPersonalData, isWorkspaceActivities, isWorkspaceMail } from "./data.js";
import { activityPhase } from "./model.js";
import { TodayApprovals, TodayMail, TodayProgress, TodayTasks } from "./TodaySections.js";
import { usePageResource } from "./usePageResource.js";

export type TodayPageProps = {
  active: boolean;
  onPrompt: (text: string) => void;
  onGroup: (group: CardGroup) => void;
  onDaylight: (taskId?: string) => void;
  onActivities: () => void;
  onSettings: () => void;
  onConversation: (id: number) => void;
};

const prompts = [
  { icon: "list-todo", label: "梳理今天的优先级", text: "请查看我今天到期和逾期的 Daylight 待办，结合执行中的任务，帮我梳理今天最值得先做的三件事。没有足够数据时请直接说明。" },
  { icon: "notebook-pen", label: "把想法变成下一步", text: "我想把一个想法拆成可执行的下一步。请先问我想完成什么，再帮我整理成清晰的待办。" },
  { icon: "message-circle", label: "回顾最近的进展", text: "请结合已有的会话和任务记录，帮我回顾最近的进展，列出已完成、仍在推进和需要我决定的事项，并说明来源。" },
];

export function TodayPage({ active, onPrompt, onGroup, onDaylight, onActivities, onSettings, onConversation }: TodayPageProps) {
  const daylight = usePageResource<DaylightSnapshot>("/api/daylight", active, isDaylightSnapshot);
  const personal = usePageResource<PersonalData>("/api/personal", active, isPersonalData);
  const activities = usePageResource<WorkspaceActivities>("/api/workspace/activities", active, isWorkspaceActivities);
  const mail = usePageResource<WorkspaceMail>("/api/workspace/mail", active, isWorkspaceMail);
  const resources = [daylight, personal, activities, mail];
  const loading = resources.some(resource => resource.loading);
  const now = new Date();
  // Quiet successful empty states, but never hide an error or incomplete data.
  const showProgress = !activities.data || !!activities.error || activities.data.truncated || activities.data.items.some(item => item.status === "failed" || ["running", "pending"].includes(activityPhase(item)));
  const showApprovals = !personal.data || !!personal.error || [...personal.data.memory, ...personal.data.skills].some(item => item.status === "pending");
  const mailAttention = !!mail.error || !!mail.data?.status.error;


  function refreshAll() {
    for (const resource of resources) resource.refresh();
  }

  return <div className="today-page" hidden={!active}>
    <header className="today-page-header">
      <div><p className="today-date"><Icon name="calendar-days" /><time dateTime={`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`}>{now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}</time></p><h1>今天</h1></div>
      <button type="button" className="today-refresh-button" disabled={loading} onClick={refreshAll}><Icon name="rotate-ccw" />{loading ? "正在更新" : "刷新"}</button>
    </header>
    <div className="today-workspace-grid">
      <TodayTasks resource={daylight} onDaylight={onDaylight} />
      {showProgress && <TodayProgress resource={activities} onActivities={onActivities} onConversation={onConversation} />}
      {showApprovals && <TodayApprovals resource={personal} onGroup={onGroup} />}
    </div>
    <details className="today-secondary" open={mailAttention || undefined}>
      <summary><Icon name="mail" /><span>最近邮件</span>{mailAttention && <span className="today-secondary-attention">需要检查</span>}<Icon name="chevron-down" /></summary>
      <TodayMail resource={mail} onSettings={onSettings} />
    </details>
    <details className="today-secondary today-shortcuts">
      <summary><Icon name="message-circle" /><span>从一句话开始</span><Icon name="chevron-down" /></summary>
      <div className="today-shortcut-list">{prompts.map(prompt => <button type="button" key={prompt.label} className="today-shortcut" onClick={() => onPrompt(prompt.text)}><Icon name={prompt.icon} /><span>{prompt.label}</span><Icon name="arrow-up-right" /></button>)}</div>
    </details>
  </div>;
}
