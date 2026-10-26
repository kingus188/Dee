import { useEffect, useMemo } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { createDocumentExtensions } from "./tiptap/extensions.js";
import { parseDocument } from "./tiptap/parse-document.js";

export function MarkdownDocument({ value, className = "", label }: { value: string; className?: string; label?: string }) {
  const extensions = useMemo(() => createDocumentExtensions(), []);
  const editor = useEditor({ extensions, editable: false, content: "", immediatelyRender: false,
    editorProps: { attributes: { class: "tiptap-document-content", role: "document", ...(label ? { "aria-label": label } : {}) } },
  });
  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(parseDocument(editor, value), { emitUpdate: false });
    editor.view.dom.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6").forEach((heading, index) => { heading.id = `note-heading-${index}`; heading.tabIndex = -1; });
  }, [editor, value]);
  return <article className={`markdown-document-reader ${className}`}><EditorContent editor={editor} /></article>;
}
