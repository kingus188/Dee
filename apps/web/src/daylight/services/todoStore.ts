import { request } from '../../api/request.js'
import type { Snapshot, Task, Project, Status } from '../domain/todo.js'

export function load(): Promise<Snapshot> {
  return request<Snapshot>('/api/daylight')
}
export async function saveTask(task: Task): Promise<void> {
  await request('/api/daylight/tasks/save', { task })
}
export async function saveProject(project: Project): Promise<void> {
  await request('/api/daylight/projects/save', { project })
}
export async function moveTask(id: string, status: Status, position?: number): Promise<void> {
  await request('/api/daylight/tasks/move', { id, status, ...(position === undefined ? {} : { position }) })
}
export async function deleteTask(id: string): Promise<void> {
  await request('/api/daylight/tasks/delete', { id })
}
export async function deleteProject(id: string): Promise<void> {
  await request('/api/daylight/projects/delete', { id })
}
export async function databaseLocation(): Promise<string> {
  return (await request<{ location: string }>('/api/daylight/storage')).location
}
