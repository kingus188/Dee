import type { Editor, MarkdownToken } from "@tiptap/core";
import { extractAbsorbedBlankLines, isTaskItem } from "@tiptap/markdown";
import type { Node as PMNode } from "@tiptap/pm/model";
import { parseDocument } from "./parse-document.js";
import type { MarkdownSourceSegment, MarkdownSourceSegments } from "./source-ledger.js";

interface OffsetChange { end: number; removed: number }
interface SourceView { text: string; offset: (position: number) => number }

/** Marked normalizes EOLs; store only changed spans, never one offset per payload byte. */
function sourceView(source: string): SourceView {
  const crlf: number[] = [];
  const normalized = source.replace(/\r\n?/gu, (value, position: number) => {
    if (value.length === 2) crlf.push(position - crlf.length);
    return "\n";
  });
  const changes: OffsetChange[] = [];
  let removed = 0;
  // A short URL preserves inline-image tokenization without feeding large base64
  // strings to marked's recursive block expressions (which can overflow V8).
  const prefix = `https://markdown-source.invalid/${crypto.randomUUID()}/`;
  const text = normalized.replace(/data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/]+=*/gi, (value, position: number) => {
    if (value.length < 2048) return value;
    const replacement = `${prefix}${changes.length}.png`;
    const end = position - removed + replacement.length;
    removed += value.length - replacement.length;
    changes.push({ end, removed });
    return replacement;
  });
  return {
    text,
    offset(position) {
      let low = 0, high = changes.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (changes[mid]!.end <= position) low = mid + 1;
        else high = mid;
      }
      const normalizedPosition = position + (changes[low - 1]?.removed ?? 0);
      low = 0; high = crlf.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (crlf[mid]! < normalizedPosition) low = mid + 1;
        else high = mid;
      }
      return normalizedPosition + low;
    },
  };
}

function withoutFinalEOL(raw: string): string {
  return raw.replace(/\n+$/u, "");
}

/** The official manager splits only consecutive task/non-task item groups. */
function listSegments(token: MarkdownToken, raw: string, start: number): MarkdownSourceSegment[] {
  const groups: { from: number; to: number }[] = [];
  let cursor = 0;
  let previousTask: boolean | undefined;
  for (const item of token.items ?? []) {
    // extractAbsorbedBlankLines may have removed blank lines from the list's
    // final raw, while the last item's raw still includes those lines.
    const itemRaw = extractAbsorbedBlankLines([item])[0]?.raw ?? "";
    const needle = withoutFinalEOL(itemRaw);
    const from = raw.indexOf(needle, cursor);
    if (!needle || from < cursor) return [];
    const to = Math.min(from + (item.raw ?? "").length, raw.length);
    const task = isTaskItem(item).isTask;
    if (groups.length && task === previousTask) groups[groups.length - 1]!.to = start + to;
    else groups.push({ from: start + from, to: start + to });
    previousTask = task;
    cursor = to;
  }
  return groups.map(range => ({ from: range.from, to: range.from + withoutFinalEOL(raw.slice(range.from - start, range.to - start)).length }));
}

/**
 * Exact top-level source ranges for createDocumentExtensions' Markdown parser.
 * Definitions and separators remain in the gaps; empty paragraphs may be points.
 * The editor must keep the same Markdown extensions as the document's parser.
 */
export function createSourceSegments(editor: Editor): MarkdownSourceSegments {
  return (source: string, doc: PMNode): readonly MarkdownSourceSegment[] => {
    const markdown = editor.markdown;
    if (!markdown) throw new Error("Source segments require the Tiptap Markdown extension");
    const view = sourceView(source);
    const tokens = extractAbsorbedBlankLines(markdown.instance.lexer(view.text) as MarkdownToken[]);
    const firstNonSpace = tokens.findIndex(token => token.type !== "space");
    const lastNonSpace = tokens.findLastIndex(token => token.type !== "space");
    const segments: MarkdownSourceSegment[] = [];
    let cursor = 0;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      const raw = token.raw ?? "";
      const from = raw ? view.text.indexOf(raw, cursor) : cursor;
      if (from < cursor) throw new RangeError(`Markdown token ${token.type} has no matching source raw`);
      cursor = from + raw.length;
      if (token.type === "space") {
        // Mirror MarkdownManager 3.32's public parser: every pair of LF adds
        // an empty paragraph, except the first pair between non-space tokens.
        const boundary = firstNonSpace === -1 || index < firstNonSpace || index > lastNonSpace;
        const pairs = [...raw.matchAll(/\n\n/gu)];
        for (const pair of pairs.slice(boundary ? 0 : 1)) {
          const point = view.offset(from + pair.index);
          segments.push({ from: point, to: point });
        }
        continue;
      }
      const leadingEOL = raw.match(/^\n*/u)![0].length;
      const blockFrom = from + leadingEOL;
      const blockRaw = withoutFinalEOL(raw.slice(leadingEOL));
      // Re-parse through the public API rather than assuming every lexer token
      // emits a node. In particular, ordinary reference definitions emit none.
      const count = parseDocument(editor, blockRaw).content?.length ?? 0;
      if (!count) continue;
      const ranges = count > 1 && token.type === "list" ? listSegments(token, blockRaw, blockFrom) : [{ from: blockFrom, to: blockFrom + blockRaw.length }];
      if (ranges.length !== count) throw new RangeError(`Markdown token ${token.type} emits ${count} nodes without separate source boundaries`);
      for (const range of ranges) segments.push({ from: view.offset(range.from), to: view.offset(range.to) });
    }
    // ProseMirror can fill an empty document with one default paragraph.
    if (!segments.length && doc.childCount === 1 && doc.firstChild?.type.name === "paragraph" && !doc.firstChild.content.size) {
      return [{ from: 0, to: 0 }];
    }
    if (segments.length !== doc.childCount) throw new RangeError(`Markdown source has ${segments.length} blocks for ${doc.childCount} document nodes`);
    return segments;
  };
}
