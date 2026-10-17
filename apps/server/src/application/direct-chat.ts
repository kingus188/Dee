import { Index } from "@assistant/runtime";
import { AgentDoc, configure } from "@earendil-works/pi-durable";
import type { AppContext } from "./context.js";

export function openDirectChat({ root, ctx, agentModel }: Pick<AppContext, "root" | "ctx" | "agentModel">, { fresh = false }: { fresh?: boolean } = {}) {
  // 普通打开恢复最新网页会话；只有显式新建才另开。选择和创建共用事务。
  return root.commit(async tx => {
    const index = await tx.doc(Index);
    const available = index.items.filter(item => !item.archivedAt && !item.forkOf);
    let existing;
    for (const item of fresh ? [] : [...available.filter(item => item.channel === "web").reverse(), ...available.filter(item => !item.channel).reverse()]) {
      // Unbound legacy chats may also contain simulated history.
      const model = (await tx.doc(AgentDoc, item.id)).model;
      if (agentModel.provider !== "faux" && (!model || model.provider === "faux")) continue;
      existing = item;
      break;
    }
    if (existing) {
      existing.channel = "web";
      // Repair older unbound chats while preserving any model the user already selected.
      if (!(await tx.doc(AgentDoc, existing.id)).model) await configure(tx, existing.id, { model: agentModel });
      return existing.id;
    }
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, conversation.id, { model: agentModel });
    index.items.push({ id: conversation.id, title: "小 D", channel: "web", createdAt: new Date().toISOString() });
    return conversation.id;
  }, ctx);
}
