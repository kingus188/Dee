import { useRef, useState } from 'react'
import { CalendarOutlined, PlusOutlined } from '@ant-design/icons'
import { newTask, priorities, type Priority, type Project, type Task } from '../../domain/todo.js'

export default function TaskQuickAdd({ projects, projectId, dueDate, disabled, onSave }: {
  projects: Project[]
  projectId?: string
  dueDate: string | null
  disabled: boolean
  onSave: (task: Task) => Promise<boolean>
}) {
  const [title, setTitle] = useState('')
  const [project, setProject] = useState('')
  const [date, setDate] = useState<string | null>(null)
  const [priority, setPriority] = useState<Priority>('medium')
  const [error, setError] = useState('')
  const identity = useRef<string | null>(null)
  const submitting = useRef(false)
  const selectedProject = projects.some(item => item.id === project) ? project : projectId ?? projects[0]?.id ?? ''

  async function submit() {
    if (disabled || submitting.current || !title.trim() || !selectedProject) return
    submitting.current = true
    setError('')
    const task = newTask(selectedProject)
    // 重试沿用同一条待办 ID，保存后的刷新失败也不会重复新增。
    identity.current ??= task.id
    try {
      if (await onSave({ ...task, id: identity.current, title: title.trim(), dueDate: (date ?? dueDate) || null, priority })) {
        setTitle(''); setDate(null); setPriority('medium'); identity.current = null
      } else setError('请核对保存结果后重试，输入内容已保留。')
    } catch (error) {
      setError(error instanceof Error ? error.message : '添加失败，输入内容已保留。')
    } finally { submitting.current = false }
  }

  return <form className="task-quick-add" aria-label="快速添加待办" onSubmit={event => { event.preventDefault(); void submit() }}>
    <div className="quick-add-title"><PlusOutlined /><input aria-label="新待办标题" placeholder="添加一件要做的事…" value={title} required maxLength={160} disabled={disabled} onChange={event => setTitle(event.target.value)} /><span className="quick-add-hint">Enter 添加</span></div>
    <div className="quick-add-options">
      <label><span className="sr-only">新增待办项目</span><select aria-label="新增待办项目" value={selectedProject} disabled={disabled} onChange={event => setProject(event.target.value)}>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="quick-add-date"><CalendarOutlined /><span className="sr-only">新增待办日期</span><input aria-label="新增待办日期" type="date" value={date ?? dueDate ?? ''} disabled={disabled} onChange={event => setDate(event.target.value)} /></label>
      <label><span className="sr-only">新增待办优先级</span><select aria-label="新增待办优先级" value={priority} disabled={disabled} onChange={event => setPriority(event.target.value as Priority)}>{Object.entries(priorities).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button type="submit" className="button primary" disabled={disabled || !title.trim() || !selectedProject}><PlusOutlined />添加</button>
    </div>
    {error && <p className="quick-add-error" role="alert">{error}</p>}
  </form>
}
