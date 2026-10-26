export interface MarkdownInputRange { from: number; to: number; inputType?: string }

// Textareas expose LF-normalized text. Map only the changed range back to the untouched source.
export function textareaMarkdownEdit(original: string, value: string, hint?: MarkdownInputRange): string {
  const shown = original.replace(/\r\n?/g, "\n");
  if (shown === value) return original;
  let from = 0, oldTo = shown.length, newTo = value.length;
  while (from < oldTo && from < newTo && shown[from] === value[from]) from++;
  while (oldTo > from && newTo > from && shown[oldTo - 1] === value[newTo - 1]) { oldTo--; newTo--; }
  if (hint) {
    let start = hint.from, end = hint.to;
    const removed = shown.length - value.length;
    if (start === end && removed > 0) {
      if (hint.inputType?.includes("Backward")) start -= removed;
      if (hint.inputType?.includes("Forward")) end += removed;
    }
    const inserted = value.length - shown.length + end - start;
    if (start >= 0 && end <= shown.length && inserted >= 0 && shown.slice(0, start) + value.slice(start, start + inserted) + shown.slice(end) === value) {
      from = start; oldTo = end; newTo = start + inserted;
    }
  }
  const offsets = [0];
  for (let index = 0; index < original.length; index++) {
    if (original[index] === "\r" && original[index + 1] === "\n") index++;
    offsets.push(index + 1);
  }
  const eol = /\r\n|\r|\n/.exec(original)?.[0] ?? "\n";
  return original.slice(0, offsets[from]) + value.slice(from, newTo).replace(/\n/g, eol) + original.slice(offsets[oldTo]);
}
