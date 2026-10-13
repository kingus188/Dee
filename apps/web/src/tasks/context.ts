import type { CardGroup, ConversationCard } from "../chat/cards.js";
import type { ViewEntry } from "../types.js";

export function cardGroupsForTurn(entries: ViewEntry[]) {
  const tools: Record<string, CardGroup> = {
    todo: "notes", memo: "notes", remind_me: "tasks", schedule_task: "tasks", delegate_background: "tasks",
    propose_memory: "memory", propose_skill: "skills",
  };
  const lastUser = entries.findLastIndex(entry => entry.kind === "user");
  const groups = new Set<CardGroup>();
  for (const entry of entries.slice(lastUser + 1)) {
    for (const call of entry.toolCalls ?? []) {
      if (Object.hasOwn(tools, call.name)) groups.add(tools[call.name]);
    }
  }
  return groups;
}

export function visibleCards(cards: ConversationCard[], group: CardGroup | null, kept: ReadonlySet<string>, automatic: ReadonlySet<CardGroup>) {
  return cards.filter(card => group ? card.group === group : kept.has(card.key) ||
    automatic.has(card.group) && (card.group === "tasks" || card.group === "notes" || card.tone === "pending"));
}
