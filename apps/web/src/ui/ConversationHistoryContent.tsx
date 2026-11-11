import type { ReactNode } from "react";
import { ConversationSource } from "./ConversationSource.js";
import { Icon } from "./Icon.js";

const shortcut = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";

export function ConversationHistoryContent({ query, onQuery, onClose, onTeams, onNew, newDisabled = false, searchLabel = "搜索历史对话", closeLabel = "关闭历史对话", children, bottom }: {
  query: string; onQuery: (query: string) => void; onClose: () => void; onTeams?: () => void;
  onNew?: () => void; newDisabled?: boolean; searchLabel?: string; closeLabel?: string; children: ReactNode; bottom?: ReactNode;
}) {
  return <>
    <header>{onTeams ? <ConversationSource source="assistant" onAssistant={() => {}} onTeams={onTeams} /> : <strong>对话</strong>}<button className="icon-button history-close" type="button" aria-label={closeLabel} onClick={onClose}><Icon name="panel-left-close" /></button></header>
    <div className="history-tools">
      <label className="history-search"><Icon name="search" /><input aria-label={searchLabel} placeholder="搜索" value={query} onChange={event => onQuery(event.target.value)} /><kbd aria-hidden="true">{shortcut}</kbd></label>
      {onNew && <button className="conversation-new-button" type="button" title="新对话" aria-label="新对话" disabled={newDisabled} onClick={onNew}><Icon name="square-pen" /><span>新对话</span></button>}
    </div>
    <div className="history-list">{children}</div>
    {bottom && <div className="history-bottom">{bottom}</div>}
  </>;
}
