import { Extension, Node, type JSONContent, type MarkdownToken } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";

export const LITERAL_BLOCK = "markdownLiteralBlock";
export const LITERAL_INLINE = "markdownLiteralInline";

function literalContent(raw: string): JSONContent[] {
  return raw ? [{ type: "text", text: raw }] : [];
}

export function literalInline(raw: string, kind = "html"): JSONContent {
  return { type: LITERAL_INLINE, attrs: { kind }, content: literalContent(raw) };
}

function literalBlock(raw: string, kind = "html"): JSONContent {
  return { type: LITERAL_BLOCK, attrs: { kind }, content: literalContent(raw.replace(/\n+$/, "")) };
}

function literalText(node: JSONContent): string {
  return (node.content ?? []).map(child => child.text ?? "").join("");
}

function footnoteDefinition(src: string): string | undefined {
  if (!/^\[\^[^\]\n]+\]:/.test(src)) return undefined;
  const lines = src.split("\n");
  let end = 1;
  while (end < lines.length) {
    if (/^(?: {2,}|\t)\S?/.test(lines[end])) {
      end++;
    } else if (lines[end] === "" && /^(?: {2,}|\t)\S?/.test(lines[end + 1] ?? "")) {
      end += 2;
    } else {
      break;
    }
  }
  return lines.slice(0, end).join("\n");
}

export function createLiteralExtensions() {
  // Use Marked's own HTML tokenizer. Inline HTML otherwise bypasses registered
  // parseMarkdown handlers in MarkdownManager 3.32 and enters generateJSON().
  const marked = new MarkdownManager({ extensions: [] }).instance;
  const htmlTokenizer = new marked.Tokenizer();
  new marked.Lexer({ tokenizer: htmlTokenizer, gfm: true });

  const block = Node.create({
    name: LITERAL_BLOCK,
    group: "block",
    content: "text*",
    marks: "",
    code: true,
    defining: true,
    isolating: true,
    addAttributes: () => ({ kind: { default: "html" } }),
    parseHTML: () => [{ tag: 'pre[data-type="markdown-literal-block"]', preserveWhitespace: "full" }],
    renderHTML: ({ node }) => ["pre", { "data-type": "markdown-literal-block", "data-literal-kind": node.attrs.kind }, ["code", 0]],
    parseMarkdown: token => literalBlock(token.raw ?? "", token.kind ?? "html"),
    renderMarkdown: literalText,
    markdownTokenizer: {
      name: LITERAL_BLOCK,
      level: "block",
      start: src => {
        const match = /^(?:---[ \t]*$|\[\^[^\]\n]+\]:)/m.exec(src);
        return match?.index ?? -1;
      },
      tokenize: (src, tokens) => {
        const frontmatter = tokens.length === 0 ? /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?=\n|$)/.exec(src)?.[0] : undefined;
        const raw = frontmatter ?? footnoteDefinition(src);
        return raw ? { type: LITERAL_BLOCK, raw, kind: frontmatter ? "frontmatter" : "footnoteDefinition" } : undefined;
      },
    },
  });

  const inline = Node.create({
    name: LITERAL_INLINE,
    group: "inline",
    inline: true,
    content: "text*",
    marks: "",
    code: true,
    isolating: true,
    addAttributes: () => ({ kind: { default: "html" } }),
    parseHTML: () => [{ tag: 'span[data-type="markdown-literal-inline"]', preserveWhitespace: "full" }],
    renderHTML: ({ node }) => ["span", { "data-type": "markdown-literal-inline", "data-literal-kind": node.attrs.kind }, 0],
    parseMarkdown: token => literalInline(token.raw ?? "", token.kind ?? "html"),
    renderMarkdown: literalText,
    markdownTokenizer: {
      name: LITERAL_INLINE,
      level: "inline",
      start: src => {
        const match = /<|\[\^/.exec(src);
        return match?.index ?? -1;
      },
      tokenize: src => {
        const footnote = /^\[\^[^\]\n]+\]/.exec(src)?.[0];
        if (footnote) return { type: LITERAL_INLINE, raw: footnote, kind: "footnote" };
        const token = src.startsWith("<") ? htmlTokenizer.tag(src) : undefined;
        return token ? { type: LITERAL_INLINE, raw: token.raw, kind: "html" } : undefined;
      },
    },
  });

  const html = Extension.create({
    name: "literalHTML",
    priority: 2000,
    markdownTokenName: "html",
    parseMarkdown: (token: MarkdownToken) => token.block
      ? literalBlock(token.raw ?? token.text ?? "")
      : literalInline(token.raw ?? token.text ?? ""),
  });
  return [block, inline, html];
}
