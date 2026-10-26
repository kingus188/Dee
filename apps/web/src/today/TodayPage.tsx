import type { DaylightSnapshot, PersonalData, WorkspaceActivities, WorkspaceMail } from "@assistant/contracts";
import type { CardGroup } from "../chat/cards.js";
import { Icon } from "../ui/Icon.js";
import { isDaylightSnapshot, isPersonalData, isWorkspaceActivities, isWorkspaceMail } from "./data.js";
import { greeting } from "./model.js";
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

  function refreshAll() {
    for (const resource of resources) resource.refresh();
  }

  return <div className="today-page" hidden={!active}>
    <header className="today-page-header">
      <div><p className="today-date"><Icon name="calendar-days" /><time dateTime={`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`}>{now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}</time></p><h1>今天</h1><p className="today-greeting">{greeting(now)}</p></div>
      <button type="button" className="today-refresh-button" disabled={loading} onClick={refreshAll}><Icon name="rotate-ccw" />{loading ? "正在更新" : "刷新"}</button>
    </header>
    <div className="today-workspace-grid">
      <TodayTasks resource={daylight} onDaylight={onDaylight} />
      <TodayProgress resource={activities} onActivities={onActivities} onConversation={onConversation} />
      <TodayApprovals resource={personal} onGroup={onGroup} />
      <TodayMail resource={mail} onSettings={onSettings} />
    </div>
    <section className="today-shortcuts" aria-labelledby="today-shortcuts-title">
      <div className="today-shortcuts-heading"><h2 id="today-shortcuts-title">从一句话开始</h2><p>交给小 D，一起往前走。</p></div>
      <div className="today-shortcut-list">{prompts.map(prompt => <button type="button" key={prompt.label} className="today-shortcut" onClick={() => onPrompt(prompt.text)}><Icon name={prompt.icon} /><span>{prompt.label}</span><Icon name="arrow-up-right" /></button>)}</div>
    </section>
    <p className="today-page-footnote">显示个人空间中的真实记录 · 页面可见时每 30 秒更新</p>
  </div>;
}
