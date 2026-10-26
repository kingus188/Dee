import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationOverview, NotificationPreferences, NotificationQuietHours, NotificationStatus } from "@assistant/contracts";
import { request } from "../api/request.js";
import { Icon } from "../ui/Icon.js";

type Filter = NotificationStatus | "all";
const filters: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" }, { value: "pending", label: "待发送" },
  { value: "sent", label: "已送达" }, { value: "failed", label: "失败" },
];
const statusLabels: Record<NotificationStatus, string> = { pending: "待发送", sent: "已送达", failed: "失败" };
const statusContent: Record<NotificationStatus, { title: string; icon: string }> = {
  pending: { title: "等待投递", icon: "clock-3" },
  sent: { title: "通知已送达", icon: "check" },
  failed: { title: "投递失败", icon: "circle-alert" },
};
const formatTime = (value: number) => new Date(value).toLocaleString("zh-CN");

function QuietHoursSettings() {
  const [draft, setDraft] = useState<NotificationQuietHours | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const busy = useRef(false), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  async function load() {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(""); setFeedback("");
    try {
      const data = await request<NotificationPreferences>("/api/notifications/preferences");
      if (!data?.quietHours || typeof data.quietHours.enabled !== "boolean" || ![data.quietHours.start, data.quietHours.end, data.quietHours.timeZone].every(value => typeof value === "string")) throw new Error("偏好响应无效");
      if (live.current) setDraft(data.quietHours);
    } catch { if (live.current) setError("免打扰设置读取失败，请重新读取后再保存。"); }
    finally { busy.current = false; if (live.current) setPending(false); }
  }
  async function save() {
    if (busy.current || !draft) return;
    busy.current = true; setPending(true); setError(""); setFeedback("");
    try {
      const data = await request<NotificationPreferences>("/api/notifications/preferences", { quietHours: draft });
      if (!data?.quietHours || typeof data.quietHours.enabled !== "boolean") throw new Error("偏好响应无效");
      if (live.current) { setDraft(data.quietHours); setFeedback("已保存，新的投递时段即时生效。"); }
    } catch { if (live.current) setError("免打扰设置保存失败，请核对时间与 IANA 时区后重试，当前草稿仍保留。"); }
    finally { busy.current = false; if (live.current) setPending(false); }
  }
  function change(patch: Partial<NotificationQuietHours>) { setDraft(previous => previous ? { ...previous, ...patch } : previous); setFeedback(""); }
  return <details className="notification-policy" data-notification-preferences onToggle={event => { if (event.currentTarget.open && !draft) void load(); }}>
    <summary><Icon name="moon" />免打扰时段<Icon name="chevron-right" /></summary>
    <p className="settings-field-hint">免打扰期间，通知中心继续保留全部内容；外部通知（含失败事件）在窗口结束后投递。起止时刻按所填时区计算，开始包含、结束排除，支持跨午夜。</p>
    {!draft ? <><p role={error ? "alert" : "status"}>{error || "正在读取免打扰设置…"}</p>{error && <button className="header-button" type="button" disabled={pending} onClick={() => void load()}>重新读取</button>}</> : <form aria-label="免打扰设置" aria-busy={pending} onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={pending}>
        <label htmlFor="quiet-enabled"><input id="quiet-enabled" name="quiet-enabled" type="checkbox" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} /> 启用免打扰</label>
        <label htmlFor="quiet-start">开始时间</label><input id="quiet-start" name="quiet-start" type="time" required value={draft.start} onChange={event => change({ start: event.target.value })} />
        <label htmlFor="quiet-end">结束时间</label><input id="quiet-end" name="quiet-end" type="time" required value={draft.end} onChange={event => change({ end: event.target.value })} />
        <label htmlFor="quiet-timezone">IANA 时区</label><input id="quiet-timezone" name="quiet-timezone" required maxLength={100} value={draft.timeZone} placeholder="Asia/Shanghai" autoComplete="off" spellCheck={false} onChange={event => change({ timeZone: event.target.value })} />
        <p className="settings-field-hint">例如 Asia/Shanghai、America/New_York、Europe/London 或 UTC。起止时间须不同。</p>
      </fieldset>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <p className="settings-feedback" role="status" aria-live="polite">{feedback}</p>
      <div className="settings-actions"><button className="header-button" type="button" disabled={pending} onClick={() => void load()}>重新读取</button><button className="settings-save" type="submit" disabled={pending}>{pending ? "正在保存…" : "保存免打扰"}</button></div>
    </form>}
  </details>;
}

