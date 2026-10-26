import { useEffect, useRef, useState } from 'react'
import type { ExecutionRun } from '@assistant/contracts'
import { request } from '../../../api/request.js'
import { ExecutionHistory } from '../../../tasks/ExecutionHistory.js'

export function TaskExecutionPanel({ taskId, disabled }: { taskId: string; disabled: boolean }) {
  const [runs, setRuns] = useState<ExecutionRun[]>([]), [pending, setPending] = useState(false), [error, setError] = useState('')
  const requestId = useRef(crypto.randomUUID()), busy = useRef(false)
  const path = `/api/daylight/tasks/${taskId}`
  async function load() {
    try { const data = await request<{ items: ExecutionRun[] }>(path + '/executions'); setRuns(data.items); setError('') }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => { if (!document.hidden) void load() }, 5000); return () => window.clearInterval(timer) }, [taskId])
  async function start() {
    if (busy.current) return
    busy.current = true; setPending(true); setError('')
    try { await request(path + '/execute', { requestId: requestId.current }); requestId.current = crypto.randomUUID(); await load() }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { busy.current = false; setPending(false) }
  }
  const running = runs.some(run => run.status === 'queued' || run.status === 'running')
  return <section aria-label="交给小D执行"><h3>执行与结果</h3><p className="field-hint">按已保存的待办启动后台任务。结果交付后进入待确认，完成状态由你决定。</p>
    <button type="button" disabled={disabled || pending || running} onClick={() => void start()}>{pending ? '正在启动…' : running ? '正在执行' : '交给小D执行'}</button>
    <button type="button" className="text-button" disabled={pending} onClick={() => void load()}>刷新执行记录</button>
    <ExecutionHistory runs={runs} />{error && <p role="alert">{error}</p>}
  </section>
}
