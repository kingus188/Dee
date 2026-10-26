import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { parseDocument } from "./parse-document.js";

/** Enter-driven structures complement Tiptap's character input rules. */
export function markdownTypingExtension(onMath: (position: number) => void) {
  return Extension.create({
    name: "documentMarkdownTyping", priority: 3000,
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [new Plugin({ props: { handleTextInput(view, from, to, text) {
        if (!editor.isEditable || view.composing || from !== to) return false;
        const resolved = view.state.doc.resolve(from);
        if (resolved.parent.type.name !== "paragraph" || resolved.parentOffset !== resolved.parent.content.size) return false;
        const marker = /^\[([ xX])\] $/.exec(resolved.parent.textContent + text);
        if (!marker) return false;
        let item: string | undefined;
        for (let depth = resolved.depth; depth > 0; depth--) if (["listItem", "taskItem"].includes(resolved.node(depth).type.name)) { item = resolved.node(depth).type.name; break; }
        if (item === "taskItem") return editor.chain().deleteRange({ from: resolved.start(), to }).updateAttributes("taskItem", { checked: marker[1]!.toLowerCase() === "x" }).run();
        if (item !== "listItem" || !editor.can().liftListItem("listItem")) return false;
        return editor.chain().deleteRange({ from: resolved.start(), to }).liftListItem("listItem").toggleTaskList().updateAttributes("taskItem", { checked: marker[1]!.toLowerCase() === "x" }).run();
      } } })];
    },
    addKeyboardShortcuts() {
      return { Enter: () => {
        const editor = this.editor, { state } = editor, { $from, empty } = state.selection;
        if (!editor.isEditable || editor.view.composing || !empty || $from.parent.type.name !== "paragraph" || $from.parentOffset !== $from.parent.content.size) return false;
        const text = $from.parent.textContent, from = $from.before(), to = $from.after();
        const fence = /^ {0,3}(`{3,}|~{3,})([\w+-]*)\s*$/.exec(text);
        if (fence) {
          const node = state.schema.nodes.codeBlock!.create({ language: fence[2] || null });
          const transaction = state.tr.replaceWith(from, to, node);
          transaction.setSelection(TextSelection.near(transaction.doc.resolve(from + 1)));
          editor.view.dispatch(transaction); return true;
        }
        if (/^\s*\$\$\s*$/.test(text)) {
          const math = state.schema.nodes.blockMath!.create({ latex: "" });
          const transaction = state.tr.replaceWith(from, to, [math, state.schema.nodes.paragraph!.create()]);
          transaction.setSelection(TextSelection.near(transaction.doc.resolve(from + math.nodeSize + 1)));
          editor.view.dispatch(transaction); onMath(from); return true;
        }
        const parent = $from.node($from.depth - 1), index = $from.index($from.depth - 1), previous = index > 0 ? parent.child(index - 1) : null;
        if (previous?.type.name !== "paragraph") return false;
        const heading = /^ {0,3}(={3,}|-{3,})[ \t]*$/.exec(text);
        if (heading && previous.textContent.trim()) {
          const start = from - previous.nodeSize;
          const node = state.schema.nodes.heading!.create({ level: heading[1]![0] === "=" ? 1 : 2 }, previous.content);
          const transaction = state.tr.replaceWith(start, to, [node, state.schema.nodes.paragraph!.create()]);
          transaction.setSelection(TextSelection.near(transaction.doc.resolve(start + node.nodeSize + 1)));
          editor.view.dispatch(transaction); return true;
        }
        if (!/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(text) || !previous.textContent.includes("|")) return false;
        const columns = text.trim().replace(/^\||\|$/g, "").split("|").length;
        const document = parseDocument(editor, `${previous.textContent}\n${text}\n|${Array.from({ length: columns }, () => " ").join("|")}|`);
        const json = document.content?.find(node => node.type === "table");
        if (!json) return false;
        const table = state.schema.nodeFromJSON(json), start = from - previous.nodeSize;
        const transaction = state.tr.replaceWith(start, to, [table, state.schema.nodes.paragraph!.create()]);
        transaction.setSelection(TextSelection.near(transaction.doc.resolve(start + table.firstChild!.nodeSize + 4)));
        editor.view.dispatch(transaction); return true;
      } };
    },
  });
}
