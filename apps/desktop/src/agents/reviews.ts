import { createHash } from "node:crypto";
import type { DesktopRunReview, DesktopRunReviewInput } from "@assistant/contracts";
import type { StoredAgentSession } from "./session-record.js";

export function resultVersion(session: StoredAgentSession, requestId: string, result: string): string {
  return createHash("sha256").update(JSON.stringify([session.id, requestId, session.messages.find(message => message.role === "user" && message.id === requestId)?.text, "done", result])).digest("hex");
}
export function validReviewHistory(value: unknown): value is Record<string, DesktopRunReview[]> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(history => Array.isArray(history) && history.every((review: DesktopRunReview, index: number) =>
    review && review.revision === index + 1 && /^[a-f0-9]{64}$/.test(review.resultVersion) && ["accepted", "rejected"].includes(review.decision) && typeof review.reviewedAt === "string" && Number.isFinite(Date.parse(review.reviewedAt)) && (review.reason === undefined || typeof review.reason === "string" && review.reason.length <= 2000)));
}
export function reviewResult(session: StoredAgentSession, input: DesktopRunReviewInput, result: string, persist: (session: StoredAgentSession) => void): void {
  if (!input || typeof input.sessionId !== "string" || typeof input.requestId !== "string" || typeof input.resultVersion !== "string" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !["accepted", "rejected"].includes(input.decision) || (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 2000))) throw new Error("Invalid review");
  if (session.id !== input.sessionId || session.requests?.[input.requestId]?.status !== "done" || !session.messages.some(message => message.role === "user" && message.id === input.requestId)) throw new Error("Only completed results can be reviewed");
  const history = session.reviews?.[input.requestId] ?? [];
  if (input.resultVersion !== resultVersion(session, input.requestId, result) || input.expectedRevision !== history.length) throw new Error("Result or review changed; refresh before reviewing");
  const previous = session.reviews;
  session.reviews = { ...previous, [input.requestId]: [...history, { revision: history.length + 1, resultVersion: input.resultVersion, decision: input.decision, reason: input.reason?.trim() || undefined, reviewedAt: new Date().toISOString() }] };
  try { persist(session); } catch (error) { session.reviews = previous; throw error; }
}
