// Markdown documents cannot address the desktop filesystem or execute embedded pages.
export function safeImageUrl(value: string): boolean {
  return /^https:\/\//i.test(value) || /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/]+=*$/i.test(value);
}
export function restrictMedia(fragment: DocumentFragment) {
  for (const element of fragment.querySelectorAll("iframe,object,embed,form,style,link,meta,base")) element.remove();
  for (const element of fragment.querySelectorAll("img,video,audio,source")) {
    const source = element.getAttribute("src") || "";
    if (element.tagName === "IMG" ? !safeImageUrl(source) : !/^https:\/\//i.test(source)) {
      element.replaceWith(document.createTextNode(element.getAttribute("alt") || source));
      continue;
    }
    element.removeAttribute("srcset");
    const poster = element.getAttribute("poster");
    if (poster && !safeImageUrl(poster)) element.removeAttribute("poster");
  }
}
