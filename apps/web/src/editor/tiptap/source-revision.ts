import { Extension } from "@tiptap/core";

export const RAW_SOURCE_META = "document-exact-source";
export const SOURCE_REVISION = "markdownRevision";

// Source edits explicitly change this small attribute so even whitespace-only
// edits enter history. Ordinary input transactions must remain untouched:
// Tiptap input rules verify their intermediate document before converting it.
export function sourceRevisionExtension() {
  return Extension.create({
    name: "markdownSourceRevision",
    addGlobalAttributes: () => [{ types: ["doc"], attributes: { [SOURCE_REVISION]: { default: 0, rendered: false } } }],
  });
}
