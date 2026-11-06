import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import type { DaylightTask, DaylightProject } from '@assistant/contracts'
import TaskList from '../dist/daylight/features/tasks/TaskList.js'
import TaskNavigation from '../dist/daylight/components/layout/Sidebar.js'
import TaskQuickAdd from '../dist/daylight/features/tasks/TaskQuickAdd.js'
import { mount } from './dom.js'

const projects: DaylightProject[] = [{ id: 'project', name: 'Dee', description: '', color: 'mint' }]
const task: DaylightTask = { id: 'task', projectId: 'project', title: '确认结果', description: '', status: 'review', priority: 'high', color: 'mint', dueDate: '2020-01-01', tags: [], checklist: [], createdAt: 1, position: 1 }

test('简洁任务行保留待确认、逾期、详情与完成操作', async t => {
  const edited: string[] = [], moved: string[] = []
  const { dom } = await mount(t, <TaskList tasks={[task]} projects={projects} disabled={false} onEdit={item => edited.push(item.id)} move={async (id, status) => { moved.push(`${id}:${status}`) }} createTask={() => {}} />)
  const doc = dom.window.document
  assert.equal(doc.querySelector('table'), null)
  assert.equal(doc.querySelector('.task-review-status')?.getAttribute('aria-label'), '确认结果 状态')
  assert.equal(doc.querySelector('.overdue')?.textContent, '2020-01-01')
  assert.match(doc.querySelector('.task-row-meta')!.textContent!, /Dee.*高优先级/)
  await act(async () => { doc.querySelector<HTMLButtonElement>('.task-row-copy')!.click(); doc.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click() })
  assert.deepEqual(edited, ['task'])
  assert.deepEqual(moved, ['task:done'])
})

test('主要待办入口保持三个，日历与逾期入口仍可使用', async t => {
  const scopes: string[] = []
  const { dom } = await mount(t, <TaskNavigation data={{ projects, tasks: [task] }} scope="today" disabled={false} navigate={scope => scopes.push(scope)} createProject={() => {}} openSettings={async () => {}} />)
  const doc = dom.window.document
  assert.equal(doc.querySelectorAll('.task-scope-tabs button').length, 3)
  assert.equal(doc.querySelector('details')!.open, false)
  const secondary = [...doc.querySelectorAll<HTMLButtonElement>('.task-project-tools button')]
  await act(async () => { secondary.find(button => button.textContent?.includes('日历'))!.click(); secondary.find(button => button.textContent?.includes('逾期'))!.click() })
  assert.deepEqual(scopes, ['calendar', 'overdue'])
})

test('快速新增默认只要求标题，隐藏详细选项仍保留默认项目和日期', async t => {
  const { dom } = await mount(t, <TaskQuickAdd projects={projects} dueDate="2026-11-05" disabled={false} onSave={async () => true} />)
  const doc = dom.window.document
  assert.equal(doc.querySelector('details')!.open, false)
  assert.ok(doc.querySelector('#daylight-quick-add'))
  assert.equal(doc.querySelector<HTMLSelectElement>('[aria-label="新增待办项目"]')!.value, 'project')
  assert.equal(doc.querySelector<HTMLInputElement>('[aria-label="新增待办日期"]')!.value, '2026-11-05')
  assert.equal(doc.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled, true)
})
