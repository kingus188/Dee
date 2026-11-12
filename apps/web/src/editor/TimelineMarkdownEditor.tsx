import { useEffect, useRef, useState } from "react";
import { LaneMarkdownEditor } from "./lane/LaneMarkdownEditor.js";
import type { MarkdownEditorProps } from "./tiptap/types.js";
import { appendDocumentVersion, readDocumentTimeline, writeDocumentTimeline, type DocumentVersion } from "./document-timeline.js";

export function TimelineMarkdownEditor(props: MarkdownEditorProps & { documentId: string }) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const [versions, setVersions] = useState<DocumentVersion[]>([]), [error, setError] = useState("");
  const history = useRef<DocumentVersion[] | null>(null), readable = useRef(true);
  const [pending, setPending] = useState(false), [composing, setComposing] = useState(false);

  function record(markdown: string) {
    let entries = history.current;
    if (entries === null) {
      try { entries = readDocumentTimeline(props.documentId); }
      catch {
        readable.current = false;
        setError("无法读取本机时间线，原缓存未覆盖；当前编辑仍可继续。");
        entries = [];
      }
    }
    const next = appendDocumentVersion(entries, markdown);
    history.current = next;
    setVersions(next);
    if (readable.current && next !== entries) {
      try { writeDocumentTimeline(props.documentId, next); setError(""); }
      catch { setError("本机时间线写入失败，仅保留在当前页面；请先保存正文。"); }
    }
    return next;
  }
  function change(markdown: string) {
    // Preserve both sides, including the abandoned redo branch, before publishing.
    record(props.value);
    record(markdown);
    props.onChange(markdown);
  }
  useEffect(() => { record(props.value); }, [props.value]);
  const chosen = versions.find(version => version.id === selected);
  const blocked = props.disabled || pending || composing;
  const tooLarge = chosen && props.maxBytes !== undefined && new TextEncoder().encode(chosen.markdown).byteLength > props.maxBytes;
  return <div className="document-timeline-editor" onCompositionStartCapture={() => setComposing(true)} onCompositionEndCapture={() => setComposing(false)}>
    <LaneMarkdownEditor {...props} onChange={change} onPendingChange={value => { setPending(value); props.onPendingChange?.(value); }} />
    <details className="document-timeline" open={open} onToggle={event => {
      const next = event.currentTarget.open;
      setOpen(next);
      if (next) record(props.value);
    }}>
      <summary>文档时间线</summary>
      <p className="document-timeline-hint">仅此设备，保留最近 100 个版本（每篇最多 1 MB）；恢复后需手动保存。</p>
      <div className="document-timeline-content">
        <ol aria-label="文档历史版本">{[...versions].reverse().map(version => <li key={version.id}>
          <button type="button" aria-pressed={selected === version.id} onClick={() => setSelected(version.id)}>
            <time dateTime={new Date(version.createdAt).toISOString()}>{new Date(version.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>
            <span>{version.markdown.length} 字符</span>
          </button>
        </li>)}</ol>
        {chosen && <div className="document-timeline-preview">
          <pre aria-label="历史版本预览">{chosen.markdown || "（空文档）"}</pre>
          <button type="button" disabled={blocked || !!tooLarge || chosen.markdown === props.value} onClick={() => {
            if (blocked || tooLarge) return;
            change(chosen.markdown);
          }}>恢复到草稿</button>
          {tooLarge && <p role="alert">此版本超过当前文档大小限制，不能恢复。</p>}
        </div>}
      </div>
    </details>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
