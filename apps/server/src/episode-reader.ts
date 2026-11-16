import type { Context } from "@earendil-works/chord";
import type { Runtime, ConversationItem } from "@assistant/runtime";
import type { EpisodeReader, OpenItem } from "@assistant/features";
import type { EpisodeStore, StoredEpisode, EpisodePage, EpisodeCursor } from "./episode-store.js";
import type { TeamsSender } from "./teams-reply-port.js";
import { verifyEpisodeReadCall } from "./episode-read-evidence.js";
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
  type ProbeBudget = { remaining: number; deadline: number; limited: boolean };
  async function probe(source: string, budget: ProbeBudget) {
    if (!budget.remaining || Date.now() >= budget.deadline) { budget.limited = true; return false; }
    budget.remaining--;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([options.teams.canReadEpisodeSource?.(source.slice(6)) ?? Promise.resolve(false),
        new Promise<false>(resolve => { timer = setTimeout(() => { budget.limited = true; resolve(false); }, Math.max(0, budget.deadline - Date.now())); })]);
    } catch { return false; }
    finally { clearTimeout(timer); }
  }
  async function authorized<T>(caller: number, rows: StoredEpisode[], project: (row: StoredEpisode) => Promise<T>, budget: ProbeBudget = { remaining: 12, deadline: Date.now() + 5000, limited: false }) {
    const callerRevision = store.sourceRevision(`conv:${caller}`);
    const initial = await visible(caller);
    const selected: Array<{ row: StoredEpisode; value: T }> = [];
    for (const row of rows) {
      if (!local(row, initial)) continue;
      const value = await project(row);
      if (row.source.startsWith("teams:")) {
        // No successful-access cache or offline fallback. The existing probe
        // discards remote bodies and binds the current account to source state.
        if (!await probe(row.source, budget)) continue;
      }
      selected.push({ row, value });
    }
    const current = await visible(caller);
    if (!store.sourceAllowed(`conv:${caller}`, callerRevision)) throw new PrivateConversationAccessError("对话访问范围已变化，请重新查询");
    return selected.filter(({ row }) => local(row, current) && store.peek(row.id)?.sourceRevision === row.sourceRevision);
  }
  async function scan<T>(caller: number, limit: number, page: (cursor?: EpisodeCursor) => EpisodePage, project: (row: StoredEpisode) => Promise<T>, size: (value: T) => number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error("摘要读取数量应为1～10");
    const revision = store.sourceRevision(`conv:${caller}`);
    await visible(caller);
    const budget = { remaining: 12, deadline: Date.now() + 5000, limited: false };
    const found: Array<{ row: StoredEpisode; value: T }> = [];
    let cursor: EpisodeCursor | undefined, scanned = 0, more = false;
    for (let batch = 0; batch < 8; batch++) {
      const next = page(cursor); scanned += next.scanned;
      found.push(...await authorized(caller, next.items, project, budget));
      cursor = next.next; more = !!cursor;
      if (!cursor || found.reduce((sum, item) => sum + size(item.value), 0) >= limit) break;
    }
    // Later page/probe waits can revoke an earlier accepted page. Recheck the
    // entire selected set and caller once more, before any exposure is recorded.
    const current = await visible(caller);
    if (!store.sourceAllowed(`conv:${caller}`, revision)) throw new PrivateConversationAccessError("对话访问范围已变化，请重新查询");
    return { found: found.filter(({ row }) => local(row, current) && store.peek(row.id)?.sourceRevision === row.sourceRevision),
      scan: { scanned, limited: more || budget.limited } };
  }
  return {
    async search(caller, tokens, limit) {
      const result = await scan(caller, limit, cursor => store.searchPage(tokens, 10, cursor), async row => row, () => 1);
      const rows = result.found.slice(0, limit).flatMap(({ row }) => {
        const exposed = store.expose(row.id, row.sourceRevision);
        return exposed ? [exposed] : [];
      });
      return Object.assign(rows, { scan: result.scan });
    },
    async read(caller, id, call) {
      const evidence = await verifyEpisodeReadCall(runtime, ctx, caller, call);
      const row = store.peek(id);
      const allowed = await authorized(caller, row ? [row] : [], async row => row);
      return allowed.length ? store.read(id, allowed[0].row.sourceRevision, evidence) : undefined;
    },
    async openItems(caller, days, limit) {
      try {
        const result = await scan(caller, limit, cursor => store.openItemsPage(days, 10, cursor), async row => options.enrichOpenItems ? options.enrichOpenItems(row)
          : row.openItems.map(text => ({ label: row.label, text, at: row.periodEnd, episodeId: row.id, source: row.source,
            sourceRevision: row.sourceRevision, messageIds: row.messageIds, verification: "unverified" as const })), items => items.length);
        const selected = result.found.flatMap(item => item.value).slice(0, limit);
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
