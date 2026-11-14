import type { AttentionItem, WorkspaceAttention, ExecutionRun, WorkspaceActivities, WorkspaceActivity, WorkspaceMail } from "@assistant/contracts";
import { Executions } from "@assistant/features";
import { WechatState } from "@assistant/channel-wechat";
import { attentionItems } from "./attention.js";
import { Index } from "@assistant/runtime";
import type { AppContext } from "./context.js";
import type { createConversations } from "./conversations.js";
import type { createManagement } from "./management.js";

function priority(item: WorkspaceActivity): number {
  if (item.status === "running") return 0;
  if (item.status === "failed") return 1;
  if (item.status === "scheduled" || item.status === "active") return 2;
  if (item.status === "paused") return 3;
  if (item.status === "cancelled") return 5;
  return 4;
}
function compareActivities(a: WorkspaceActivity, b: WorkspaceActivity): number {
  const rank = priority(a) - priority(b);
  if (rank) return rank;
  // Pending work: nearest due first, unknown due dates last. History: most recent first.
  const time = priority(a) === 2
    ? (a.at ?? Number.MAX_VALUE) - (b.at ?? Number.MAX_VALUE)
    : (b.at ?? b.createdAt) - (a.at ?? a.createdAt);
  if (time) return time;
  return a.conversationId - b.conversationId || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function createWorkspace(
  { harness, ctx, mail, root, episodeStore }: Pick<AppContext, "harness" | "ctx" | "mail" | "root" | "episodeStore">,
  conversations: Pick<ReturnType<typeof createConversations>, "getConversation">,
  management: Pick<ReturnType<typeof createManagement>, "get">,
) {
  async function activities(): Promise<WorkspaceActivities> {
    const index = await harness.snapshot(Index, ctx);
    const items: WorkspaceActivity[] = [];
    // archive retains an item with archivedAt; remove splices it out of Index.items.
    // A never-materialized index is the initial empty personal space, not a read failure.
    for (const owner of index?.items ?? []) {
      if (owner.archivedAt) continue;
      // Sequential across conversations. Keep management.get's existing terminal correction.
      // Missing indexed conversations and read failures propagate, never become partial success.
      const conversation = await conversations.getConversation(owner.id);
      const data = await management.get(conversation);
      const base = { conversationId: owner.id, conversationTitle: owner.title };
      const ownerCreatedAt = Date.parse(owner.createdAt);
      for (const reminder of data.reminders) items.push({
        ...base, id: String(reminder.id), kind: "reminder", text: reminder.text,
        status: reminder.status, at: reminder.at,
        createdAt: Number.isFinite(ownerCreatedAt) ? ownerCreatedAt : 0,
      });
      for (const schedule of data.schedules) items.push({
        ...base, id: schedule.id, kind: "schedule", text: schedule.text,
        status: schedule.status, at: schedule.nextAt, createdAt: schedule.createdAt,
      });
      for (const job of data.background) items.push({
        ...base, id: job.id, kind: "background", text: job.text, status: job.status,
        at: job.finishedAt ?? job.createdAt, createdAt: job.createdAt, result: job.result,
      });
    }
    items.sort(compareActivities);
    return { items: items.slice(0, 200), total: items.length, truncated: items.length > 200 };
  }
  async function attention(): Promise<WorkspaceAttention> {
    async function visible() {
      const index = await harness.snapshot(Index, ctx);
      const bindings = (await harness.snapshot(WechatState, ctx))?.bindings ?? {};
      const bound = new Set(Object.values(bindings).map(binding => Number(binding.conversationId)));
      return (index?.items ?? []).filter(owner => owner.id !== root.id && !owner.archivedAt && !bound.has(owner.id)
        && episodeStore.sourceAllowed(`conv:${owner.id}`) && (!owner.channel || ["web", "desktop"].includes(owner.channel)));
    }
    const observations = new Map<number, { revision: number; data: Awaited<ReturnType<typeof management.get>> }>();
    for (const owner of await visible()) {
      const revision = episodeStore.sourceRevision(`conv:${owner.id}`);
      const conversation = await conversations.getConversation(owner.id);
      observations.set(owner.id, { revision, data: await management.get(conversation, { retryDelivery: false }) });
    }
    const items: AttentionItem[] = [];
    // Async reads must not return a source removed, revoked, archived or rebound in the meantime.
    // Use the fresh owner's title/state rather than a pre-await snapshot.
    for (const owner of await visible()) {
      const observation = observations.get(owner.id);
      if (!observation || observation.revision !== episodeStore.sourceRevision(`conv:${owner.id}`)
        || !episodeStore.sourceAllowed(`conv:${owner.id}`, observation.revision)) continue;
      items.push(...attentionItems(owner, observation.data));
    }
    items.sort((a, b) => Number(b.reasons.includes("Archive pending")) - Number(a.reasons.includes("Archive pending"))
      || (b.at ?? 0) - (a.at ?? 0) || a.id.localeCompare(b.id));
    return { items: items.slice(0, 200), total: items.length, truncated: items.length > 200 };
  }
  function recentMail(): WorkspaceMail {
    const { enabled, connected, offline, syncing, lastSuccessAt, error } = mail.status();
    return { status: { enabled, connected, offline, syncing, lastSuccessAt, error }, messages: mail.list({ limit: 6 }) };
  }
  return { activities, attention, mail: recentMail };
}
