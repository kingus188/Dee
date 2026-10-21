import { useEffect, useRef, useState } from "react";
import type { DailyReport, DailyReportInput, DailyReportSummary } from "@assistant/contracts";
import { request } from "../api/request.js";
import { renderMarkdown } from "../chat/markdown.js";
import { Icon } from "../ui/Icon.js";
import { MarkdownEditor } from "../editor/MarkdownEditor.js";

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function DailyReports({ active }: { active: boolean }) {
  const [date, setDate] = useState(today), [markdown, setMarkdown] = useState("");
  const [saved, setSaved] = useState<DailyReport | null>(null), [reports, setReports] = useState<DailyReportSummary[]>([]);
  const [ready, setReady] = useState(false), [loading, setLoading] = useState(false), [pending, setPending] = useState(false);
  const [error, setError] = useState(""), [listError, setListError] = useState(""), [preview, setPreview] = useState(false);
  const sequence = useRef(0), busy = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  const dirty = ready && markdown !== (saved?.markdown ?? "");

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

  return <section className="daily-reports" hidden={!active} aria-labelledby="reports-title">
    <header className="reports-heading"><div><p className="settings-eyebrow">个人空间 / 日报</p><h1 id="reports-title" tabIndex={-1} ref={heading}>每日记录</h1><p>用 Markdown 记下今天的进展、问题和明日计划。</p></div></header>
    <div className="reports-layout">
      <aside className="reports-history" aria-label="日报历史">
        <div className="reports-history-heading"><h2>历史日报</h2><button className="text-button" onClick={() => void load(today())} disabled={pending}>今天</button></div>
        {listError && <div><p role="alert">{listError}</p><button className="text-button" onClick={() => void refreshList()}>重试列表</button></div>}
        {!listError && reports.length === 0 && <p className="reports-muted">保存第一篇后，会显示在这里。</p>}
        <nav>{reports.map(item => <button type="button" key={item.date} aria-current={date === item.date ? "date" : undefined} disabled={pending} onClick={() => { if (item.date !== date) void load(item.date); }}>{item.date}<Icon name="chevron-right" /></button>)}</nav>
      </aside>
      <div className="reports-editor" aria-busy={loading || pending}>
        <div className="reports-toolbar"><label htmlFor="report-date">日期<input id="report-date" type="date" min="1000-01-01" max="9999-12-31" value={date} disabled={pending} onChange={event => { const next = event.target.value; event.target.value = date; if (next) void load(next); }} /></label>
          <div className="reports-tools"><button className="header-button" disabled={!ready} aria-pressed={preview} onClick={() => setPreview(value => !value)}>{preview ? "编辑" : "预览"}</button><button className="settings-save" disabled={!ready || pending || !dirty || markdown.length > 16000} onClick={() => void save()}><Icon name="check" />{pending ? "保存中…" : "保存日报"}</button></div>
        </div>
        {loading && <p role="status">正在读取日报…</p>}
        {error && <div className="reports-error"><p role="alert">{error}</p><button className="text-button" disabled={pending} onClick={() => void load(date)}>重新读取</button></div>}
        {ready && <>
          {preview ? <article className="reports-preview md" aria-label="日报预览" dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown) || "<p>还没有内容，切回编辑开始记录。</p>" }} /> : <MarkdownEditor key={date} value={markdown} onChange={setMarkdown} disabled={pending} label="日报正文" />}
          {markdown.length > 16000 && <p className="reports-error" role="alert">正文不能超过 16000 个字符，请缩短内容后保存。当前草稿仍完整保留。</p>}
          <footer className="reports-footer"><span role="status">{pending ? "正在保存…" : dirty ? "有未保存的修改" : saved ? `已保存 · ${new Date(saved.updatedAt).toLocaleString()}` : "当天还没有日报"}</span><span>{markdown.length} / 16000</span></footer>
        </>}
      </div>
    </div>
  </section>;
}
