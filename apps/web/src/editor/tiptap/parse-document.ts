import type { Editor, JSONContent } from "@tiptap/core";

/** Keep large inline image payloads out of marked's recursive block regexes. */
export function parseDocument(editor: Editor, source: string): JSONContent {
  const payloads = new Map<string, string>();
  const prefix = `https://markdown-payload.invalid/${crypto.randomUUID()}/`;
  const compact = source.replace(/data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/]+=*/gi, value => {
    if (value.length < 2048) return value;
    const placeholder = `${prefix}${payloads.size}.png`;
    payloads.set(placeholder, value);
    return placeholder;
  });
  const doc = editor.markdown!.parse(compact);
  if (payloads.size) {
    const raw = (value: string) => {
      if (!value.includes(prefix)) return value;
      for (const [placeholder, source] of payloads) value = value.replaceAll(placeholder, source);
      return value;
    };
    const restore = (node: JSONContent) => {
      if (node.text) node.text = raw(node.text);
      if (node.attrs) for (const [key, value] of Object.entries(node.attrs)) if (typeof value === "string") node.attrs[key] = raw(value);
      for (const child of node.content ?? []) restore(child);
    };
    restore(doc);
  }
  return doc;
}
