import { CheckSquareOutlined } from '@ant-design/icons'
import { type Project, type Task, statuses } from '../../domain/todo.js'
import { markdownText } from '../../domain/markdown.js'
import { calendarDragType } from '../../domain/calendar.js'

export default function CalendarTask({
  task,
  project,
  variant,
  disabled,
  onEdit,
  onToggle,
}: {
  task: Task
  project?: Project
  variant: 'chip' | 'card' | 'row'
  disabled: boolean
  onEdit: (task: Task) => void
  onToggle: (task: Task) => void
}) {
  const done = task.status === 'done'
  const status = statuses.find((item) => item.id === task.status)!
  return (
    <article
      className={`calendar-task calendar-task-${variant} ${task.color} ${done ? 'is-done' : ''}`}
      draggable={!disabled}
      onDragStart={(event) => {
        event.dataTransfer.setData(calendarDragType, task.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
    >
      <input
        type="checkbox"
        checked={done}
        disabled={disabled}
        aria-label={`${done ? '重新打开' : '完成'} ${task.title}`}
        onChange={() => onToggle(task)}
      />
      <button
        className="calendar-task-title"
        title={task.title}
        disabled={disabled}
        onClick={() => onEdit(task)}
      >
        {task.title}
      </button>
      {variant !== 'chip' && (
        <>
          {variant === 'card' && task.description && (
            <p className="calendar-task-description">
              {markdownText(task.description).slice(0, 180)}
            </p>
          )}
          <div className="calendar-task-meta">
            <span className="calendar-project" title={project?.name}>
              <i className={`project-dot ${project?.color || 'lavender'}`} />
              {project?.name}
            </span>
            <span className={`calendar-status status-${task.status}`}>
              {status.label}
            </span>
            {variant === 'card' && task.checklist.length > 0 && (
              <span className="calendar-checklist">
                <CheckSquareOutlined />{' '}
                {task.checklist.filter((item) => item.done).length}/
                {task.checklist.length}
              </span>
            )}
          </div>
        </>
      )}
    </article>
  )
}
