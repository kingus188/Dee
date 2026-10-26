import { useEffect, useRef, useState } from "react";
import type { MemoryItem, PersonalData, SkillItem } from "@assistant/contracts";
import { request } from "../api/request.js";
import { MarkdownEditor } from "../editor/MarkdownEditor.js";
import { MarkdownDocument } from "../editor/MarkdownDocument.js";
import { Icon } from "../ui/Icon.js";
import { MemoryHistory } from './MemoryHistory.js';
import { errorMessage, mayDiscard, useUnsavedChanges } from "./editing.js";

type Item = MemoryItem | SkillItem;
type Mode = "browse" | "view" | "create" | "edit";
type Filter = "all" | Item["status"];
const statuses: Record<Item["status"], string> = { pending: "待确认", approved: "已生效", rejected: "已撤回" };
const filters: { value: Filter; label: string }[] = [{ value: "all", label: "全部" }, { value: "approved", label: "已生效" }, { value: "pending", label: "待确认" }, { value: "rejected", label: "已撤回" }];
const bodyOf = (item: Item) => "text" in item ? item.text : item.body;
const sourceOf = (item: Item) => item.source === "agent" ? "小 D 提议" : "你创建的";

export function PersonalPage({ kind, active }: { kind: "memory" | "skills"; active: boolean }) {
  const [items, setItems] = useState<Item[]>([]), [ready, setReady] = useState(false), [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>("browse"), [filter, setFilter] = useState<Filter>("all"), [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Item | null>(null), [text, setText] = useState("");
  const [name, setName] = useState(""), [description, setDescription] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const busy = useRef(false), requestId = useRef(crypto.randomUUID()), heading = useRef<HTMLHeadingElement>(null);
  const memory = kind === "memory", title = memory ? "记忆" : "技能", editing = mode === "create" || mode === "edit";
  const originalText = selected ? bodyOf(selected) : "";
  const dirty = editing && (text !== originalText || name !== (selected && "name" in selected ? selected.name : "") || description !== (selected && "description" in selected ? selected.description : ""));
  useUnsavedChanges(dirty);
  async function load() {
    if (busy.current) return;
    setLoading(true);
    try { const data = await request<PersonalData>("/api/personal"); setItems(data[kind]); setReady(true); setError(""); }
    catch (error) { setError(errorMessage(error)); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (active) void load(); }, [active]);
  useEffect(() => { if (mode !== "browse") heading.current?.focus(); }, [mode, selected?.id]);
  function select(item: Item | null, next: Mode) {
    if (busy.current || !mayDiscard(dirty)) return;
    setSelected(item); setMode(next); setText(item ? bodyOf(item) : "");
    setName(item && "name" in item ? item.name : ""); setDescription(item && "description" in item ? item.description : "");
    requestId.current = crypto.randomUUID(); setError(""); setFeedback("");
  }
  async function save() {
    if (busy.current || !dirty || !text.trim()) return;
    busy.current = true; setPending(true); setError(""); setFeedback("");
    try {
      const body = memory ? { text } : { name, description, body: text };
      const result = await request<{ item: Item }>(`/api/personal/${kind}${selected ? `/${selected.id}/edit` : ""}`, { ...body, ...(selected ? { base: selected } : { requestId: requestId.current }) });
      setSelected(result.item); setText(bodyOf(result.item));
      if ("name" in result.item) { setName(result.item.name); setDescription(result.item.description); }
      setItems(old => [result.item, ...old.filter(item => item.id !== result.item.id)]); setMode("view"); setFeedback("已保存");
    } catch (error) { setError(errorMessage(error)); }
    finally { busy.current = false; setPending(false); }
  }
  async function decide(item: Item, action: "approve" | "reject") {
    if (busy.current || !mayDiscard(dirty)) return;
    busy.current = true; setPending(true); setError("");
    try {
      const result = await request<{ item: Item }>(`/api/personal/${kind}/${item.id}/${action}`, {});
      setItems(old => old.map(value => value.id === item.id ? result.item : value));
      setSelected(result.item); setText(bodyOf(result.item));
      if ("name" in result.item) { setName(result.item.name); setDescription(result.item.description); }
      setMode("view"); setFeedback(action === "approve" ? "已批准" : "已撤回");
    } catch (error) { setError(errorMessage(error)); }
    finally { busy.current = false; setPending(false); }
  }
  const matching = items.filter(item => (filter === "all" || item.status === filter) && `${"name" in item ? `${item.name} ${item.description}` : ""} ${bodyOf(item)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const notice = <>{feedback && <p className="workspace-content-feedback" role="status">{feedback}</p>}{error && <p className="workspace-error" role="alert">{error}{editing ? "。草稿已保留，请核对最新内容后重试。" : "。请重新读取后重试。"}</p>}</>;
  if (mode === "browse") return <div className="workspace-content-page" data-kind={kind}>
    <div className="workspace-library-toolbar"><div><h2>全部{title}<span className="workspace-count">{items.length}</span></h2><p className="workspace-muted">{memory ? "已确认的记忆会作为后续协作的背景。" : "已生效的技能会在相关任务中按需使用。"}</p></div><div className="workspace-library-actions"><button type="button" className="icon-button" aria-label={`刷新${title}列表`} disabled={pending || loading} onClick={() => void load()}><Icon name="refresh-cw" /></button><button type="button" className="settings-save" disabled={pending || !ready} onClick={() => select(null, "create")}><Icon name="plus" />新增{title}</button></div></div>
    {!ready && !error && <p className="workspace-content-loading" role="status">正在读取{title}…</p>}
    {ready && items.length > 0 && <div className="workspace-library-controls"><div className="workspace-status-filters" role="group" aria-label={`${title}状态`}>{filters.map(option => <button type="button" key={option.value} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}<span>{option.value === "all" ? items.length : items.filter(item => item.status === option.value).length}</span></button>)}</div><label className="workspace-content-search"><Icon name="search" /><input type="search" aria-label={`搜索${title}`} placeholder={memory ? "搜索记忆内容" : "搜索名称或使用场景"} value={query} onChange={event => setQuery(event.target.value)} /></label></div>}
    {ready && !items.length && <section className="workspace-content-empty" aria-label={`${title}空状态`}><span className="workspace-content-mark"><Icon name={memory ? "brain" : "sparkles"} /></span><h2>还没有{title}</h2><p>{memory ? "记下你的偏好、习惯与重要背景，让小 D 在之后的协作中记得。" : "把常用的工作方法留成技能，下次遇到类似任务时接着用。"}</p><button type="button" className="text-button" onClick={() => select(null, "create")}>创建第一条{title}<Icon name="arrow-up-right" /></button><small>也可以在对话中告诉小 D，提议的内容会先交给你确认。</small></section>}
    {items.length > 0 && !matching.length && <section className="workspace-content-empty"><h2>没有匹配的{title}</h2><p>试试其他关键词，或查看全部内容。</p><button type="button" className="text-button" onClick={() => { setQuery(""); setFilter("all"); }}>清除筛选</button></section>}
    {matching.length > 0 && <ul className="workspace-library-list" aria-label={`${title}列表`}>{matching.map(item => <li key={item.id}><button type="button" className="workspace-library-item" onClick={() => select(item, "view")}><span className="workspace-library-item-icon"><Icon name={memory ? "brain" : "sparkles"} /></span><span className="workspace-library-item-copy"><strong>{"name" in item ? item.name : item.text}</strong>{"description" in item && <span>{item.description}</span>}<small>{sourceOf(item)}</small></span><span className="workspace-content-status" data-status={item.status}>{statuses[item.status]}</span><Icon name="chevron-right" /></button></li>)}</ul>}
    {notice}
  </div>;
  if (mode === "view" && selected) return <section className="workspace-content-page" aria-label={`${title}详情`}>
    <button type="button" className="text-button workspace-back" disabled={pending} onClick={() => select(null, "browse")}><Icon name="arrow-left" />全部{title}</button>
    <header className="workspace-detail-heading"><div><div className="workspace-detail-meta"><span className="workspace-content-status" data-status={selected.status}>{statuses[selected.status]}</span><span>{sourceOf(selected)}</span></div><h2 ref={heading} tabIndex={-1}>{"name" in selected ? selected.name : "记忆详情"}</h2>{"description" in selected && <p>{selected.description}</p>}</div>{selected.status !== "rejected" && <button type="button" className="header-button workspace-outline-button" disabled={pending} onClick={() => select(selected, "edit")}><Icon name="pencil" />编辑{title}</button>}</header>
    {selected.status === "pending" && <div className="workspace-review-notice"><p>这条{title}由小 D 提议，确认后才会生效。</p><div><button type="button" className="settings-save" disabled={pending} onClick={() => void decide(selected, "approve")}>批准{title}</button><button type="button" className="text-button" disabled={pending} onClick={() => void decide(selected, "reject")}>拒绝</button></div></div>}
    {selected.status === "rejected" && <p className="workspace-muted">这条{title}已撤回，不再用于后续协作。</p>}
    <MarkdownDocument className="workspace-reading md" value={originalText} />
    {'text' in selected && <MemoryHistory item={selected} />}
    {selected.status === "approved" && <footer className="workspace-detail-footer"><span className="workspace-muted">{memory ? "用于后续对话的背景信息" : "在相关任务中按需使用"}</span><button type="button" className="text-button" disabled={pending} onClick={() => void decide(selected, "reject")}>撤回{title}</button></footer>}
    {notice}
  </section>;
  return <section className="workspace-content-page workspace-edit-form" aria-label={`${title}编辑`} aria-busy={pending}>
    <button type="button" className="text-button workspace-back" disabled={pending} onClick={() => select(selected, selected ? "view" : "browse")}><Icon name="arrow-left" />取消编辑</button>
    <header className="workspace-edit-heading"><h2 ref={heading} tabIndex={-1}>{selected ? `编辑${title}` : `新增${title}`}</h2><span className="workspace-muted">{selected ? statuses[selected.status] : "本人创建，保存后生效"}</span></header>
    {!memory && <div className="workspace-skill-fields"><label>技能名称<input value={name} maxLength={40} placeholder="例如：每周项目复盘" disabled={pending} onChange={event => setName(event.target.value)} /></label><label>使用场景<input value={description} maxLength={180} placeholder="什么时候使用这项技能" disabled={pending} onChange={event => setDescription(event.target.value)} /></label></div>}
    <MarkdownEditor key={selected?.id ?? "new"} label={memory ? "记忆正文" : "技能正文"} value={text} onChange={setText} disabled={pending} />
    <footer className="workspace-edit-actions"><span role="status">{pending ? "正在保存…" : dirty ? "有未保存的修改" : "保存后返回详情"}</span><span>{text.length} / {memory ? 280 : 4000}</span><button type="button" className="settings-save" disabled={pending || !text.trim() || !dirty || text.length > (memory ? 280 : 4000) || (!memory && (!name.trim() || !description.trim()))} onClick={() => void save()}>{pending ? "保存中…" : `保存${title}`}</button></footer>
    {notice}
  </section>;
}
