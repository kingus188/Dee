import { Fragment, useState } from 'react'
import { PlusOutlined } from '@ant-design/icons'
import { statuses, type Status, type Task } from '../../domain/todo.js'
import TaskCard from './TaskCard.js'

interface Props {
  tasks: Task[]
  disabled: boolean
  filtered: boolean
  /** Manual order is shown, so drops can also reorder within a column. */
  sortable: boolean
  createTask: (status?: Status) => void
  onEdit: (task: Task) => void
  onToggle: (task: Task, id: string) => void
  move: (id: string, status: Status, position?: number) => Promise<void>
}

interface DropTarget {
  status: Status
  /** Insert index among the column's cards, excluding the dragged one. */
  index: number
}

// Index of the first card whose midline is below the pointer.
function dropIndex(column: HTMLElement, y: number, dragging: string): number {
  const cards = [
    ...column.querySelectorAll<HTMLElement>('.task-card[data-id]'),
  ].filter((card) => card.dataset.id !== dragging)
  const index = cards.findIndex((card) => {
    const rect = card.getBoundingClientRect()
    return y < rect.top + rect.height / 2
  })
  return index < 0 ? cards.length : index
}

// ponytail: midpoint ordering, float precision runs out after ~20 drops into
// the same gap; renumber a column's positions if that ever shows up.
function positionAt(items: Task[], index: number): number {
  const before = items[index - 1]?.position
  const after = items[index]?.position
  if (before === undefined && after === undefined) return 0
  if (before === undefined) return after! - 1000
  if (after === undefined) return before + 1000
  return (before + after) / 2
}

export default function TaskBoard({
  tasks,
  disabled,
  filtered,
  sortable,
  createTask,
  onEdit,
  onToggle,
  move,
}: Props) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<DropTarget | null>(null)
  function drop(status: Status, index: number) {
    const task = tasks.find((task) => task.id === dragging)
    if (!task) return
    if (!sortable) {
      void move(task.id, status)
      return
    }
    const items = tasks.filter(
      (item) => item.status === status && item.id !== task.id,
    )
    const current = tasks
      .filter((item) => item.status === status)
      .findIndex((item) => item.id === task.id)
    // Dropping back into its own slot is a no-op.
    if (current === index) return
    void move(task.id, status, positionAt(items, index))
  }
  return (
    <div className="board">
      {statuses.map((status) => {
        const items = tasks.filter((task) => task.status === status.id)
        const others = items.filter((task) => task.id !== dragging)
        const indicatorBefore =
          sortable && dragOver?.status === status.id
            ? (others[dragOver.index]?.id ?? 'end')
            : null
        return (
          <section
            className={`board-column ${dragOver?.status === status.id ? 'drag-over' : ''}`}
            key={status.id}
            aria-label={status.label}
            onDragOver={(event) => {
              if (dragging && !disabled) {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                const index = sortable
                  ? dropIndex(event.currentTarget, event.clientY, dragging)
                  : -1
                if (dragOver?.status !== status.id || dragOver.index !== index)
                  setDragOver({ status: status.id, index })
              }
            }}
            onDragLeave={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              )
                setDragOver(null)
            }}
            onDrop={(event) => {
              event.preventDefault()
              setDragOver(null)
              if (
                dragging &&
                event.dataTransfer.getData('text/plain') === dragging
              )
                drop(
                  status.id,
                  dropIndex(event.currentTarget, event.clientY, dragging),
                )
              setDragging(null)
            }}
          >
            <header className="column-header">
              <div>
                <h2>
                  <i style={{ background: status.color }} />
                  {status.label}
                  <span>{items.length}</span>
                </h2>
                <p>{status.hint}</p>
              </div>
              <button
                className="column-add"
                disabled={disabled}
                onClick={() => createTask(status.id)}
                aria-label={`在${status.label}中新建待办`}
              >
                <PlusOutlined />
              </button>
            </header>
            <div className="column-content">
              {items.map((task) => (
                <Fragment key={task.id}>
                  {indicatorBefore === task.id && (
                    <div className="drop-indicator" />
                  )}
                  <TaskCard
                    task={task}
                    busy={disabled}
                    onEdit={() => onEdit(task)}
                    onToggle={(id) => onToggle(task, id)}
                    onComplete={() =>
                      void move(
                        task.id,
                        task.status === 'done' ? 'todo' : 'done',
                      )
                    }
                    onDrag={(id) => {
                      setDragging(id)
                      if (!id) setDragOver(null)
                    }}
                  />
                </Fragment>
              ))}
              {indicatorBefore === 'end' && <div className="drop-indicator" />}
              {!items.length && (
                <div className="column-empty">
                  <span>
                    {filtered
                      ? '没有符合筛选的待办'
                      : status.id === 'done'
                        ? '完成的事情会在这里相聚'
                        : '留点空间，给新的可能'}
                  </span>
                </div>
              )}
              <button
                className="add-card"
                disabled={disabled}
                onClick={() => createTask(status.id)}
              >
                <PlusOutlined /> 添加待办
              </button>
            </div>
          </section>
        )
      })}
    </div>
  )
}
