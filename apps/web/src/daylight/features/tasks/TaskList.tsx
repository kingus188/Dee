import { CheckOutlined, SearchOutlined } from '@ant-design/icons'
import { statuses, priorities, progress, isOverdue, localDate, type Task, type Project, type Status } from '../../domain/todo.js'

interface Props {
  tasks: Task[]
  projects: Project[]
  disabled: boolean
  move: (id: string, status: Status) => Promise<void>
  onEdit: (task: Task) => void
  createTask: () => void
}

/** Keep the title and next action visible; full task controls live in the editor. */
export default function TaskList({ tasks, projects, disabled, move, onEdit, createTask }: Props) {
  return <div className="list-view task-calm-list">
    {tasks.length ? <ul className="task-rows">
      {tasks.map(task => <li key={task.id} className={`task-row ${task.status === 'done' ? 'is-done' : ''}`}>
        <button className={`list-check ${task.status === 'done' ? 'is-done' : ''}`} disabled={disabled}
          role="checkbox" aria-checked={task.status === 'done'}
          aria-label={`${task.status === 'done' ? '重新打开' : '完成'} ${task.title}`}
          onClick={() => void move(task.id, task.status === 'done' ? 'todo' : 'done')}><CheckOutlined /></button>
        <button className="task-row-copy" onClick={() => onEdit(task)}>
          <span className="list-task-name">{task.title}</span>
          <span className="task-row-meta">
            <span>{projects.find(project => project.id === task.projectId)?.name}</span>
            {task.priority === 'high' && <span className="task-important">{priorities[task.priority]}</span>}
            {!!task.checklist.length && <span>子任务 {progress(task)}%</span>}
          </span>
        </button>
        <div className="task-row-side">
          <select aria-label={`${task.title} 状态`} disabled={disabled} value={task.status}
            className={task.status === 'review' ? 'task-review-status' : ''}
            onChange={event => void move(task.id, event.target.value as Status)}>
            {statuses.map(status => <option key={status.id} value={status.id}>{status.label}</option>)}
          </select>
          {task.dueDate && <time dateTime={task.dueDate} className={isOverdue(task) ? 'overdue' : ''}>{task.dueDate === localDate() ? '今天' : task.dueDate}</time>}
        </div>
      </li>)}
    </ul> : <div className="empty-state">
      <SearchOutlined /><h2>这里暂时没有待办</h2>
      <p>可以添加一件事，或换个筛选看看。</p>
      <button className="text-button" disabled={disabled} onClick={createTask}>新建待办</button>
    </div>}
  </div>
}
