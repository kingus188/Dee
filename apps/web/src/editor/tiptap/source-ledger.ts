import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

export interface MarkdownSourceSegment { readonly from: number; readonly to: number }
export type MarkdownSourceSegments = (source: string, doc: PMNode) => readonly MarkdownSourceSegment[];
type Serialize = (doc: PMNode) => string;
interface Snapshot { source: string; doc: PMNode; segments: readonly MarkdownSourceSegment[] }
interface EqualRun { raw: number; canonical: number; length: number }
interface Block { node: PMNode; pos: number; index: number }
interface Anchor { old: number; next: number }

const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 32;
const MAX_DIFF_DISTANCE = 128;
const MAX_DIFF_WORK = 1_000_000;
const MAX_ANCHOR_WORDS = 50_000;

function blocks(doc: PMNode): Block[] {
  const result: Block[] = [];
  doc.forEach((node, pos, index) => result.push({ node, pos, index }));
  return result;
}
function fragmentDoc(doc: PMNode, nodes: readonly PMNode[]): PMNode {
  return doc.copy(Fragment.fromArray([...nodes]));
}

/** Bounded Myers alignment. Large common strings are scanned, never expanded into character arrays. */
function equalRuns(raw: string, canonical: string, rawOffset = 0, canonicalOffset = 0): EqualRun[] {
  let prefix = 0;
  while (prefix < raw.length && prefix < canonical.length && raw.charCodeAt(prefix) === canonical.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < raw.length - prefix && suffix < canonical.length - prefix && raw.charCodeAt(raw.length - suffix - 1) === canonical.charCodeAt(canonical.length - suffix - 1)) suffix++;
  const result: EqualRun[] = prefix ? [{ raw: rawOffset, canonical: canonicalOffset, length: prefix }] : [];
  const left = raw.slice(prefix, raw.length - suffix);
  const right = canonical.slice(prefix, canonical.length - suffix);
  if (left && right) {
    const words = (text: string) => {
      const found = new Map<string, number[]>();
      let count = 0;
      for (const match of text.matchAll(/[\p{L}\p{N}_]+/gu)) {
        if (++count > MAX_ANCHOR_WORDS) return new Map<string, number[]>();
        const positions = found.get(match[0]);
        if (positions) positions.push(match.index);
        else found.set(match[0], [match.index]);
      }
      return found;
    };
    const oldWords = words(left);
    const newWords = words(right);
    const pairs: { raw: number; canonical: number; length: number }[] = [];
    for (const [word, positions] of newWords) {
      const old = oldWords.get(word);
      if (old?.length === positions.length) for (let i = 0; i < positions.length; i++) pairs.push({ raw: old[i]!, canonical: positions[i]!, length: word.length });
    }
    pairs.sort((a, b) => a.canonical - b.canonical);
    const tails: number[] = [];
    const parents: number[] = [];
    for (let i = 0; i < pairs.length; i++) {
      let low = 0, high = tails.length;
      while (low < high) { const mid = (low + high) >>> 1; if (pairs[tails[mid]!]!.raw < pairs[i]!.raw) low = mid + 1; else high = mid; }
      parents[i] = low ? tails[low - 1]! : -1;
      tails[low] = i;
    }
    const anchors: EqualRun[] = [];
    for (let at = tails.at(-1) ?? -1; at >= 0; at = parents[at]!) anchors.push(pairs[at]!);
    anchors.reverse();
    let oldCursor = 0, newCursor = 0;
    for (const anchor of [...anchors, { raw: left.length, canonical: right.length, length: 0 }]) {
      result.push(...smallDiff(left.slice(oldCursor, anchor.raw), right.slice(newCursor, anchor.canonical), rawOffset + prefix + oldCursor, canonicalOffset + prefix + newCursor));
      if (anchor.length) result.push({ raw: rawOffset + prefix + anchor.raw, canonical: canonicalOffset + prefix + anchor.canonical, length: anchor.length });
      oldCursor = anchor.raw + anchor.length;
      newCursor = anchor.canonical + anchor.length;
    }
  }
  if (suffix) result.push({ raw: rawOffset + raw.length - suffix, canonical: canonicalOffset + canonical.length - suffix, length: suffix });
  return result;
}

