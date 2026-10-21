import type { BrowserView } from "../types.js";
import type { ConversationCard } from "../chat/cards.js";

export function noteCards(notes: BrowserView["notes"] | undefined): ConversationCard[] {
  if (!notes) return [];
  const cards: ConversationCard[] = [];
  if (notes.memos.length) cards.push({
    key: "notes:memo", group: "notes", title: "随手记",
    text: notes.memos.map(item => typeof item === "string" ? item : item.text || "").join("\n\n"),
    meta: "保存在聊天中。",
    actions: [{ label: "补充想法", kind: "prompt", text: "帮我补充一条备忘：" }],
  });
  return cards;
}
