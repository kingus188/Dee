import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { MarkdownDocument, RichEditor } from "./kernel.js";
import { textareaMarkdownEdit, type MarkdownInputRange } from "../live-markdown-source-input.js";
import type { MarkdownEditorProps } from "../tiptap/types.js";
import { LaneToolbar, type InsertKind } from "./LaneToolbar.js";
import { LaneInsertPanel } from "./LaneInsertPanel.js";
import { reconcileRichMarkdown } from "./raw-markdown.js";
import { LaneSourceEditor } from "./LaneSourceEditor.js";
import type { SelectionBookmark } from "./kernel.js";

const normalized = (text: string) => text.replace(/\r\n?/g, "\n");
const options = (readOnly: boolean) => ({ spellcheck: false, tabSize: 2, typewriter: false, emoji: true, readOnly });

export function LaneMarkdownEditor(props: MarkdownEditorProps) {
  const id = useId(), latest = useRef(props); latest.current = props;
  const root = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const instance = useRef<{ model: MarkdownDocument; rich: RichEditor } | null>(null);
  const raw = useRef(props.value), applied = useRef(props.value), history = useRef(new Map<string, string>());
  const sourceMode = useRef(false), reading = useRef(false), alive = useRef(false);
  const focusAfterToggle = useRef(false);
  const sourceView = useRef<EditorView | null>(null);
  const deferredExternal = useRef(false), sourceComposing = useRef(false);
  const [sourceValue, setSourceValue] = useState(props.value);
  const [source, setSource] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState("");
  const [compositionRevision, setCompositionRevision] = useState(0);
  const [insert, setInsert] = useState<{ kind: InsertKind; anchor: number; head: number; before: string; selected: string } | null>(null);

  function remember(text: string, markdown: string) {
    history.current.set(text, markdown);
    let bytes = 0;
    for (const [key, value] of [...history.current].reverse()) {
      bytes += (key.length + value.length) * 2;
      if ((history.current.size > 100 || bytes > 32 * 1024 * 1024) && key !== text) history.current.delete(key);
    }
  }
  function publish() {
    const current = instance.current;
    if (!current || latest.current.disabled || reading.current || deferredExternal.current || current.rich.composing) return;
    const next = history.current.get(current.model.text) ?? reconcileRichMarkdown(raw.current, current.model.text);
    remember(current.model.text, next);
    raw.current = next; applied.current = next;
    if (sourceMode.current) setSourceValue(next);
    if (next !== latest.current.value) latest.current.onChange(next);
  }
  useLayoutEffect(() => {
    alive.current = true;
    const model = new MarkdownDocument(normalized(latest.current.value));
    raw.current = latest.current.value; applied.current = latest.current.value;
    remember(model.text, raw.current);
    const rich = new RichEditor(root.current!, model, id, {
      change: publish, cursor: () => {}, image: file => { void insertImages([file]); },
      link: url => {
        if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
        else if (/^mailto:/i.test(url)) window.location.href = url;
      },
      error: setError,
      compositionFinished: () => setCompositionRevision(revision => revision + 1),
    });
    instance.current = { model, rich };
    rich.setOptions(options(!!latest.current.disabled));
    root.current!.setAttribute("aria-label", latest.current.label);
    const jump = (event: Event) => {
      const line = (event as CustomEvent<{ line: number }>).detail?.line;
      if (!Number.isSafeInteger(line) || line < 0) return;
      if (sourceMode.current) { model.endSourceSession(); sourceMode.current = false; setSource(false); }
      rich.jump(line + 1);
    };
    container.current!.addEventListener("live-markdown-jump", jump);
    const element = container.current!;
    return () => {
      alive.current = false;
      element.removeEventListener("live-markdown-jump", jump);
      rich.destroy(); root.current?.replaceChildren(); instance.current = null;
      if (reading.current) latest.current.onPendingChange?.(false);
    };
  }, []);
  useLayoutEffect(() => {
    const current = instance.current;
    if (!current || applied.current === props.value) { deferredExternal.current = false; return; }
    if (current.rich.composing || sourceComposing.current) { deferredExternal.current = true; return; }
    deferredExternal.current = false;
    current.rich.releaseFence();
    current.model.replaceExternal(normalized(props.value));
    if (sourceMode.current) current.model.beginSourceSession();
    raw.current = props.value; applied.current = props.value; setSourceValue(props.value);
    history.current.clear(); remember(current.model.text, props.value);
    current.rich.render(false);
  }, [props.value, compositionRevision]);
  useEffect(() => {
    instance.current?.rich.setOptions(options(!!props.disabled || pending || source));
    root.current?.setAttribute("aria-label", props.label);
    if (focusAfterToggle.current) {
      focusAfterToggle.current = false;
      if (source) sourceView.current?.focus();
      else instance.current?.rich.restore();
    }
  }, [props.disabled, props.label, pending, source]);

  function toggleSource() {
    const current = instance.current;
    if (!current || latest.current.disabled || reading.current || current.rich.composing || sourceComposing.current || sourceView.current?.composing) return;
    if (sourceMode.current) { current.model.endSourceSession(); current.rich.render(false); }
    else { current.model.selection = current.rich.bookmark(); current.rich.releaseFence(); current.model.beginSourceSession(); setSourceValue(raw.current); }
    focusAfterToggle.current = true;
    sourceMode.current = !sourceMode.current; setSource(sourceMode.current); setError("");
  }
  function changeSource(value: string, range?: MarkdownInputRange, selection?: SelectionBookmark) {
    if (latest.current.disabled || reading.current || !instance.current) return;
    setSourceValue(value);
    if (sourceComposing.current || deferredExternal.current) return;
    const next = textareaMarkdownEdit(raw.current, value, range);
    const model = instance.current.model;
    model.replace(0, model.text.length, normalized(next), "source", selection);
    remember(model.text, next); raw.current = next; applied.current = next;
    if (next !== latest.current.value) latest.current.onChange(next);
  }
  function sourceHistory(redo: boolean) {
    const current = instance.current;
    if (!current || latest.current.disabled || reading.current || sourceComposing.current || sourceView.current?.composing) return false;
    if (redo ? current.model.redo() : current.model.undo()) publish();
    return true;
  }
  function command(action: string, args?: Record<string, unknown>) {
    if (latest.current.disabled || reading.current || sourceMode.current || instance.current?.rich.composing) return;
    setError("");
    if (action === "undo") instance.current?.rich.undo();
    else if (action === "redo") instance.current?.rich.redo();
    else {
      const markers: Record<string, string> = { bold: "**", italic: "*", strike: "~~", "inline-code": "`" };
      if (markers[action]) instance.current?.rich.wrap(markers[action], markers[action]);
      else if (action === "code") instance.current?.rich.codeBlock();
      else instance.current?.rich.command(action, args);
    }
  }
  function openInsert(kind: InsertKind) {
    const current = instance.current;
    if (!current || latest.current.disabled || reading.current || sourceMode.current || current.rich.composing) return;
    const selection = current.rich.bookmark();
    setInsert({ kind, ...selection, before: current.model.text, selected: current.model.text.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head)) });
  }
  function applyInsert(markdown: string) {
    const current = instance.current;
    if (!current || !insert || latest.current.disabled || reading.current || sourceMode.current || current.rich.composing) return;
    if (insert.before !== current.model.text) { setError("正文已变化，请重新选择插入位置。"); setInsert(null); return; }
    const from = Math.min(insert.anchor, insert.head), to = Math.max(insert.anchor, insert.head);
    const next = textareaMarkdownEdit(raw.current, current.model.text.slice(0, from) + markdown + current.model.text.slice(to));
    if (latest.current.maxBytes !== undefined && new TextEncoder().encode(next).byteLength > latest.current.maxBytes) { setError("插入后正文超过大小限制。"); return; }
    current.rich.releaseFence();
    current.model.replace(from, to, markdown, "insert", { anchor: from + markdown.length, head: from + markdown.length });
    current.rich.render(); publish(); setInsert(null);
  }
  async function insertImages(files: File[]) {
    const current = instance.current, reader = latest.current.imageFileReader;
    if (!current || latest.current.disabled || reading.current || !files.length) return;
    if (!reader) { setError("此处可通过图片地址加入图片。"); return; }
    if (current.rich.composing || sourceComposing.current) { setError("请先完成当前输入法组合输入。"); return; }
    const before = raw.current, beforeModel = current.model.text, selection = { ...current.rich.bookmark() }, mode = sourceMode.current;
    const range = sourceView.current?.state.selection.main;
    reading.current = true; setPending(true); latest.current.onPendingChange?.(true);
    current.rich.setOptions(options(true)); setError("");
    try {
      const urls: string[] = [];
      for (const file of files) {
        const url = await reader(file);
        if (!/^data:image\/(png|jpeg|gif|webp);base64,[a-z\d+/]+=*$/i.test(url) && !/^https:\/\/[^\s<>"()]+$/i.test(url)) throw new Error("图片地址无效，请选择 PNG、JPEG、GIF 或 WebP 图片。");
        urls.push(`![${file.name.replace(/[\[\]\\\r\n]/g, "_")}](${url})`);
      }
      if (!alive.current || instance.current !== current) return;
      if (latest.current.disabled || latest.current.value !== before || raw.current !== before || current.model.text !== beforeModel || sourceMode.current !== mode) throw new Error("正文已变化，图片未插入，请重试。");
      const markdown = urls.join("\n");
      const from = range?.from ?? Math.min(selection.anchor, selection.head), to = range?.to ?? Math.max(selection.anchor, selection.head);
      const next = current.model.text.slice(0, from) + markdown + current.model.text.slice(to);
      const exact = textareaMarkdownEdit(before, next);
      if (latest.current.maxBytes !== undefined && new TextEncoder().encode(exact).byteLength > latest.current.maxBytes) throw new Error("插入图片后正文超过大小限制。");
      reading.current = false;
      current.rich.releaseFence();
      current.model.replace(from, to, markdown, "image", { anchor: from + markdown.length, head: from + markdown.length });
      if (!mode) current.rich.render();
      publish();
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "图片读取失败，请重试。");
    } finally {
      reading.current = false;
      if (alive.current) { setPending(false); current.rich.setOptions(options(!!latest.current.disabled || sourceMode.current)); latest.current.onPendingChange?.(false); }
    }
  }
  const blocked = !!props.disabled || pending;
  return <div ref={container} className="markdown-editor lane-editor" data-editor-engine="open-markdown-lane" data-variant={props.variant ?? "default"}
    onKeyDownCapture={event => {
      if (blocked || event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.altKey || event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey) || event.key !== "/") return;
      if (!(event.target as HTMLElement).closest(".lane-document-content, .lane-source")) return;
      event.preventDefault(); event.stopPropagation(); toggleSource();
    }}
    onPasteCapture={event => {
      if (!sourceMode.current && /<table(?:\s|>)/i.test(event.clipboardData.getData("text/html"))) return;
      const files = Array.from(event.clipboardData.files ?? []).filter(file => file.type.startsWith("image/"));
      if (!files.length) for (const item of Array.from(event.clipboardData.items ?? [])) {
        if (item.kind === "file" && item.type.startsWith("image/")) { const file = item.getAsFile(); if (file) files.push(file); }
      }
      if (files.length) { event.preventDefault(); event.stopPropagation(); void insertImages(files); }
    }} onDropCapture={event => {
      if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); void insertImages(Array.from(event.dataTransfer.files)); }
    }}>
    <LaneToolbar blocked={blocked} source={source} imageFiles={!!props.imageFileReader} command={command} insert={openInsert} imageFile={() => fileInput.current?.click()} toggleSource={toggleSource} />
    {insert && <LaneInsertPanel key={insert.kind} kind={insert.kind} selected={insert.selected} disabled={blocked || source} apply={applyInsert} cancel={() => setInsert(null)} />}
    <div className="lane-scroller" hidden={source}><div ref={root} className="rich-document lane-document-content" /></div>
    {source && instance.current && <LaneSourceEditor value={sourceValue} label={`${props.label} Markdown 源码`} disabled={blocked}
      model={instance.current.model} viewRef={sourceView} onChange={changeSource} onHistory={sourceHistory}
      onCompositionStart={() => { sourceComposing.current = true; }}
      onCompositionEnd={value => {
        sourceComposing.current = false;
        changeSource(value, undefined, sourceView.current?.state.selection.main);
        setCompositionRevision(revision => revision + 1);
      }} />}
    <input ref={fileInput} type="file" hidden multiple accept="image/png,image/jpeg,image/gif,image/webp" onChange={event => { void insertImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
