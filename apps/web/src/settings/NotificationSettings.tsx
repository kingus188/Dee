import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationOverview, NotificationStatus } from "@assistant/contracts";
import { request } from "../api/request.js";

type Filter = NotificationStatus | "all";
const filters: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" }, { value: "pending", label: "待发送" },
  { value: "sent", label: "已送达" }, { value: "failed", label: "失败" },
];
const statusLabels: Record<NotificationStatus, string> = { pending: "待发送", sent: "已送达", failed: "失败" };
const formatTime = (value: number) => new Date(value).toLocaleString("zh-CN");

export function NotificationSettings() {
  const [filter, setFilter] = useState<Filter>("failed");
  const [snapshot, setSnapshot] = useState<{ filter: Filter; data: NotificationOverview } | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const version = useRef(0), busy = useRef<number | null>(null);
  const overview = snapshot?.filter === filter ? snapshot.data : null;

  const refresh = useCallback(async (retryId?: string) => {
    if (busy.current !== null) return;
    const current = ++version.current;
    busy.current = current; setPending(true); setError("");
    if (retryId !== undefined) setFeedback("");
    let queued = false;
    try {
      if (retryId !== undefined) {
        await request<{ ok: true }>("/api/notifications/retry", { id: retryId });
        if (current !== version.current) return;
        queued = true; setFeedback("已入队。");
      }
      const data = await request<NotificationOverview>(`/api/notifications${filter === "all" ? "" : `?status=${filter}`}`);
      if (current === version.current) setSnapshot({ filter, data });
    } catch {
      if (current === version.current) setError(retryId !== undefined && !queued
        ? "重新投递未能确认，请刷新记录后核对，再决定是否重试。"
        : "暂时无法读取通知记录，已有记录仍保留。请手动刷新或等待自动重试。");
    } finally {
      if (busy.current === current) busy.current = null;
      if (current === version.current) setPending(false);
    }
  }, [filter]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { version.current++; busy.current = null; clearInterval(timer); };
  }, [refresh]);

  return <section className="settings-form notification-settings" aria-labelledby="notifications-title">
    <h2 id="notifications-title">通知投递</h2>
    <p className="settings-field-hint" id="notifications-retry-hint">查看当前投递目标最近 100 条通知记录，每 5 秒自动刷新。重新投递会保留原事件 ID 和正文，并重新获得 5 次投递机会；可能重复送达，接收端需按事件 ID 去重。</p>
    {overview && <p className="settings-field-hint">{overview.enabled ? "通知投递已启用。" : overview.mode === "off" ? "通知已关闭或当前处于离线模式，记录仍保留。" : "未配置通知投递地址。"}{!overview.enabled && "当前无法重新投递。"}</p>}
    <div className="notification-controls">
      <div><label htmlFor="notification-filter">投递状态</label>
        <select id="notification-filter" value={filter} disabled={pending} onChange={event => {
          version.current++; setFilter(event.target.value as Filter); setFeedback(""); setError("");
        }}>{filters.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
      </div>
      <button type="button" className="header-button" disabled={pending} onClick={() => void refresh()}>刷新记录</button>
    </div>
    <p className="settings-field-hint" role="status" aria-live="polite">{pending ? "正在读取或更新通知记录…" : overview ? `已显示 ${overview.items.length} 条${filter === "all" ? "" : statusLabels[filter]}记录。` : "尚未读取到通知记录。"}</p>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <p className="settings-feedback" role="status" aria-live="polite">{feedback}</p>
    <div aria-busy={pending}>
      {overview && (overview.items.length === 0 ? <p className="notification-empty">{filter === "all" ? "当前目标暂无通知记录。" : `当前目标暂无${statusLabels[filter]}记录。`}</p> : <ul className="notification-records" aria-label="通知记录">
        {overview.items.map(item => <li key={item.id} className="notification-record">
          <div className="notification-record-heading"><strong>{statusLabels[item.status]}</strong><span>已尝试 {item.attempts} 次</span></div>
          <dl>
            <div><dt>事件 ID</dt><dd><code>{item.id}</code></dd></div>
            <div><dt>创建时间</dt><dd>{formatTime(item.createdAt)}</dd></div>
            {item.status === "pending" ? <div><dt>下次投递</dt><dd>{formatTime(item.nextAt)}</dd></div> : <div><dt>完成时间</dt><dd>{item.finishedAt === null ? "尚未完成" : formatTime(item.finishedAt)}</dd></div>}
            {item.lastError && <div><dt>投递错误</dt><dd className="notification-record-error">{item.lastError}</dd></div>}
          </dl>
          {item.status === "failed" && <button type="button" className="header-button" disabled={pending || !overview.enabled} aria-label={`重新投递事件 ${item.id}`} aria-describedby="notifications-retry-hint" onClick={() => void refresh(item.id)}>重新投递</button>}
        </li>)}
      </ul>)}
    </div>
  </section>;
}
