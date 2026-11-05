import type { ToolActivity } from "./activities.js";
import { MediaItems, teamsMedia, type Media } from "./TeamsMedia.js";

export type ChatRecord = { chatId: string; id: string; chatLabel: string; sender: string; createdAt: string; text: string; deleted: boolean; media: Media[] };

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
          chatLabel: typeof item.chatLabel === "string" ? item.chatLabel : "聊天记录", createdAt: item.createdAt, text: item.text, deleted: item.deleted === true, media });
      }
    }
  }
  return [...messages.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.chatId.localeCompare(b.chatId) || a.id.localeCompare(b.id));
}

export function TeamsRecords({ records }: { records: ChatRecord[] }) {
  const chats = new Map<string, ChatRecord[]>();
  for (const record of records) chats.set(record.chatId, [...(chats.get(record.chatId) ?? []), record]);
  return <div className="teams-records-inline">{[...chats].map(([chatId, messages]) => <section className="teams-records-chat" key={chatId}>
    <h3>{messages[0].chatLabel}</h3>
    <ol>{messages.map(message => <li className="teams-record" key={message.id} data-teams-message-id={message.id}>
      <header><strong>{message.sender}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString("zh-CN", { hour12: false })}</time></header>
      {message.deleted ? <p className="teams-record-deleted">此消息已删除</p> : message.text && <p className="teams-record-text">{message.text}</p>}
      {!!message.media.length && <div className="teams-record-attachments"><MediaItems media={message.media} /></div>}
    </li>)}</ol>
  </section>)}</div>;
}
