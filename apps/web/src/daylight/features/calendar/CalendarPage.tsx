import { useState, type DragEvent } from 'react'
import {
  LeftOutlined,
  RightOutlined,
  PlusOutlined,
  CalendarOutlined,
} from '@ant-design/icons'
import {
  localDate,
  selectTasks,
  type Snapshot,
  type Task,
} from '../../domain/todo.js'
import {
  addDays,
  agendaDays,
  calendarDate,
  calendarDragType,
  dayLabel,
  groupByDate,
  monthLabel,
  moveMonth,
  weekDays,
  weekdays,
  type CalendarView,
} from '../../domain/calendar.js'
import CalendarTask from './CalendarTask.js'
import MonthGrid from './MonthGrid.js'

export default function CalendarPage({
  data,
  query,
  disabled,
  onCreate,
  onEdit,
  onToggle,
  onSchedule,
}: {
  data: Snapshot
  query: string
  disabled: boolean
  onCreate: (date: string | null, projectId?: string) => void
  onEdit: (task: Task) => void
  onToggle: (task: Task) => void
  onSchedule: (id: string, date: string | null) => void
}) {
  const today = localDate()
  const [view, setView] = useState<CalendarView>('month')
  const [selected, setSelected] = useState(today)
  const [projectId, setProjectId] = useState('all')
  const [dragOver, setDragOver] = useState<string | null | undefined>()
  const activeProject = data.projects.some(
    (project) => project.id === projectId,
  )
    ? projectId
    : 'all'
  const tasks = selectTasks(data.tasks, activeProject, query, '', 'due')
  const groups = groupByDate(tasks)
  const projects = new Map(
    data.projects.map((project) => [project.id, project]),
  )
  const days = weekDays(selected)
  const selectedTasks = groups.get(selected) ?? []
  const undated = groups.get(null) ?? []
  function create(date: string | null) {
    onCreate(date, activeProject === 'all' ? undefined : activeProject)
  }
  function changePeriod(amount: number) {
    setSelected(
      view === 'week'
        ? addDays(selected, amount * 7)
        : moveMonth(selected, amount),
    )
  }
  function renderTask(task: Task, variant: 'chip' | 'card' | 'row') {
    return (
      <CalendarTask
        key={task.id}
        task={task}
        project={projects.get(task.projectId)}
        variant={variant}
        disabled={disabled}
        onEdit={onEdit}
        onToggle={onToggle}
      />
    )
  }
  function dragOverDate(event: DragEvent, date: string | null) {
    if (!disabled && event.dataTransfer.types.includes(calendarDragType)) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDragOver(date)
    }
  }
  function dropOnDate(event: DragEvent, date: string | null) {
    event.preventDefault()
    setDragOver(undefined)
    const id = event.dataTransfer.getData(calendarDragType)
    if (!disabled && id) onSchedule(id, date)
  }
  const unscheduled = (
    <section
      className={`calendar-unscheduled ${dragOver === null ? 'calendar-drop-over' : ''}`}
      aria-label="未安排日期"
      onDragOver={(event) => dragOverDate(event, null)}
      onDragLeave={() => setDragOver(undefined)}
      onDrop={(event) => dropOnDate(event, null)}
    >
      <div className="calendar-section-heading">
        <h2>
          未安排日期 <span>{undated.length}</span>
        </h2>
        <button
          className="icon-button"
          aria-label="新建未安排日期的待办"
          disabled={disabled}
          onClick={() => create(null)}
        >
          <PlusOutlined />
        </button>
      </div>
      {undated.length ? (
        <div className="calendar-unscheduled-items">
          {undated.map((task) =>
            renderTask(task, view === 'week' ? 'card' : 'row'),
          )}
        </div>
      ) : (
        <p className="calendar-empty">还没有未安排日期的待办</p>
      )}
    </section>
  )
  const grid = (compact = false) => (
    <MonthGrid
      selected={selected}
      today={today}
      groups={groups}
      compact={compact}
      disabled={disabled}
      onSelect={setSelected}
      onCreate={create}
      onSchedule={onSchedule}
      renderTask={(task) => renderTask(task, 'chip')}
    />
  )
  const period =
    view === 'week'
      ? `${monthLabel(days[0])}${calendarDate(days[0]).getDate()}日 – ${calendarDate(days[6]).getMonth() + 1}月${calendarDate(days[6]).getDate()}日`
      : monthLabel(selected)
  return (
    <section
      className={`calendar-page calendar-view-${view}`}
      aria-label="日历"
      onDragEnd={() => setDragOver(undefined)}
    >
      <div className="project-header">
        <div className="project-intro">
          <div className="title-row">
            <h1>日历</h1>
          </div>
          <p>把想做的事，放进合适的日子。</p>
        </div>
        <button
          className="button primary new-task"
          disabled={disabled}
          onClick={() => create(selected)}
        >
          <PlusOutlined /> 新建待办
        </button>
      </div>
      <div className="calendar-toolbar">
        <div className="calendar-period">
          <button
            className="button calendar-arrow"
            aria-label={view === 'week' ? '上一周' : '上个月'}
            onClick={() => changePeriod(-1)}
          >
            <LeftOutlined />
          </button>
          <h2 aria-live="polite">{period}</h2>
          <button
            className="button calendar-arrow"
            aria-label={view === 'week' ? '下一周' : '下个月'}
            onClick={() => changePeriod(1)}
          >
            <RightOutlined />
          </button>
          <button className="button" onClick={() => setSelected(today)}>
            今天
          </button>
        </div>
        <div className="calendar-controls">
          <div
            className="view-tabs calendar-view-tabs"
            role="group"
            aria-label="日历视图"
          >
            {(
              [
                ['month', '月'],
                ['week', '周'],
                ['agenda', '日程'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={view === value}
                className={view === value ? 'active' : ''}
                onClick={() => setView(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            aria-label="日历项目筛选"
            value={activeProject}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="all">全部项目</option>
            {data.projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {query && (
        <p className="calendar-search-result" role="status">
          搜索“{query}” · 共 {tasks.length} 条待办
        </p>
      )}
      {view === 'month' ? (
        <div className="calendar-month-layout">
          {grid()}
          <aside className="calendar-aside" aria-label="当天待办">
            <div className="calendar-day-detail">
              <div className="calendar-section-heading">
                <h2>{dayLabel(selected)}</h2>
                {selected === today && (
                  <span className="calendar-today-badge">今天</span>
                )}
              </div>
              <p className="calendar-task-count">
                {selectedTasks.length} 条待办
              </p>
              <div className="calendar-detail-tasks">
                {selectedTasks.map((task) => renderTask(task, 'card'))}
              </div>
              {!selectedTasks.length && (
                <p className="calendar-empty">
                  <CalendarOutlined /> 这一天还没有安排，留一点空间给自己。
                </p>
              )}
              <button
                className="calendar-add-task"
                disabled={disabled}
                onClick={() => create(selected)}
              >
                <PlusOutlined /> 添加待办
              </button>
            </div>
            {unscheduled}
          </aside>
        </div>
      ) : view === 'week' ? (
        <div className="calendar-week-layout">
          <div className="calendar-week-scroll">
            <div className="calendar-week-columns">
              {days.map((date, index) => (
                <section
                  key={date}
                  className={`calendar-week-day ${date === today ? 'today-column' : ''} ${dragOver === date ? 'calendar-drop-over' : ''}`}
                  aria-label={`${dayLabel(date)}待办`}
                  onDragOver={(event) => dragOverDate(event, date)}
                  onDragLeave={() => setDragOver(undefined)}
                  onDrop={(event) => dropOnDate(event, date)}
                >
                  <button
                    className="calendar-week-heading"
                    aria-label={`选择 ${date}`}
                    aria-pressed={date === selected}
                    onClick={() => setSelected(date)}
                  >
                    <span>{weekdays[index]}</span>
                    <strong className={date === today ? 'is-today' : ''}>
                      {calendarDate(date).getDate()}
                    </strong>
                  </button>
                  <div className="calendar-week-tasks">
                    {(groups.get(date) ?? []).map((task) =>
                      renderTask(task, 'card'),
                    )}
                    <button
                      className="calendar-add-task"
                      disabled={disabled}
                      onClick={() => {
                        setSelected(date)
                        create(date)
                      }}
                    >
                      <PlusOutlined /> 添加待办
                    </button>
                  </div>
                </section>
              ))}
            </div>
          </div>
          {unscheduled}
        </div>
      ) : (
        <div className="calendar-agenda-layout">
          <div className="calendar-agenda" aria-label="日期清单">
            <p className="calendar-agenda-range">
              {dayLabel(selected)}起 · 本月日程
            </p>
            {agendaDays(selected, groups).map((date) => (
              <section
                key={date}
                className={`calendar-agenda-day ${date === today ? 'today-agenda' : ''}`}
                aria-label={`${dayLabel(date)}日程`}
              >
                <div className="calendar-agenda-heading">
                  <h2>
                    {date === today ? (
                      <>
                        <b>今天</b> {dayLabel(date)}
                      </>
                    ) : date === addDays(today, 1) ? (
                      <>
                        <b>明天</b> {dayLabel(date)}
                      </>
                    ) : (
                      dayLabel(date)
                    )}
                  </h2>
                  <button
                    className="icon-button"
                    aria-label={`在 ${date} 新建待办`}
                    disabled={disabled}
                    onClick={() => create(date)}
                  >
                    <PlusOutlined />
                  </button>
                </div>
                {(groups.get(date) ?? []).map((task) =>
                  renderTask(task, 'row'),
                )}
                {!groups.get(date)?.length && (
                  <p className="calendar-empty">这一天暂无待办</p>
                )}
              </section>
            ))}
          </div>
          <aside
            className="calendar-aside calendar-agenda-aside"
            aria-label="日期导航与未安排待办"
          >
            <div className="calendar-mini-month">
              <div className="calendar-section-heading">
                <h2>{monthLabel(selected)}</h2>
                <span>
                  <button
                    className="icon-button"
                    aria-label="迷你日历上个月"
                    onClick={() => changePeriod(-1)}
                  >
                    <LeftOutlined />
                  </button>
                  <button
                    className="icon-button"
                    aria-label="迷你日历下个月"
                    onClick={() => changePeriod(1)}
                  >
                    <RightOutlined />
                  </button>
                </span>
              </div>
              {grid(true)}
            </div>
            {unscheduled}
          </aside>
        </div>
      )}
    </section>
  )
}
