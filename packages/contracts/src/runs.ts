/** Schedule result processing, separate from Daylight synchronization and external receipts. */
export type RunResultDelivery = {
  status: "pending" | "running" | "completed" | "failed" | "unknown";
  phase?: "deliver" | "notify";
  attempts?: number;
  rebuilds?: number;
  error?: string;
  /** queued means durable notification admission, never recipient delivery. */
  notification?: "queued" | "skipped" | "unknown";
};
/** A task can produce several runs; neither a completed run nor a model report is human acceptance. */
export type UnifiedRun = {
  id: string;
  taskId: string;
  conversationId: number;
  workerConversationId?: number;
  source: "delegate" | "background" | "schedule" | "goal";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "waiting" | "review" | "interrupted";
  text: string;
  startedAt: number | null;
  finishedAt: number | null;
  result: string | null;
  error: string | null;
  evidence: string[];
  cancellation: "not_requested" | "requested" | "confirmed" | "unknown";
  delivery: { status: "not_applicable" | "pending" | "delivered" | "failed" | "unknown"; detail?: string };
  resultDelivery?: RunResultDelivery;
  review: { status: "pending" | "accepted" | "rejected" | "not_applicable"; note?: string; reviewedAt?: number };
  /** Opaque fingerprint of the execution result, independent of a review. */
  revision: string;
};
export type RunReviewRequest = { runId: string; revision: string; decision: "accepted" | "rejected"; note?: string };
