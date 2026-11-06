import { useEffect, useRef, useState } from "react";
import type { TeamsTriageAction, TeamsTriageItem, TeamsTriageOverview } from "@assistant/contracts";
import { request } from "../api/request.js";
import { Icon } from "../ui/Icon.js";
import { dateTime } from "../today/model.js";
import type { PageResource } from "../today/usePageResource.js";
import { isTeamsTriageActionResult, isTeamsTriageOverview, teamsSourceUrl } from "./data.js";
import { TeamsSyncPreferences } from "./TeamsSyncPreferences.js";

const keyOf = (item: TeamsTriageItem) => JSON.stringify([item.id, item.revision]);
type Notice = { text: string; error?: boolean; taskId?: string };
type Props = { resource: PageResource<TeamsTriageOverview>; active: boolean; onDaylight: (id?: string) => void; onCreated: () => void };

export function TeamsTriage({ resource, active, onDaylight, onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settled, setSettled] = useState<Map<string, number>>(new Map());
  const inFlight = useRef(new Set<string>());
  const syncInFlight = useRef(false);
  const lifetime = useRef(0);
  useEffect(() => {
    lifetime.current++;
    if (!active) setNotice(null);
    return () => { lifetime.current++; };
  }, [active]);
  const data = resource.data;
  const items = data?.enabled && !resource.error ? data.items.filter(item => (settled.get(keyOf(item)) ?? 0) <= Date.now()) : [];
  const counts = { now: items.filter(item => item.attention === "now").length, later: items.filter(item => item.attention === "later").length, unclear: items.filter(item => item.attention === "unclear").length };
  const busy = resource.loading || syncing;

  async function sync() {
    if (!active || !data?.enabled || syncInFlight.current) return;
    const owner = lifetime.current;
    syncInFlight.current = true; setSyncing(true); setNotice(null);
    try {
      const result = await request<unknown>("/api/teams/triage/refresh", {});
      if (!isTeamsTriageOverview(result)) throw new Error("服务返回的数据格式不完整，请重新读取。");
      if (owner === lifetime.current) { resource.refresh(); setNotice({ text: "来源已更新，正在读取最新建议。" }); }
    } catch (error) {
      if (owner === lifetime.current) { setNotice({ error: true, text: error instanceof Error ? error.message : "来源更新失败，请稍后重试。" }); resource.refresh(); }
    } finally {
      syncInFlight.current = false;
      setSyncing(false);
    }
  }

  async function act(item: TeamsTriageItem, action: TeamsTriageAction["action"]) {
    const key = keyOf(item);
    if (!active || !data?.enabled || resource.error || busy || inFlight.current.has(key) || (settled.get(key) ?? 0) > Date.now() || (action === "create" && !item.suggestTodo)) return;
    const owner = lifetime.current;
    inFlight.current.add(key); setPending([...inFlight.current]); setNotice(null);
    try {
      const result = await request<unknown>("/api/teams/triage/act", { id: item.id, revision: item.revision, action } satisfies TeamsTriageAction);
      if (!isTeamsTriageActionResult(result) || (action === "create" && !result.taskId)) throw new Error("操作结果尚未确认，请重新读取列表核对，暂勿重复操作。");
      if (owner !== lifetime.current) return;
      setSettled(previous => new Map([...previous, [key, action === "snooze" ? Date.now() + 2 * 60 * 60_000 : Infinity]]));
      setNotice({ text: action === "create" ? "待办已创建到 Daylight 收件箱。" : action === "snooze" ? "已暂缓 2 小时，之后仍需处理时再显示。" : "已忽略这条消息的建议。", taskId: result.taskId });
      resource.refresh();
      if (action === "create") onCreated();
    } catch (error) {
      if (owner === lifetime.current) { setNotice({ error: true, text: error instanceof Error ? error.message : "操作未完成，请重新读取列表核对。" }); resource.refresh(); }
    } finally {
      inFlight.current.delete(key);
      setPending([...inFlight.current]);
    }
  }

  return <details className="today-secondary teams-triage" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Icon name="messages-square" /><span>Teams 消息建议</span><span className="teams-triage-summary">{resource.error ? "读取失败" : !data ? "正在读取" : !data.enabled ? "未连接" : items.length ? `${counts.now ? `${counts.now} 条建议优先核对` : `${items.length} 条待查看`}${data.stale ? " · 缓存" : ""}` : "暂无待处理建议"}</span><Icon name="chevron-down" /></summary>
    <section className="teams-triage-content" aria-label="Teams 消息处理建议">
      <p className="teams-triage-intro">根据最近 24 小时已采集的消息给出建议，可能遗漏上下文。仅在你确认后创建待办，不会自动发送 Teams 消息。</p>
      {resource.loading && !data && <p className="today-feedback" role="status">正在读取 Teams 消息建议…</p>}
      {resource.error && <div className="today-feedback today-feedback-error" role="alert"><p>Teams 建议读取失败：{resource.error}</p><p>旧建议已隐藏，请重新读取后操作。</p><button type="button" className="today-text-button" disabled={busy} onClick={resource.refresh}>重新读取建议</button></div>}
      {data && <>
        <div className="teams-triage-toolbar"><span>{data.lastSuccessAt ? `上次采集 ${dateTime(data.lastSuccessAt)}` : "尚无成功采集记录"}{!data.settings.enabled && " · 后台采集已暂停"}</span><button type="button" className="today-text-button" disabled={!active || busy || !data.enabled} onClick={() => { void sync(); }}><Icon name="rotate-ccw" />{syncing ? "正在更新来源" : "更新来源"}</button></div>
        {!data.enabled ? <p className="today-note">Teams 尚未连接，连接后可查看消息建议。</p> : <>
          {data.stale && <p className="teams-triage-caution">当前仅有缓存，消息可能已经回复、编辑或撤回。创建前会重新核对来源；核对失败不会创建。</p>}
          {!resource.error && items.length === 0 && <p className="today-note">当前已采集范围内没有待处理建议，不代表所有 Teams 消息都已处理。</p>}
          {data.truncated && <p className="teams-triage-caution">建议列表已截断，以下数量只对应已加载的消息。</p>}
          {(["now", "later", "unclear"] as const).filter(attention => counts[attention] > 0).map(attention => <div className="teams-triage-group" key={attention}>
            <h3>{({ now: "建议优先核对", later: "待安排处理", unclear: "需要你判断" })[attention]}<span>{counts[attention]}</span></h3>
            {attention === "later" && <p className="today-note">尚未找到可靠的即时处理依据，请先核对原文中的期限。</p>}
            <ul className="teams-triage-list">{items.filter(item => item.attention === attention).map(item => <TriageItem key={keyOf(item)} item={item} disabled={!active || busy || pending.includes(keyOf(item))} pending={pending.includes(keyOf(item))} onAction={action => { void act(item, action); }} />)}</ul>
          </div>)}
        </>}
        {notice && <p className={`teams-triage-notice${notice.error ? " teams-triage-caution" : ""}`} role={notice.error ? "alert" : "status"}>{notice.text}{notice.taskId && <button type="button" className="today-text-button" onClick={() => onDaylight(notice.taskId)}>查看待办<Icon name="arrow-up-right" /></button>}</p>}
        <TeamsSyncPreferences settings={data.settings} active={active} available={data.enabled} onSaved={resource.refresh} />
      </>}
    </section>
  </details>;
}

