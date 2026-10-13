import type { PersonalData } from "@assistant/contracts";
import type { ConversationCard, CardAction } from "../chat/cards.js";

export function personalCards(data: PersonalData): ConversationCard[] {
  const cards: ConversationCard[] = [];
  for (const [group, items] of [["memory", data.memory], ["skills", data.skills]] as const) {
    for (const item of items) {
      const path = "/api/personal/" + group + "/" + encodeURIComponent(item.id);
      const actions: CardAction[] = [];
      if (item.status === "pending") actions.push({ label: group === "memory" ? "确认记住" : "批准技能", kind: "request", path: path + "/approve" });
      if (group === "memory" && "text" in item && item.status !== "rejected") actions.push({ label: "修改", kind: "edit", path: path + "/edit", text: item.text });
      if (item.status !== "rejected") actions.push({ label: item.status === "approved" ? "撤回" : "暂不保存", kind: "request", path: path + "/reject" });
      cards.push({
        key: group + ":" + item.id, group,
        title: group === "memory" ? "关于你的记忆" : "技能",
        text: "text" in item ? item.text : item.name + "\n" + item.description,
        status: { pending: "待你确认", approved: "已生效", rejected: "未生效" }[item.status],
        tone: item.status === "pending" ? "pending" : item.status === "approved" ? "done" : undefined,
        meta: item.status === "pending" ? "确认后才会用于以后的聊天。" : item.status === "approved" ? "以后聊天时会记得，随时可以撤回。" : "这条内容不会用于后续聊天。",
        details: "body" in item ? item.body : undefined, actions,
      });
    }
  }
  return cards;
}
