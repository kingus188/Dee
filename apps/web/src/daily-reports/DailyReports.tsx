import { useEffect, useRef, useState } from "react";
import type { DailyReport, DailyReportInput, DailyReportSummary } from "@assistant/contracts";
import { request } from "../api/request.js";
import { MarkdownDocument } from "../editor/MarkdownDocument.js";
import { Icon } from "../ui/Icon.js";
import { MarkdownEditor } from "../editor/MarkdownEditor.js";
import { ReportCalendar, reportDate, shiftReportDate, useReportToday } from "./ReportCalendar.js";

const REPORT_TEMPLATE = "## 今日进展\n\n- \n\n## 问题与思考\n\n\n\n## 明日计划\n\n- \n";
const today = () => reportDate(new Date());

export function DailyReports({ active }: { active: boolean }) {
  const [date, setDate] = useState(today), [markdown, setMarkdown] = useState("");
  const [saved, setSaved] = useState<DailyReport | null>(null), [reports, setReports] = useState<DailyReportSummary[]>([]);
  const [ready, setReady] = useState(false), [loading, setLoading] = useState(false), [pending, setPending] = useState(false);
  const [error, setError] = useState(""), [listError, setListError] = useState(""), [preview, setPreview] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const sequence = useRef(0), busy = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const dirty = ready && markdown !== (saved?.markdown ?? "");
  const [year, month, day] = date.split("-");
  const weekday = new Date(`${date}T12:00:00`).toLocaleDateString("zh-CN", { weekday: "long" });
  const currentDay = useReportToday(active);
  const isToday = date === currentDay;
  const reportDates = new Set(reports.map(item => item.date));
  const status = pending ? "正在保存…" : dirty ? "有未保存的修改" : saved ? "已保存" : "尚未记录";

  async function refreshList() {
    try { setReports(await request<DailyReportSummary[]>("/api/daily-reports")); setListError(""); }
    catch { setListError("历史列表读取失败"); }
  }
  async function load(next: string) {
    if (busy.current) return;
    if (dirty && !window.confirm("当前日报尚未保存，放弃修改并重新读取吗？")) return;
    const current = ++sequence.current;
    setDate(next); setLoading(true); setReady(false); setError(""); setPreview(false);
    setSaved(null); setMarkdown("");
    try {
      const data = await request<DailyReport | null>(`/api/daily-reports/${next}`);
      if (sequence.current === current) { setSaved(data); setMarkdown(data?.markdown ?? ""); setReady(true); }
    } catch (error) { if (sequence.current === current) setError(error instanceof Error ? error.message : "读取失败，请重试"); }
    finally { if (sequence.current === current) setLoading(false); }
  }
  function selectDate(next: string) { if (next.length === 10 && next >= "1000-01-01" && next <= "9999-12-31" && next !== date) void load(next); }
  useEffect(() => { void load(date); void refreshList(); return () => { sequence.current++; }; }, []);
  useEffect(() => { if (active) heading.current?.focus(); }, [active]);
  useEffect(() => {
    if (!dirty && !pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, pending]);

  async function save() {
    if (!ready || busy.current || !dirty || markdown.length > 16000) return;
    busy.current = true; setPending(true); setError("");
    const input: DailyReportInput = { markdown, revision: saved?.revision ?? null };
    try {
      const data = await request<DailyReport>(`/api/daily-reports/${date}`, input);
      setSaved(data);
      // 保存成功不依赖另一次列表请求，断网时也不会把已保存误报为失败。
      setReports(items => [{ date: data.date, updatedAt: data.updatedAt, revision: data.revision }, ...items.filter(item => item.date !== data.date)].sort((a, b) => b.date.localeCompare(a.date)));
    } catch (error) { setError(error instanceof Error ? error.message : "保存失败，内容仍保留，可重试"); }
    finally { busy.current = false; setPending(false); }
  }

  return <section className="daily-reports" hidden={!active} aria-labelledby="reports-title" onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } }}>
    <header className="reports-heading">
      <div><p className="reports-eyebrow">我的工作日志</p><h1 id="reports-title" tabIndex={-1} ref={heading}>每日日报<span className="reports-title-dot" aria-hidden="true" /></h1><p className="reports-description">让每一天的进展，都有迹可循。</p></div>
      <div className="reports-heading-actions">
        <button type="button" className="reports-history-toggle" aria-expanded={historyOpen} aria-controls="reports-archive" onClick={() => setHistoryOpen(value => !value)}><Icon name="calendar" />日历与历史</button>
        <div className="reports-day-navigation" aria-label="切换日报日期"><button type="button" className="reports-icon-button" aria-label="前一天" disabled={pending || date === "1000-01-01"} onClick={() => selectDate(shiftReportDate(date, -1))}><Icon name="chevron-left" /></button><button type="button" className="reports-today-button" disabled={pending || isToday} onClick={() => selectDate(currentDay)}>回到今天</button><button type="button" className="reports-icon-button" aria-label="后一天" disabled={pending || date === "9999-12-31"} onClick={() => selectDate(shiftReportDate(date, 1))}><Icon name="chevron-right" /></button></div>
      </div>
    </header>
    <div className="reports-layout">
      <aside className="reports-history" id="reports-archive" data-open={historyOpen} aria-label="日报历史">
        <ReportCalendar selected={date} today={currentDay} dates={reportDates} disabled={pending} onSelect={selectDate} />
        <label className="reports-date-picker" htmlFor="report-date"><span>跳转日期</span><input id="report-date" type="date" min="1000-01-01" max="9999-12-31" value={date} disabled={pending} onChange={event => { const next = event.target.value; event.target.value = date; if (next) selectDate(next); }} /></label>
        <div className="reports-history-heading"><h2>历史日报</h2><span>{reports.length} 篇</span></div>
        {listError && <div className="reports-list-error"><p role="alert">{listError}</p><button type="button" className="text-button" onClick={() => void refreshList()}>重试列表</button></div>}
        {!listError && reports.length === 0 && <div className="reports-history-empty"><p>你的第一篇，从今天开始。</p><span>保存后的日报会按日期收在这里。</span></div>}
        <nav aria-label="按日期浏览日报">{reports.map((item, index) => <div className="reports-history-entry" key={item.date}>
          {reports[index - 1]?.date.slice(0, 7) !== item.date.slice(0, 7) && <h3 className="reports-history-month">{item.date.slice(0, 4)}年{Number(item.date.slice(5, 7))}月</h3>}
          <button type="button" aria-current={date === item.date ? "date" : undefined} disabled={pending} onClick={() => selectDate(item.date)}><Icon name="file-text" /><time dateTime={item.date}>{item.date}</time><Icon name="chevron-right" /></button>
        </div>)}</nav>
      </aside>
      <div className="reports-editor" aria-busy={loading || pending}>
        <div className="reports-toolbar">
          <div className="reports-date-heading"><p className="reports-document-eyebrow">{isToday ? "今天，记下一点进展" : "回看这一天"}</p><h2><time dateTime={date}>{year}年{Number(month)}月{Number(day)}日</time>{isToday && <span className="reports-today-badge">今天</span>}</h2><p className="reports-date-detail">{weekday}<span aria-hidden="true">·</span>{saved ? "一日一页，留住工作的脉络" : "新的一页，等你落笔"}</p></div>
          <div className="reports-tools"><button type="button" className="header-button" disabled={!ready} aria-pressed={preview} onClick={() => setPreview(value => !value)}>{preview ? <Icon name="pencil" /> : <Icon name="eye" />}{preview ? "编辑" : "预览"}</button><button type="button" className="settings-save" disabled={!ready || pending || !dirty || markdown.length > 16000} onClick={() => void save()}><Icon name="check" />{pending ? "保存中…" : "保存日报"}</button></div>
        </div>
        {loading && <div className="reports-loading"><p role="status">正在读取日报…</p><div aria-hidden="true"><span /><span /><span /></div></div>}
        {error && <div className="reports-error"><p role="alert">{error}</p><button type="button" className="text-button" disabled={pending} onClick={() => void load(date)}>重新读取</button></div>}
        {ready && <>
          {!markdown.trim() && !preview && <div className="reports-starter"><div><p>从今天最值得记下的事开始。</p><span>自由记录，或用三个小标题理清思路。</span></div><button type="button" disabled={pending} onClick={() => setMarkdown(REPORT_TEMPLATE)}>使用日报模板<Icon name="chevron-right" /></button></div>}
          {preview && <div className="reports-preview md" aria-label="日报预览">{markdown ? <MarkdownDocument value={markdown} /> : <p className="reports-empty-preview">还没有内容，切回编辑开始记录。</p>}</div>}
          <div className="reports-writing" hidden={preview}><MarkdownEditor key={date} value={markdown} onChange={setMarkdown} disabled={pending} label="日报正文" variant="document" /></div>
          {markdown.length > 16000 && <p className="reports-error" role="alert">正文不能超过 16000 个字符，请缩短内容后保存。当前草稿仍完整保留。</p>}
          <footer className="reports-footer"><div><span className="reports-save-status" data-dirty={dirty || pending} role="status">{status}</span>{saved && !dirty && !pending && <time className="reports-saved-time" dateTime={saved.updatedAt}>{new Date(saved.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</time>}</div><span className="reports-character-count" data-limit={markdown.length > 16000}>{markdown.length.toLocaleString("zh-CN")} / 16,000 字符</span></footer>
          <p className="reports-shortcut">⌘ / Ctrl + S 保存<span aria-hidden="true">·</span>支持 Markdown</p>
        </>}
      </div>
    </div>
  </section>;
}
