import type { Editor } from "@tiptap/core";
import type { ReactNode } from "react";

export type AttributeKind = "link" | "image" | "inlineMath" | "blockMath" | "code";
interface Props {
  editor: Editor | null; disabled: boolean; source: boolean; blockSource: boolean;
  onSource: () => void; onBlockSource: () => void; onAttribute: (kind: AttributeKind) => void;
  onImageFile?: () => void;
}

export function DocumentToolbar({ editor, disabled, source, blockSource, onSource, onBlockSource, onAttribute, onImageFile }: Props) {
  const locked = disabled || source || blockSource || !editor;
  function button(label: string, text: ReactNode, run: () => unknown, active = false, unavailable = false) {
    return <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={locked || unavailable}
      onMouseDown={event => event.preventDefault()} onClick={() => { run(); }}>{text}</button>;
  }
  function insert(markdown: string) { editor?.chain().focus().insertContent(markdown, { contentType: "markdown" }).run(); }
  return <div className="markdown-editor-toolbar tiptap-document-toolbar" role="toolbar" aria-label="Markdown 格式">
    <select aria-label="段落格式" disabled={locked} value={editor?.isActive("heading") ? `h${editor.getAttributes("heading").level}` : "p"}
      onChange={event => { const value = event.target.value; if (value === "p") editor?.chain().focus().setParagraph().run(); else editor?.chain().focus().toggleHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6 }).run(); }}>
      <option value="p">正文</option>{[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={`h${level}`}>标题 {level}</option>)}
    </select>
    {button("粗体", <b>B</b>, () => editor?.chain().focus().toggleBold().run(), editor?.isActive("bold"))}
    {button("斜体", <i>I</i>, () => editor?.chain().focus().toggleItalic().run(), editor?.isActive("italic"))}
    {button("删除线", <s>S</s>, () => editor?.chain().focus().toggleStrike().run(), editor?.isActive("strike"))}
    <span className="tiptap-toolbar-separator" />
    {button("无序列表", "≡", () => editor?.chain().focus().toggleBulletList().run(), editor?.isActive("bulletList"))}
    {button("有序列表", "1.", () => editor?.chain().focus().toggleOrderedList().run(), editor?.isActive("orderedList"))}
    {button("任务列表", "☑", () => editor?.chain().focus().toggleTaskList().run(), editor?.isActive("taskList"))}
    {button("引用", "❞", () => editor?.chain().focus().toggleBlockquote().run(), editor?.isActive("blockquote"))}
    <details className="tiptap-insert-menu"><summary aria-label="插入内容">＋</summary><div>
      <button type="button" disabled={locked} onMouseDown={e => e.preventDefault()} onClick={() => onAttribute("link")}>链接</button>
      <button type="button" disabled={locked} onMouseDown={e => e.preventDefault()} onClick={() => onAttribute("image")}>图片地址</button>
      {onImageFile && <button type="button" disabled={locked} onClick={onImageFile}>本机图片…</button>}
      <button type="button" disabled={locked} onMouseDown={e => e.preventDefault()} onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>表格</button>
      <button type="button" disabled={locked} onMouseDown={e => e.preventDefault()} onClick={() => editor?.chain().focus().toggleCode().run()}>行内代码</button>
      <button type="button" disabled={locked} onMouseDown={e => e.preventDefault()} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>代码块</button>
      <button type="button" disabled={locked} onClick={() => onAttribute("inlineMath")}>行内公式</button>
      <button type="button" disabled={locked} onClick={() => onAttribute("blockMath")}>块公式</button>
      <button type="button" disabled={locked} onMouseDown={e => e.preventDefault()} onClick={() => editor?.chain().focus().setHorizontalRule().run()}>分隔线</button>
      <button type="button" disabled={locked} onMouseDown={e => e.preventDefault()} onClick={() => insert("[^note]\n\n[^note]: 脚注内容")}>脚注</button>
      <button type="button" disabled={locked} onMouseDown={e => e.preventDefault()} onClick={() => insert("---\ntitle: 文档标题\n---\n")}>文档元信息</button>
    </div></details>
    <span className="tiptap-toolbar-spacer" />
    {button("撤销", "↶", () => editor?.chain().focus().undo().run(), false, !editor?.can().undo())}
    {button("重做", "↷", () => editor?.chain().focus().redo().run(), false, !editor?.can().redo())}
    <button type="button" disabled={disabled || source || !editor} aria-pressed={blockSource} title="编辑当前块 Markdown" onMouseDown={e => e.preventDefault()} onClick={onBlockSource}>{blockSource ? "完成当前块" : "块语法"}</button>
    <button type="button" disabled={disabled || !editor} aria-pressed={source} onClick={onSource}>{source ? "返回文档" : "Markdown 源码"}</button>
    {editor?.isActive("table") && !source && <div className="tiptap-table-tools" role="group" aria-label="表格操作">
      {button("在后面插入行", "＋行", () => editor.chain().focus().addRowAfter().run())}
      {button("删除行", "−行", () => editor.chain().focus().deleteRow().run())}
      {button("在后面插入列", "＋列", () => editor.chain().focus().addColumnAfter().run())}
      {button("删除列", "−列", () => editor.chain().focus().deleteColumn().run())}
      {button("切换表头行", "表头", () => editor.chain().focus().toggleHeaderRow().run())}
      {button("合并单元格", "合并", () => editor.chain().focus().mergeCells().run(), false, !editor.can().mergeCells())}
      {button("拆分单元格", "拆分", () => editor.chain().focus().splitCell().run(), false, !editor.can().splitCell())}
      {button("删除表格", "删除表格", () => editor.chain().focus().deleteTable().run())}
    </div>}
    {editor?.isActive("codeBlock") && !source && <div className="tiptap-code-tools"><button type="button" disabled={locked} onClick={() => onAttribute("code")}>代码语言：{String(editor.getAttributes("codeBlock").language || "纯文本")}</button></div>}
  </div>;
}
