import { markdownText } from './markdown.js'
import type {
  DaylightStatus as Status,
  DaylightColor as Color,
  DaylightPriority as Priority,
  DaylightProject as Project,
  DaylightChecklistItem as ChecklistItem,
  DaylightTask as Task,
  DaylightSnapshot as Snapshot,
} from '@assistant/contracts'
export type { Status, Color, Priority, Project, ChecklistItem, Task, Snapshot }

export const statuses = [
  { id: 'todo', label: '待开始', hint: '给想法一个起点', color: '#9c94b1' },
  { id: 'doing', label: '进行中', hint: '专注眼前的一小步', color: '#b49aef' },
  { id: 'review', label: '待确认', hint: '再检查一下就完成', color: '#e9ae72' },
  { id: 'done', label: '已完成', hint: '每一份努力都算数', color: '#83b99d' },
] as const
export const colors = ['peach', 'lavender', 'mint', 'sky', 'rose'] as const
export const priorities: Record<Priority, string> = {
  low: '低优先级',
  medium: '普通',
  high: '高优先级',
}
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function progress(task: Task): number {
  if (task.status === 'done') return 100
  if (!task.checklist.length) return 0
  return Math.round(
    (task.checklist.filter((item) => item.done).length /
      task.checklist.length) *
      100,
  )
}
export function isOverdue(task: Task, today = localDate()): boolean {
  return task.status !== 'done' && !!task.dueDate && task.dueDate < today
}
export function selectTasks(
  tasks: Task[],
  scope: string,
  query: string,
  priority: string,
  sort: string,
  today = localDate(),
): Task[] {
  const needle = query.trim().toLocaleLowerCase()
  return tasks
    .filter((task) => {
      const inScope =
        scope === 'all' ||
        (scope === 'today'
          ? task.dueDate === today && task.status !== 'done'
          : scope === 'completed'
            ? task.status === 'done'
            : task.projectId === scope)
      return (
        inScope &&
        (!priority || task.priority === priority) &&
        (!needle ||
          [task.title, markdownText(task.description), ...task.tags]
            .join(' ')
            .toLocaleLowerCase()
            .includes(needle))
      )
    })
    .sort((a, b) => {
      if (sort === 'due')
        return (
          (a.dueDate || '9999').localeCompare(b.dueDate || '9999') ||
          b.createdAt - a.createdAt
        )
      if (sort === 'priority')
        return (
          { high: 0, medium: 1, low: 2 }[a.priority] -
            { high: 0, medium: 1, low: 2 }[b.priority] ||
          b.createdAt - a.createdAt
        )
      if (sort === 'manual') return a.position - b.position
      return b.createdAt - a.createdAt
    })
}
export function newTask(projectId: string, status: Status = 'todo'): Task {
  return {
    id: crypto.randomUUID(),
    projectId,
    title: '',
    description: '',
    status,
    priority: 'medium',
    color: 'lavender',
    dueDate: null,
    tags: [],
    checklist: [],
    createdAt: Date.now(),
    position: -Date.now(),
  }
}
