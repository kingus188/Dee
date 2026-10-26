import { useEffect, useRef, useState } from "react";
import type { ConversationView } from "@assistant/contracts";
import { request } from "../../api/request.js";
import { errorMessage, mayDiscard, useUnsavedChanges } from "../editing.js";

type Notes = ConversationView["notes"];
export function useNotesDocument(owner: number, active: boolean) {
  const [notes, setNotes] = useState<Notes>({ todos: [], memos: [] });
  const [base, setBase] = useState<Notes | null>(null);
  const [index, setIndex] = useState<number | null>(null), [text, setText] = useState("");
  const [editing, setEditing] = useState(false), [pending, setPending] = useState(false);
  const [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const busy = useRef(false), version = useRef(0);
  const original = index === null ? "" : notes.memos[index] ?? "";
  const dirty = editing && base !== null && text !== original;
  const canSave = base !== null && !pending && dirty && !!text.trim() && text.length <= 16000;
  useUnsavedChanges(dirty);
  useEffect(() => () => { version.current++; }, [owner]);

  async function load() {
    if (busy.current || !mayDiscard(dirty)) return;
    const current = ++version.current;
    busy.current = true; setPending(true); setError("");
    try {
      const data = await request<Notes>(`/api/conversations/${owner}/notes`);
      if (current !== version.current) return;
      setNotes(data); setBase(data); setIndex(data.memos.length ? 0 : null);
      setText(""); setEditing(false); setFeedback("");
    } catch (error) { if (current === version.current) setError(errorMessage(error)); }
    finally { if (current === version.current) { busy.current = false; setPending(false); } }
  }
  useEffect(() => { if (active && base === null) void load(); }, [active, owner]);

  function select(next: number | null) {
    if (busy.current || !mayDiscard(dirty)) return false;
    setIndex(next); setText(next === null ? "" : notes.memos[next]); setEditing(false); setFeedback(""); setError("");
    return true;
  }
  function create() {
    if (busy.current || !mayDiscard(dirty)) return false;
    setIndex(null); setText(""); setEditing(true); setFeedback(""); setError("");
    return true;
  }
  function edit() {
    if (busy.current || index === null) return;
    setText(original); setEditing(true); setFeedback(""); setError("");
  }
  function cancel() {
    if (busy.current || !mayDiscard(dirty)) return;
    setText(original); setEditing(false); setFeedback(""); setError("");
  }
  async function save() {
    if (!base || busy.current || !canSave) return;
    const next: Notes = { todos: [], memos: [...notes.memos] };
    const savedIndex = index ?? next.memos.length;
    if (index === null) next.memos.push(text); else next.memos[index] = text;
    if (next.memos.length > 1000 || next.memos.reduce((total, memo) => total + memo.length, 0) > 128000) {
      setError("笔记总量已超过 1000 篇或 128000 字符，请先整理现有内容。"); return;
    }
    const current = ++version.current;
    busy.current = true; setPending(true); setError(""); setFeedback("");
    try {
      const data = await request<Notes>(`/api/conversations/${owner}/notes`, { notes: next, base });
      if (current !== version.current) return;
      setNotes(data); setBase(data); setIndex(savedIndex); setText(data.memos[savedIndex] ?? text);
      setEditing(false); setFeedback("已保存");
    } catch (error) { if (current === version.current) setError(errorMessage(error)); }
    finally { if (current === version.current) { busy.current = false; setPending(false); } }
  }
  return { notes, base, index, text, setText, original, editing, pending, error, feedback, dirty, canSave, load, select, create, edit, cancel, save };
}
