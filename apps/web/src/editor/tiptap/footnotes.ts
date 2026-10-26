import { Extension } from "@tiptap/core";
import type { Node as DocumentNode } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { renderDocumentMarkdown } from "../../chat/markdown.js";

/** Render footnotes without replacing their editable, source-preserving nodes. */
export function footnotePresentation() {
  return Extension.create({
    name: "documentFootnotes",
    addProseMirrorPlugins() {
      const editor = this.editor;
      const identities = new WeakMap<DocumentNode, number>();
      let sequence = 0;
      const identity = (node: DocumentNode) => { if (!identities.has(node)) identities.set(node, ++sequence); return identities.get(node)!; };
      return [new Plugin({ props: { decorations(state) {
        const definitions = new Map<string, { node: DocumentNode; pos: number; body: string }>();
        const references: { id: string; node: DocumentNode; pos: number }[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name === "markdownLiteralBlock" && node.attrs.kind === "footnoteDefinition") {
            const match = /^\[\^([^\]]+)\]:[ \t]*([\s\S]*)$/.exec(node.textContent);
            if (match) definitions.set(match[1]!, { node, pos, body: match[2]!.replace(/\n(?: {2,4}|\t)/g, "\n") });
          }
          if (node.type.name === "markdownLiteralInline" && node.attrs.kind === "footnote") {
            const match = /^\[\^([^\]]+)\]$/.exec(node.textContent);
            if (match) references.push({ id: match[1]!, node, pos });
          }
        });
        const numbers = new Map<string, number>();
        for (const reference of references) if (definitions.has(reference.id) && !numbers.has(reference.id)) numbers.set(reference.id, numbers.size + 1);
        const active = (pos: number, node: DocumentNode) => editor.isEditable && editor.isFocused && state.selection.from >= pos && state.selection.from <= pos + node.nodeSize;
        const result: Decoration[] = [];
        for (const { id, node, pos } of references) {
          const number = numbers.get(id);
          if (!number || active(pos, node)) continue;
          result.push(Decoration.node(pos, pos + node.nodeSize, { class: "tiptap-footnote-source" }));
          result.push(Decoration.widget(pos + 1, view => {
            const link = view.dom.ownerDocument.createElement("button");
            link.type = "button"; link.className = "tiptap-footnote-link"; link.textContent = String(number);
            link.setAttribute("aria-label", `脚注 ${number}`); link.contentEditable = "false";
            link.addEventListener("mousedown", event => event.preventDefault());
            link.addEventListener("click", event => {
              event.preventDefault();
              const target = view.dom.querySelector<HTMLElement>(`[data-footnote-number="${number}"]`);
              target?.scrollIntoView?.({ block: "center" }); target?.focus();
            });
            return link;
          }, { key: `footnote-ref-${identity(node)}-${number}`, ignoreSelection: true, stopEvent: () => true }));
        }
        for (const [id, { node, pos, body }] of definitions) {
          const number = numbers.get(id);
          if (!number || active(pos, node)) continue;
          result.push(Decoration.node(pos, pos + node.nodeSize, { class: "tiptap-footnote-definition-source" }));
          result.push(Decoration.widget(pos, view => {
            const section = view.dom.ownerDocument.createElement("div");
            section.className = "tiptap-footnote-preview"; section.dataset.footnoteNumber = String(number); section.contentEditable = "false"; section.tabIndex = -1;
            const label = view.dom.ownerDocument.createElement("span"); label.className = "tiptap-footnote-number"; label.textContent = `${number}.`;
            const content = view.dom.ownerDocument.createElement("div");
            // The shared renderer escapes raw HTML before applying Markdown.
            content.innerHTML = renderDocumentMarkdown(body).html;
            section.append(label, content);
            if (editor.isEditable) {
              const edit = view.dom.ownerDocument.createElement("button");
              edit.type = "button"; edit.textContent = "编辑脚注"; edit.className = "tiptap-footnote-edit";
              edit.addEventListener("mousedown", event => event.preventDefault());
              edit.addEventListener("click", () => { view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1)))); view.focus(); });
              section.append(edit);
            }
            return section;
          }, { key: `footnote-def-${identity(node)}-${number}-${editor.isEditable}`, side: -1, ignoreSelection: true, stopEvent: () => true }));
        }
        return DecorationSet.create(state.doc, result);
      } } })];
    },
  });
}
