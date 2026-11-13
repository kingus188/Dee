import { Component, lazy, memo, Suspense, useEffect, useMemo, useRef, useState, useId, useSyncExternalStore, type ReactNode } from "react";
import { readerSelection } from "./code-reader-selection.js";
import hljs from "highlight.js/lib/common";
import { escapeHtml } from "../ui/format.js";
import { showToast } from "../ui/toast.js";

const CodeReader = lazy(() => import("./CodeReader.js"));
class ReaderBoundary extends Component<{ children: ReactNode; onClose: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div role="alert">Code reader unavailable. <button type="button" onClick={this.props.onClose}>Close</button></div> : this.props.children; }
}

export const CodeBlock = memo(function CodeBlock({ source, language, streaming = false }: { source: string; language: string; streaming?: boolean }) {
  const id = useId();
  const expanded = useSyncExternalStore(readerSelection.subscribe, readerSelection.get, () => null) === id;
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => () => readerSelection.close(id), [id]);
  const [highlightSource, setHighlightSource] = useState(source);
  const latest = useRef(source);
  latest.current = source;
  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => setHighlightSource(latest.current), 100);
    return () => clearInterval(timer);
  }, [streaming]);
  useEffect(() => { if (!streaming) setHighlightSource(source); }, [source, streaming]);
  const html = useMemo(() => {
    // Bound preview work; the reader virtualizes the complete source on demand.
    const preview = highlightSource.split("\n").slice(0, 300).join("\n");
    if (preview.length > 100_000 || !hljs.getLanguage(language)) return escapeHtml(preview);
    return hljs.highlight(preview, { language, ignoreIllegals: true }).value;
  }, [highlightSource, language]);
  async function copy() {
    try { await navigator.clipboard.writeText(source); setCopied(source); }
    catch { showToast("Unable to copy. Select the code and copy it manually.", "error"); }
  }
  const renderedLines = useMemo(() => highlightedLines(html), [html]);
  const lines = renderedLines.length;
  return <section className="code-card" aria-label={`${language} code`}>
    <header className="code-card-toolbar"><span className="code-language">{language}</span><div>
      <button type="button" onClick={() => void copy()} aria-label="Copy code">{copied === source ? "Copied" : "Copy"}</button>
      <button type="button" onClick={() => readerSelection.open(id)} aria-label="Expand code">Expand</button>
    </div></header>
    <div className="code-card-scroll" tabIndex={0} role="region" aria-label="Code preview">
      <div className="code-line-numbers" aria-hidden="true">{Array.from({ length: lines }, (_, i) => <span key={i}>{i + 1}</span>)}</div>
      <pre><code>{renderedLines.map((line, index) => <CodeLine key={index} html={line} newline={index < lines - 1} />)}</code></pre>
    </div>
    {source.split("\n").length > 300 && <button className="code-show-all" type="button" onClick={() => readerSelection.open(id)}>Show all {source.split("\n").length} lines</button>}
    {expanded && <ReaderBoundary onClose={() => readerSelection.close(id)}><Suspense fallback={<div role="status">Loading code reader… <button type="button" onClick={() => readerSelection.close(id)}>Cancel</button></div>}><CodeReader source={source} language={language} onClose={() => readerSelection.close(id)} /></Suspense></ReaderBoundary>}
  </section>;
});

const CodeLine = memo(function CodeLine({ html, newline }: { html: string; newline: boolean }) {
  return <span className="code-source-line"><span dangerouslySetInnerHTML={{ __html: html }} />{newline ? "\n" : ""}</span>;
});

// highlight.js emits nested spans across newlines. Balance each line to keep
// unchanged lines mounted without losing multi-line grammar context.
function highlightedLines(html: string): string[] {
  const open: string[] = [];
  return html.split("\n").map(line => {
    const prefix = open.join("");
    for (const match of line.matchAll(/<span\b[^>]*>|<\/span>/g)) {
      if (match[0] === "</span>") open.pop(); else open.push(match[0]);
    }
    return prefix + line + "</span>".repeat(open.length);
  });
}
