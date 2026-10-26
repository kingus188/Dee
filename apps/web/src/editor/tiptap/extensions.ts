import { Extension, type AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { common, createLowlight } from "lowlight";
import { createLiteralExtensions, literalInline } from "./literal-nodes.js";
import { footnotePresentation } from "./footnotes.js";
import { allowedLink, createImageExtension, createMathExtensions, type EditDocumentNode } from "./markdown-nodes.js";

export type { MathematicsOptions } from "@tiptap/extension-mathematics";
export type { TableOptions } from "@tiptap/extension-table";
export type { StarterKitOptions } from "@tiptap/starter-kit";

export interface DocumentExtensionOptions {
  onEditNode?: EditDocumentNode;
}

/** Official Tiptap Markdown schema shared by the mounted editor and pure models. */
export function createDocumentExtensions(options: DocumentExtensionOptions = {}): AnyExtension[] {
  const safeLinks = Extension.create({
    name: "safeMarkdownLinks",
    priority: 2000,
    markdownTokenName: "link",
    parseMarkdown: (token, helpers) => allowedLink(token.href)
      ? helpers.applyMark("link", helpers.parseInline(token.tokens ?? []), { href: token.href, title: token.title ?? null })
      : literalInline(token.raw ?? token.text ?? "", "link"),
    renderMarkdown: (node, helpers) => {
      const text = helpers.renderChildren(node);
      const href = node.attrs?.href ?? "";
      const title = node.attrs?.title;
      return title ? `[${text}](${href} "${title}")` : `[${text}](${href})`;
    },
  });

  const imageParagraphs = Extension.create({
    name: "inlineImageParagraphs",
    priority: 2000,
    markdownTokenName: "paragraph",
    parseMarkdown: (token, helpers) => token.tokens?.length === 1 && token.tokens[0].type === "image"
      ? helpers.createNode("paragraph", undefined, helpers.parseInline(token.tokens))
      : [],
    renderMarkdown: (node, helpers, context) => {
      if (node.content?.length) return helpers.renderChildren(node.content);
      const previous = context.previousNode;
      return previous?.type === "paragraph" && !previous.content?.length ? "&nbsp;" : "";
    },
  });

  return [
    StarterKit.configure({
      codeBlock: false,
      underline: false,
      trailingNode: false,
      link: {
        openOnClick: false,
        defaultProtocol: "https",
        markdownLinks: true,
        isAllowedUri: allowedLink,
        HTMLAttributes: { target: null, rel: "noopener noreferrer nofollow" },
      },
    }),
    Markdown.extend({
      onBeforeCreate(event) {
        this.parent?.(event);
        // Official Markdown leaves empty input as a string for the HTML parser.
        // A JSON paragraph also works when the editor has no DOM to parse HTML.
        if (this.editor.options.contentType === "markdown" && typeof this.editor.options.content === "string") {
          this.editor.options.content = { type: "doc", content: [{ type: "paragraph" }] };
        }
      },
    }).configure({ markedOptions: { gfm: true }, indentation: { style: "space", size: 2 } }),
    CodeBlockLowlight.configure({ lowlight: createLowlight(common) }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { renderWrapper: true, resizable: true, cellMinWidth: 50 } }),
    createImageExtension(options.onEditNode),
    ...createMathExtensions(options.onEditNode),
    ...createLiteralExtensions(),
    footnotePresentation(),
    safeLinks,
    imageParagraphs,
  ];
}
