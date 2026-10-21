import {
  type DragEvent,
  type ReactNode,
  type CSSProperties,
  useState,
} from 'react'
import { PlusOutlined } from '@ant-design/icons'
import { type Task } from '../../domain/todo.js'
import {
  calendarDate,
  calendarDragType,
  dayLabel,
  monthDays,
  monthLabel,
  weekdays,
} from '../../domain/calendar.js'

export default function MonthGrid({
  selected,
  today,
  groups,
  compact = false,
  disabled,
  onSelect,
  onCreate,
  onSchedule,
  renderTask,
}: {
  selected: string
  today: string
  groups: Map<string | null, Task[]>
  compact?: boolean
  disabled: boolean
  onSelect: (date: string) => void
  onCreate: (date: string) => void
  onSchedule: (id: string, date: string) => void
  renderTask: (task: Task) => ReactNode
}) {
  const [dragOver, setDragOver] = useState<string | null>(null)
  function drop(event: DragEvent, date: string) {
    event.preventDefault()
    setDragOver(null)
    const id = event.dataTransfer.getData(calendarDragType)
    if (!disabled && id) onSchedule(id, date)
  }
  return (
    <div
      className={`calendar-month ${compact ? 'is-compact' : ''}`}
      onDragEnd={() => setDragOver(null)}
      role="group"
      aria-label={`${monthLabel(selected)}${compact ? '日期导航' : '月历'}`}
    >
      <div className="calendar-weekdays">
        {weekdays.map((day) => (
          <span key={day}>{compact ? day.slice(1) : day}</span>
        ))}
      </div>
      <div
        className="calendar-month-days"
        style={{ '--weeks': monthDays(selected).length / 7 } as CSSProperties}
      >
        {monthDays(selected).map((date) => {
          const tasks = groups.get(date) ?? []
          const outside = date.slice(0, 7) !== selected.slice(0, 7)
          return (
            <div
              key={date}
              className={`calendar-day ${outside ? 'outside-month' : ''} ${date === selected ? 'selected-day' : ''} ${dragOver === date ? 'calendar-drop-over' : ''}`}
              onClick={(event) => {
                if (event.target === event.currentTarget) onSelect(date)
              }}
              onDragOver={(event) => {
                if (
                  !disabled &&
                  event.dataTransfer.types.includes(calendarDragType)
                ) {
                  event.preventDefault()
                  setDragOver(date)
                }
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(event) => drop(event, date)}
            >
              <div className="calendar-day-heading">
                <button
                  className={`calendar-date ${date === today ? 'is-today' : ''}`}
                  aria-label={`${dayLabel(date)}${date === today ? '，今天' : ''}，${tasks.length}条待办`}
                  aria-pressed={date === selected}
                  aria-current={date === today ? 'date' : undefined}
                  onClick={() => onSelect(date)}
                >
                  {outside && !compact
                    ? `${calendarDate(date).getMonth() + 1}/`
                    : ''}
                  {calendarDate(date).getDate()}
                </button>
                {!compact && (
                  <button
                    className="calendar-day-add icon-button"
                    aria-label={`在 ${date} 新建待办`}
                    disabled={disabled}
                    onClick={() => {
                      onSelect(date)
                      onCreate(date)
                    }}
                  >
                    <PlusOutlined />
                  </button>
                )}
              </div>
              {compact ? (
                <div className="calendar-day-dots">
                  {tasks.slice(0, 3).map((task) => (
                    <i key={task.id} className={`project-dot ${task.color}`} />
                  ))}
                </div>
              ) : (
                <div className="calendar-day-tasks">
                  {tasks.slice(0, 3).map(renderTask)}
                  {tasks.length > 1 && (
                    <button
                      className={`calendar-more ${tasks.length <= 3 ? 'calendar-more-mobile-only' : ''}`}
                      onClick={() => onSelect(date)}
                    >
                      <span className="calendar-more-desktop">
                        还有 {tasks.length - 3} 条
                      </span>
                      <span className="calendar-more-mobile">
                        还有 {tasks.length - 1} 条
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
