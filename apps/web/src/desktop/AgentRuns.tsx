import { useState } from "react";
import type { DesktopAgentRun, DesktopRunReviewInput, DesktopAgentSnapshot } from "@assistant/contracts";
import { MarkdownContent } from "../chat/MarkdownContent.js";

const labels = { running: "Running", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted", unknown: "Unknown" };
export function AgentRuns({ snapshot, review, disabled }: { snapshot: DesktopAgentSnapshot; review?: (input: DesktopRunReviewInput) => Promise<void>; disabled?: boolean }) {
  if (snapshot.agent === "pi") return <details><summary>本机执行记录</summary><p>Pi 的逐次执行记录尚未接入此视图，请查看对话和任务状态。</p></details>;
  const runs = snapshot.runs;
  if (!runs?.length) return null;
  return <details className="desktop-agent-runs"><summary>本机执行记录 · {runs.length}</summary>

    {[...runs].reverse().map(run => <details key={`${run.sessionId}:${run.id}`}>
      <summary>{labels[run.status]} · {run.request.slice(0, 80)}</summary>
      <p>请求 {run.id} · 会话 {run.sessionId}{run.nativeSessionId ? ` · 原生会话 ${run.nativeSessionId}` : ""}</p>
      <div className="md"><MarkdownContent text={run.request} /></div>
      {run.result && <div className="md"><MarkdownContent text={run.result} /></div>}
      <RunReview key={`${run.resultVersion}:${run.reviewRevision}`} run={run} review={review} disabled={disabled} />
      {run.cancellation === "confirmed" && <p>执行已停止，已产生的改动未回滚。</p>}
      {run.cancellation === "unknown" && <p>停止结果未确认，请核对原生会话。</p>}
    </details>)}
  </details>;
}

function RunReview({ run, review, disabled }: { run: DesktopAgentRun; review?: (input: DesktopRunReviewInput) => Promise<void>; disabled?: boolean }) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function decide(decision: DesktopRunReviewInput["decision"]) {
    if (!review || !run.resultVersion) return;
    setPending(true); setError("");
    try { await review({ sessionId: run.sessionId, requestId: run.id, resultVersion: run.resultVersion, expectedRevision: run.reviewRevision ?? 0, decision, reason }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Review was not saved"); }
    finally { setPending(false); }
  }
  return <section aria-label="Result review">
    <p>Review: {run.review === "unsupported" ? "Unavailable" : run.review === "pending" ? "Pending" : run.review === "accepted" ? "Accepted" : "Rejected"}</p>
    {run.resultVersion && review && <>
      <textarea aria-label="Review reason (optional)" placeholder="Reason (optional)" maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} disabled={pending || disabled} />
      <button type="button" disabled={pending || disabled} onClick={() => void decide("accepted")}>Accept</button>
      <button type="button" disabled={pending || disabled} onClick={() => void decide("rejected")}>Reject</button>
    </>}
    {!!run.reviews?.length && <details><summary>Review history</summary>{run.reviews.map(item => <p key={item.revision}>{item.decision === "accepted" ? "Accepted" : "Rejected"} · {item.reviewedAt} · {item.resultVersion.slice(0, 12)}{item.reason ? ` · ${item.reason}` : ""}</p>)}</details>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
