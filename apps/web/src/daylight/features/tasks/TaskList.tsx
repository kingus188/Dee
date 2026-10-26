import {
  CheckOutlined,
  SearchOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons'
import {
  statuses,
  priorities,
  progress,
  isOverdue,
  type Task,
  type Project,
  type Status,
} from '../../domain/todo.js'

interface Props {
  tasks: Task[]
  projects: Project[]
  disabled: boolean
  move: (id: string, status: Status) => Promise<void>
  onEdit: (task: Task) => void
  createTask: () => void
}

export default function TaskList({
  tasks,
  projects,
  disabled,
  move,
  onEdit,
  createTask,
}: Props) {
  return (
    <div className="list-view">
      {tasks.length ? (
        <table>
          <thead>
            <tr>
              <th>任务名称</th>
              <th>项目</th>
              <th>状态</th>
              <th>优先级</th>
              <th>截止日期</th>
              <th>进度</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <div className="list-title">
                    <button
                      className={`list-check ${task.status === 'done' ? 'is-done' : ''}`}
                      disabled={disabled}
                      aria-label={`${task.status === 'done' ? '重新打开' : '完成'} ${task.title}`}
                      onClick={() =>
                        void move(
                          task.id,
                          task.status === 'done' ? 'todo' : 'done',
                        )
                      }
                    >
                      <CheckOutlined />
                    </button>
                    <button
                      className="list-task-name"
                      onClick={() => onEdit(task)}
                    >
                      {task.title}
                    </button>
                  </div>
                </td>
                <td data-label="项目">
                  {
                    projects.find((project) => project.id === task.projectId)
                      ?.name
                  }
                </td>
                <td data-label="状态">
                  <select
                    aria-label={`${task.title} 状态`}
                    disabled={disabled}
                    value={task.status}
                    onChange={(event) =>
                      void move(task.id, event.target.value as Status)
                    }
                  >
                    {statuses.map((status) => (
                      <option key={status.id} value={status.id}>
                        {status.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td data-label="优先级">
                  <span className={`priority-label priority-${task.priority}`}>
                    {priorities[task.priority]}
                  </span>
                </td>
                <td data-label="截止日期" className={isOverdue(task) ? 'overdue' : ''}>
                  {task.dueDate || '—'}
                </td>
                <td data-label="进度">{progress(task)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty-state">
          <SearchOutlined />
          <h2>没有找到待办</h2>
          <p>试试其他关键词，或添加一条新的待办。</p>
          <button className="button" onClick={() => createTask()}>
            新建待办 <ArrowRightOutlined />
          </button>
        </div>
      )}
    </div>
  )
}
