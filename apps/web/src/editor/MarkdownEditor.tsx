import { TiptapMarkdownEditor } from "./tiptap/TiptapMarkdownEditor.js";
import type { MarkdownEditorProps } from "./tiptap/types.js";

export type { MarkdownEditorProps } from "./tiptap/types.js";

export function MarkdownEditor(props: MarkdownEditorProps) {
  return <TiptapMarkdownEditor {...props} />;
}
