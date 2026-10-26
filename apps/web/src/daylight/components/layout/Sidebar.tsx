import {
  AppstoreOutlined,
  SunOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  FolderOutlined,
  SettingOutlined,
  PlusOutlined,
} from '@ant-design/icons'
import { localDate, type Snapshot } from '../../domain/todo.js'

interface Props {
  data: Snapshot
  scope: string
  disabled: boolean
  navigate: (scope: string) => void
  createProject: () => void
  openSettings: () => Promise<void>
}

/** Local views stay in one row, leaving the main workspace for task content. */
export default function TaskNavigation({ data, scope, disabled, navigate, createProject, openSettings }: Props) {
  const views = [
    { id: 'today', label: '今天', icon: <SunOutlined />, count: data.tasks.filter((task) => task.dueDate === localDate() && task.status !== 'done').length },
    { id: 'all', label: '全部', icon: <AppstoreOutlined />, count: data.tasks.length },
    { id: 'completed', label: '已完成', icon: <CheckCircleOutlined />, count: data.tasks.filter((task) => task.status === 'done').length },
    { id: 'calendar', label: '日历', icon: <CalendarOutlined />, count: undefined },
  ]
  const project = data.projects.find((item) => item.id === scope)
  return (
    <div className="task-navigation-row">
      <nav className="task-scope-tabs" aria-label="待办视图">
        {views.map((item) => (
          <button key={item.id} aria-current={scope === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
            {item.icon}<span>{item.label}</span>
            {item.count !== undefined && <small>{item.count}</small>}
          </button>
        ))}
      </nav>
      <div className="task-project-tools">
        <label className={`task-project-select ${project ? 'is-selected' : ''}`}>
          <FolderOutlined />
          <select aria-label="选择项目" value={project?.id ?? ''} disabled={disabled || !data.projects.length} onChange={(event) => navigate(event.target.value)}>
            <option value="" disabled>按项目查看</option>
            {data.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <button className="icon-button" aria-label="新建项目" title="新建项目" onClick={createProject} disabled={disabled}><PlusOutlined /></button>
        <button className="icon-button" aria-label="设置与存储" title="设置与存储" onClick={() => void openSettings()}><SettingOutlined /></button>
      </div>
    </div>
  )
}
