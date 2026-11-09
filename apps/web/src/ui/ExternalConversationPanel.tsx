import { useState, type ReactNode } from "react";
import { Icon } from "./Icon.js";

/** Resizes the reading surface without remounting its current conversation. */
export function ExternalConversationPanel({ active, children, id, label, compact = true }: { active: boolean; children: ReactNode; id: string; label: string; compact?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  return <section className={compact ? "external-message-stage" : "conversation-surface"} hidden={!active} aria-label={compact ? `${label} 消息工作台` : undefined} data-expanded={compact ? expanded : undefined}>
    <div className={compact ? "external-message-shell" : "conversation-surface-shell"}>
      <div className="external-message-toolbar" hidden={!compact}><span>外部消息</span><button className="external-message-resize" type="button" aria-label={expanded ? "收起消息面板" : "展开消息面板"} aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>{expanded ? <Icon name="minimize-2" /> : <Icon name="maximize-2" />}<span>{expanded ? "收起" : "展开"}</span></button></div>
      <div id={id} className={compact ? "external-message-panel" : "conversation-surface-panel"} aria-label={compact ? `${label} 消息面板` : undefined}>{children}</div>
    </div>
  </section>;
}
