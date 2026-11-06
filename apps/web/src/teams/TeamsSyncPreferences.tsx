import { useEffect, useRef, useState } from "react";
import type { TeamsSyncSettings } from "@assistant/contracts";
import { request } from "../api/request.js";
import { Icon } from "../ui/Icon.js";
import { isTeamsSyncSettings } from "./data.js";

const intervals = [
  { key: "workIntervalMinutes", label: "工作时段采集间隔", min: 1, max: 60 },
  { key: "offHoursIntervalMinutes", label: "非工作时段采集间隔", min: 5, max: 120 },
  { key: "archiveIntervalMinutes", label: "历史补采间隔", min: 5, max: 1440 },
  { key: "normalDigestMinutes", label: "普通通知汇总间隔", min: 5, max: 1440 },
] as const;
const week = ["一", "二", "三", "四", "五", "六", "日"];

export function TeamsSyncPreferences({ settings, active, available, onSaved }: { settings: TeamsSyncSettings; active: boolean; available: boolean; onSaved: () => void }) {
  const [draft, setDraft] = useState(settings);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean } | null>(null);
  const writing = useRef(false), lifetime = useRef(0);
  useEffect(() => { lifetime.current++; return () => { lifetime.current++; }; }, [active]);
  // A saved response is newer than the last polled settings. Do not reset it when dirty changes.
  useEffect(() => { if (!dirty) setDraft(settings); }, [settings]);
  function change(patch: Partial<TeamsSyncSettings>) { setDraft(value => ({ ...value, ...patch })); setDirty(true); setFeedback(null); }

  async function save() {
    if (!active || !available || writing.current) return;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.workStart) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.workEnd) || draft.workStart === draft.workEnd) {
      setFeedback({ error: true, text: "请填写不同的有效工作开始与结束时间。" }); return;
    }
    const invalid = intervals.find(field => !Number.isInteger(draft[field.key]) || draft[field.key] < field.min || draft[field.key] > field.max);
    if (invalid) { setFeedback({ error: true, text: `${invalid.label}须为 ${invalid.min}–${invalid.max} 分钟的整数。` }); return; }
    if (draft.offHoursIntervalMinutes < draft.workIntervalMinutes || draft.archiveIntervalMinutes < draft.workIntervalMinutes) {
      setFeedback({ error: true, text: "非工作时段和历史补采的间隔不能短于工作时段。" }); return;
    }
    try { new Intl.DateTimeFormat("zh-CN", { timeZone: draft.timeZone }); }
    catch { setFeedback({ error: true, text: "请填写有效的 IANA 时区，例如 Asia/Shanghai。" }); return; }
    const owner = lifetime.current;
    writing.current = true; setSaving(true); setFeedback(null);
    try {
      const result = await request<unknown>("/api/teams/triage/settings", { settings: draft });
      if (!isTeamsSyncSettings(result)) throw new Error("设置保存结果尚未确认，请重新读取后核对。");
      if (owner !== lifetime.current) return;
      setDraft(result); setDirty(false); setFeedback({ text: "采集设置已保存。" }); onSaved();
    } catch (error) {
      if (owner === lifetime.current) setFeedback({ error: true, text: error instanceof Error ? error.message : "设置未保存，请重试。" });
    } finally { writing.current = false; setSaving(false); }
  }

  return <details className="teams-sync-preferences">
    <summary><Icon name="settings-2" />采集与汇总设置<Icon name="chevron-down" /></summary>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className="today-note">采集频率与通知投递分开设置。保存这里的设置不会授予自动回复或自动建待办权限。</p>
      <fieldset disabled={!active || !available || saving}>
        <label className="teams-sync-toggle"><input type="checkbox" checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} />启用后台采集</label>
        <div className="teams-sync-fields">
          <label>工作时区<input required aria-label="Teams 工作时区" value={draft.timeZone} placeholder="Asia/Shanghai" onChange={event => change({ timeZone: event.target.value.trim() })} /></label>
          <label>工作开始<input type="time" required value={draft.workStart} onChange={event => change({ workStart: event.target.value })} /></label>
          <label>工作结束<input type="time" required value={draft.workEnd} onChange={event => change({ workEnd: event.target.value })} /></label>
        </div>
        <fieldset className="teams-sync-days"><legend>工作日</legend>{week.map((label, index) => <label key={label}><input type="checkbox" checked={draft.workDays.includes(index + 1)} onChange={event => change({ workDays: event.target.checked ? [...draft.workDays, index + 1].sort((a, b) => a - b) : draft.workDays.filter(day => day !== index + 1) })} />周{label}</label>)}</fieldset>
        <div className="teams-sync-fields">{intervals.map(field => <label key={field.key}>{field.label}<span><input type="number" required min={field.min} max={field.max} step="1" value={Number.isFinite(draft[field.key]) ? draft[field.key] : ""} onChange={event => change({ [field.key]: event.target.valueAsNumber })} />分钟</span></label>)}</div>
        <p className="today-note">跨午夜时段归属开始的工作日。间隔越短，采集请求越频繁；普通通知仍遵循现有投递设置。</p>
        <div className="teams-triage-actions"><button type="submit" className="teams-triage-create" disabled={!dirty}>{saving ? "正在保存…" : "保存设置"}</button><button type="button" className="today-text-button" disabled={!dirty} onClick={() => { setDraft(settings); setDirty(false); setFeedback(null); }}>取消修改</button></div>
      </fieldset>
      {feedback && <p className={feedback.error ? "teams-triage-caution" : "today-note"} role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
    </form>
  </details>;
}
