import { useState, type FormEvent } from 'react'
import { DatePicker, Modal } from 'antd'
import zhCN from 'antd/locale/zh_CN.js'
import dayjs from 'dayjs'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import {
  priorities,
  statuses,
  type Project,
  type Task,
} from '../../domain/todo.js'
import ColorPicker from '../../components/ColorPicker.js'
import MarkdownEditor from '../../components/MarkdownEditor.js'
import { descriptionTooLarge } from '../../domain/markdown.js'
import { useDaylightContainer } from '../../WorkspaceContainer.js'

export default function TaskEditor({
  task,
  projects,
  existing,
  busy,
  onClose,
  onSave,
  onDelete,
}: {
  task: Task
  projects: Project[]
  existing: boolean
  busy: boolean
  onClose: () => void
  onSave: (task: Task) => Promise<boolean>
  onDelete: () => void
}) {
  const getContainer = useDaylightContainer()
  const [draft, setDraft] = useState<Task>(structuredClone(task))
  const [tags, setTags] = useState(task.tags.join('，'))
  const [error, setError] = useState('')
  const [imagePending, setImagePending] = useState(false)
  const locked = busy || imagePending
  function update<K extends keyof Task>(key: K, value: Task[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (locked) return
    if (descriptionTooLarge(draft.description)) {
      setError('备注含图片不能超过 8 MiB，请减少图片或文字。')
      return
    }
    const parsedTags = [
      ...new Set(
        tags
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ]
    if (parsedTags.length > 8 || parsedTags.some((tag) => tag.length > 24)) {
      setError('最多 8 个标签，每个标签最多 24 字。')
      return
    }
    if (!draft.title.trim()) {
      setError('请填写任务名称。')
      return
    }
    if (draft.checklist.some((item) => !item.title.trim())) {
      setError('请填写子任务名称，或移除空白项。')
      return
    }
    if (await onSave({ ...draft, title: draft.title.trim(), tags: parsedTags }))
      onClose()
  }
  return (
    <Modal
      getContainer={getContainer}
      open
      title={existing ? '每一小步，都值得认真对待' : '记下一件想做的事'}
      onCancel={() => {
        if (!locked) onClose()
      }}
      mask={{ closable: false }}
      keyboard={!locked}
      closable={!locked}
      width={600}
      footer={null}
    >
      <form onSubmit={submit} className="editor-form">
        <div className="editor-fields">
          <fieldset disabled={locked}>
            <label>
              任务名称
              <input
                autoFocus
                required
                maxLength={160}
                value={draft.title}
                onChange={(event) => update('title', event.target.value)}
                placeholder="比如，给自己安排一个充实的周末"
              />
            </label>
            <div className="field-label">
              <span>备注</span>
              <MarkdownEditor
                value={draft.description}
                disabled={locked}
                onChange={(value) => update('description', value)}
                onPendingChange={setImagePending}
              />
            </div>
            <div className="form-row">
              <label>
                所属项目
                <select
                  value={draft.projectId}
                  onChange={(event) => update('projectId', event.target.value)}
                >
                  {projects.map((project) => (
                    <option value={project.id} key={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                状态
                <select
                  value={draft.status}
                  onChange={(event) =>
                    update('status', event.target.value as Task['status'])
                  }
                >
                  {statuses.map((status) => (
                    <option key={status.id} value={status.id}>
                      {status.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-row">
              <label>
                截止日期
                <DatePicker
                  aria-label="截止日期"
                  locale={zhCN.default.DatePicker}
                  format="YYYY年MM月DD日"
                  placeholder="请选择截止日期"
                  value={draft.dueDate ? dayjs(draft.dueDate) : null}
                  onChange={(date) =>
                    update('dueDate', date ? date.format('YYYY-MM-DD') : null)
                  }
                  allowClear
                />
              </label>
              <label>
                优先级
                <select
                  value={draft.priority}
                  onChange={(event) =>
                    update('priority', event.target.value as Task['priority'])
                  }
                >
                  {Object.entries(priorities).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              标签<span className="field-hint">用逗号分隔，最多 8 个</span>
              <input
                value={tags}
                maxLength={220}
                onChange={(event) => setTags(event.target.value)}
                placeholder="生活，灵感"
              />
            </label>
            <div className="field-label">
              卡片颜色
              <ColorPicker
                value={draft.color}
                onChange={(color) => update('color', color)}
              />
            </div>
            <div className="checklist-editor">
              <div className="section-label">
                <span>
                  子任务{' '}
                  <small>
                    {draft.checklist.filter((item) => item.done).length}/
                    {draft.checklist.length}
                  </small>
                </span>
                <button
                  type="button"
                  className="text-button"
                  disabled={draft.checklist.length >= 50}
                  onClick={() =>
                    update('checklist', [
                      ...draft.checklist,
                      { id: crypto.randomUUID(), title: '', done: false },
                    ])
                  }
                >
                  <PlusOutlined /> 添加子任务
                </button>
              </div>
              {draft.checklist.map((item) => (
                <div className="checklist-edit-row" key={item.id}>
                  <input
                    type="checkbox"
                    aria-label={`完成子任务 ${item.title}`}
                    checked={item.done}
                    onChange={() =>
                      update(
                        'checklist',
                        draft.checklist.map((check) =>
                          check.id === item.id
                            ? { ...check, done: !check.done }
                            : check,
                        ),
                      )
                    }
                  />
                  <input
                    aria-label="子任务名称"
                    required
                    maxLength={160}
                    value={item.title}
                    onChange={(event) =>
                      update(
                        'checklist',
                        draft.checklist.map((check) =>
                          check.id === item.id
                            ? { ...check, title: event.target.value }
                            : check,
                        ),
                      )
                    }
                    placeholder="一个小小的步骤"
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`移除子任务 ${item.title}`}
                    onClick={() =>
                      update(
                        'checklist',
                        draft.checklist.filter((check) => check.id !== item.id),
                      )
                    }
                  >
                    <DeleteOutlined />
                  </button>
                </div>
              ))}
            </div>
          </fieldset>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          {existing && (
            <button
              type="button"
              className="text-button danger"
              disabled={locked}
              onClick={onDelete}
            >
              <DeleteOutlined /> 删除任务
            </button>
          )}
          <div className="action-spacer" />
          <button
            type="button"
            className="button"
            disabled={locked}
            onClick={onClose}
          >
            取消
          </button>
          <button type="submit" className="button primary" disabled={locked}>
            {imagePending ? '读取图片中…' : busy ? '保存中…' : '保存任务'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
