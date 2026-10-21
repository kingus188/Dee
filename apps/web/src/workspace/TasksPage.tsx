import { useEffect, useRef, useState } from "react";
import type { Management, Reminder, Schedule } from "@assistant/contracts";
import { request } from "../api/request.js";
import { MarkdownEditor } from "../editor/MarkdownEditor.js";
import { managementCards } from "../tasks/management.js";
import { renderMarkdown } from "../chat/markdown.js";
import { errorMessage, mayDiscard, useUnsavedChanges } from "./editing.js";

type Selection = { kind: "schedules"; item: Schedule } | { kind: "reminders"; item: Reminder };
export function TasksPage({ owner, active }: { owner: number; active: boolean }) {
  const [data, setData] = useState<Management>({ schedules: [], reminders: [], background: [] }), [ready, setReady] = useState(false);
  const [kind, setKind] = useState<"schedules" | "reminders" | "background">("reminders"), [selected, setSelected] = useState<Selection | null>(null);
  const [text, setText] = useState(""), [minutes, setMinutes] = useState("10"), [every, setEvery] = useState("0"), [initialTiming, setInitialTiming] = useState({ minutes: "10", every: "0" });
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const busy = useRef(false), requestId = useRef(crypto.randomUUID());
  const dirty = text !== (selected?.item.text ?? "") || minutes !== initialTiming.minutes || every !== initialTiming.every;
  useUnsavedChanges(dirty);
  async function load() {
    try { setData(await request<Management>(`/api/conversations/${owner}/management`)); setReady(true); }
    catch (error) { setError(errorMessage(error)); }
  }
  useEffect(() => { if (active) void load(); }, [active]);
  function select(value: Selection | null) {
    if (busy.current || !mayDiscard(dirty)) return;
    const nextMinutes = value ? String(Math.max(1, Math.ceil((((value.kind === "schedules" ? value.item.nextAt : value.item.at) ?? Date.now()) - Date.now()) / 60000))) : "10";
    const nextEvery = value?.kind === "schedules" ? String(value.item.everyMinutes) : "0";
    setSelected(value); if (value) setKind(value.kind); setText(value?.item.text ?? ""); setMinutes(nextMinutes); setEvery(nextEvery); setInitialTiming({ minutes: nextMinutes, every: nextEvery });
    requestId.current = crypto.randomUUID(); setFeedback(""); setError("");
  }
  async function save() {
    if (busy.current || !text.trim()) return;
    busy.current = true; setPending(true); setError(""); setFeedback("");
    try {
      const body = { text, minutesFromNow: Number(minutes), everyMinutes: Number(every), requestId: requestId.current, ...(selected?.kind === "schedules" ? { revision: selected.item.revision } : selected ? { at: selected.item.at } : {}) };
      const path = `/api/conversations/${owner}/${kind}${selected ? `/${selected.item.id}/edit` : ""}`;
      const result = await request<{ item: Schedule | Reminder }>(path, body);
      if (kind !== "background") { setSelected(kind === "schedules" ? { kind, item: result.item as Schedule } : { kind, item: result.item as Reminder }); setText(result.item.text); }
      else { setText(""); requestId.current = crypto.randomUUID(); }
      setInitialTiming({ minutes, every }); setFeedback(kind === "background" ? "已启动后台任务" : "已保存安排");
      await load();
    } catch (error) { setError(errorMessage(error)); }
    finally { busy.current = false; setPending(false); }
  }
  async function manage(path: string) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError("");
    try { await request(path, {}); setFeedback("操作已完成"); await load(); }
    catch (error) { setError(errorMessage(error)); }
    finally { busy.current = false; setPending(false); }
  }
  const cards = managementCards(data, String(owner));
  return <div className="workspace-editor-layout workspace-tasks-layout">
    <section className="workspace-records" aria-label="任务列表">
      <div className="workspace-records-heading"><h2>任务与提醒</h2><button className="text-button" type="button" disabled={pending} onClick={() => select(null)}>新增安排</button></div>
      {!ready && !error && <p role="status">正在读取…</p>}
      {ready && !cards.length && <p className="workspace-muted">还没有安排，在右侧直接创建提醒、计划或后台任务。</p>}
      {cards.map(card => {
        const schedule = data.schedules.find(item => card.key === `schedule:${item.id}`), reminder = data.reminders.find(item => card.key === `reminder:${item.id}`);
        return <article className="workspace-task" key={card.key}><header><h3>{card.title}</h3><span>{card.status}</span></header><article className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(card.text) }} /><p className="workspace-muted">{card.meta}</p>
          {card.details && <details><summary>执行结果</summary><article className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(card.details) }} /></details>}
          <div className="workspace-record-actions">
            {schedule && (schedule.status === "active" || schedule.status === "paused") && <button type="button" disabled={pending} onClick={() => select({ kind: "schedules", item: schedule })}>编辑计划</button>}
            {reminder?.status === "scheduled" && <button type="button" disabled={pending} onClick={() => select({ kind: "reminders", item: reminder })}>编辑提醒</button>}
            {card.actions?.map(action => action.kind === "request" && <button type="button" key={action.path} disabled={pending} onClick={() => void manage(action.path)}>{action.label}</button>)}
          </div>
        </article>;
      })}
      <button type="button" className="text-button" disabled={pending} onClick={() => void load()}>刷新任务</button>
    </section>
    <section className="workspace-edit-form" aria-label="任务编辑" aria-busy={pending}>
      <header className="workspace-edit-heading"><h2>{selected ? "编辑安排" : "新增安排"}</h2><span className="workspace-muted">当前会话 #{owner}</span></header>
      <label>安排类型<select value={kind} disabled={pending || selected !== null} onChange={event => setKind(event.target.value as typeof kind)}><option value="reminders">提醒</option><option value="schedules">计划任务</option><option value="background">后台任务</option></select></label>
      <MarkdownEditor key={selected ? `${selected.kind}:${selected.item.id}` : "new"} label="任务正文" value={text} onChange={setText} disabled={pending} />
      {kind !== "background" && <div className="workspace-timing"><label>{selected ? "从现在起几分钟后重新安排" : "几分钟后执行"}<input type="number" min="0.25" max={kind === "reminders" ? 1440 : 525600} step="0.25" value={minutes} disabled={pending} onChange={event => setMinutes(event.target.value)} /></label>{kind === "schedules" && <label>重复间隔（分钟，0 为单次）<input type="number" min="0" max="525600" step="1" value={every} disabled={pending} onChange={event => setEvery(event.target.value)} /></label>}</div>}
      <p className="workspace-muted">{kind === "reminders" ? "到时发送提醒，不调用模型生成。" : kind === "background" ? "保存后立即启动模型任务；运行中的说明只读，可在列表停止。" : "到时由模型执行正文中的任务；修改会重新安排执行时间。"}</p>
      <footer className="workspace-edit-actions"><span role="status">{pending ? "正在处理…" : dirty ? "有未保存的修改" : feedback || "Markdown 正文"}</span><button className="settings-save" type="button" disabled={pending || !text.trim() || (!!selected && !dirty) || (kind !== "background" && (!Number.isFinite(Number(minutes)) || Number(minutes) < 0.25 || Number(minutes) > (kind === "reminders" ? 1440 : 525600) || every === "" || !Number.isFinite(Number(every)) || Number(every) < 0 || Number(every) > 525600))} onClick={() => void save()}>{pending ? "处理中…" : selected ? "保存安排" : kind === "background" ? "启动任务" : "创建安排"}</button></footer>
      {error && <p role="alert" className="workspace-error">{error}。正文保留，请核对列表中的最新状态后再操作。</p>}
    </section>
  </div>;
}
