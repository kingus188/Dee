import { InputRule, type AnyExtension, type NodeViewRenderer } from "@tiptap/core";
import { InlineMath, BlockMath } from "@tiptap/extension-mathematics";
import Image from "@tiptap/extension-image";
import { literalInline } from "./literal-nodes.js";

export type EditDocumentNode = (kind: "inlineMath" | "blockMath" | "image", pos: number) => void;

export function imageSourceKind(source: unknown): "data" | "remote" | undefined {
  if (typeof source !== "string") return undefined;
  const data = /^data:image\/(png|jpeg|gif|webp);base64,([a-z\d+/]+={0,2})$/i.exec(source);
  if (data) {
    try {
      const bytes = atob(data[2]);
      const mime = data[1].toLowerCase();
      const valid = mime === "png" ? bytes.startsWith("\u0089PNG\r\n\u001a\n")
        : mime === "jpeg" ? bytes.startsWith("\u00ff\u00d8\u00ff")
        : mime === "gif" ? /^GIF8[79]a/.test(bytes)
        : bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
      return valid ? "data" : undefined;
    } catch {
      return undefined;
    }
  }
  if (!/^https:\/\//i.test(source) || /[\u0000-\u0020\u007f]/.test(source)) return undefined;
  try {
    const url = new URL(source);
    return url.protocol === "https:" && url.hostname && !source.slice(8).split(/[/?#]/)[0].includes("@") ? "remote" : undefined;
  } catch {
    return undefined;
  }
}

export function allowedLink(source: unknown): boolean {
  if (typeof source !== "string" || /[\u0000-\u0020\u007f]/.test(source)) return false;
  return /^(?:https?:\/\/|mailto:|tel:|#|\/(?!\/)|\.\.?\/)/i.test(source);
}

function readOnlyMathView(render: NodeViewRenderer | null | undefined): NodeViewRenderer | null {
  if (!render) return null;
  return props => {
    const view = render(props);
    const guard = (event: Event) => {
      if (!props.editor.isEditable) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    view.dom.addEventListener("click", guard, true);
    return {
      ...view,
      destroy: () => {
        view.dom.removeEventListener("click", guard, true);
        view.destroy?.();
      },
    };
  };
}

export function createMathExtensions(onEditNode?: EditDocumentNode): AnyExtension[] {
  const inline = InlineMath.extend({
    addNodeView() { return readOnlyMathView(this.parent?.()); },
    addInputRules() {
      return [new InputRule({
        find: text => {
          const match = /(^|[^$\\])\$([^$\n]+)\$$/.exec(text);
          if (!match) return null;
          const prefix = match[1].length;
          return { index: match.index + prefix, text: match[0].slice(prefix), data: { latex: match[2] } };
        },
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match.data?.latex }));
        },
      })];
    },
  }).configure({
    katexOptions: { trust: false, throwOnError: false, maxExpand: 1000, maxSize: 20 },
    onClick: (_node, pos) => onEditNode?.("inlineMath", pos),
  });
  const block = BlockMath.extend({
    addNodeView() { return readOnlyMathView(this.parent?.()); },
    addInputRules() {
      return [new InputRule({
        find: /^\$\$([^$\n]+)\$\$$/,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          if (!$from.parent.isTextblock || range.from !== $from.start() || range.to !== $from.end()) return null;
          if (!$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), this.type)) return null;
          state.tr.replaceWith($from.before(), $from.after(), this.type.create({ latex: match[1] }));
        },
      })];
    },
  }).configure({
    katexOptions: { trust: false, throwOnError: false, displayMode: true, maxExpand: 1000, maxSize: 20 },
    onClick: (_node, pos) => onEditNode?.("blockMath", pos),
  });
  return [inline, block];
}

export function createImageExtension(onEditNode?: EditDocumentNode): AnyExtension {
  return Image.extend({
    parseHTML() {
      return [{ tag: "img[src]", getAttrs: element => imageSourceKind(element.getAttribute("src")) ? null : false }];
    },
    parseMarkdown(token, helpers) {
      if (!imageSourceKind(token.href)) return literalInline(token.raw ?? `![${token.text ?? ""}](${token.href ?? ""})`, "image");
      return helpers.createNode("image", { src: token.href, title: token.title ?? null, alt: token.text ?? "" });
    },
    renderHTML({ node }) {
      const { src, alt, title } = node.attrs;
      if (imageSourceKind(src) === "data") return ["img", { src, alt, title }];
      return ["span", { "data-type": "image-placeholder" }, `${imageSourceKind(src) ? "图片（点击加载）" : "图片地址未加载"}${alt ? `：${alt}` : ""}`];
    },
    addNodeView() {
      return ({ node, editor, getPos }) => {
        let current = node;
        let loadedSource: string | undefined;
        const dom = document.createElement("span");
        dom.dataset.type = "document-image";
        dom.contentEditable = "false";
        const requestEdit = () => {
          const pos = getPos();
          if (editor.isEditable && pos !== undefined) onEditNode?.("image", pos);
        };
        const render = () => {
          dom.replaceChildren();
          const { src, alt, title } = current.attrs;
          const kind = imageSourceKind(src);
          if (kind === "data" || kind === "remote" && loadedSource === src) {
            const image = document.createElement("img");
            image.alt = typeof alt === "string" ? alt : "";
            if (typeof title === "string") image.title = title;
            image.referrerPolicy = "no-referrer";
            image.src = src;
            image.addEventListener("click", requestEdit);
            dom.append(image);
          } else {
            const label = document.createElement("span");
            label.textContent = `${kind ? "外部图片" : "图片地址未加载"}${alt ? `：${alt}` : ""}`;
            label.addEventListener("click", requestEdit);
            dom.append(label);
            if (kind === "remote") {
              const load = document.createElement("button");
              load.type = "button";
              load.textContent = "加载外部图片";
              load.addEventListener("mousedown", event => event.preventDefault());
              load.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                loadedSource = src;
                render();
              });
              dom.append(load);
            }
          }
          if (onEditNode) {
            const edit = document.createElement("button");
            edit.type = "button";
            edit.textContent = "编辑图片";
            edit.disabled = !editor.isEditable;
            edit.addEventListener("mousedown", event => event.preventDefault());
            edit.addEventListener("click", requestEdit);
            dom.append(edit);
          }
        };
        render();
        return {
          dom,
          stopEvent: event => event.target instanceof HTMLElement && !!event.target.closest("button"),
          update: next => {
            if (next.type !== current.type) return false;
            current = next;
            render();
            return true;
          },
        };
      };
    },
  }).configure({ inline: true, allowBase64: true });
}
