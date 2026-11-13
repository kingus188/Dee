import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, bracketMatching, codeFolding, defaultHighlightStyle, foldGutter, foldKeymap, foldService, syntaxHighlighting } from "@codemirror/language";
import { javascript, typescript, json } from "@codemirror/legacy-modes/mode/javascript";
import { python } from "@codemirror/legacy-modes/mode/python";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { css } from "@codemirror/legacy-modes/mode/css";

export function readerLanguage(name: string): Extension {
  const normalized = name.toLowerCase();
  if (["javascript", "js", "jsx"].includes(normalized)) return StreamLanguage.define(javascript);
  if (["typescript", "ts", "tsx"].includes(normalized)) return StreamLanguage.define(typescript);
  if (normalized === "json") return StreamLanguage.define(json);
  if (["python", "py"].includes(normalized)) return StreamLanguage.define(python);
  if (["sh", "bash", "shell", "zsh"].includes(normalized)) return StreamLanguage.define(shell);
  if (["css", "scss", "less"].includes(normalized)) return StreamLanguage.define(css);
  return [];
}

// A language-independent indentation fold is useful for streamed/incomplete snippets too.
export function indentationFold(state: EditorState, start: number, end: number) {
  const first = state.doc.lineAt(start);
  if (!first.text.trim()) return null;
  const indentation = (text: string) => text.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
  const base = indentation(first.text);
  let to = end;
  for (let number = first.number + 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    if (line.text.trim() && indentation(line.text) <= base) break;
    if (line.text.trim()) to = line.to;
  }
  return to > end ? { from: end, to } : null;
}

// Reuse CodeMirror's semantic tag definitions with the app's theme-aware palette.
const palette: Record<string, string> = { "#708": "var(--purple)", "#219": "var(--primary)", "#164": "var(--success)", "#a11": "var(--success)", "#e40": "var(--warning-text)", "#00f": "var(--primary)", "#940": "var(--warning-text)", "#30a": "var(--purple)", "#000": "var(--text-main)", "#00c": "var(--primary)", "#d11": "var(--danger)" };
const readerHighlightStyle = HighlightStyle.define(defaultHighlightStyle.specs.map(spec => ({ ...spec, ...(typeof spec.color === "string" ? { color: palette[spec.color] ?? "var(--text-muted)" } : {}) })));

export function createCodeReader(parent: HTMLElement, source: string, language: string, wrap: Compartment, syntax: Compartment, find: () => void) {
  return new EditorView({ parent, state: EditorState.create({ doc: source, extensions: [
    EditorState.readOnly.of(true), EditorView.editable.of(false),
    EditorView.contentAttributes.of({ "aria-label": "Read-only code", tabindex: "0" }),
    lineNumbers(), drawSelection(), bracketMatching(), codeFolding(), foldGutter(),
    foldService.of(indentationFold), syntax.of(readerLanguage(language)),
    syntaxHighlighting(readerHighlightStyle), wrap.of([]),
    keymap.of([{ key: "Mod-f", run: () => { find(); return true; } }, ...foldKeymap, ...defaultKeymap]),
  ] }) });
}

export function updateReaderSource(view: EditorView, source: string) {
  const previous = view.state.doc.toString();
  if (previous === source) return;
  let from = 0, oldEnd = previous.length, newEnd = source.length;
  while (from < oldEnd && from < newEnd && previous[from] === source[from]) from++;
  while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === source[newEnd - 1]) { oldEnd--; newEnd--; }
  const { scrollTop, scrollLeft } = view.scrollDOM;
  view.dispatch({ changes: { from, to: oldEnd, insert: source.slice(from, newEnd) } });
  view.scrollDOM.scrollTop = scrollTop; view.scrollDOM.scrollLeft = scrollLeft;
}