function smallDiff(raw: string, canonical: string, rawOffset: number, canonicalOffset: number): EqualRun[] {
  const trace: Map<number, number>[] = [];
  let previous = new Map<number, number>([[1, 0]]);
  let work = 0;
  for (let distance = 0; distance <= MAX_DIFF_DISTANCE; distance++) {
    const frontier = new Map<number, number>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = diagonal === -distance || diagonal !== distance && (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1);
      let x = down ? previous.get(diagonal + 1) ?? 0 : (previous.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < raw.length && y < canonical.length && raw.charCodeAt(x) === canonical.charCodeAt(y)) {
        x++; y++;
        if (++work > MAX_DIFF_WORK) return [];
      }
      if (++work > MAX_DIFF_WORK) return [];
      frontier.set(diagonal, x);
      if (x >= raw.length && y >= canonical.length) {
        const runs: EqualRun[] = [];
        for (let d = distance; d >= 0; d--) {
          const before = d ? trace[d - 1]! : new Map<number, number>([[1, 0]]);
          const k = x - y;
          const goesDown = k === -d || k !== d && (before.get(k - 1) ?? -1) < (before.get(k + 1) ?? -1);
          const priorK = goesDown ? k + 1 : k - 1;
          const priorX = before.get(priorK) ?? 0;
          const priorY = priorX - priorK;
          const snakeX = d ? priorX + (goesDown ? 0 : 1) : 0;
          const snakeY = d ? priorY + (goesDown ? 1 : 0) : 0;
          const length = x - snakeX;
          if (length > 0) runs.push({ raw: rawOffset + snakeX, canonical: canonicalOffset + snakeY, length });
          x = priorX; y = priorY;
        }
        return runs.reverse();
      }
    }
    trace.push(frontier);
    previous = frontier;
  }
  return [];
}

function canonicalSegments(doc: PMNode, canonical: string, serialize: Serialize): MarkdownSourceSegment[] {
  let cursor = 0;
  return blocks(doc).map(({ node }, index) => {
    const value = serialize(fragmentDoc(doc, [node]));
    const from = value ? canonical.indexOf(value, cursor) : Math.min(canonical.length, cursor + (index ? 2 : 0));
    if (from < cursor || from < 0) throw new Error("Markdown serializer must support top-level document fragments; supply source segments for context-sensitive renderers");
    cursor = from + value.length;
    return { from, to: cursor };
  });
}

function sourceSegments(source: string, doc: PMNode, serialize: Serialize): MarkdownSourceSegment[] {
  const canonical = serialize(doc);
  const canonicalRanges = canonicalSegments(doc, canonical, serialize);
  const crlf: number[] = [];
  for (const match of source.matchAll(/\r\n/gu)) crlf.push(match.index - crlf.length);
  const normalized = source.replace(/\r\n?/gu, "\n");
  const originalOffset = (offset: number) => {
    let low = 0, high = crlf.length;
    while (low < high) { const mid = (low + high) >>> 1; if (crlf[mid]! < offset) low = mid + 1; else high = mid; }
    return offset + low;
  };
  const runs = equalRuns(normalized, canonical);
  const map = (offset: number, assoc: number): number => {
    let low = 0, high = runs.length;
    while (low < high) { const mid = (low + high) >>> 1; if (runs[mid]!.canonical + runs[mid]!.length < offset) low = mid + 1; else high = mid; }
    let index = low;
    while (index < runs.length && runs[index]!.canonical <= offset) {
      const run = runs[index]!;
      if (offset > run.canonical && offset < run.canonical + run.length) return run.raw + offset - run.canonical;
      if (offset === run.canonical && assoc > 0 || offset === run.canonical + run.length && assoc < 0) return run.raw + offset - run.canonical;
      index++;
    }
    const before = runs[index - 1];
    const after = runs[index];
    const oldStart = before ? before.raw + before.length : 0;
    const oldEnd = after?.raw ?? normalized.length;
    const newStart = before ? before.canonical + before.length : 0;
    const newEnd = after?.canonical ?? canonical.length;
    if (newStart === newEnd) return assoc > 0 ? oldEnd : oldStart;
    if (offset <= newStart) return oldStart;
    if (offset >= newEnd) return oldEnd;
    throw new Error("Ambiguous Markdown source boundary; supply exact source segments for this parser/serializer");
  };
  const mapped = canonicalRanges.map((range, index) => {
    let from = originalOffset(map(range.from, 1));
    let to = Math.max(from, originalOffset(map(range.to, -1)));
    if (from !== to) {
      // Canonical renderers remove line syntax (HTML tags, setext underlines, trailing
      // spaces). Keep that syntax inside its block, and EOL separators outside it.
      from = Math.max(source.lastIndexOf("\n", from - 1), source.lastIndexOf("\r", from - 1)) + 1;
      while (to > from && /[\r\n]/u.test(source[to - 1]!)) to--;
      const lineEnd = source.slice(to).search(/[\r\n]/u);
      if (lineEnd >= 0) to += lineEnd;
      else to = source.length;
      if (doc.child(index).type.name === "heading") {
        const underline = source.slice(to).match(/^(?:\r\n|\r|\n)[ \t]{0,3}(?:=+|-+)[ \t]*(?=\r|\n|$)/u);
        if (underline) to += underline[0].length;
      }
    }
    return { from, to };
  });
  return mapped.map((range, index) => {
    let to = Math.min(range.to, mapped[index + 1]?.from ?? source.length);
    while (to > range.from && /[\r\n]/u.test(source[to - 1]!)) to--;
    return { from: range.from, to };
  });
}

