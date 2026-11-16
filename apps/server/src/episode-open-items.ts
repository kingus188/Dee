import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { Index } from "@assistant/runtime";
import { Executions, Goals } from "@assistant/features";
import type { OpenItem } from "@assistant/features";
import type { AppContext } from "./application/context.js";
import type { StoredEpisode } from "./episode-store.js";

// An ID in both source text and summary is only a reference, not proof that the
// entire summarized commitment belongs to that task. Never hide or resolve it.
function mentions(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_:-])${escaped}($|[^A-Za-z0-9_:-])`).test(text);
}
export function createEpisodeOpenItems({ harness, ctx, daylight, sourceAllowed }: Pick<AppContext, "harness" | "ctx" | "daylight"> & {
  sourceAllowed: (episode: StoredEpisode) => boolean | Promise<boolean>;
}) {
  return { async items(episode: StoredEpisode): Promise<OpenItem[]> {
    const base: OpenItem[] = episode.openItems.map(text => ({ label: episode.label, text, at: episode.periodEnd,
      episodeId: episode.id, source: episode.source, sourceRevision: episode.sourceRevision, messageIds: episode.messageIds, verification: "unverified" }));
    const rawOwner = /^conv:([1-9]\d*)$/.exec(episode.source)?.[1];
    if (!rawOwner || !Number.isSafeInteger(Number(rawOwner)) || !episode.messageIds.length || episode.messageIds.length > 200) return base;
    const ownerId = Number(rawOwner) as ConversationId;
    const visible = async () => {
      if (!await sourceAllowed(episode)) return false;
      const owner = (await harness.snapshot(Index, ctx))?.items.find(item => item.id === ownerId);
      return !!owner && !owner.archivedAt && !owner.archivingAt;
    };
    try {
      if (!await visible()) return base;
      const goals = (await harness.snapshot(Goals, ctx))?.items ?? [];
      const goalsObservedAt = new Date().toISOString();
      const runs = (await harness.snapshot(Executions, ownerId, ctx))?.items ?? [];
      const runsObservedAt = new Date().toISOString();
      type Reference = { taskObservedAt: string; taskReference: NonNullable<OpenItem["taskReference"]>; taskStatus: NonNullable<OpenItem["taskStatus"]> };
      const candidates: Reference[] = [];
      const wanted = (id: string) => base.some(item => mentions(item.text, id));
      for (const goal of goals) if (goal.conversationId === ownerId && wanted(goal.id)) candidates.push({
        taskReference: { kind: "goal", id: goal.id }, taskObservedAt: goalsObservedAt,
        taskStatus: goal.status === "completed" ? "completed" : goal.status === "cancelled" ? "cancelled" : goal.status === "review" ? "review" : goal.status === "blocked" ? "failed" : "open",
      });
      for (const run of runs) {
        if (run.conversationId !== ownerId) continue;
        if (wanted(run.id)) candidates.push({ taskReference: { kind: "execution", id: run.id }, taskObservedAt: runsObservedAt,
          taskStatus: run.status === "done" ? "review" : run.status === "failed" ? "failed" : run.status === "cancelled" ? "cancelled" : "open" });
        if (run.daylightTaskId && wanted(run.daylightTaskId) && !candidates.some(item => item.taskReference.kind === "daylight" && item.taskReference.id === run.daylightTaskId)) {
          const task = await daylight.getTask(run.daylightTaskId);
          candidates.push({ taskReference: { kind: "daylight", id: task.id }, taskObservedAt: new Date().toISOString(), taskStatus: task.status === "done" ? "completed" : task.status === "review" ? "review" : "open" });
        }
      }
      if (!candidates.length) return base;
      if (episode.messageIds.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) return base;
      const conversation = await harness.conversation(ownerId, ctx);
      if (!conversation) return base;
      const originals: string[] = [];
      for (const raw of episode.messageIds) {
        const id = Number(raw) as EntryId;
        const page = await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, ctx);
        for (const entry of page.items) {
          if (entry.id !== id || (entry.kind !== "pi.user" && entry.kind !== "pi.assistant")) continue;
          const content = entry.model?.[0]?.content;
          originals.push(typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : "");
        }
      }
      if (!await visible()) return base;
      return base.map(item => {
        const refs = candidates.filter(candidate => mentions(item.text, candidate.taskReference.id) && originals.some(text => mentions(text, candidate.taskReference.id)));
        return refs.length === 1 ? { ...item, ...refs[0] } : item;
      });
    } catch {
      // Missing records or unavailable source evidence cannot establish a reference.
      return base;
    }
  } };
}
