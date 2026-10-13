import { Index } from "@assistant/runtime";
import type { AppContext } from "./context.js";

export function openDirectChat({ root, ctx }: Pick<AppContext, "root" | "ctx">) {
  // 选择和创建放在同一事务里，多标签页也只会得到一个固定聊天。
  return root.commit(async tx => {
    const index = await tx.doc(Index);
    const available = index.items.filter(item => !item.archivedAt && !item.forkOf);
    const existing = available.find(item => item.channel === "web")
      ?? available.findLast(item => !item.channel);
    if (existing) {
      existing.channel = "web";
      return existing.id;
    }
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    index.items.push({ id: conversation.id, title: "小 D", channel: "web", createdAt: new Date().toISOString() });
    return conversation.id;
  }, ctx);
}