function validateSegments(source: string, doc: PMNode, segments: readonly MarkdownSourceSegment[]): void {
  let end = 0;
  if (segments.length !== doc.childCount) throw new RangeError("Source segments must contain exactly one range per top-level document node");
  for (const segment of segments) {
    if (!Number.isSafeInteger(segment.from) || !Number.isSafeInteger(segment.to) || segment.from < end || segment.to < segment.from || segment.to > source.length) throw new RangeError(`Invalid or overlapping Markdown source segments: [${segment.from}, ${segment.to}) after ${end}`);
    end = segment.to;
  }
}

function unchangedBlocks(before: PMNode, after: PMNode, tr: Transaction): Anchor[] {
  const old = blocks(before), next = blocks(after);
  const atPosition = new Map(next.map(block => [block.pos, block]));
  const anchors = new Map<number, number>();
  const used = new Set<number>();
  const oldUsed = new Set<number>();
  for (const block of old) {
    const start = tr.mapping.map(block.pos, 1);
    const end = tr.mapping.map(block.pos + block.node.nodeSize, -1);
    const candidate = atPosition.get(start);
    if (candidate && end === candidate.pos + candidate.node.nodeSize && candidate.node.eq(block.node) && !used.has(candidate.index)) {
      anchors.set(candidate.index, block.index); used.add(candidate.index); oldUsed.add(block.index);
    }
  }
  // Whole-document replacement steps can discard useful positions while retaining equal edges.
  for (let i = 0; i < Math.min(old.length, next.length) && old[i]!.node.eq(next[i]!.node); i++) if (!used.has(i) && !oldUsed.has(i)) { anchors.set(i, i); used.add(i); oldUsed.add(i); }
  for (let i = old.length - 1, j = next.length - 1; i >= 0 && j >= 0 && old[i]!.node.eq(next[j]!.node); i--, j--) if (!used.has(j) && !oldUsed.has(i)) { anchors.set(j, i); used.add(j); oldUsed.add(i); }
  let last = -1;
  return [...anchors].sort(([a], [b]) => a - b).flatMap(([nextIndex, oldIndex]) => {
    if (oldIndex <= last) return [];
    last = oldIndex;
    return [{ old: oldIndex, next: nextIndex }];
  });
}

/**
 * Retains source spelling outside edited top-level blocks. Pass every transaction in order,
 * and call reset when external Markdown replaces the editor document. No transaction is dispatched.
 * Exact segment callbacks are available for custom renderers whose source has no textual anchors.
 * The initial source is pinned; other snapshots are limited to 32 entries / 16 MiB (UTF-16 estimate).
 */
export class MarkdownSourceLedger {
  private initial!: Snapshot;
  private current!: Snapshot;
  private history: Snapshot[] = [];
  private historyBytes = 0;

  constructor(source: string, doc: PMNode, private readonly serialize: Serialize, private readonly segment?: MarkdownSourceSegments) {
    this.reset(source, doc);
  }

  get source(): string { return this.current.source; }

