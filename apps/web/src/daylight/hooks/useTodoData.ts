import { useEffect, useRef, useState } from 'react'
import { message } from 'antd'
import type { Snapshot } from '../domain/todo.js'
import * as store from '../services/todoStore.js'
import { useDaylightContainer } from '../WorkspaceContainer.js'

export default function useTodoData(active: boolean) {
  const [data, setData] = useState<Snapshot>({ projects: [], tasks: [] })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const readVersion = useRef(0)
  const [notice, noticeContext] = message.useMessage({ getContainer: useDaylightContainer() })

  async function read() {
    const version = ++readVersion.current
    try {
      const result = await store.load()
      if (version === readVersion.current) {
        setData(result)
        setLoadError('')
      }
      return result
    } catch (error) {
      if (version === readVersion.current)
        setLoadError(error instanceof Error ? error.message : '读取失败，请重试。')
      throw error
    }
  }

  useEffect(() => {
    if (!active) return
    const reload = () => {
      if (document.visibilityState !== 'hidden' && !pending.current)
        void read().catch(() => {})
    }
    reload()
    const timer = window.setInterval(reload, 5000)
    window.addEventListener('daylight-data-changed', reload)
    window.addEventListener('focus', reload)
    document.addEventListener('visibilitychange', reload)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('daylight-data-changed', reload)
      window.removeEventListener('focus', reload)
      document.removeEventListener('visibilitychange', reload)
      ++readVersion.current
    }
  }, [active])

  async function refresh() {
    setLoading(true)
    try {
      return await read()
    } catch {
      // Keep the last snapshot and every in-progress editor draft.
    } finally {
      setLoading(false)
    }
  }

  async function mutate(action: () => Promise<void>, success = '已保存'): Promise<boolean> {
    if (pending.current) return false
    pending.current = true
    ++readVersion.current
    setBusy(true)
    try {
      await action()
      try {
        await read()
      } catch {
        setLoadError('操作已保存，但刷新失败。请重新读取后继续。')
        return false
      }
      void notice.success(success)
      return true
    } catch (error) {
      void notice.error(error instanceof Error ? error.message : '操作未保存，请重试。')
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return { data, loading, loadError, busy, refresh, mutate, notice, noticeContext }
}
