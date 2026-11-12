import { useLayoutEffect, useRef, type RefObject } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap } from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import type { MarkdownInputRange } from "../live-markdown-source-input.js";
import type { MarkdownDocument, SelectionBookmark } from "./kernel.js";

interface Props {
  value: string;
  label: string;
  disabled: boolean;
  model: MarkdownDocument;
  viewRef: RefObject<EditorView | null>;
  onChange: (value: string, range?: MarkdownInputRange, selection?: SelectionBookmark) => void;
  onHistory: (redo: boolean) => boolean;
  onCompositionStart: () => void;
  onCompositionEnd: (value: string) => void;
}

export function LaneSourceEditor(props: Props) {
  const root = useRef<HTMLDivElement>(null), latest = useRef(props); latest.current = props;
  const behavior = useRef(new Compartment()), syncing = useRef(false), composing = useRef(false);
  const compositionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readOnly = (disabled: boolean) => [EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)];

  useLayoutEffect(() => {
    const view = new EditorView({
      parent: root.current!,
      state: EditorState.create({
        doc: latest.current.value.replace(/\r\n?/g, "\n"), selection: latest.current.model.selection,
        extensions: [
          behavior.current.of(readOnly(latest.current.disabled)),
          EditorState.tabSize.of(2), EditorState.lineSeparator.of("\n"),
          drawSelection(), highlightActiveLine(), EditorView.lineWrapping,
          keymap.of([
            { key: "Mod-z", run: () => latest.current.onHistory(false) },
            { key: "Mod-Shift-z", run: () => latest.current.onHistory(true) },
            { key: "Ctrl-y", run: () => latest.current.onHistory(true) },
            ...defaultKeymap, indentWithTab,
          ]),
          EditorView.contentAttributes.of({ "aria-label": latest.current.label, "aria-multiline": "true", spellcheck: "false" }),
          EditorView.updateListener.of(update => {
            if (syncing.current) return;
            const { anchor, head } = update.state.selection.main;
            if (update.docChanged) {
              let from = update.startState.doc.length, to = 0;
              update.changes.iterChangedRanges((start, end) => { from = Math.min(from, start); to = Math.max(to, end); });
              latest.current.onChange(update.state.doc.toString(), { from, to }, { anchor, head });
            } else if (update.selectionSet) latest.current.model.selection = { anchor, head };
          }),
          EditorView.domEventHandlers({
            compositionstart() {
              if (compositionTimer.current !== null) clearTimeout(compositionTimer.current);
              composing.current = true; latest.current.onCompositionStart();
              return false;
            },
            compositionend(_event, current) {
              compositionTimer.current = setTimeout(() => {
                compositionTimer.current = null; composing.current = false;
                latest.current.onCompositionEnd(current.state.doc.toString());
              }, 0);
              return false;
            },
          }),
        ],
      }),
    });
    props.viewRef.current = view;
    return () => {
      if (compositionTimer.current !== null) clearTimeout(compositionTimer.current);
      view.destroy(); props.viewRef.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const view = props.viewRef.current;
    if (!view) return;
    view.contentDOM.setAttribute("aria-label", props.label);
    view.dispatch({ effects: behavior.current.reconfigure(readOnly(props.disabled)) });
    const value = props.value.replace(/\r\n?/g, "\n");
    if (!composing.current && view.state.doc.toString() !== value) {
      syncing.current = true;
      try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: props.model.selection }); }
      finally { syncing.current = false; }
    }
  }, [props.value, props.disabled, props.label]);
  return <div ref={root} className="lane-source source-mode" />;
}
