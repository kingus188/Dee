import type { CalendarRule } from "@assistant/contracts";
export type TimingDraft = { mode: "minutes" | "daily" | "weekly" | "monthly"; time: string; timeZone: string; weekdays: number[]; monthDay: number };
export function timingDraft(rule?: CalendarRule): TimingDraft {
  return { mode: rule?.kind ?? "minutes", time: rule?.time ?? "08:00", timeZone: rule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, weekdays: rule?.kind === "weekly" ? rule.weekdays : [1, 2, 3, 4, 5], monthDay: rule?.kind === "monthly" ? rule.monthDay : 1 };
}
export function calendarRule(value: TimingDraft): CalendarRule | undefined {
  const { mode, time, timeZone, weekdays, monthDay } = value;
  if (mode === "minutes") return;
  return mode === "weekly" ? { kind: mode, time, timeZone, weekdays } : mode === "monthly" ? { kind: mode, time, timeZone, monthDay } : { kind: mode, time, timeZone };
}
export function CalendarFields({ value, onChange, disabled }: { value: TimingDraft; onChange: (next: TimingDraft) => void; disabled: boolean }) {
  const patch = (change: Partial<TimingDraft>) => onChange({ ...value, ...change });
  return <fieldset className="workspace-timing" disabled={disabled}><legend>执行规律</legend>
    <label>重复方式<select value={value.mode} onChange={event => patch({ mode: event.target.value as TimingDraft["mode"] })}><option value="minutes">按分钟安排</option><option value="daily">每天</option><option value="weekly">每周指定星期</option><option value="monthly">每月指定日期</option></select></label>
    {value.mode !== "minutes" && <><label>当地时间<input type="time" required value={value.time} onChange={event => patch({ time: event.target.value })} /></label><label>时区<input value={value.timeZone} required placeholder="Asia/Shanghai" onChange={event => patch({ timeZone: event.target.value })} /></label></>}
    {value.mode === "weekly" && <fieldset><legend>执行日</legend>{["一", "二", "三", "四", "五", "六", "日"].map((label, i) => <label key={i}><input type="checkbox" checked={value.weekdays.includes(i + 1)} onChange={event => patch({ weekdays: event.target.checked ? [...value.weekdays, i + 1].sort() : value.weekdays.filter(day => day !== i + 1) })} />周{label}</label>)}</fieldset>}
    {value.mode === "monthly" && <label>每月几日<input type="number" min="1" max="31" value={value.monthDay} onChange={event => patch({ monthDay: Number(event.target.value) })} /></label>}
    {value.mode !== "minutes" && <p className="workspace-muted">按所选时区执行。跳过缺失的日期或夏令时时刻；重复时刻只执行一次。</p>}
  </fieldset>;
}
