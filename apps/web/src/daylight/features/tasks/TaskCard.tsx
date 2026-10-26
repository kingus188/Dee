import { useMemo } from 'react'
import { markdownText } from '../../domain/markdown.js'
import {
  CalendarOutlined,
  CheckOutlined,
  MoreOutlined,
  CheckSquareOutlined,
  ArrowUpOutlined,
} from '@ant-design/icons'
import {
  isOverdue,
  localDate,
  priorities,
  progress,
  type Task,
} from '../../domain/todo.js'

interface Props {
  task: Task
  busy: boolean
  onEdit: () => void
  onToggle: (id: string) => void
  onComplete: () => void
  onDrag: (id: string | null) => void
}
export default function TaskCard({
  task,
  busy,
  onEdit,
  onToggle,
  onComplete,
  onDrag,
}: Props) {
  const description = useMemo(
    () => markdownText(task.description),
    [task.description],
  )
  const percent = progress(task)
  const date =
    task.dueDate === localDate()
      ? '今天'
      : task.dueDate
        ? `${Number(task.dueDate.slice(5, 7))} 月 ${Number(task.dueDate.slice(8))} 日`
        : '未设日期'
  return (
    <article
      className={`task-card ${task.color}`}
      data-id={task.id}
      data-status={task.status}
      draggable={!busy}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', task.id)
        event.dataTransfer.effectAllowed = 'move'
        onDrag(task.id)
      }}
      onDragEnd={() => onDrag(null)}
    >
      <div className="card-top">
        <div className="tags">
          {task.tags.length ? (
            task.tags.map((tag) => (
              <span className="tag" key={tag}>
                {tag}
              </span>
            ))
          ) : (
            <span className="tag">待办</span>
          )}
        </div>
        <button
          className="icon-button card-menu"
          onClick={onEdit}
          aria-label={`编辑 ${task.title}`}
        >
          <MoreOutlined />
        </button>
      </div>
      <button className="card-title" onClick={onEdit}>
        {task.title}
      </button>
      {task.description && <p className="card-description">{description}</p>}
      {!!task.checklist.length && (
        <div className="card-checklist">
          {task.checklist.slice(0, 4).map((item) => (
            <label className={item.done ? 'checked' : ''} key={item.id}>
              <input
                type="checkbox"
                checked={item.done}
                disabled={busy}
                onChange={() => onToggle(item.id)}
              />
              <span>{item.title}</span>
            </label>
          ))}
          {task.checklist.length > 4 && (
            <button className="more-checks" onClick={onEdit}>
              还有 {task.checklist.length - 4} 个子任务
            </button>
          )}
        </div>
      )}
      <div className={`card-date ${isOverdue(task) ? 'overdue' : ''}`}>
        <CalendarOutlined />
        <span>
          {date}
          {isOverdue(task) ? ' · 已逾期' : ''}
        </span>
      </div>
      {(task.checklist.length > 0 || task.status === 'done') && (
        <div className="progress-section">
          <div>
            <span>完成进度</span>
            <span>{percent}%</span>
          </div>
          <div
            className="dotted-progress"
            role="progressbar"
            aria-label={`${task.title} 完成进度`}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <i style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}
      <footer className="card-footer">
        <span className={`priority-label priority-${task.priority}`}>
          {task.priority === 'high' && <ArrowUpOutlined />}
          {priorities[task.priority]}
        </span>
        <div className="card-footer-right">
          {!!task.checklist.length && (
            <span>
              <CheckSquareOutlined />{' '}
              {task.checklist.filter((item) => item.done).length}/
              {task.checklist.length}
            </span>
          )}
          <button
            className={`complete-button ${task.status === 'done' ? 'is-done' : ''}`}
            onClick={onComplete}
            disabled={busy}
            aria-label={
              task.status === 'done'
                ? `重新打开 ${task.title}`
                : `完成 ${task.title}`
            }
            title={task.status === 'done' ? '重新打开' : '标记完成'}
          >
            <CheckOutlined />
          </button>
        </div>
      </footer>
    </article>
  )
}
