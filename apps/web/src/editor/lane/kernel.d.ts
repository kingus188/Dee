// Public boundary of the vendored kernel, bundled from vendor/open-markdown-lane/kernel.ts.
export interface SelectionBookmark { anchor: number; head: number }
export class MarkdownDocument {
  constructor(source: string, lineEnding?: string);
  text: string;
  selection: SelectionBookmark;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  replace(from: number, to: number, insert: string, kind?: string, selection?: SelectionBookmark): boolean;
  replaceExternal(source: string, lineEnding?: string): void;
  beginSourceSession(): void;
  endSourceSession(): void;
  closeGroup(): void;
  refreshCaret(): void;
  undo(): boolean;
  redo(): boolean;
}
export interface RichCallbacks {
  change(): void;
  cursor(line: number, column: number): void;
  image(file: File): void;
  link(url: string): void;
  compositionFinished(): void;
  error?(message: string): void;
}
export class RichEditor {
  constructor(root: HTMLElement, model: MarkdownDocument, documentId: string, callbacks: RichCallbacks);
  readonly model: MarkdownDocument;
  composing: boolean;
  destroy(): void;
  render(restore?: boolean): void;
  restore(selection?: SelectionBookmark, focus?: boolean): void;
  setOptions(options: { spellcheck: boolean; tabSize: number; typewriter: boolean; autoPair?: boolean; emoji?: boolean; readOnly?: boolean }): void;
  jump(line: number): void;
  select(selection: SelectionBookmark, focus?: boolean): void;
  insert(text: string, kind?: string): void;
  wrap(before: string, after?: string): void;
  command(action: string, args?: Record<string, unknown>): void;
  undo(): void;
  redo(): void;
  releaseFence(): void;
  bookmark(): SelectionBookmark;
  codeBlock(): void;
}
export function renderMarkdown(source: string, documentId?: string): string;
export function extractHeadings(source: string): { line: number; level: number; text: string; id: string }[];
