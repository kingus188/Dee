import { parseDocument } from "./parse-document.js";
import { closeHistory } from "@tiptap/pm/history";
import { RAW_SOURCE_META, SOURCE_REVISION } from "./source-revision.js";
import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface BlockSourceSession { id: string; from: number; to: number; container: HTMLDivElement }
const key = new PluginKey<BlockSourceSession | null>("document-block-source");

export function beginBlockSource(editor: Editor, position = editor.state.selection.from) {
  const resolved = editor.state.doc.resolve(Math.min(position, editor.state.doc.content.size));
  const from = resolved.depth ? resolved.before(1) : Math.min(position, editor.state.doc.content.size - 1);
  const node = editor.state.doc.nodeAt(from);
  if (!node) return null;
  const container = editor.view.dom.ownerDocument.createElement("div");
  container.className = "tiptap-source-island";
  container.contentEditable = "false";
  const session: BlockSourceSession = { id: crypto.randomUUID(), from, to: from + node.nodeSize, container };
  const markdown = editor.markdown!.serialize({ type: "doc", content: [node.toJSON()] });
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta(key, session));
  return { ...session, markdown };
}

export function updateBlockSource(editor: Editor, id: string, markdown: string, exact: { value: string; revision: number }) {
  const session = key.getState(editor.state);
  if (!session || session.id !== id) return;
  const doc = editor.schema.nodeFromJSON(parseDocument(editor, markdown));
  const transaction = editor.state.tr.replaceWith(session.from, session.to, doc.content)
    .setDocAttribute(SOURCE_REVISION, exact.revision).setMeta(RAW_SOURCE_META, exact.value);
  transaction.setMeta(key, { ...session, to: session.from + doc.content.size });
  editor.view.dispatch(transaction);
}

export function finishBlockSource(editor: Editor, focus = true) {
  const session = key.getState(editor.state);
  if (!session) return;
  const transaction = editor.state.tr.setMeta(key, null);
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(Math.min(session.from + 1, transaction.doc.content.size))));
  editor.view.dispatch(transaction);
  if (focus) editor.view.focus();
}

function blockMarker(name: string, level?: number) {
  return name === "heading" ? "#".repeat(level ?? 1) : ({ bulletList: "−", orderedList: "1.", taskList: "☑", blockquote: ">", codeBlock: "```", table: "|", blockMath: "$$", image: "![]", frontmatter: "---", rawBlock: "<>" } as Record<string, string>)[name] ?? "¶";
}

export function activeSourceExtension(onOpen: (position: number) => void) {
  return Extension.create({
    name: "activeMarkdownSource",
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [new Plugin<BlockSourceSession | null>({
        key,
        state: {
          init: () => null,
          apply(transaction, session) {
            const next = transaction.getMeta(key) as BlockSourceSession | null | undefined;
            if (next !== undefined) return next;
            if (!session || !transaction.docChanged) return session;
            return { ...session, from: transaction.mapping.map(session.from, -1), to: transaction.mapping.map(session.to, 1) };
          },
        },
        props: {
          decorations(state) {
            const session = key.getState(state);
            const decorations: Decoration[] = [];
            if (session) {
              state.doc.nodesBetween(session.from, Math.min(session.to, state.doc.content.size), (node, position) => {
                if (position >= session.from && position + node.nodeSize <= session.to) decorations.push(Decoration.node(position, position + node.nodeSize, { class: "tiptap-source-hidden" }));
                return false;
              });
              decorations.push(Decoration.widget(session.from, session.container, { key: session.id, side: -1, ignoreSelection: true, stopEvent: () => true }));
            } else if (editor.isEditable && editor.isFocused && state.selection.$from.depth) {
              const from = state.selection.$from.before(1);
              const node = state.doc.nodeAt(from)!;
              decorations.push(Decoration.widget(from, view => {
                const button = view.dom.ownerDocument.createElement("button");
                button.type = "button";
                button.className = "tiptap-block-marker";
                button.textContent = blockMarker(node.type.name, node.attrs.level as number | undefined);
                button.title = "编辑当前块 Markdown";
                button.setAttribute("aria-label", "编辑当前块 Markdown");
                button.contentEditable = "false";
                button.addEventListener("mousedown", event => { event.preventDefault(); onOpen(from + 1); });
                return button;
              }, { key: `marker-${from}-${node.type.name}-${node.attrs.level}`, side: -1, ignoreSelection: true, stopEvent: () => true }));
              const cursor = state.selection.$from;
              const marks = cursor.marks().filter(mark => ["bold", "italic", "strike", "code", "link"].includes(mark.type.name));
              if (marks.length && !editor.view.composing) {
                const text = marks.map(mark => ({ bold: "**", italic: "*", strike: "~~", code: "`", link: "[]" })[mark.type.name as "bold"]).join("");
                decorations.push(Decoration.widget(cursor.pos, view => {
                  const marker = view.dom.ownerDocument.createElement("button");
                  marker.type = "button"; marker.className = "tiptap-inline-marker"; marker.textContent = text;
                  marker.contentEditable = "false"; marker.title = "编辑当前行的 Markdown 标记";
                  marker.addEventListener("mousedown", event => { event.preventDefault(); onOpen(cursor.pos); });
                  return marker;
                }, { key: `inline-${cursor.pos}-${text}`, ignoreSelection: true, side: -1, stopEvent: () => true }));
              }
            }
            return DecorationSet.create(state.doc, decorations);
          },
        },
      })];
    },
  });
}
