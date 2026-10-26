import { MarkdownEditor as DocumentEditor } from '../../editor/MarkdownEditor.js'
import { MAX_DESCRIPTION_BYTES, readImage } from '../domain/markdown.js'

export default function MarkdownEditor({ value, disabled, onChange, onPendingChange }: {
  value: string
  disabled: boolean
  onChange: (value: string) => void
  onPendingChange: (pending: boolean) => void
}) {
  return <>
    <DocumentEditor value={value} disabled={disabled} onChange={onChange} label="任务备注"
      imageFileReader={readImage} maxBytes={MAX_DESCRIPTION_BYTES} onPendingChange={onPendingChange} />
    <p className="field-hint">支持 Markdown、直接粘贴图片；单张 ≤ 2 MiB，备注合计 ≤ 8 MiB。</p>
  </>
}
