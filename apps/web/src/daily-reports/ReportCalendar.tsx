import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Icon } from "../ui/Icon.js";

export function reportDate(value: Date) {
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export function shiftReportDate(value: string, days: number) {
  const next = new Date(`${value}T12:00:00`);
  next.setDate(next.getDate() + days);
  return reportDate(next);
}

export function useReportToday(active: boolean) {
  const [value, setValue] = useState(() => reportDate(new Date()));
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      setValue(reportDate(new Date()));
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      timer = setTimeout(refresh, Math.max(1, midnight.getTime() - Date.now()));
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearTimeout(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [active]);
  return value;
}

export function ReportCalendar({ selected, dates, disabled, onSelect, today }: {
  selected: string;
  dates: Set<string>;
  disabled: boolean;
  onSelect: (date: string) => void;
  today: string;
}) {
  const [month, setMonth] = useState(selected.slice(0, 7));
  const [focused, setFocused] = useState(selected);
  const grid = useRef<HTMLDivElement>(null);
  const keyboard = useRef(false);
  const now = today;
  const first = new Date(`${month}-01T12:00:00`);
  const offset = (first.getDay() + 6) % 7;
  const label = `${first.getFullYear()}年${first.getMonth() + 1}月`;
  const cells = Array.from({ length: 42 }, (_, index) => shiftReportDate(`${month}-01`, index - offset));
  const tabDate = focused.startsWith(month) ? focused : `${month}-01`;

  useEffect(() => { setMonth(selected.slice(0, 7)); setFocused(selected); }, [selected]);
  useEffect(() => {
    if (keyboard.current) {
      grid.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus();
      keyboard.current = false;
    }
  }, [focused, month]);

  function changeMonth(direction: number) {
    const next = new Date(`${month}-01T12:00:00`);
    next.setMonth(next.getMonth() + direction);
    setMonth(reportDate(next).slice(0, 7));
  }

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const current = (event.target as HTMLElement).dataset.date;
    if (!current) return;
    let next: string;
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in steps) next = shiftReportDate(current, steps[event.key]!);
    else if (event.key === "Home" || event.key === "End") {
      const weekday = (new Date(`${current}T12:00:00`).getDay() + 6) % 7;
      next = shiftReportDate(current, event.key === "Home" ? -weekday : 6 - weekday);
    } else return;
    event.preventDefault();
    if (next.length !== 10 || next < "1000-01-01" || next > "9999-12-31") return;
    keyboard.current = true;
    setFocused(next);
    setMonth(next.slice(0, 7));
  }

  return <div className="reports-calendar">
    <div className="reports-calendar-heading">
      <h3 aria-live="polite">{label}</h3>
      <div><button type="button" className="reports-icon-button" aria-label="上个月" disabled={disabled || month === "1000-01"} onClick={() => changeMonth(-1)}><Icon name="chevron-left" /></button><button type="button" className="reports-icon-button" aria-label="下个月" disabled={disabled || month === "9999-12"} onClick={() => changeMonth(1)}><Icon name="chevron-right" /></button></div>
    </div>
    <div className="reports-calendar-weekdays" aria-hidden="true">{["一", "二", "三", "四", "五", "六", "日"].map(day => <span key={day}>{day}</span>)}</div>
    <div className="reports-calendar-grid" ref={grid} role="group" aria-label={`${label}，方向键浏览日期，回车选择`} onKeyDown={moveFocus}>
      {cells.map(value => value.length !== 10 || value < "1000-01-01" || value > "9999-12-31" ? <span key={value} /> : <button type="button" key={value} data-date={value} data-outside={!value.startsWith(month)} data-today={value === now} data-recorded={dates.has(value)} aria-label={`${value}${value === now ? "，今天" : ""}${dates.has(value) ? "，有日报" : ""}`} aria-current={value === now ? "date" : undefined} aria-pressed={value === selected} tabIndex={value === tabDate ? 0 : -1} disabled={disabled} onFocus={() => setFocused(value)} onClick={() => onSelect(value)}><span>{Number(value.slice(8))}</span><i aria-hidden="true" /></button>)}
    </div>
    <p className="reports-calendar-legend"><i aria-hidden="true" />有日报的日子</p>
  </div>;
}
