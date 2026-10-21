import { type RefObject } from 'react'
import {
  AppstoreOutlined,
  SunOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  SettingOutlined,
  SearchOutlined,
  PlusOutlined,
} from '@ant-design/icons'
import { localDate, type Snapshot } from '../../domain/todo.js'

interface Props {
  data: Snapshot
  scope: string
  sidebarOpen: boolean
  query: string
  disabled: boolean
  searchRef: RefObject<HTMLInputElement | null>
  navigate: (scope: string) => void
  setQuery: (query: string) => void
  createProject: () => void
  openSettings: () => Promise<void>
  onClose: () => void
}

export default function Sidebar({
  data,
  scope,
  sidebarOpen,
  query,
  disabled,
  searchRef,
  navigate,
  setQuery,
  createProject,
  openSettings,
  onClose,
}: Props) {
  return (
    <>
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => onClose()}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label="待办导航">
        <h2 className="sidebar-heading">待办</h2>
        <label className="search-box">
          <SearchOutlined />
          <input
            ref={searchRef}
            aria-label="搜索待办"
            placeholder="搜索待办…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>⌘ K</kbd>
        </label>
        <div className="sidebar-section-title">视图</div>
        <button
          className={`nav-item ${scope === 'all' ? 'selected' : ''}`}
          onClick={() => navigate('all')}
        >
          <AppstoreOutlined />
          <span>全部待办</span>
          <small>{data.tasks.length}</small>
        </button>
        <button
          className={`nav-item ${scope === 'today' ? 'selected' : ''}`}
          onClick={() => navigate('today')}
        >
          <SunOutlined />
          <span>今天</span>
          <small>
            {
              data.tasks.filter(
                (task) =>
                  task.dueDate === localDate() && task.status !== 'done',
              ).length
            }
          </small>
        </button>
        <button
          className={`nav-item calendar-nav ${scope === 'calendar' ? 'selected' : ''}`}
          onClick={() => navigate('calendar')}
        >
          <CalendarOutlined />
          <span>日历</span>
        </button>
        <button
          className={`nav-item ${scope === 'completed' ? 'selected' : ''}`}
          onClick={() => navigate('completed')}
        >
          <CheckCircleOutlined />
          <span>已完成</span>
          <small>
            {data.tasks.filter((task) => task.status === 'done').length}
          </small>
        </button>
        <div className="sidebar-section-title project-heading">
          <span>
            我的项目 <small>{data.projects.length}</small>
          </span>
        </div>
        <div className="project-navigation">
          {data.projects.map((project) => (
            <button
              className={`nav-item project-item ${scope === project.id ? 'selected' : ''}`}
              key={project.id}
              onClick={() => navigate(project.id)}
            >
              <i className={`project-dot ${project.color}`} />
              <span>{project.name}</span>
              <small>
                {
                  data.tasks.filter(
                    (task) =>
                      task.projectId === project.id && task.status !== 'done',
                  ).length
                }
              </small>
            </button>
          ))}
          <button
            className="nav-item add-project"
            onClick={createProject}
            disabled={disabled}
          >
            <PlusOutlined />
            <span>新建项目</span>
          </button>
        </div>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => void openSettings()}>
            <SettingOutlined />
            <span>设置与存储</span>
          </button>
          <div className="storage-status">
            <i />
            <span>
              服务端持久存储
            </span>
          </div>
        </div>
      </aside>
    </>
  )
}
