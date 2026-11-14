import type { AttentionItem, ConversationItem, Management } from "@assistant/contracts";
import { sanitizeEpisodeText } from "../episode-privacy.js";

/** Read-only projection. Review opens the source; it never retries external effects. */
export function attentionItems(owner: ConversationItem, data: Management): AttentionItem[] {
  if (owner.archivedAt) return [];
  const base = { conversationId: owner.id, conversationTitle: sanitizeEpisodeText(owner.title).slice(0, 200) };
  const items: AttentionItem[] = [];
  if (owner.archivingAt || owner.status === "waiting") items.push({ ...base, id: `conversation:${owner.id}`,
    text: owner.archivingAt ? "停止尚未确认；在历史对话中重试或取消归档。" : "对话被标记为等待，请查看下一步。",
    reasons: [owner.archivingAt ? "Archive pending" : "Waiting"], target: "conversation", at: owner.archivingAt ? Date.parse(owner.archivingAt) || null : null });
  for (const run of data.runs ?? []) {
    if (run.source === "goal") {
      const goal = data.goals?.find(goal => goal.id === run.taskId);
      // Old rounds remain inspectable history, not outstanding decisions after a later round.
      if (!goal || goal.status === "completed" || goal.status === "cancelled" || run.id !== `goal:${goal.id}:${goal.round}`) continue;
    }
    const reasons: AttentionItem["reasons"] = [];
    if (run.status === "failed") reasons.push("Failed");
    if (run.status === "interrupted") reasons.push("Interrupted");
    if (run.review.status === "pending") reasons.push("Review pending");
    if (run.delivery.status === "unknown") reasons.push("Delivery unknown");
    if (run.delivery.status === "failed") reasons.push("Delivery failed");
    if (run.cancellation === "requested" || run.cancellation === "unknown") reasons.push("Stop pending");
    if (run.status === "waiting") reasons.push("Waiting");
    if (reasons.length) items.push({ ...base, id: `run:${owner.id}:${run.id}`, runId: run.id,
      text: sanitizeEpisodeText(run.text).slice(0, 300), reasons, target: "tasks", at: run.finishedAt ?? run.startedAt });
  }
  // Older jobs can have a terminal state but no run record.
  for (const [kind, records] of [["background", data.background], ["schedule", data.schedules]] as const) {
    for (const task of records) if (task.status === "failed" && !(data.runs ?? []).some(run => run.source === kind && run.taskId === task.id)) {
      items.push({ ...base, id: `${kind}:${owner.id}:${task.id}`, text: sanitizeEpisodeText(task.text).slice(0, 300), reasons: ["Failed"], target: "tasks", at: task.createdAt });
    }
  }
  return items;
}
