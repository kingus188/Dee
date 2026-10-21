import { useEffect, useRef, useState } from "react";
import type { MemoryItem, PersonalData, SkillItem } from "@assistant/contracts";
import { request } from "../api/request.js";
import { MarkdownEditor } from "../editor/MarkdownEditor.js";
import { renderMarkdown } from "../chat/markdown.js";
import { errorMessage, mayDiscard, useUnsavedChanges } from "./editing.js";

type Item = MemoryItem | SkillItem;
const statuses: Record<Item["status"], string> = { pending: "待确认", approved: "已生效", rejected: "已撤回" };

export function PersonalPage({ kind, active }: { kind: "memory" | "skills"; active: boolean }) {
  const [items, setItems] = useState<Item[]>([]), [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<Item | null>(null), [text, setText] = useState("");
  const [name, setName] = useState(""), [description, setDescription] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const busy = useRef(false), requestId = useRef(crypto.randomUUID());
  const memory = kind === "memory", title = memory ? "记忆" : "技能";
  const originalText = selected ? "text" in selected ? selected.text : selected.body : "";
  const dirty = text !== originalText || name !== (selected && "name" in selected ? selected.name : "") || description !== (selected && "description" in selected ? selected.description : "");
  useUnsavedChanges(dirty);
  async function load() {
    try { const data = await request<PersonalData>("/api/personal"); setItems(data[kind]); setReady(true); setError(""); }
    catch (error) { setError(errorMessage(error)); }
  }
  useEffect(() => { if (active) void load(); }, [active]);
  function select(item: Item | null) {
    if (busy.current || !mayDiscard(dirty)) return;
    setSelected(item); setText(item ? "text" in item ? item.text : item.body : "");
    setName(item && "name" in item ? item.name : ""); setDescription(item && "description" in item ? item.description : "");
    requestId.current = crypto.randomUUID(); setError(""); setFeedback("");
  }
  async function save() {
    if (busy.current || !text.trim()) return;
    busy.current = true; setPending(true); setError(""); setFeedback("");
    try {
      const body = memory ? { text } : { name, description, body: text };
      const result = await request<{ item: Item }>(`/api/personal/${kind}${selected ? `/${selected.id}/edit` : ""}`, { ...body, ...(selected ? { base: selected } : { requestId: requestId.current }) });
      setSelected(result.item); setText("text" in result.item ? result.item.text : result.item.body);
      if ("name" in result.item) { setName(result.item.name); setDescription(result.item.description); }
      setItems(old => [result.item, ...old.filter(item => item.id !== result.item.id)]); setFeedback("已保存");
    } catch (error) { setError(errorMessage(error)); }
    finally { busy.current = false; setPending(false); }
  }
  async function decide(item: Item, action: "approve" | "reject") {
    if (busy.current || !mayDiscard(dirty)) return;
    busy.current = true; setPending(true); setError("");
    try {
      const result = await request<{ item: Item }>(`/api/personal/${kind}/${item.id}/${action}`, {});
      setItems(old => old.map(value => value.id === item.id ? result.item : value));
      if (selected?.id === item.id) { setSelected(result.item); setText("text" in result.item ? result.item.text : result.item.body); if ("name" in result.item) { setName(result.item.name); setDescription(result.item.description); } }
      setFeedback(action === "approve" ? "已批准" : "已撤回");
    } catch (error) { setError(errorMessage(error)); }
    finally { busy.current = false; setPending(false); }
  }
  return <div className="workspace-editor-layout">
    <aside className="workspace-records" aria-label={`${title}列表`}>
      <div className="workspace-records-heading"><h2>全部{title}</h2><button type="button" className="text-button" disabled={pending} onClick={() => select(null)}>新增{title}</button></div>
      {!ready && !error && <p role="status">正在读取…</p>}
      {ready && !items.length && <p className="workspace-muted">还没有{title}，在右侧直接编写。</p>}
      {items.map(item => <article className="workspace-record" key={item.id} data-selected={selected?.id === item.id}>
        <button type="button" className="workspace-record-select" disabled={pending} onClick={() => select(item)}><strong>{"name" in item ? item.name : item.text}</strong><span>{statuses[item.status]}</span></button>
        <div className="workspace-record-actions">{item.status === "pending" && <button type="button" disabled={pending} onClick={() => void decide(item, "approve")}>批准</button>}{item.status !== "rejected" && <button type="button" disabled={pending} onClick={() => void decide(item, "reject")}>{item.status === "approved" ? "撤回" : "拒绝"}</button>}</div>
      </article>)}
      <button className="text-button" type="button" disabled={pending} onClick={() => void load()}>刷新列表</button>
    </aside>
    <section className="workspace-edit-form" aria-label={`${title}编辑`} aria-busy={pending}>
      <header className="workspace-edit-heading"><h2>{selected ? `编辑${title}` : `新增${title}`}</h2><span className="workspace-muted">{selected ? statuses[selected.status] : "本人创建，保存后生效"}</span></header>
      {selected?.status === "rejected" ? <><p className="workspace-muted">已撤回的记录只读。可新增一条内容。</p><article className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(originalText) }} /></> : <>
        {!memory && <><label>技能名称<input value={name} maxLength={40} disabled={pending} onChange={event => setName(event.target.value)} /></label><label>使用场景<input value={description} maxLength={180} disabled={pending} onChange={event => setDescription(event.target.value)} /></label></>}
        <MarkdownEditor key={selected?.id ?? "new"} label={memory ? "记忆正文" : "技能正文"} value={text} onChange={setText} disabled={pending} />
        <footer className="workspace-edit-actions"><span role="status">{pending ? "正在保存…" : dirty ? "有未保存的修改" : feedback || "Markdown 正文"}</span><span>{text.length} / {memory ? 280 : 4000}</span><button type="button" className="settings-save" disabled={pending || !text.trim() || !dirty || text.length > (memory ? 280 : 4000) || (!memory && (!name.trim() || !description.trim()))} onClick={() => void save()}>{pending ? "保存中…" : `保存${title}`}</button></footer>
      </>}
      {error && <p className="workspace-error" role="alert">{error}。草稿已保留；若内容已被更新，请刷新列表后重新选择记录，核对再保存。</p>}
    </section>
  </div>;
}
