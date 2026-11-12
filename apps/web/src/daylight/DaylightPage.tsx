import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN.js'
import { WorkspaceContainer } from './WorkspaceContainer.js'
import { WorkspaceBrand } from '../ui/WorkspaceBrand.js'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AppstoreOutlined,
  CloseOutlined,
  EditOutlined,
  FolderOutlined,
  PlusOutlined,
  SearchOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import TaskNavigation from './components/layout/Sidebar.js'
import CalendarPage from './features/calendar/CalendarPage.js'
import TaskBoard from './features/tasks/TaskBoard.js'
import TaskList from './features/tasks/TaskList.js'
import TaskEditor from './features/tasks/TaskEditor.js'
import TaskQuickAdd from './features/tasks/TaskQuickAdd.js'
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

type DaylightPageProps = { active: boolean; headerActions: ReactNode; taskId?: string }

function DaylightContent({ active, headerActions, taskId }: DaylightPageProps) {
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
  const [scope, setScope] = useState('today')
  const [view, setView] = useState<'board' | 'list'>('list')
  const [query, setQuery] = useState('')
  const [priority, setPriority] = useState('')
  const [sort, setSort] = useState('manual')
  const [draft, setDraft] = useState<Task | null>(null)
  const [projectDraft, setProjectDraft] = useState<Project | null>(null)
  const [settings, setSettings] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const openedTask = useRef<string | undefined>(undefined)
  const isCalendar = scope === 'calendar'
  const currentProject = data.projects.find((project) => project.id === scope)
  const tasks = selectTasks(data.tasks, scope, query, priority, sort)
  const title = currentProject?.name || '把事情一件件做好'

  useEffect(() => { void refresh() }, [])

  useEffect(() => {
    if (!taskId) { openedTask.current = undefined; return }
    if (!active || loading || loadError || openedTask.current === taskId) return
    // A source link waits for any existing editor to close, preserving its draft.
    if (draft || projectDraft || settings !== null) return
    const task = data.tasks.find((item) => item.id === taskId)
    if (!task) return
    openedTask.current = taskId
    setScope(task.projectId)
    setQuery('')
    setPriority('')
    setDraft(task)
  }, [active, taskId, loading, loadError, data.tasks, draft, projectDraft, settings])
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
        const options = searchRef.current?.closest('details')
        if (options) options.open = true
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [active, draft, projectDraft, settings])
  function navigate(next: string) {
    setScope(next)
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
        <main className="main-area" id="daylight-main">
          <header className="topbar"><div className="topbar-identity"><WorkspaceBrand />
            <div className="breadcrumbs">
              <span>工作空间</span>
              <span>/</span>
              <strong>待办</strong>
            </div>
            </div><div className="topbar-right">
              {headerActions}
            </div>
          </header>
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
                </div>
                <button
                  className="button primary new-task"
                  disabled={disabled}
                  onClick={() => {
                    const input = document.getElementById('daylight-quick-add')
                    if (!isCalendar && data.projects.length && input) input.focus()
                    else createTask()
                  }}
                >
                  <PlusOutlined /> 新增
                </button>
              </div>
          <TaskNavigation
            data={data}
            scope={scope}
            disabled={disabled}
            navigate={navigate}
            createProject={createProject}
            openSettings={openSettings}
          />
              <details className="task-display-options">
                <summary>搜索与显示{query || (!isCalendar && priority) ? ' · 已筛选' : ''}</summary>
              <div className="board-toolbar">
                <div className="view-tabs" role="group" aria-label="显示方式">
                  <button
                    aria-pressed={!isCalendar && view === 'board'}
                    className={!isCalendar && view === 'board' ? 'active' : ''}
                    onClick={() => { if (isCalendar) setScope('all'); setView('board') }}
                  >
                    <AppstoreOutlined /> 看板
                  </button>
                  <button
                    aria-pressed={!isCalendar && view === 'list'}
                    className={!isCalendar && view === 'list' ? 'active' : ''}
                    onClick={() => { if (isCalendar) setScope('all'); setView('list') }}
                  >
                    <UnorderedListOutlined /> 列表
                  </button>
                </div>
                <div className="task-tools">
                  <label className="task-search">
                    <SearchOutlined />
                    <input
                      ref={searchRef}
                      aria-label="搜索待办"
                      placeholder="搜索标题、标签、备注…"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    <kbd>⌘ K</kbd>
                  </label>
                {!isCalendar && <div className="board-filters">
                  <label>
                    <span className="sr-only">筛选优先级</span>
                    <select
                      aria-label="筛选优先级"
                      disabled={isCalendar}
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
                      disabled={isCalendar}
                      value={sort}
                      onChange={(event) => setSort(event.target.value)}
                    >
                      <option value="manual">自定义顺序</option>
                      <option value="newest">创建时间</option>
                      <option value="due">截止日期</option>
                      <option value="priority">优先级</option>
                    </select>
                  </label>
                </div>}
                </div>
              </div>
              </details>
              {(query || (!isCalendar && priority)) && !isCalendar && <div className="task-filter-summary" role="status">
                筛选后 {tasks.length} 条
                <button className="text-button" onClick={() => { setQuery(''); setPriority('') }}>清除筛选 <CloseOutlined /></button>
              </div>}
          </>
          <div hidden={isCalendar || !data.projects.length || !!loadError || loading}>
            <TaskQuickAdd projects={data.projects} projectId={currentProject?.id} dueDate={scope === 'today' ? localDate() : null} disabled={disabled} onSave={task => mutate(() => store.saveTask(task), '已添加待办')} />
          </div>
          {taskId && !loading && !loadError && !data.tasks.some((task) => task.id === taskId) && (
            <p className="empty-state" role="status">这条待办已删除或暂未载入。可以浏览现有项目，或重新读取待办。</p>
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
            <span role="status"><i className={busy || loading || loadError ? 'is-saving' : ''} />{loading ? '正在读取待办…' : loadError ? '读取失败，请重试' : busy ? '正在保存…' : '所有更改已保存'}</span>
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
export function DaylightPage({ active, headerActions, taskId }: DaylightPageProps) {
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
        <DaylightContent active={active} headerActions={headerActions} taskId={taskId} />
        </WorkspaceContainer.Provider>
      </ConfigProvider>
    </div>
  )
}

export default DaylightPage
