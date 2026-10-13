import type { ViewEntry } from "@assistant/contracts";

// Gina TurnCard 的一轮结构：用户输入、可折叠执行过程、独立回复。
export type ChatTurn = { id: number; user: ViewEntry; entries: ViewEntry[] };
export function chatTurns(entries: ViewEntry[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") turns.push({ id: entry.id, user: entry, entries: [] });
    else if (turns.length) turns.at(-1)!.entries.push(entry);
    else turns.push({ id: -entry.id, user: { id: -entry.id, kind: "user", text: "" }, entries: [entry] });
  }
  return turns;
}
