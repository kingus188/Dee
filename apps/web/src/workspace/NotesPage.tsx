import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MarkdownDocument } from "../editor/MarkdownDocument.js";
import { MarkdownEditor } from "../editor/MarkdownEditor.js";
import { renderDocumentMarkdown, type MarkdownHeading } from "../chat/markdown.js";
import { Icon } from "../ui/Icon.js";
import { useNotesDocument } from "./notes/useNotesDocument.js";

function titleOf(text: string, index: number) {
  const first = text.split(/\r?\n/).find(line => line.trim()) ?? "";
  return first.replace(/^\s*#{1,6}\s+/, "").replace(/\*\*|__|`|~~/g, "").trim().slice(0, 90) || `笔记 ${index + 1}`;
}
function previewOf(text: string) {
  return text.split(/\r?\n/).filter(line => line.trim()).slice(1).join(" ").replace(/[#*`>_|]/g, "").slice(0, 100);
}

export function NotesPage({ owner, active, headerActions }: { owner: number; active: boolean; headerActions?: ReactNode }) {
  const doc = useNotesDocument(owner, active);
  const [libraryOpen, setLibraryOpen] = useState(false), [tab, setTab] = useState<"notes" | "outline">("notes");
  const [query, setQuery] = useState(""), [focus, setFocus] = useState(false);
  const paper = useRef<HTMLDivElement>(null), library = useRef<HTMLElement>(null), libraryToggle = useRef<HTMLButtonElement>(null);
  const value = doc.editing ? doc.text : doc.original;
  const rendered = useMemo(() => renderDocumentMarkdown(value), [value]);
  const matches = doc.notes.memos.map((memo, index) => ({ memo, index })).filter(({ memo }) => memo.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const hasDocument = doc.editing || doc.index !== null;
  const title = hasDocument ? titleOf(value, doc.index ?? doc.notes.memos.length) : "所有笔记";
  const documentTitle = doc.editing && doc.index === null && !value.trim() ? "未命名笔记" : title;
  const status = doc.pending ? "正在读取或保存…" : doc.dirty ? "有未保存的修改" : doc.feedback || (hasDocument ? "已保存的笔记" : `${doc.notes.memos.length} 篇笔记`);

  useEffect(() => { if (!active) setLibraryOpen(false); }, [active]);
  useEffect(() => {
    if (!libraryOpen || !active) return;
    // The library is a temporary navigation surface; keep the document in place.
    library.current?.querySelector<HTMLElement>(tab === "notes" ? "input" : '[role="tab"][aria-selected="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!library.current?.contains(event.target as Node) && !libraryToggle.current?.contains(event.target as Node)) setLibraryOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setLibraryOpen(false); libraryToggle.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [libraryOpen, active]);

  function select(index: number | null) {
    if (doc.select(index)) {
      setLibraryOpen(index === null); setFocus(false);
      if (paper.current) paper.current.scrollTop = 0;
      if (index !== null) libraryToggle.current?.focus();
    }
  }
  function create() {
    if (doc.create()) { setLibraryOpen(false); setFocus(false); if (paper.current) paper.current.scrollTop = 0; }
  }
  function jump(heading: MarkdownHeading, index: number) {
    const source = paper.current?.querySelector<HTMLTextAreaElement>("textarea");
    if (source) {
      const offset = doc.text.split("\n").slice(0, heading.line).reduce((sum, line) => sum + line.length + 1, 0);
      source.focus(); source.setSelectionRange(offset, offset);
      source.scrollTop = source.scrollHeight * heading.line / Math.max(1, doc.text.split("\n").length);
    } else if (doc.editing && paper.current?.querySelector('[data-editor-engine="tiptap"]')) {
      paper.current.querySelector('[data-editor-engine="tiptap"]')!.dispatchEvent(new CustomEvent("live-markdown-jump", { detail: { line: heading.line } }));
    } else {
      const target = doc.editing ? paper.current?.querySelectorAll<HTMLElement>(".tiptap h1, .tiptap h2, .tiptap h3, .tiptap h4, .tiptap h5, .tiptap h6")[index] : paper.current?.querySelector<HTMLElement>(`#${heading.id}`);
      target?.scrollIntoView?.({ block: "start" }); target?.focus({ preventScroll: true });
    }
    setLibraryOpen(false);
  }
  return <div className="workspace-content-page notes-workspace" data-focus={focus} onKeyDown={event => {
    if (active && doc.editing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!event.nativeEvent.isComposing) void doc.save(); }
  }}>
    <header className="workspace-header management-header notes-header">
      <div className="notes-header-location">
        <button ref={libraryToggle} className="header-button notes-library-toggle" type="button" aria-label={libraryOpen ? "收起笔记目录" : "显示笔记目录"} aria-expanded={libraryOpen} aria-controls={`notes-library-${owner}`} onClick={() => { setFocus(false); setLibraryOpen(!libraryOpen); }}><Icon name="notebook-pen" /><strong>笔记</strong><span className="notes-count">{doc.notes.memos.length}</span><Icon name="chevron-down" /></button>
        <span className="notes-header-divider" aria-hidden="true">/</span>
        <span className="notes-document-title" title={documentTitle}>{documentTitle}</span>
        {doc.dirty && <span className="notes-unsaved-dot" title="有未保存的修改" aria-label="有未保存的修改" />}
      </div>
      <div className="notes-header-actions">
        <div className="notes-document-actions">
          {!doc.editing && hasDocument && <button className="icon-button notes-focus-toggle" type="button" aria-label={focus ? "退出专注阅读" : "专注阅读"} aria-pressed={focus} onClick={() => { setLibraryOpen(false); setFocus(!focus); }}><Icon name="scan-line" /></button>}
          {doc.editing ? <><button className="text-button notes-cancel" type="button" aria-label="取消编辑" disabled={doc.pending} onClick={doc.cancel}>取消<span>编辑</span></button><button className="settings-save" type="button" disabled={!doc.canSave} onClick={() => void doc.save()}>保存笔记</button></> : hasDocument ? <><button className="icon-button notes-new" type="button" aria-label="新增笔记" title="新增笔记" disabled={doc.pending || !doc.base} onClick={create}><Icon name="plus" /></button><button className="header-button notes-edit" type="button" disabled={doc.pending} onClick={doc.edit}><Icon name="pencil" />编辑笔记</button></> : <button className="header-button notes-edit" type="button" disabled={doc.pending || !doc.base} onClick={create}><Icon name="plus" />新增笔记</button>}
        </div>
        {headerActions && <div className="notes-service-actions">{headerActions}</div>}
      </div>
    </header>
    <aside ref={library} id={`notes-library-${owner}`} className="notes-sidebar" hidden={!libraryOpen} aria-label="笔记导航">
      <header className="notes-library-heading"><div><h2>笔记库</h2><span>{doc.notes.memos.length} 篇</span></div><button className="icon-button" type="button" aria-label="关闭笔记目录" onClick={() => { setLibraryOpen(false); libraryToggle.current?.focus(); }}><Icon name="x" /></button></header>
      <p className="notes-owner">当前会话 #{owner}</p>
      <div className="notes-tabs" role="tablist" aria-label="笔记导航方式" onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault(); const next = tab === "notes" ? "outline" : "notes"; setTab(next);
        event.currentTarget.querySelector<HTMLButtonElement>(`[id="notes-tab-${next}-${owner}"]`)?.focus();
      }}>
        <button id={`notes-tab-notes-${owner}`} type="button" role="tab" aria-selected={tab === "notes"} aria-controls={`notes-panel-notes-${owner}`} tabIndex={tab === "notes" ? 0 : -1} onClick={() => setTab("notes")}>笔记列表</button>
        <button id={`notes-tab-outline-${owner}`} type="button" role="tab" aria-selected={tab === "outline"} aria-controls={`notes-panel-outline-${owner}`} tabIndex={tab === "outline" ? 0 : -1} onClick={() => setTab("outline")}>大纲</button>
      </div>
      <section id={`notes-panel-notes-${owner}`} className="notes-library" role="tabpanel" aria-labelledby={`notes-tab-notes-${owner}`} hidden={tab !== "notes"}>
        <label className="notes-search"><Icon name="search" /><input aria-label="搜索笔记" placeholder="搜索标题或正文…" type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="notes-list" aria-label="笔记列表">
          {matches.map(({ memo, index }) => <button className="notes-list-item workspace-record-select" key={index} type="button" aria-current={doc.index === index ? "true" : undefined} disabled={doc.pending} onClick={() => select(index)}><strong>{titleOf(memo, index)}</strong><span>{previewOf(memo) || "一篇 Markdown 笔记"}</span><small>{memo.length.toLocaleString()} 字符</small></button>)}
          {doc.base && !matches.length && <p className="notes-navigation-empty">{query.trim() ? "没有匹配的笔记" : "从第一篇笔记开始。"}{query.trim() && <button className="text-button" type="button" onClick={() => setQuery("")}>清除搜索</button>}</p>}
        </div>
      </section>
      <nav id={`notes-panel-outline-${owner}`} className="notes-outline" role="tabpanel" aria-labelledby={`notes-tab-outline-${owner}`} hidden={tab !== "outline"}>
        {rendered.headings.map((heading, index) => <button type="button" key={heading.id} data-level={heading.level} onClick={() => jump(heading, index)}>{heading.text}</button>)}
        {!rendered.headings.length && <p className="notes-navigation-empty">{hasDocument ? "用 Markdown 标题组织内容，段落会出现在这里。" : "选择一篇笔记，查看文档大纲。"}</p>}
      </nav>
      <footer className="notes-library-footer"><button className="text-button" type="button" aria-label="新增笔记" disabled={doc.pending || !doc.base} onClick={create}><Icon name="plus" />新建笔记</button><button className="icon-button" type="button" aria-label="重新读取" title="重新读取" disabled={doc.pending} onClick={() => void doc.load()}><Icon name="refresh-cw" /></button><a href={`/api/conversations/${owner}/export.md`} download title="导出聊天记录" aria-label="导出聊天记录"><Icon name="download" /></a></footer>
    </aside>
    <section className="notes-main" aria-label="笔记文档">
      {doc.error && <div role="alert" className="notes-error">{doc.error}{doc.editing ? "。草稿已保留；重新读取前请复制需要保留的正文。" : "。请重新读取后重试。"}<button className="text-button" type="button" disabled={doc.pending} onClick={() => void doc.load()}>重新读取</button></div>}
      <div className="notes-paper-scroll" ref={paper}>
        {!doc.base && !doc.error && <p className="notes-document-placeholder" role="status">正在读取…</p>}
        {hasDocument && <div className="notes-document-meta"><span><Icon name="notebook-pen" />会话 #{owner}</span><span>{doc.editing ? "正在编辑" : "个人笔记"}</span><span>Markdown</span></div>}
        {doc.editing ? <section className="notes-paper notes-writing" aria-label="笔记编辑" aria-busy={doc.pending}><MarkdownEditor key={doc.index ?? "new"} value={doc.text} onChange={doc.setText} label="笔记正文" disabled={doc.pending} variant="document" /></section> : doc.index !== null ? <section className="notes-paper workspace-reading" aria-label="笔记详情"><MarkdownDocument className="md notes-prose" value={doc.original} /><button className="text-button notes-back" type="button" onClick={() => select(null)}>返回笔记列表</button></section> : doc.base && <section className="notes-blank workspace-content-empty"><span className="notes-blank-eyebrow">你的想法，值得记下来</span><Icon name="notebook-pen" /><h2>{doc.notes.memos.length ? "接着上次的想法" : "从一个想法开始"}</h2><p>{doc.notes.memos.length ? "打开笔记库，继续整理已有记录。也可以另起一篇，写下此刻的想法。" : "灵感、决定，或一段还没想清楚的话。\n在这里慢慢整理，让思路有处安放。"}</p><div className="notes-blank-actions"><button className="settings-save" type="button" disabled={doc.pending} onClick={create}><Icon name="plus" />新增笔记</button>{doc.notes.memos.length > 0 && <button className="text-button" type="button" onClick={() => setLibraryOpen(true)}>打开笔记库<Icon name="arrow-up-right" /></button>}</div><small>笔记保存在当前会话，随时回来接着写。</small></section>}
      </div>
      <footer className="notes-status"><span role="status" data-dirty={doc.dirty}>{status}</span><span className="notes-save-shortcut">{doc.editing ? "⌘ / Ctrl + S 保存" : "随时记录，慢慢整理"}</span><span>{doc.editing ? `${doc.text.length.toLocaleString()} / 16000` : `${value.length.toLocaleString()} 字符`}{hasDocument && ` · 约 ${Math.max(1, Math.ceil(value.length / 450))} 分钟阅读`}</span></footer>
    </section>
  </div>;
}
