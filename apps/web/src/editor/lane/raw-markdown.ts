interface LineAnchor { old: number; next: number }

// Only line endings need reconciliation. Unique unchanged lines anchor edits;
// replacement lines between anchors inherit the old endings in document order.
function lineAnchors(before: string[], after: string[], start: number, oldEnd: number, newEnd: number): LineAnchor[] {
  const unique = (lines: string[], end: number) => {
    const positions = new Map<string, number>();
    for (let index = start; index < end; index++) {
      const line = lines[index]!;
      positions.set(line, positions.has(line) ? -1 : index);
    }
    return positions;
  };
  const oldPositions = unique(before, oldEnd), newPositions = unique(after, newEnd);
  const pairs: LineAnchor[] = [];
  for (let next = start; next < newEnd; next++) {
    const old = oldPositions.get(after[next]!);
    if (old !== undefined && old >= 0 && newPositions.get(after[next]!) === next) pairs.push({ old, next });
  }
  // Patience alignment chooses a monotone subset, so reordered lines cannot
  // assign the same original ending to several output lines.
  const tails: number[] = [], parents: number[] = [];
  for (let index = 0; index < pairs.length; index++) {
    let low = 0, high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (pairs[tails[middle]!]!.old < pairs[index]!.old) low = middle + 1;
      else high = middle;
    }
    parents[index] = low ? tails[low - 1]! : -1;
    tails[low] = index;
  }
  const anchors: LineAnchor[] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = parents[index]!) anchors.push(pairs[index]!);
  return anchors.reverse();
}

/** Restore original CRLF/CR/LF endings around LF-normalized rich-editor edits.
 * New lines use the first original ending (LF for a single-line document).
 * Identical repeated lines have no edit identity here; alignment is positional
 * within unchanged anchors, rather than guessing a character-level edit history.
 * Work is O(characters + lines * log(lines)); no character diff matrix is built.
 */
export function reconcileRichMarkdown(original: string, value: string): string {
  if (!original.includes("\r")) return value;
  if (original.replace(/\r\n?/g, "\n") === value) return original;
  const before = original.split(/\r\n|\r|\n/), after = value.split("\n");
  const endings = original.match(/\r\n|\r|\n/g) ?? [];
  const fallback = endings[0] ?? "\n";
  const mapped = new Int32Array(after.length).fill(-1);
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) {
    mapped[start] = start; start++;
  }
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    mapped[--newEnd] = --oldEnd;
  }
  let oldCursor = start, newCursor = start;
  for (const anchor of [...lineAnchors(before, after, start, oldEnd, newEnd), { old: oldEnd, next: newEnd }]) {
    const count = Math.min(anchor.old - oldCursor, anchor.next - newCursor);
    for (let offset = 0; offset < count; offset++) mapped[newCursor + offset] = oldCursor + offset;
    if (anchor.next < newEnd) mapped[anchor.next] = anchor.old;
    oldCursor = anchor.old + 1; newCursor = anchor.next + 1;
  }
  const output: string[] = [];
  let previousEnding = "";
  for (let index = 0; index < after.length; index++) {
    const line = after[index]!;
    let ending = index === after.length - 1 ? "" : endings[mapped[index]!] ?? fallback;
    // A deleted line body can put separate CR and LF endings next to each
    // other. Keep two line breaks instead of accidentally forming one CRLF.
    if (!line && previousEnding === "\r" && ending === "\n") ending = "\r\n";
    output.push(line, ending);
    previousEnding = ending;
  }
  return output.join("");
}
