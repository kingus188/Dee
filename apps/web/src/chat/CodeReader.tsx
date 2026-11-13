import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldAll, unfoldAll } from "@codemirror/language";
import { createCodeReader, readerLanguage, updateReaderSource } from "./code-reader-editor.js";

export interface CodeReaderProps { source: string; language: string; onClose: () => void }

export default function CodeReader({ source, language, onClose }: CodeReaderProps) {
  const root = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null), search = useRef<HTMLInputElement>(null);
  const editor = useRef<EditorView | null>(null), wrap = useRef(new Compartment()), syntax = useRef(new Compartment());
  const latest = useRef({ source, language, onClose }); latest.current = { source, language, onClose };
  const [wrapped, setWrapped] = useState(false), [query, setQuery] = useState(""), [match, setMatch] = useState("");

  useLayoutEffect(() => {
    const view = createCodeReader(root.current!, latest.current.source, latest.current.language, wrap.current, syntax.current, () => search.current?.focus());
    editor.current = view;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const host = panel.current!.parentElement!;
    const background = [...document.body.children].filter(node => node !== host && node instanceof HTMLElement) as HTMLElement[];
    const priorInert = background.map(node => node.inert);
    background.forEach(node => { node.inert = true; });
    panel.current!.querySelector<HTMLButtonElement>('[aria-label="Close code reader"]')?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); latest.current.onClose(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); search.current?.focus(); return; }
      if (event.key !== "Tab") return;
      const controls = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]')].filter(node => !node.hidden);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      background.forEach((node, index) => { node.inert = priorInert[index]; });
      view.destroy(); editor.current = null;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => { if (editor.current) updateReaderSource(editor.current, source); }, [source]);
  useEffect(() => { editor.current?.dispatch({ effects: syntax.current.reconfigure(readerLanguage(language)) }); }, [language]);
  useEffect(() => { editor.current?.dispatch({ effects: wrap.current.reconfigure(wrapped ? EditorView.lineWrapping : []) }); }, [wrapped]);
  useEffect(() => { setMatch(""); }, [query, source]);

  function find(backward = false) {
    const view = editor.current;
    if (!view || !query) return;
    const text = view.state.doc.toString(), selected = view.state.selection.main;
    let index = backward ? (selected.from > 0 ? text.lastIndexOf(query, selected.from - 1) : -1) : text.indexOf(query, selected.to);
    if (index < 0) index = backward ? text.lastIndexOf(query) : text.indexOf(query);
    if (index < 0) { setMatch("No matches"); return; }
    view.dispatch({ selection: { anchor: index, head: index + query.length }, scrollIntoView: true });
    setMatch(`Line ${view.state.doc.lineAt(index).number}`);
  }

  return createPortal(<div className="code-reader-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <aside ref={panel} className="code-reader" role="dialog" aria-modal="true" aria-label="Code reader">
      <header className="code-reader-header"><strong>{language || "Plain text"}</strong><span className="code-reader-readonly">Read only</span><button type="button" onClick={onClose} aria-label="Close code reader">Close</button></header>
      <div className="code-reader-tools"><form role="search" onSubmit={event => { event.preventDefault(); find(); }}><input ref={search} aria-label="Find in code" placeholder="Find" value={query} onChange={event => setQuery(event.target.value)} /><button type="button" disabled={!query} onClick={() => find(true)} aria-label="Previous match">↑</button><button type="submit" disabled={!query} aria-label="Next match">↓</button></form>
        <button type="button" aria-pressed={wrapped} onClick={() => setWrapped(value => !value)}>Wrap</button>
        <button type="button" title="Fold indented blocks" onClick={() => { if (editor.current) foldAll(editor.current); }}>Fold</button>
        <button type="button" onClick={() => { if (editor.current) unfoldAll(editor.current); }}>Unfold</button>
      </div>
      <span className="code-reader-match" role="status">{match}</span><div className="code-reader-editor" ref={root} />
    </aside>
  </div>, document.body);
}
