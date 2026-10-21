import { Modal } from 'antd'
import { CloudOutlined } from '@ant-design/icons'
import { useDaylightContainer } from '../../WorkspaceContainer.js'

interface Props {
  location: string | null
  projectCount: number
  taskCount: number
  onClose: () => void
}

export default function StorageSettings({ location, projectCount, taskCount, onClose }: Props) {
  const getContainer = useDaylightContainer()
  return (
    <Modal
      open={location !== null}
      getContainer={getContainer}
      title="Daylight 数据存储"
      onCancel={onClose}
      footer={<button className="button primary" onClick={onClose}>知道了</button>}
    >
      <div className="settings-content">
        <div className="settings-icon"><CloudOutlined /></div>
        <p>项目、待办、清单与图片备注保存在助手服务端数据库。助手工具与此页面使用同一份数据。</p>
        <label>服务端存储位置</label>
        <code>{location}</code>
        <p className="field-hint">备份前请停止助手服务，再复制数据库及其同目录下的 -wal / -shm 文件（若存在）。</p>
        <div className="settings-stats">
          <span>{projectCount} 个项目</span>
          <span>{taskCount} 条待办</span>
        </div>
      </div>
    </Modal>
  )
}
