import type { MemoryItem } from '@assistant/contracts';
import { MarkdownDocument } from '../editor/MarkdownDocument.js';

export function MemoryHistory({ item }: { item: MemoryItem }) {
  const provenance = item.provenance;
  return <section aria-label="记忆出处与版本" className="workspace-detail-footer">
    <div><p className="workspace-muted">版本 {item.revision ?? 1} · {new Date(item.updatedAt ?? item.createdAt).toLocaleString('zh-CN')}</p>
      {provenance?.messageId && provenance.conversationId !== null ? <p><a href={`#chat/${provenance.conversationId}`}>查看原对话</a> · 消息 #{provenance.messageId}</p> : <p className="workspace-muted">这条记忆没有关联的原始消息。</p>}
      {provenance?.quote && <blockquote>{provenance.quote}{provenance.quoteTruncated ? '…' : ''}</blockquote>}
      {!!item.history?.length && <details><summary>历史版本（{item.history.length}）</summary><ol>{[...item.history].reverse().map(version => <li key={version.revision}><p>版本 {version.revision} · {new Date(version.changedAt).toLocaleString('zh-CN')} · {version.status === 'approved' ? '已生效' : version.status === 'pending' ? '待确认' : '已撤回'}</p><MarkdownDocument value={version.text} /></li>)}</ol></details>}
    </div>
  </section>;
}
