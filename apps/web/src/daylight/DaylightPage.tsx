import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN.js'
import { WorkspaceContainer } from './WorkspaceContainer.js'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AppstoreOutlined,
  BarsOutlined,
  CloseOutlined,
  EditOutlined,
  FolderOutlined,
  PlusOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import Sidebar from './components/layout/Sidebar.js'
import CalendarPage from './features/calendar/CalendarPage.js'
import TaskBoard from './features/tasks/TaskBoard.js'
import TaskList from './features/tasks/TaskList.js'
import TaskEditor from './features/tasks/TaskEditor.js'
import ProjectEditor from './features/projects/ProjectEditor.js'
import StorageSettings from './features/settings/StorageSettings.js'
import useTodoData from './hooks/useTodoData.js'
import {
  localDate,
  newTask,
  priorities,
  selectTasks,
  statuses,
  type Project,
  type Status,
  type Task,
} from './domain/todo.js'
import * as store from './services/todoStore.js'

function DaylightContent({ active, headerActions }: { active: boolean; headerActions: ReactNode }) {
  const {
    data,
    loading,
    loadError,
    busy,
    refresh,
    mutate,
    notice,
    noticeContext,
  } = useTodoData(active)
  const [scope, setScope] = useState('all')
  const [view, setView] = useState<'board' | 'list'>('board')
  const [query, setQuery] = useState('')
  const [priority, setPriority] = useState('')
  const [sort, setSort] = useState('manual')
  const [draft, setDraft] = useState<Task | null>(null)
  const [projectDraft, setProjectDraft] = useState<Project | null>(null)
  const [settings, setSettings] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const isCalendar = scope === 'calendar'
  const currentProject = data.projects.find((project) => project.id === scope)
  const tasks = selectTasks(data.tasks, scope, query, priority, sort)
  const scopedTasks = selectTasks(data.tasks, scope, '', '', 'newest')
  const completed = scopedTasks.filter((task) => task.status === 'done').length
  const completion = scopedTasks.length
    ? Math.round((completed / scopedTasks.length) * 100)
    : 0
  const title =
    currentProject?.name ||
    {
      all: '我的全部待办',
      today: '今天，慢慢来',
      completed: '已经完成的美好',
      calendar: '日历',
    }[scope] ||
    '我的待办'
  const subtitle =
    currentProject?.description ||
    {
      all: '把想做的事记下来，把心里的空间留出来。',
      today: '专注今天到期的事，一次做好一件。',
      completed: '回头看看，你已经走了这么远。',
    }[scope]

  useEffect(() => {
    void refresh().then((result) => {
      if (result?.projects.length)
        setScope(result.projects[0].id)
    })
  }, [])
  useEffect(() => {
    if (!active) return
    const handle = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k' &&
        !draft &&
        !projectDraft &&
        settings === null
      ) {
        event.preventDefault()
        setSidebarOpen(true)
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [active, draft, projectDraft, settings])
  function navigate(next: string) {
    setScope(next)
    setSidebarOpen(false)
  }
  function createProject() {
    setProjectDraft({
      id: crypto.randomUUID(),
      name: '',
      description: '',
      color: 'lavender',
    })
  }
  function createTask(
    status: Status = 'todo',
    dueDate?: string | null,
    targetProjectId?: string,
  ) {
    const projectId =
      targetProjectId || currentProject?.id || data.projects[0]?.id
    if (!projectId) {
      createProject()
      return
    }
    const next = newTask(projectId, status)
    if (dueDate !== undefined) next.dueDate = dueDate
    else if (scope === 'today') next.dueDate = localDate()
    setDraft(next)
  }
  async function move(id: string, status: Status, position?: number) {
    const task = data.tasks.find((task) => task.id === id)
    if (!task) return
    if (task.status !== status)
      await mutate(
        () => store.moveTask(id, status, position),
        `已移至${statuses.find((item) => item.id === status)?.label}`,
      )
    else if (position !== undefined && position !== task.position)
      await mutate(() => store.moveTask(id, status, position), '已调整顺序')
  }
  async function deleteTask(task: Task) {
    if (await mutate(() => store.deleteTask(task.id), '已删除')) setDraft(null)
  }
  async function deleteProject(project: Project) {
    if (await mutate(() => store.deleteProject(project.id), '已删除')) {
      setProjectDraft(null)
      setScope('all')
    }
  }
  async function openSettings() {
    try {
      setSettings(await store.databaseLocation())
    } catch {
      void notice.error('暂时无法读取存储信息。')
    }
  }
  const disabled = busy || loading || !!loadError
  return (
    <div className="desktop-backdrop">
      {noticeContext}
      <div className="app-shell">
        <Sidebar
          data={data}
          scope={scope}
          sidebarOpen={sidebarOpen}
          query={query}
          disabled={disabled}
          searchRef={searchRef}
          navigate={navigate}
          setQuery={setQuery}
          createProject={createProject}
          openSettings={openSettings}
          onClose={() => setSidebarOpen(false)}
        />
        <main className="main-area" id="daylight-main">
          <header className="topbar">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setSidebarOpen(true)}
            >
              <BarsOutlined />
            </button>
            <div className="breadcrumbs">
              <span>待办</span>
              <span>/</span>
              <strong>{title}</strong>
            </div>
            <div className="topbar-right">
              {headerActions}
            </div>
          </header>
          {!isCalendar && (
            <>
              <div className="project-header">
                <div className="project-intro">
                  <div className="title-row">
                    <h1>{title}</h1>
                    {currentProject && (
                      <button
                        className="icon-button"
                        aria-label="编辑当前项目"
                        disabled={disabled}
                        onClick={() => setProjectDraft(currentProject)}
                      >
                        <EditOutlined />
                      </button>
                    )}
                  </div>
                  <p>{subtitle}</p>
                </div>
                <button
                  className="button primary new-task"
                  disabled={disabled}
                  onClick={() => createTask()}
                >
                  <PlusOutlined /> 新建待办
                </button>
              </div>
              <div className="board-toolbar">
                <div className="view-tabs" role="group" aria-label="显示方式">
                  <button
                    aria-pressed={view === 'board'}
                    className={view === 'board' ? 'active' : ''}
                    onClick={() => setView('board')}
                  >
                    <AppstoreOutlined /> 看板
                  </button>
                  <button
                    aria-pressed={view === 'list'}
                    className={view === 'list' ? 'active' : ''}
                    onClick={() => setView('list')}
                  >
                    <UnorderedListOutlined /> 列表
                  </button>
                </div>
                <div className="board-filters">
                  <label>
                    <span className="sr-only">筛选优先级</span>
                    <select
                      aria-label="筛选优先级"
                      value={priority}
                      onChange={(event) => setPriority(event.target.value)}
                    >
                      <option value="">所有优先级</option>
                      {Object.entries(priorities).map(([value, text]) => (
                        <option key={value} value={value}>
                          {text}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="sr-only">排序方式</span>
                    <select
                      aria-label="排序方式"
                      value={sort}
                      onChange={(event) => setSort(event.target.value)}
                    >
                      <option value="manual">自定义顺序</option>
                      <option value="newest">创建时间</option>
                      <option value="due">截止日期</option>
                      <option value="priority">优先级</option>
                    </select>
                  </label>
                </div>
              </div>
              <div className="board-summary">
                <span>
                  <i className="small-purple-dot" /> 共 {scopedTasks.length}{' '}
                  条待办 <b>·</b> 已完成 {completed} 条
                  {(query || priority) && (
                    <span className="filter-result">
                      {' '}
                      · 筛选后 {tasks.length} 条
                      <button
                        className="text-button"
                        onClick={() => {
                          setQuery('')
                          setPriority('')
                        }}
                      >
                        清除筛选 <CloseOutlined />
                      </button>
                    </span>
                  )}
                </span>
                <div className="summary-progress">
                  <span>项目进度</span>
                  <div>
                    <i style={{ width: `${completion}%` }} />
                  </div>
                  <strong>{completion}%</strong>
                </div>
              </div>
            </>
          )}
          {loadError ? (
            <div className="empty-state" role="alert">
              <FolderOutlined />
              <h2>暂时无法读取待办</h2>
              <p>{loadError}</p>
              <button className="button" onClick={() => void refresh()}>
                重新读取
              </button>
            </div>
          ) : loading ? (
            <div className="empty-state" role="status">
              <div className="loading-orbit" />
              <p>正在打开你的小小空间…</p>
            </div>
          ) : !data.projects.length ? (
            <div className="empty-state">
              <FolderOutlined />
              <h2>让第一个想法，有个归处</h2>
              <p>创建一个项目，开始整理你的日常。</p>
              <button className="button primary" onClick={createProject}>
                <PlusOutlined /> 创建项目
              </button>
            </div>
          ) : isCalendar ? (
            <CalendarPage
              data={data}
              query={query}
              disabled={disabled}
              onCreate={(date, projectId) =>
                createTask('todo', date, projectId)
              }
              onEdit={setDraft}
              onToggle={(task) =>
                void move(task.id, task.status === 'done' ? 'todo' : 'done')
              }
              onSchedule={(id, dueDate) => {
                const task = data.tasks.find((task) => task.id === id)
                if (task && task.dueDate !== dueDate)
                  void mutate(
                    () => store.saveTask({ ...task, dueDate }),
                    dueDate ? '已调整截止日期' : '已移至未安排日期',
                  )
              }}
            />
          ) : view === 'board' ? (
            <TaskBoard
              tasks={tasks}
              disabled={disabled}
              filtered={!!(query || priority)}
              sortable={sort === 'manual'}
              createTask={createTask}
              onEdit={setDraft}
              move={move}
              onToggle={(task, id) =>
                void mutate(() =>
                  store.saveTask({
                    ...task,
                    checklist: task.checklist.map((item) =>
                      item.id === id ? { ...item, done: !item.done } : item,
                    ),
                  }),
                )
              }
            />
          ) : (
            <TaskList
              tasks={tasks}
              projects={data.projects}
              disabled={disabled}
              move={move}
              onEdit={setDraft}
              createTask={createTask}
            />
          )}
          <footer className="main-footer">
            <span>{busy ? '正在保存…' : '一点点完成，一点点轻松。'}</span>
            <span>
              {isCalendar
                ? '拖动待办调整日期 · 点击标题编辑'
                : view === 'board'
                  ? '拖动卡片切换状态 · 点击标题编辑'
                  : '在状态选项中移动待办'}
            </span>
          </footer>
        </main>
      </div>
      {draft && (
        <TaskEditor
          key={draft.id}
          task={draft}
          projects={data.projects}
          existing={data.tasks.some((task) => task.id === draft.id)}
          busy={busy}
          onClose={() => setDraft(null)}
          onSave={(task) => mutate(() => store.saveTask(task))}
          onDelete={() => deleteTask(draft)}
        />
      )}
      {projectDraft && (
        <ProjectEditor
          key={projectDraft.id}
          project={projectDraft}
          existing={data.projects.some(
            (project) => project.id === projectDraft.id,
          )}
          busy={busy}
          onClose={() => setProjectDraft(null)}
          onSave={async (project) => {
            const saved = await mutate(() => store.saveProject(project))
            if (saved) navigate(project.id)
            return saved
          }}
          onDelete={() => deleteProject(projectDraft)}
        />
      )}
      <StorageSettings
        location={settings}
        projectCount={data.projects.length}
        taskCount={data.tasks.length}
        onClose={() => setSettings(null)}
      />
    </div>
  )
}


/** Keep mounted when inactive so task and project editor drafts survive navigation. */
export function DaylightPage({ active, headerActions }: { active: boolean; headerActions: ReactNode }) {
  const container = useRef<HTMLDivElement>(null)
  const [theme] = useState(() => {
    const style = getComputedStyle(document.body)
    const token = (name: string) => style.getPropertyValue(name).trim()
    return { token: {
      colorPrimary: token('--primary'),
      colorText: token('--text-main'),
      colorTextSecondary: token('--text-muted'),
      colorBorder: token('--border'),
      colorBgContainer: token('--bg-surface'),
      borderRadius: 9,
      fontFamily: style.fontFamily,
    } }
  })
  return (
    <div className="daylight-workspace" ref={container} hidden={!active}>
      <ConfigProvider
        locale={zhCN.default}
        getPopupContainer={(trigger) => container.current ?? trigger?.parentElement ?? document.body}
        getTargetContainer={() => container.current ?? document.body}
        theme={theme}
      >
        <WorkspaceContainer.Provider value={() => container.current ?? document.body}>
        <DaylightContent active={active} headerActions={headerActions} />
        </WorkspaceContainer.Provider>
      </ConfigProvider>
    </div>
  )
}

export default DaylightPage
