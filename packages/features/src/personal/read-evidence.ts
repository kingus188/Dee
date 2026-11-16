import { createHash } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import type { Tx } from "@earendil-works/pi-durable";
import { toolInputInTx, UserOriginError, type ToolOrigin } from "@assistant/runtime";

export const MEMORY_READ_EVIDENCE_LIMIT = 256;
export type MemoryReadReceipt = {
  id: string; kind: "explicit_read"; conversationId: number; taskId: number;
  callId: string; memoryId: string; revision: number; observedAt: number;
};
/** A bounded execution-observation ledger, not proof of citation or user acceptance.
 * SDK SQLite mints global monotonic task IDs from persisted next_id. Retiring
 * entire task groups prevents evicted safe-tool replays from becoming new usage.
 * A first delayed read below the watermark also remains unrecorded. */
export const MemoryReadEvidence = defineDoc<{ items: MemoryReadReceipt[]; retiredThroughTaskId?: number }>({
  kind: "app.memory-read-evidence", version: 1, scope: "conversation", fork: "initial", history: "latest", initial: () => ({ items: [] }),
});
export type MemoryReadObservation = { recorded: true; receipt: MemoryReadReceipt }
  | { recorded: false; reason: "unverified_tool_origin" | "outside_window" };

export async function recordMemoryRead(tx: Tx, origin: ToolOrigin, memoryId: string, revision: number): Promise<MemoryReadObservation> {
  if (!Number.isSafeInteger(origin.taskId) || !Number.isSafeInteger(origin.conversationId) || typeof origin.callId !== "string" || !origin.callId || origin.callId.length > 512
    || !memoryId || memoryId.length > 512 || !Number.isSafeInteger(revision) || revision < 1) {
    return { recorded: false, reason: "unverified_tool_origin" };
  }
  try { await toolInputInTx(tx, origin); }
  catch (error) {
    if (error instanceof UserOriginError) return { recorded: false, reason: "unverified_tool_origin" };
    throw error;
  }
  const id = createHash("sha256").update(JSON.stringify([origin.conversationId, origin.taskId, origin.callId, memoryId, revision])).digest("hex");
  const doc = await tx.doc(MemoryReadEvidence, origin.conversationId);
  if (origin.taskId <= (doc.retiredThroughTaskId ?? -1)) return { recorded: false, reason: "outside_window" };
  const previous = doc.items.find(item => item.id === id);
  if (previous) return { recorded: true, receipt: { ...previous } };
  const receipt: MemoryReadReceipt = { id, kind: "explicit_read", conversationId: origin.conversationId, taskId: origin.taskId, callId: origin.callId, memoryId, revision, observedAt: Date.now() };
  doc.items.push(receipt);
  doc.items.sort((a, b) => a.taskId - b.taskId || a.id.localeCompare(b.id));
  if (doc.items.length > MEMORY_READ_EVIDENCE_LIMIT) {
    const cutoff = doc.items[doc.items.length - MEMORY_READ_EVIDENCE_LIMIT - 1].taskId;
    doc.retiredThroughTaskId = Math.max(doc.retiredThroughTaskId ?? -1, cutoff);
    doc.items = doc.items.filter(item => item.taskId > cutoff);
  }
  if (origin.taskId <= (doc.retiredThroughTaskId ?? -1)) return { recorded: false, reason: "outside_window" };
  return { recorded: true, receipt: { ...receipt } };
}
