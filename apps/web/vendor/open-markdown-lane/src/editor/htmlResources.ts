import DOMPurify from "./purify.ts";
import { restrictMedia } from "./webMedia.ts";
export function safeDocumentHtml(html: string, _documentId?: string, _block = true) {
  const template = document.createElement("template");
  template.innerHTML = DOMPurify.sanitize(html, {
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ["iframe", "object", "embed", "form", "style", "link", "meta", "base"],
    FORBID_ATTR: ["contenteditable", "srcset", "style"],
  });
  restrictMedia(template.content);
  return template.innerHTML;
}
