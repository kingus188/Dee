import { useEffect, useRef, useState } from "react";
import type { ConversationView } from "@assistant/contracts";
import { request } from "../api/request.js";
import { MarkdownEditor } from "../editor/MarkdownEditor.js";
import { errorMessage, mayDiscard, useUnsavedChanges } from "./editing.js";

type Notes = ConversationView["notes"];
export function NotesPage({ owner, active }: { owner: number; active: boolean }) {
  const [notes, setNotes] = useState<Notes>({ todos: [], memos: [] }), [base, setBase] = useState<Notes | null>(null);
  const [index, setIndex] = useState<number | null>(null), [text, setText] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const busy = useRef(false);
  const original = index === null ? "" : notes.memos[index] ?? "";
  const dirty = base !== null && text !== original;
  useUnsavedChanges(dirty);
  async function load() {
    if (busy.current || !mayDiscard(dirty)) return;
    busy.current = true; setPending(true); setError("");
    try { const data = await request<Notes>(`/api/conversations/${owner}/notes`); setNotes(data); setBase(data); setIndex(null); setText(""); setFeedback(""); }
    catch (error) { setError(errorMessage(error)); }
    finally { busy.current = false; setPending(false); }
  }
  useEffect(() => { if (active && base === null) void load(); }, [active]);
  function select(nextIndex: number | null) {
    if (busy.current || !mayDiscard(dirty)) return;
    setIndex(nextIndex); setText(nextIndex === null ? "" : notes.memos[nextIndex]); setFeedback("");
  }
  async function save() {
    if (!base || busy.current || !dirty || !text.trim()) return;
    const next: Notes = { todos: [], memos: [...notes.memos] };
    const savedIndex = index ?? next.memos.length;
    if (index === null) next.memos.push(text); else next.memos[index] = text;
    busy.current = true; setPending(true); setError(""); setFeedback("");
    try { const data = await request<Notes>(`/api/conversations/${owner}/notes`, { notes: next, base }); setNotes(data); setBase(data); setIndex(savedIndex); setFeedback("已保存"); }
    catch (error) { setError(errorMessage(error)); }
    finally { busy.current = false; setPending(false); }
  }
  return <div className="workspace-editor-layout">
    <aside className="workspace-records" aria-label="笔记列表">
      <div className="workspace-records-heading"><h2>笔记</h2><button className="text-button" type="button" disabled={pending || !base} onClick={() => select(null)}>新增笔记</button></div>
      {notes.memos.map((item, i) => <button className="workspace-record-select" type="button" key={i} disabled={pending} aria-current={index === i ? "true" : undefined} onClick={() => select(i)}>{item}</button>)}
      {base && !notes.memos.length && <p className="workspace-muted">直接编写第一条笔记。待办请从左侧 Daylight 管理。</p>}
      <button className="text-button" type="button" disabled={pending} onClick={() => void load()}>重新读取</button>
      <a className="text-button" href={`/api/conversations/${owner}/export.md`} download>导出聊天记录</a>
    </aside>
    <section className="workspace-edit-form" aria-label="笔记编辑" aria-busy={pending}>
      <header className="workspace-edit-heading"><h2>{index === null ? "新增笔记" : "编辑笔记"}</h2><span className="workspace-muted">当前会话 #{owner}</span></header>
      {!base && !error && <p role="status">正在读取…</p>}
      {base && <MarkdownEditor key={index ?? "new"} value={text} onChange={setText} label="笔记正文" disabled={pending} />}
      <footer className="workspace-edit-actions"><span role="status">{pending ? "正在保存…" : dirty ? "有未保存的修改" : feedback || "Markdown 正文"}</span><span>{text.length} / 16000</span><button className="settings-save" type="button" disabled={!base || pending || !dirty || !text.trim() || text.length > 16000} onClick={() => void save()}>{pending ? "保存中…" : "保存笔记"}</button></footer>
      {error && <p role="alert" className="workspace-error">{error}。草稿已保留；重新读取前请复制需要保留的正文。</p>}
    </section>
  </div>;
}
