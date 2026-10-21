import { useState } from 'react'
import { Modal } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import { type Project } from '../../domain/todo.js'
import ColorPicker from '../../components/ColorPicker.js'
import { useDaylightContainer } from '../../WorkspaceContainer.js'

export default function ProjectEditor({
  project,
  existing,
  busy,
  onClose,
  onSave,
  onDelete,
}: {
  project: Project
  existing: boolean
  busy: boolean
  onClose: () => void
  onSave: (project: Project) => Promise<boolean>
  onDelete: () => void
}) {
  const getContainer = useDaylightContainer()
  const [draft, setDraft] = useState(project)
  return (
    <Modal
      getContainer={getContainer}
      open
      title={existing ? '编辑项目' : '为一组想法，建个项目'}
      onCancel={onClose}
      mask={{ closable: false }}
      keyboard={!busy}
      closable={!busy}
      footer={null}
      width={460}
    >
      <form
        className="editor-form"
        onSubmit={async (event) => {
          event.preventDefault()
          if (await onSave(draft)) onClose()
        }}
      >
        <div className="editor-fields">
          <fieldset disabled={busy}>
            <label>
              项目名称
              <input
                autoFocus
                required
                maxLength={60}
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
                placeholder="比如，新的生活计划"
              />
            </label>
            <label>
              描述
              <textarea
                rows={3}
                maxLength={240}
                value={draft.description}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
                placeholder="这个项目里，想完成什么？"
              />
            </label>
            <div className="field-label">
              项目颜色
              <ColorPicker
                value={draft.color}
                onChange={(color) => setDraft({ ...draft, color })}
              />
            </div>
          </fieldset>
        </div>
        <div className="modal-actions">
          {existing && (
            <button
              type="button"
              className="text-button danger"
              disabled={busy}
              onClick={onDelete}
            >
              <DeleteOutlined /> 删除项目
            </button>
          )}
          <div className="action-spacer" />
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? '保存中…' : '保存项目'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