export function NotificationSettings() {
  const [filter, setFilter] = useState<Filter>("failed");
  const [snapshot, setSnapshot] = useState<{ filter: Filter; data: NotificationOverview } | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const version = useRef(0), busy = useRef<number | null>(null);
  const overview = snapshot?.filter === filter ? snapshot.data : null;
  const channel = snapshot?.data;

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
    <header className="notification-heading">
      <div><h2 id="notifications-title">通知投递</h2><p>查看投递结果，处理需要关注的通知。</p></div>
      <span className="notification-auto-refresh"><Icon name="refresh-cw" />每 5 秒刷新</span>
    </header>
    <div className="notification-channel" data-enabled={channel?.enabled ?? false}>
      <span className="notification-channel-icon"><Icon name="webhook" /></span>
      <div className="notification-channel-copy">
        <strong>{channel ? channel.kind === "teams" ? "Microsoft Teams" : "Webhook 通知" : "当前投递渠道"}</strong>
        <p>{!channel ? error ? "渠道状态尚未读取，请刷新重试。" : "正在读取渠道状态…" : channel.enabled
          ? channel.mode === "all" ? "全部事件 · 当前投递目标" : channel.mode === "errors" ? "仅错误事件 · 当前投递目标" : "按服务端配置投递 · 当前投递目标"
          : channel.mode === "off" ? "通知已关闭或当前处于离线模式，记录仍保留。" : "投递地址未配置或当前处于离线模式，记录仍保留。"}</p>
      </div>
      <span className="notification-channel-state">{!channel ? error ? "待确认" : "读取中" : channel.enabled ? "已启用" : "未启用"}</span>
    </div>
    <div className="notification-toolbar">
      <div className="notification-filters" role="group" aria-label="投递状态">
        {filters.map(item => <button key={item.value} type="button" aria-pressed={filter === item.value} disabled={pending} onClick={() => {
          version.current++; setFilter(item.value); setFeedback(""); setError("");
        }}>{item.label}</button>)}
      </div>
      <button type="button" className="notification-refresh" aria-label="刷新记录" disabled={pending} onClick={() => void refresh()}><Icon name="refresh-cw" /><span>刷新记录</span></button>
    </div>
    <div className="notification-list-caption">
      <p role="status" aria-live="polite">{pending ? "正在读取或更新通知记录…" : overview ? `已显示 ${overview.items.length} 条${filter === "all" ? "" : statusLabels[filter]}记录` : "尚未读取到通知记录"}</p>
      <span>当前筛选 · 最近 100 条以内</span>
    </div>
    {error && <p className="settings-error notification-error" role="alert"><Icon name="circle-alert" /><span>{error}</span></p>}
    <p className="settings-feedback" role="status" aria-live="polite">{feedback}</p>
    <div className="notification-results" aria-busy={pending}>
      {!overview && !error && <div className="notification-loading" role="status"><Icon name="ellipsis" /><p>正在读取投递记录</p></div>}
      {overview && (overview.items.length === 0 ? <div className="notification-empty">
        <span className="notification-empty-icon">{filter === "failed" ? <Icon name="check" /> : <Icon name="inbox" />}</span>
        <strong>{filter === "failed" ? "没有需要处理的失败投递" : filter === "all" ? "暂无投递记录" : `暂无${statusLabels[filter]}记录`}</strong>
        <p>{filter === "all" ? "当前投递目标产生通知后，记录会显示在这里。" : `当前投递目标最近的${statusLabels[filter]}记录会显示在这里，也可切换查看其他状态。`}</p>
      </div> : <ul className="notification-records" aria-label="通知记录">
        {overview.items.map(item => <li key={item.id} className="notification-record" data-status={item.status}>
          <span className="notification-state-icon"><Icon name={statusContent[item.status].icon} /></span>
          <div className="notification-record-copy">
            <div className="notification-record-heading"><strong>{statusContent[item.status].title}</strong><span>已尝试 {item.attempts} 次</span></div>
            <p className="notification-record-time">{item.status === "pending" ? <>下次投递 <time dateTime={new Date(item.nextAt).toISOString()}>{formatTime(item.nextAt)}</time></> : item.finishedAt === null ? "尚未完成" : <>完成于 <time dateTime={new Date(item.finishedAt).toISOString()}>{formatTime(item.finishedAt)}</time></>}</p>
            {item.lastError && <p className="notification-record-error notification-error-preview">{item.lastError}</p>}
            <details className="notification-record-details">
              <summary>投递详情<Icon name="chevron-right" /></summary>
              <dl>
                <div><dt>事件 ID</dt><dd><code>{item.id}</code></dd></div>
                <div><dt>创建时间</dt><dd>{formatTime(item.createdAt)}</dd></div>
                {item.status === "pending" ? <div><dt>下次投递</dt><dd>{formatTime(item.nextAt)}</dd></div> : <div><dt>完成时间</dt><dd>{item.finishedAt === null ? "尚未完成" : formatTime(item.finishedAt)}</dd></div>}
                {item.lastError && <div><dt>投递错误</dt><dd className="notification-record-error">{item.lastError}</dd></div>}
              </dl>
            </details>
          </div>
          {item.status === "failed" && <button type="button" className="notification-retry" disabled={pending || !overview.enabled} aria-label={`重新投递 ${formatTime(item.createdAt)} 创建的通知`} aria-describedby="notifications-retry-hint" onClick={() => void refresh(item.id)}><Icon name="rotate-cw" />重新投递</button>}
        </li>)}
      </ul>)}
    </div>
    <details className="notification-policy">
      <summary><Icon name="info" />关于记录与重新投递<Icon name="chevron-right" /></summary>
      <p id="notifications-retry-hint">仅展示当前投递目标、当前筛选下最近 100 条记录，数量不代表全部历史。重新投递会保留原事件 ID 和正文，并重新获得 5 次投递机会；可能重复送达，接收端需按事件 ID 去重。未启用通知投递时，重新投递暂不可用。</p>
    </details>
    <QuietHoursSettings />
  </section>;
}