function TriageItem({ item, disabled, pending, onAction }: { item: TeamsTriageItem; disabled: boolean; pending: boolean; onAction: (action: TeamsTriageAction["action"]) => void }) {
  const url = teamsSourceUrl(item.sourceUrl);
  return <li className="teams-triage-item" data-teams-triage-id={item.id}>
    <div className="teams-triage-source"><strong>{item.senderName || "发送者未提供"}</strong><span>{item.chatLabel || "Teams 会话"}</span><time dateTime={item.createdAt}>{dateTime(item.createdAt)}</time></div>
    <p className="teams-triage-reason">{item.reason || "请结合原消息判断是否需要处理。"}</p>
    <p className="teams-triage-uncertainty"><Icon name="info" />{item.uncertainty || "建议仅基于已采集消息，完整上下文仍需核对。"}</p>
    <details className="teams-triage-evidence"><summary>查看来源与原文<Icon name="chevron-down" /></summary><p>{item.text || "原消息没有可显示的文本。"}</p>{url ? <a href={url} target="_blank" rel="noopener noreferrer">在 Teams 中查看来源<Icon name="arrow-up-right" /></a> : <span>来源链接不可用</span>}</details>
    {item.suggestTodo ? <p className="teams-triage-proposed"><span>建议待办</span><strong>{item.suggestedTitle}</strong><small>创建到 Daylight 收件箱</small></p> : <p className="teams-triage-proposed">暂不建议建待办，请先核对是否需要回复。</p>}
    <div className="teams-triage-actions">
      {item.suggestTodo && <button type="button" className="teams-triage-create" disabled={disabled} onClick={() => onAction("create")}>{pending ? "正在核对并处理…" : "确认创建待办"}</button>}
      <button type="button" className="today-text-button" disabled={disabled} onClick={() => onAction("snooze")}>稍后再看 · 2 小时</button>
      <button type="button" className="today-text-button" disabled={disabled} onClick={() => onAction("dismiss")}>忽略建议</button>
      {pending && !item.suggestTodo && <span role="status">正在处理…</span>}
    </div>
  </li>;
}
