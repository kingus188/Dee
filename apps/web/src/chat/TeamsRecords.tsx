import type { ToolActivity } from "./activities.js";
import { MediaItems, teamsMedia, type Media } from "./TeamsMedia.js";
import { Icon } from "../ui/Icon.js";

export type ChatRecord = { chatId: string; id: string; chatLabel: string; sender: string; createdAt: string; text: string; direction?: "in" | "out" | "unknown"; deleted: boolean; media: Media[] };

export function teamsRecords(activities: ToolActivity[]) {
  const messages = new Map<string, ChatRecord>();
  for (const activity of activities) {
    if (!["teams_history", "teams_archive", "teams_messages"].includes(activity.name) || activity.status !== "completed") continue;
    for (const marker of activity.text.matchAll(/^<teams-records>([^\n]*)<\/teams-records>$/gm)) {
      let data: unknown;
      try { data = JSON.parse(marker[1]); } catch { continue; }
      if (!Array.isArray(data)) continue;
      for (const item of data) {
        if (!item || typeof item.chatId !== "string" || typeof item.id !== "string" || typeof item.sender !== "string" || typeof item.text !== "string" || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) continue;
        const media = teamsMedia([{ ...activity, text: `<teams-media>${JSON.stringify(item.media)}</teams-media>` }]);
        messages.set(JSON.stringify([item.chatId, item.id]), { chatId: item.chatId, id: item.id, sender: item.sender,
          direction: item.direction === "in" || item.direction === "out" ? item.direction : "unknown",
          chatLabel: typeof item.chatLabel === "string" ? item.chatLabel : "聊天记录", createdAt: item.createdAt, text: item.text, deleted: item.deleted === true, media });
      }
    }
  }
  return [...messages.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.chatId.localeCompare(b.chatId) || a.id.localeCompare(b.id));
}

export function TeamsRecords({ records, onQuote }: { records: ChatRecord[]; onQuote?: (record: ChatRecord) => void }) {
  const chats = new Map<string, ChatRecord[]>();
  for (const record of records) chats.set(record.chatId, [...(chats.get(record.chatId) ?? []), record]);
  return <div className="teams-records-inline">{[...chats].map(([chatId, messages]) => <details className="teams-records-chat" key={chatId} open>
    <summary className="teams-records-heading"><span className="teams-records-provider" aria-hidden="true">T</span><span><strong>{messages[0].chatLabel}</strong><small>Teams · {new Date(messages[0].createdAt).toLocaleDateString("zh-CN")} · {messages.length} 条消息</small></span><Icon name="chevron-down" /></summary>
    <div className="teams-records-scroll" role="region" aria-label={`${messages[0].chatLabel} 的 Teams 聊天记录`} tabIndex={0}>
    <ol>{messages.map((message, index) => {
      const previous = messages[index - 1], at = new Date(message.createdAt);
      const day = !previous || new Date(previous.createdAt).toDateString() !== at.toDateString();
      const gap = previous ? at.getTime() - Date.parse(previous.createdAt) : Infinity;
      const grouped = !day && !message.deleted && !previous.deleted && message.direction === "out" && previous.direction === "out" && gap >= 0 && gap <= 60_000;
      return <li className={`teams-record${grouped ? " is-grouped" : ""}`} key={message.id} data-teams-message-id={message.id} data-direction={message.direction ?? "unknown"}>
        {day && index > 0 && <div className="teams-record-day"><time dateTime={at.toLocaleDateString("en-CA")}>{at.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}</time></div>}
        <div className="teams-record-message">
          <span className="teams-record-avatar" aria-hidden="true">{Array.from(message.sender.trim())[0] || "?"}</span>
          <div className="teams-record-content">
            <header><strong>{message.sender}{message.direction === "out" && " · 我"}</strong><time dateTime={message.createdAt} title={at.toLocaleString("zh-CN", { hour12: false })}>{at.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time></header>
            <div className="teams-record-bubble" title={at.toLocaleString("zh-CN", { hour12: false })}>
              {message.deleted ? <p className="teams-record-deleted">此消息已删除</p> : <>{message.text && <p className="teams-record-text">{message.text}</p>}
                {!!message.media.length && <div className="teams-record-attachments"><MediaItems media={message.media} /></div>}</>}
            </div>
            {!message.deleted && onQuote && <button type="button" className="teams-record-quote" aria-label={`引用 ${message.sender} 的消息`} onClick={() => onQuote(message)}>引用</button>}
          </div>
        </div>
      </li>;
    })}</ol>
    </div>
  </details>)}</div>;
}
