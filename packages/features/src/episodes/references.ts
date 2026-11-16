/** Locators only: producing tool arguments does not verify or fetch the originals. */
export function episodeReferences(row: { source: string; messageIds: readonly string[] }) {
  const references: { tool: string; arguments: Record<string, string | number> }[] = [];
  for (const id of row.messageIds) {
    if (row.source.startsWith("teams:")) {
      const chatId = row.source.slice(6), prefix = chatId + ":";
      if (chatId && id.startsWith(prefix) && id.length > prefix.length) references.push({ tool: "teams_history", arguments: { chatId, messageId: id.slice(prefix.length) } });
    } else if (/^conv:\d+$/.test(row.source) && /^\d+$/.test(id)) {
      const conversationId = Number(row.source.slice(5)), entryId = Number(id);
      if (Number.isSafeInteger(conversationId) && conversationId > 0 && Number.isSafeInteger(entryId + 1) && entryId > 0) {
        references.push({ tool: "read_conversation", arguments: { conversationId, beforeEntryId: entryId + 1, limit: 1 } });
      }
    }
  }
  return { references: references.slice(0, 8), total: references.length, truncated: references.length > 8,
    unavailable: references.length !== row.messageIds.length || !references.length, verified: false as const };
}
