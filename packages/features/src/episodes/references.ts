/** Locators only: producing tool arguments does not verify or fetch the originals. */
export function episodeReferences(row: { source: string; messageIds: readonly string[]; sourceRevision?: number }) {
  const references: { tool: string; arguments: Record<string, string | number> }[] = [];
  for (const id of row.messageIds) {
    if (row.source.startsWith("teams:")) {
      const chatId = row.source.slice(6), prefix = chatId + ":";
      if (chatId && id.startsWith(prefix) && id.length > prefix.length) references.push({ tool: "teams_history", arguments: { chatId, messageId: id.slice(prefix.length) } });
    } else if (/^conv:[1-9]\d*$/.test(row.source)) {
      const conversationId = Number(row.source.slice(5));
      if (Number.isSafeInteger(conversationId) && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f]/.test(id)
        && Number.isSafeInteger(row.sourceRevision) && row.sourceRevision! >= 0) {
        references.push({ tool: "read_conversation", arguments: { conversationId, messageId: id, expectedSourceRevision: row.sourceRevision! } });
      }
    }
  }
  return { references: references.slice(0, 8), total: references.length, truncated: references.length > 8,
    unavailable: references.length !== row.messageIds.length || !references.length, verified: false as const };
}
