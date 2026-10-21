import { useEffect, useId, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";

export interface MarkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  disabled?: boolean;
  label: string;
}

export function MarkdownEditor({ value, onChange, disabled = false, label }: MarkdownEditorProps) {
  const id = useId();
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const applied = useRef<string | null>(null);
  const [source, setSource] = useState(false);
  const [sourceRequired, setSourceRequired] = useState(false);
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: false }), Markdown],
    content: "",
    contentType: "markdown",
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { role: "textbox", "aria-label": label, "aria-multiline": "true", "aria-describedby": `${id}-help` },
      // Admit plain text only, never clipboard HTML or embedded remote resources.
      handlePaste: (view, event) => {
        const text = event.clipboardData?.getData("text/plain");
        if (text === undefined) return true;
        event.preventDefault();
        view.dispatch(view.state.tr.insertText(text));
        return true;
      },
      handleDrop: () => true,
    },
    onUpdate: ({ editor: current }) => {
      const markdown = current.getMarkdown();
      applied.current = markdown;
      latest.current.onChange(markdown);
    },
  });

  useEffect(() => {
    if (!editor || applied.current === value) return;
    // HTML is kept exclusively as literal source; it never enters an HTML parser.
    const literalOnly = /[<>]/.test(value);
    editor.commands.setContent(literalOnly ? "" : value, { contentType: "markdown", emitUpdate: false });
    // Conservative, exact round-trip gate also protects unsupported syntax and whitespace.
    // Merely opening a document or switching modes must never rewrite its stored source.
    const requiresSource = literalOnly || editor.getMarkdown() !== value;
    setSourceRequired(requiresSource);
    if (requiresSource) setSource(true);
    applied.current = value;
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled, false);
    editor?.setOptions({ editorProps: { attributes: {
      role: "textbox", "aria-label": label, "aria-multiline": "true",
      "aria-disabled": String(disabled), "aria-describedby": `${id}-help`,
    } } });
  }, [editor, disabled, label, id]);

  const tools = editor ? [
    { label: "标题", active: editor.isActive("heading", { level: 2 }), run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: "粗体", active: editor.isActive("bold"), run: () => editor.chain().focus().toggleBold().run() },
    { label: "斜体", active: editor.isActive("italic"), run: () => editor.chain().focus().toggleItalic().run() },
    { label: "无序列表", active: editor.isActive("bulletList"), run: () => editor.chain().focus().toggleBulletList().run() },
    { label: "有序列表", active: editor.isActive("orderedList"), run: () => editor.chain().focus().toggleOrderedList().run() },
    { label: "引用", active: editor.isActive("blockquote"), run: () => editor.chain().focus().toggleBlockquote().run() },
    { label: "代码", active: editor.isActive("codeBlock"), run: () => editor.chain().focus().toggleCodeBlock().run() },
  ] : [];

  function showRichText() {
    if (!editor) return;
    const markdown = latest.current.value;
    if (/[<>]/.test(markdown)) { setSourceRequired(true); return; }
    editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
    const requiresSource = editor.getMarkdown() !== markdown;
    setSourceRequired(requiresSource);
    if (!requiresSource) setSource(false);
  }

  return <div className="markdown-editor" aria-busy={!editor}>
    <div className="markdown-editor-toolbar" role="group" aria-label={`${label}格式`}>
      {tools.map(tool => <button key={tool.label} type="button" disabled={disabled || source} aria-pressed={tool.active} onMouseDown={event => event.preventDefault()} onClick={tool.run}>{tool.label}</button>)}
      <button type="button" disabled={disabled || !editor} aria-pressed={source} onClick={() => source ? showRichText() : setSource(true)}>{source ? "切换富文本" : "Markdown 源码"}</button>
    </div>
    <p className="markdown-editor-help" id={`${id}-help`}>{sourceRequired ? "为完整保留原文，当前使用源码编辑（包含不支持的语法或无法无损往返的格式）。" : "支持 Markdown；源码模式可保留所有语法。编辑器不加载外部资源。"}</p>
    {source ? <><label className="markdown-editor-label" htmlFor={`${id}-source`}>{label}</label><textarea id={`${id}-source`} aria-describedby={`${id}-help`} value={value} disabled={disabled} spellCheck={false} onChange={event => {
      // Source edits must pass through the round-trip gate before returning to rich text.
      latest.current.onChange(event.target.value);
    }} /></> : <EditorContent editor={editor} />}
  </div>;
}
