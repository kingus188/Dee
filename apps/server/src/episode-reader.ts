import type { Context } from "@earendil-works/chord";
import type { Runtime, ConversationItem } from "@assistant/runtime";
import type { EpisodeReader, OpenItem } from "@assistant/features";
import type { EpisodeStore, StoredEpisode } from "./episode-store.js";
import type { TeamsSender } from "./teams-reply-port.js";
import { createPrivateConversationAccess, PrivateConversationAccessError } from "./conversation-access.js";

// Audience and current source access are checked at consumption, independently
// of the permission check performed when a summary was generated.
export function createEpisodeReader(runtime: Runtime, ctx: Context, store: EpisodeStore, options: {
  offline(): boolean;
  teams: Pick<TeamsSender, "canReadEpisodeSource">;
  enrichOpenItems?: (episode: StoredEpisode) => Promise<OpenItem[]>;
}): EpisodeReader {
  const visible = createPrivateConversationAccess(runtime, ctx, store);
  const local = (row: StoredEpisode, items: ConversationItem[]) => {
    if (!store.sourceAllowed(row.source, row.sourceRevision, row.messageIds)) return false;
    if (row.source.startsWith("teams:")) return row.channel === "teams" && row.source.length > 6 && !options.offline();
    return items.some(item => row.source === `conv:${item.id}` && row.channel === (item.channel ?? "web"));
  };
  async function authorized<T>(caller: number, rows: StoredEpisode[], project: (row: StoredEpisode) => Promise<T>) {
    const callerRevision = store.sourceRevision(`conv:${caller}`);
    const initial = await visible(caller);
    const selected: Array<{ row: StoredEpisode; value: T }> = [];
    for (const row of rows) {
      if (!local(row, initial)) continue;
      const value = await project(row);
      if (row.source.startsWith("teams:")) {
        // No successful-access cache or offline fallback. The existing probe
        // discards remote bodies and binds the current account to source state.
        try { if (!options.teams.canReadEpisodeSource || !await options.teams.canReadEpisodeSource(row.source.slice(6))) continue; }
        catch { continue; }
      }
      selected.push({ row, value });
    }
    const current = await visible(caller);
    if (!store.sourceAllowed(`conv:${caller}`, callerRevision)) throw new PrivateConversationAccessError("对话访问范围已变化，请重新查询");
    return selected.filter(({ row }) => local(row, current) && store.peek(row.id)?.sourceRevision === row.sourceRevision);
  }
  return {
    async search(caller, tokens, limit) {
      return (await authorized(caller, store.search(tokens, limit), async row => row)).flatMap(({ row }) => {
        const exposed = store.expose(row.id, row.sourceRevision);
        return exposed ? [exposed] : [];
      });
    },
    async read(caller, id) {
      const row = store.peek(id);
      const allowed = await authorized(caller, row ? [row] : [], async row => row);
      return allowed.length ? store.read(id, allowed[0].row.sourceRevision) : undefined;
    },
    async openItems(caller, days, limit) {
      const items = store.openItems(days, limit);
      const rows = [...new Set(items.map(item => item.episodeId))].map(id => store.peek(id)).filter((row): row is StoredEpisode => !!row);
      try {
        const selected = (await authorized(caller, rows, async row => options.enrichOpenItems ? options.enrichOpenItems(row)
          : items.filter(item => item.episodeId === row.id).map(item => ({ ...item, verification: "unverified" as const }))))
          .flatMap(item => item.value).slice(0, limit);
        const exposed = new Set<string>();
        for (const item of selected) {
          if (item.episodeId && item.sourceRevision !== undefined && !exposed.has(item.episodeId) && store.expose(item.episodeId, item.sourceRevision)) exposed.add(item.episodeId);
        }
        return selected.filter(item => item.episodeId && exposed.has(item.episodeId));
      } catch (error) {
        // An automatic section must not prevent external-channel conversations
        // from running; it simply supplies no private memory to that audience.
        if (error instanceof PrivateConversationAccessError) return [];
        throw error;
      }
    },
  };
}
