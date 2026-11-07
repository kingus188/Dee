import type { ConversationCard } from "../chat/cards.js";
import { useState } from "react";
import type { CSSProperties } from "react";
import { renderMarkdown } from "../chat/markdown.js";
import { Icon } from "../ui/Icon.js";
import { taskColor, taskPriority, taskStatus } from "./related.js";

export function RelatedTaskDetails({ card }: { card: ConversationCard }) {
  const { task, project } = card.daylight!;
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const completed = task.checklist.filter(item => item.done).length, total = task.checklist.length;
  const next = task.checklist.find(item => !item.done);
  return <>
    <div className="related-task-overview">
      <h3>{task.title}</h3>
      {total > 0 && <div className="related-task-progress" role="img" aria-label={`子任务已完成 ${completed}/${total}`}>
        <span style={{ "--progress": `${completed / total * 360}deg` } as CSSProperties}>{completed}<small>/{total}</small></span>
        <div><strong>{completed === 0 ? "子任务尚未开始" : completed === total ? "子任务已全部完成" : `已完成 ${completed} 项`}</strong>{next && <small>下一步：{next.title}</small>}</div>
      </div>}
    </div>
    <dl className="related-task-fields">
      <div><dt>项目</dt><dd>{project ?? "项目不可用"}</dd></div>
      <div><dt>状态</dt><dd>{taskStatus[task.status]}</dd></div>
      <div><dt>优先级</dt><dd><span className="related-priority" data-priority={task.priority}>{taskPriority[task.priority]}</span></dd></div>
      <div><dt>颜色</dt><dd><span className="related-color" data-color={task.color} />{taskColor[task.color]}</dd></div>
      <div><dt>截止</dt><dd>{task.dueDate ?? "未设置"}</dd></div>
    </dl>
    {!!task.checklist.length && <ul className="related-checklist" aria-label="子任务（只读）">{task.checklist.map(item => <li key={item.id} data-done={item.done}><Icon name={item.done ? "square-check" : "square"} /><span>{item.title}</span><span className="sr-only">{item.done ? "已完成" : "未完成"}</span></li>)}</ul>}
    {!!task.tags.length && <div className="related-tags" aria-label="标签">{task.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
    {task.description && <details className="related-description" onToggle={event => setDescriptionOpen(event.currentTarget.open)}><summary>待办说明</summary>{descriptionOpen && <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(task.description) }} />}</details>}
  </>;
}
