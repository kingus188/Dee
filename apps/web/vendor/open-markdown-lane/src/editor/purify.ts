import createDOMPurify from "dompurify";
// Bind to the current document, including isolated test documents.
let current: Window | undefined;
let purifier: ReturnType<typeof createDOMPurify>;
export default {
  sanitize(html: string, options?: Parameters<ReturnType<typeof createDOMPurify>["sanitize"]>[1]) {
    if (current !== window) { current = window; purifier = createDOMPurify(window); }
    return purifier.sanitize(html, options);
  },
};
