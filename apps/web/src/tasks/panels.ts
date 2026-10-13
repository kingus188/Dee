import type { BrowserView } from "../types.js";
import type { ConversationCard } from "../chat/cards.js";

export function noteCards(notes: BrowserView["notes"] | undefined): ConversationCard[] {
  if (!notes) return [];
  const cards: ConversationCard[] = [];
  if (notes.todos.length) cards.push({
    key: "notes:todo", group: "notes", title: "待办清单",
    text: notes.todos.map(item => `${item.done ? "✓" : "○"} ${item.text}`).join("\n"),
    meta: `已完成 ${notes.todos.filter(item => item.done).length} / ${notes.todos.length} 项`,
    actions: [{ label: "更新待办", kind: "prompt", text: "帮我更新待办清单：" }],
  });
  if (notes.memos.length) cards.push({
    key: "notes:memo", group: "notes", title: "随手记",
    text: notes.memos.map(item => typeof item === "string" ? item : item.text || "").join("\n\n"),
    meta: "保存在聊天中。",
    actions: [{ label: "补充想法", kind: "prompt", text: "帮我补充一条备忘：" }],
  });
  return cards;
}
