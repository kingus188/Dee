import { localDate, type Task } from './todo.js'

export type CalendarView = 'month' | 'week' | 'agenda'
export const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

// Construct local noon explicitly: ISO strings parse as UTC, and midnight can cross DST changes.
export function calendarDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(12, 0, 0, 0)
  return date
}
export function addDays(value: string, amount: number): string {
  const date = calendarDate(value)
  date.setDate(date.getDate() + amount)
  return localDate(date)
}
export function monthStart(value: string): string {
  return `${value.slice(0, 7)}-01`
}
export function moveMonth(value: string, amount: number): string {
  const date = calendarDate(monthStart(value))
  date.setMonth(date.getMonth() + amount)
  return localDate(date)
}
export function weekDays(value: string): string[] {
  const offset = (calendarDate(value).getDay() + 6) % 7
  return Array.from({ length: 7 }, (_, index) => addDays(value, index - offset))
}
export function monthDays(value: string): string[] {
  const first = monthStart(value)
  const start = weekDays(first)[0]
  const last = addDays(moveMonth(first, 1), -1)
  const count =
    Math.ceil(
      (((calendarDate(first).getDay() + 6) % 7) +
        calendarDate(last).getDate()) /
        7,
    ) * 7
  return Array.from({ length: count }, (_, index) => addDays(start, index))
}
export function groupByDate(tasks: Task[]): Map<string | null, Task[]> {
  const groups = new Map<string | null, Task[]>()
  for (const task of tasks) {
    const group = groups.get(task.dueDate) ?? []
    group.push(task)
    groups.set(task.dueDate, group)
  }
  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        Number(a.status === 'done') - Number(b.status === 'done') ||
        b.createdAt - a.createdAt ||
        a.id.localeCompare(b.id),
    )
  }
  return groups
}
export function agendaDays(
  selected: string,
  groups: Map<string | null, Task[]>,
): string[] {
  const end = moveMonth(selected, 1)
  return [
    ...new Set(
      [selected, ...groups.keys()].filter(
        (date): date is string => !!date && date >= selected && date < end,
      ),
    ),
  ].sort()
}
export function monthLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
  }).format(calendarDate(value))
}
export function dayLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(calendarDate(value))
}
export const calendarDragType = 'application/x-daylight-task'
