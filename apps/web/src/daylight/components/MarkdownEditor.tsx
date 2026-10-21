import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import {
  descriptionTooLarge,
  markdownExtensions,
  readImage,
} from '../domain/markdown.js'

export default function MarkdownEditor({
  value,
  disabled,
  onChange,
  onPendingChange,
}: {
  value: string
  disabled: boolean
  onChange: (value: string) => void
  onPendingChange: (pending: boolean) => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const reading = useRef(false)
  const editor = useEditor({
    extensions: markdownExtensions,
    content: value,
    contentType: 'markdown',
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': '任务备注',
        'aria-multiline': 'true',
        class: 'markdown-content',
      },
      handlePaste(view, event) {
        const text = event.clipboardData?.getData('text/plain')
        if (!text || event.clipboardData?.getData('text/html')) return false
        // Keep code pasted inside a code block literal.
        if (view.state.selection.$from.parent.type.spec.code) return false
        editor?.commands.insertContent(text, { contentType: 'markdown' })
        return true
      },
    },
    onUpdate: ({ editor: current }) => onChange(current.getMarkdown()),
  })

  useEffect(() => {
    editor?.setEditable(!disabled && !pending, false)
  }, [editor, disabled, pending])

  async function pasteImages(event: ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (!files.length) return
    event.preventDefault()
    event.stopPropagation()
    if (!editor || disabled || reading.current) return
    reading.current = true
    setPending(true)
    onPendingChange(true)
    setError('')
    const range = {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    }
    try {
      const images: string[] = []
      for (const file of files) {
        images.push(await readImage(file))
        if (
          descriptionTooLarge(
            value + images.map((src) => `\n\n![图片](${src})\n\n`).join(''),
          )
        )
          throw new Error('备注含图片不能超过 8 MiB，请减少图片。')
      }
      if (editor.isDestroyed) return
      editor
        .chain()
        .focus()
        .insertContentAt(
          range,
          images.map((src) => ({ type: 'image', attrs: { src, alt: '图片' } })),
        )
        .run()
    } catch (cause) {
      if (!editor.isDestroyed)
        setError(
          cause instanceof Error ? cause.message : '图片粘贴失败，请重试。',
        )
    } finally {
      reading.current = false
      if (!editor.isDestroyed) {
        setPending(false)
        onPendingChange(false)
      }
    }
  }

  return (
    <div
      className="markdown-editor"
      onPasteCapture={(event) => void pasteImages(event)}
    >
      <EditorContent editor={editor} />
      <p className="field-hint">
        支持 Markdown、直接粘贴图片；单张 ≤ 2 MiB，备注合计 ≤ 8 MiB。
      </p>
      {pending && (
        <p role="status" className="field-hint">
          正在读取图片…
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  )
}
