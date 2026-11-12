import { LaneMarkdownEditor } from "./lane/LaneMarkdownEditor.js";
import type { MarkdownEditorProps } from "./tiptap/types.js";
import { TimelineMarkdownEditor } from "./TimelineMarkdownEditor.js";

export type { MarkdownEditorProps } from "./tiptap/types.js";

export function MarkdownEditor(props: MarkdownEditorProps) {
  return props.documentId
    ? <TimelineMarkdownEditor key={props.documentId} {...props} documentId={props.documentId} />
    : <LaneMarkdownEditor {...props} />;
}