  blockSource(position: number): { from: number; to: number; markdown: string } | null {
    const block = blocks(this.current.doc).find(item => position >= item.pos && position < item.pos + item.node.nodeSize);
    const range = block && this.current.segments[block.index];
    return range ? { ...range, markdown: this.source.slice(range.from, range.to) } : null;
  }

  reset(source: string, doc: PMNode): void {
    const segments = this.segment ? this.segment(source, doc).map(range => ({ ...range })) : sourceSegments(source, doc, this.serialize);
    validateSegments(source, doc, segments);
    this.initial = this.current = { source, doc, segments };
    this.history = [];
    this.historyBytes = 0;
  }

  commitSource(source: string, doc: PMNode): void {
    const segments = this.segment ? this.segment(source, doc).map(range => ({ ...range })) : sourceSegments(source, doc, this.serialize);
    validateSegments(source, doc, segments);
    const previous = this.current;
    this.current = { source, doc, segments };
    this.remember(previous);
  }

  update(tr: Transaction): string {
    if (!tr.before.eq(this.current.doc)) throw new RangeError("Transaction.before differs from ledger document; reset the ledger after replacing editor state");
    if (!tr.docChanged || tr.doc.eq(this.current.doc)) return this.source;
    const restored = [this.initial, ...this.history].find(snapshot => snapshot.doc.eq(tr.doc));
    const previous = this.current;
    this.current = restored ?? this.reconcile(tr);
    this.remember(previous);
    return this.source;
  }

  private remember(snapshot: Snapshot): void {
    if (snapshot === this.initial || this.history.includes(snapshot)) return;
    const bytes = 2 * (snapshot.source.length + snapshot.doc.nodeSize) + snapshot.segments.length * 16;
    if (bytes > MAX_HISTORY_BYTES) return;
    this.history.push(snapshot);
    this.historyBytes += bytes;
    while (this.history.length > MAX_HISTORY_ENTRIES || this.historyBytes > MAX_HISTORY_BYTES) {
      const removed = this.history.shift()!;
      this.historyBytes -= 2 * (removed.source.length + removed.doc.nodeSize) + removed.segments.length * 16;
    }
  }

  private reconcile(tr: Transaction): Snapshot {
    const { source, doc, segments } = this.current;
    const old = blocks(doc), next = blocks(tr.doc);
    const anchors = [{ old: -1, next: -1 }, ...unchangedBlocks(doc, tr.doc, tr), { old: old.length, next: next.length }];
    const parts: string[] = [];
    const ranges: MarkdownSourceSegment[] = [];
    let length = 0;
    const append = (value: string) => { parts.push(value); length += value.length; };
    const separator = (source.match(/\r\n|\r|\n/)?.[0] ?? "\n").repeat(2);
    for (let i = 1; i < anchors.length; i++) {
      const left = anchors[i - 1]!, right = anchors[i]!;
      const from = left.old < 0 ? 0 : segments[left.old]!.to;
      const to = right.old === old.length ? source.length : segments[right.old]!.from;
      const oldCount = right.old - left.old - 1;
      const changed = next.slice(left.next + 1, right.next).map(block => block.node);
      if (!oldCount && !changed.length) append(source.slice(from, to));
      else {
        const leading = oldCount ? source.slice(from, segments[left.old + 1]!.from) : source.slice(from, to);
        const trailing = oldCount ? source.slice(segments[right.old - 1]!.to, to) : "";
        if (!changed.length) {
          if (left.old < 0) append(leading + trailing);
          else if (right.old === old.length) append(leading + trailing);
          else append(/\S/u.test(leading + trailing) ? leading + trailing : leading || trailing || separator);
        } else {
          append(leading || (left.old >= 0 ? separator : ""));
          const fragment = fragmentDoc(tr.doc, changed);
          const canonical = this.serialize(fragment);
          for (const range of canonicalSegments(fragment, canonical, this.serialize)) ranges.push({ from: length + range.from, to: length + range.to });
          append(canonical);
          append(trailing || (right.old < old.length ? separator : ""));
        }
      }
      if (right.old < old.length) {
        const range = segments[right.old]!;
        const raw = source.slice(range.from, range.to);
        ranges.push({ from: length, to: length + raw.length });
        append(raw);
      }
    }
    return { source: parts.join(""), doc: tr.doc, segments: ranges };
  }
}
