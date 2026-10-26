import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { createPortal } from "react-dom";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import { createDocumentExtensions } from "./extensions.js";
import { activeSourceExtension, beginBlockSource, finishBlockSource, updateBlockSource, type BlockSourceSession } from "./block-source.js";
import { DocumentToolbar, type AttributeKind } from "./DocumentToolbar.js";
import { MarkdownSourceLedger } from "./source-ledger.js";
import { createSourceSegments } from "./document-segments.js";
import { markdownTypingExtension } from "./markdown-typing.js";
import { parseDocument } from "./parse-document.js";
import { RAW_SOURCE_META, SOURCE_REVISION, sourceRevisionExtension } from "./source-revision.js";
import { textareaMarkdownEdit } from "../live-markdown-source-input.js";
import type { MarkdownEditorProps } from "./types.js";

interface Panel { kind: AttributeKind; value: string; alt: string; from: number; to: number; position?: number }
interface Island extends BlockSourceSession { markdown: string; prefix: string; suffix: string }

export function TiptapMarkdownEditor(props: MarkdownEditorProps) {
  const { value, label, disabled = false, variant = "default" } = props;
  const id = useId();
  const latest = useRef(props); latest.current = props;
  const editorRef = useRef<Editor | null>(null);
  const ledger = useRef<MarkdownSourceLedger | null>(null);
  const applied = useRef<string | null>(null);
  const revisionSources = useRef(new Map<number, { source: string; doc: import("@tiptap/pm/model").Node }>());
  const sourceRevision = useRef(0);
  const [source, setSource] = useState(false);
  const [island, setIsland] = useState<Island | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const reading = useRef(false), alive = useRef(true), fileInput = useRef<HTMLInputElement>(null);
  const sourceRange = useRef<{ from: number; to: number; inputType?: string } | undefined>(undefined);
  const handlers = useRef({ openBlock: (_position?: number) => {}, openNode: (_kind: AttributeKind, _position: number) => {} });

  const extensions = useMemo(() => [
    ...createDocumentExtensions({ onEditNode: (kind, position) => handlers.current.openNode(kind, position) }),
    sourceRevisionExtension(), markdownTypingExtension(position => handlers.current.openNode("blockMath", position)), activeSourceExtension(position => handlers.current.openBlock(position)),
  ], []);

  function remember(revision: number, raw: string) {
    const history = revisionSources.current;
    history.set(revision, { source: raw, doc: editorRef.current!.state.doc });
    let bytes = 0;
    for (const item of history.values()) bytes += item.source.length * 2;
    for (const [key, item] of history) {
      if ((history.size <= 100 && bytes <= 32 * 1024 * 1024) || key === revision) break;
      history.delete(key); bytes -= item.source.length * 2;
    }
  }

  const editor = useEditor({
    extensions, content: "", contentType: "markdown", immediatelyRender: false, shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { class: "tiptap-document-content", role: "textbox", "aria-label": label, "aria-multiline": "true", "data-placeholder": "在这里写作，输入 Markdown 即时排版…" },
      handlePaste(view, event) {
        if (latest.current.disabled || reading.current) return true;
        if (event.clipboardData?.files?.length) return true;
        const text = event.clipboardData?.getData("text/plain");
        if (text === undefined) return true;
        event.preventDefault();
        if (view.state.selection.$from.parent.type.spec.code) view.dispatch(view.state.tr.insertText(text));
        else {
          const current = editorRef.current!;
          const content = parseDocument(current, text).content ?? [];
          current.commands.insertContent(content.length === 1 && content[0]!.type === "paragraph" ? content[0]!.content ?? [] : content);
        }
        return true;
      },
      handleDrop: () => true,
      handleKeyDown(_view, event) {
        if (event.isComposing || editorRef.current?.view.composing) return false;
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "m") {
          event.preventDefault(); handlers.current.openBlock(); return true;
        }
        return false;
      },
    },
    onUpdate({ editor: current, transaction, appendedTransactions }) {
      if (latest.current.disabled || !ledger.current) return;
      const transactions = [transaction, ...appendedTransactions];
      const exact = transactions.map(item => item.getMeta(RAW_SOURCE_META)).find(item => typeof item === "string") as string | undefined;
      const revision = Number(current.state.doc.attrs[SOURCE_REVISION] ?? 0);
      let next: string;
      if (exact !== undefined) { next = exact; ledger.current.commitSource(next, current.state.doc); }
      else if (transactions.some(isHistoryTransaction) && revisionSources.current.get(revision)?.doc.eq(current.state.doc)) {
        next = revisionSources.current.get(revision)!.source; ledger.current.commitSource(next, current.state.doc);
      } else {
        next = ledger.current.source;
        for (const item of transactions) if (item.docChanged) next = ledger.current.update(item);
      }
      remember(revision, next);
      applied.current = next;
      if (next !== latest.current.value) latest.current.onChange(next);
    },
  });
  editorRef.current = editor;

  useEffect(() => {
    if (!editor || applied.current === value) return;
    finishBlockSource(editor, false); setIsland(null); setPanel(null);
    editor.chain().setMeta("addToHistory", false).setContent(parseDocument(editor, value), { emitUpdate: false }).run();
    editor.view.updateState(EditorState.create({ doc: editor.state.doc, selection: editor.state.selection, plugins: editor.state.plugins }));
    revisionSources.current.clear(); sourceRevision.current = 0;
    const serialize = (doc: typeof editor.state.doc) => editor.markdown!.serialize(doc.toJSON());
    if (ledger.current) ledger.current.reset(value, editor.state.doc);
    else ledger.current = new MarkdownSourceLedger(value, editor.state.doc, serialize, createSourceSegments(editor));
    applied.current = value;
    remember(Number(editor.state.doc.attrs[SOURCE_REVISION] ?? 0), value);
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled && !pending && !panel && !island && !source, false);
    editor?.setOptions({ editorProps: { attributes: { class: "tiptap-document-content", role: "textbox", "aria-label": label, "aria-multiline": "true", "aria-disabled": String(disabled || pending), "data-placeholder": "在这里写作，输入 Markdown 即时排版…" } } });
  }, [editor, disabled, pending, panel, island, source, label]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (reading.current) latest.current.onPendingChange?.(false); };
  }, []);

  useEffect(() => {
    if (!editor) return;
    const root = editor.view.dom.closest(".markdown-editor")!;
    const jump = (event: Event) => {
      const line = Number((event as CustomEvent<{ line: number }>).detail?.line);
      if (!Number.isSafeInteger(line) || line < 0) return;
      const lines = latest.current.value.split(/\r\n|\r|\n/);
      const title = (lines[line] ?? "").replace(/^\s*#{1,6}\s+/, "").trim();
      let position: number | undefined;
      editor.state.doc.descendants((node, pos) => { if (position === undefined && node.type.name === "heading" && node.textContent === title) position = pos; });
      if (position === undefined) return;
      const element = editor.view.nodeDOM(position) as HTMLElement | null;
      element?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(position + 1))));
      editor.view.focus();
    };
    root.addEventListener("live-markdown-jump", jump);
    return () => root.removeEventListener("live-markdown-jump", jump);
  }, [editor]);

  function openBlock(position?: number) {
    if (!editor || disabled || pending || source) return;
    if (island) { finishBlockSource(editor); setIsland(null); return; }
    const session = beginBlockSource(editor, position);
    if (session) {
      const block = ledger.current?.blockSource(session.from);
      if (!block) { finishBlockSource(editor, false); setError("当前段落的原文位置已变化，请重新打开块语法。"); return; }
      setPanel(null); setIsland({ ...session, markdown: block.markdown, prefix: ledger.current!.source.slice(0, block.from), suffix: ledger.current!.source.slice(block.to) }); setError("");
    }
  }
  function openAttribute(kind: AttributeKind, position?: number) {
    if (!editor || disabled || pending || source) return;
    const node = position === undefined ? undefined : editor.state.doc.nodeAt(position);
    if (island) { finishBlockSource(editor, false); setIsland(null); }
    const value = kind === "link" ? String(editor.getAttributes("link").href || "") : kind === "image" ? String(node?.attrs.src || "") : kind === "code" ? String(editor.getAttributes("codeBlock").language || "") : String(node?.attrs.latex || "");
    setPanel({ kind, value, alt: String(node?.attrs.alt || ""), position, from: editor.state.selection.from, to: editor.state.selection.to });
    setError("");
  }
  handlers.current = { openBlock, openNode: openAttribute };

  function applySource(next: string) {
    if (!editor) return;
    const doc = editor.schema.nodeFromJSON(parseDocument(editor, next));
    sourceRevision.current = Math.max(sourceRevision.current, Number(editor.state.doc.attrs[SOURCE_REVISION] ?? 0)) + 1;
    const transaction = editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content).setDocAttribute(SOURCE_REVISION, sourceRevision.current).setMeta(RAW_SOURCE_META, next);
    editor.view.dispatch(transaction);
  }
  function applyBlock(markdown: string) {
    if (!editor || !island) return;
    setIsland({ ...island, markdown });
    sourceRevision.current = Math.max(sourceRevision.current, Number(editor.state.doc.attrs[SOURCE_REVISION] ?? 0)) + 1;
    updateBlockSource(editor, island.id, markdown, { value: island.prefix + markdown + island.suffix, revision: sourceRevision.current });
  }
  function changeSource(next: string) {
    if (!disabled && !pending) applySource(next);
  }
  function toggleSource() {
    if (editor) editor.view.dispatch(closeHistory(editor.state.tr));
    if (island && editor) { finishBlockSource(editor, false); setIsland(null); }
    setPanel(null); setSource(!source); setError("");
  }

  function applyAttribute() {
    if (!editor || !panel || disabled || pending) return;
    try {
      const text = panel.value.trim();
      if (panel.kind === "link") {
        if (text && !/^(https?:\/\/|mailto:|#)/i.test(text)) throw new Error("链接使用 https、http、mailto 或文档锚点地址。");
        const chain = editor.chain().setTextSelection({ from: panel.from, to: panel.to }).extendMarkRange("link");
        if (text) chain.setLink({ href: text }).run(); else chain.unsetLink().run();
      } else if (panel.kind === "image") {
        if (!/^https:\/\//i.test(text) && !/^data:image\/(png|jpeg|gif|webp);base64,[a-z\d+/]+=*$/i.test(text)) throw new Error("图片使用 HTTPS 地址，或已解码的 PNG、JPEG、GIF、WebP 本机图片。");
        if (panel.position !== undefined) editor.chain().setNodeSelection(panel.position).updateAttributes("image", { src: text, alt: panel.alt }).run();
        else editor.chain().setTextSelection({ from: panel.from, to: panel.to }).setImage({ src: text, alt: panel.alt }).run();
      } else if (panel.kind === "code") editor.commands.updateAttributes("codeBlock", { language: text || null });
      else {
        if (!text) throw new Error("请输入 LaTeX 公式。");
        if (panel.kind === "inlineMath") {
          if (panel.position === undefined) editor.chain().setTextSelection({ from: panel.from, to: panel.to }).insertInlineMath({ latex: text }).run();
          else editor.commands.updateInlineMath({ pos: panel.position, latex: text });
        } else if (panel.position === undefined) editor.chain().setTextSelection({ from: panel.from, to: panel.to }).insertBlockMath({ latex: text }).run();
        else editor.commands.updateBlockMath({ pos: panel.position, latex: text });
      }
      setPanel(null); setError(""); editor.view.focus();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "修改未应用，请重试。"); }
  }

  async function insertImageFiles(files: File[]) {
    if (!editor || disabled || reading.current || !files.length) return;
    const reader = latest.current.imageFileReader;
    if (!reader) { setError("此处可通过“插入 → 图片地址”加入图片。"); return; }
    const range = { from: editor.state.selection.from, to: editor.state.selection.to };
    const original = latest.current.value;
    const area = source ? editor.view.dom.closest(".markdown-editor")?.querySelector<HTMLTextAreaElement>(":scope > textarea") : island?.container.querySelector<HTMLTextAreaElement>("textarea");
    const textTarget = area ? { area, from: area.selectionStart, to: area.selectionEnd, markdown: source ? original : island!.markdown, block: !!island && !source } : null;
    reading.current = true; setPending(true); latest.current.onPendingChange?.(true); setError("");
    try {
      const images: string[] = [];
      for (const file of files) {
        const src = await reader(file);
        images.push(src);
        if (latest.current.maxBytes && new TextEncoder().encode(latest.current.value + images.map(image => `\n\n![图片](${image})\n\n`).join("")).length > latest.current.maxBytes) throw new Error("备注含图片不能超过 8 MiB，请减少图片。");
      }
      if (!alive.current || editor.isDestroyed || latest.current.disabled) return;
      if (latest.current.value !== original) { setError("正文已更新，请在新的位置重新插入图片。"); return; }
      if (textTarget) {
        const shown = textTarget.markdown.replace(/\r\n?/g, "\n");
        const inserted = images.map(src => `![图片](${src})`).join("\n\n");
        const next = textareaMarkdownEdit(textTarget.markdown, shown.slice(0, textTarget.from) + inserted + shown.slice(textTarget.to), { from: textTarget.from, to: textTarget.to, inputType: "insertFromPaste" });
        if (textTarget.block) applyBlock(next); else applySource(next);
        textTarget.area.ownerDocument.defaultView?.requestAnimationFrame(() => {
          if (!alive.current || !textTarget.area.isConnected) return;
          textTarget.area.focus(); textTarget.area.setSelectionRange(textTarget.from + inserted.length, textTarget.from + inserted.length);
        });
      } else {
        editor.commands.insertContentAt(range, images.map(src => ({ type: "image", attrs: { src, alt: "图片" } })));
        if (!editor.view.dom.closest("[hidden]")) editor.view.focus();
      }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "图片读取失败，请重试。"); }
    finally { reading.current = false; if (alive.current) { setPending(false); latest.current.onPendingChange?.(false); } }
  }
  function pasteCapture(event: ClipboardEvent<HTMLDivElement>) {
    const listed = Array.from(event.clipboardData.files ?? []);
    const files = listed.length ? listed : Array.from(event.clipboardData.items ?? []).filter(item => item.kind === "file").map(item => item.getAsFile()).filter((file): file is File => !!file);
    if (!files.length) return;
    event.preventDefault(); event.stopPropagation(); void insertImageFiles(files);
  }

  return <div className="markdown-editor tiptap-document-editor" data-editor-engine="tiptap" data-variant={variant} aria-busy={!editor || pending} onPasteCapture={pasteCapture}>
    <DocumentToolbar editor={editor} disabled={disabled || pending || !!panel} source={source} blockSource={!!island} onSource={toggleSource} onBlockSource={() => openBlock()} onAttribute={openAttribute} onImageFile={props.imageFileReader ? () => fileInput.current?.click() : undefined} />
    {panel && <div className="tiptap-attribute-panel" role="group" aria-label={panel.kind === "image" ? "图片属性" : panel.kind.includes("Math") ? "公式编辑" : panel.kind === "link" ? "链接编辑" : "代码语言"}>
      <label htmlFor={`${id}-attribute`}>{panel.kind === "image" ? "图片地址" : panel.kind === "link" ? "链接地址" : panel.kind === "code" ? "语言" : "LaTeX"}</label>
      <input autoFocus id={`${id}-attribute`} value={panel.value} disabled={disabled} onChange={event => setPanel({ ...panel, value: event.target.value })} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); applyAttribute(); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPanel(null); editor?.view.focus(); } }} />
      {panel.kind === "image" && <input aria-label="图片说明" value={panel.alt} disabled={disabled} onChange={event => setPanel({ ...panel, alt: event.target.value })} />}
      <button type="button" disabled={disabled} onClick={applyAttribute}>应用</button><button type="button" onClick={() => { setPanel(null); editor?.view.focus(); }}>取消</button>
    </div>}
    {source && <><label className="markdown-editor-label" htmlFor={`${id}-source`}>{label}</label><textarea id={`${id}-source`} aria-label={label} value={value.replace(/\r\n|\r/g, "\n")} disabled={disabled || pending} spellCheck={false}
      onBeforeInput={event => { sourceRange.current = { from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd, inputType: (event.nativeEvent as InputEvent).inputType }; }}
      onKeyDown={event => { sourceRange.current = { from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd }; }}
      onPaste={event => { sourceRange.current = { from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd, inputType: "insertFromPaste" }; }}
      onCut={event => { sourceRange.current = { from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd, inputType: "deleteByCut" }; }}
      onChange={event => { changeSource(textareaMarkdownEdit(latest.current.value, event.target.value, sourceRange.current)); sourceRange.current = undefined; }} /></>}
    <div hidden={source}><EditorContent editor={editor} /></div>
    {island && createPortal(<div className="tiptap-block-source-field"><label htmlFor={`${id}-block`}>当前块 Markdown</label><textarea id={`${id}-block`} aria-label="当前块 Markdown" autoFocus spellCheck={false} value={island.markdown} disabled={disabled || pending} rows={Math.max(2, Math.min(20, island.markdown.split("\n").length + 1))}
      onChange={event => {
        if (!editor || disabled || pending) return;
        const markdown = textareaMarkdownEdit(island.markdown, event.target.value, sourceRange.current); sourceRange.current = undefined;
        applyBlock(markdown);
      }}
      onBeforeInput={event => { sourceRange.current = { from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd, inputType: (event.nativeEvent as InputEvent).inputType }; }}
      onKeyDown={event => { sourceRange.current = { from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd }; if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (editor) finishBlockSource(editor); setIsland(null); } }} /><button type="button" disabled={disabled || pending} onClick={() => { if (editor) finishBlockSource(editor); setIsland(null); }}>完成当前块</button></div>, island.container)}
    {props.imageFileReader && <input ref={fileInput} className="tiptap-file-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={event => { void insertImageFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />}
    {pending && <p className="field-hint" role="status">正在读取图片…</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
  </div>;
}
