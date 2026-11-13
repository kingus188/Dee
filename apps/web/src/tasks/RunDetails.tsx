import { useState } from "react";
import type { UnifiedRun } from "@assistant/contracts";
import type { CardAction } from "../chat/cards.js";
import { MarkdownContent } from "../chat/MarkdownContent.js";
import { fmt } from "../ui/elements.js";

const states: Record<UnifiedRun["status"], string> = { queued: "等待执行", running: "正在执行", succeeded: "执行成功", failed: "执行失败", cancelled: "已取消", waiting: "等待继续", review: "待验收", interrupted: "已中断" };
const sources: Record<UnifiedRun["source"], string> = { delegate: "子 Agent", background: "后台任务", schedule: "计划任务", goal: "个人委托" };
const delivery: Record<UnifiedRun["delivery"]["status"], string> = { not_applicable: "无独立交付记录", pending: "交付待处理", delivered: "交付已记录", failed: "交付失败", unknown: "交付结果未确认" };
const cancellation: Record<UnifiedRun["cancellation"], string> = { not_requested: "未请求停止", requested: "已请求停止", confirmed: "已确认停止", unknown: "停止结果未确认" };

export function RunDetails({ run, pending, onAction }: { run: UnifiedRun; pending: boolean; onAction: (action: CardAction) => void }) {
  const [note, setNote] = useState("");
  const reviewable = run.source !== "goal" && (run.status === "succeeded" || run.status === "review") && (!run.review || run.review.status === "pending");
  const decide = (decision: "accepted" | "rejected") => onAction({ kind: "request", label: decision === "accepted" ? "确认验收" : "需要修改", path: `/api/conversations/${run.conversationId}/runs/review`, body: { runId: run.id, revision: run.revision, decision, ...(note.trim() ? { note: note.trim() } : {}) } });
  return <details className="execution-detail"><summary>{states[run.status]} · {run.startedAt ? fmt(run.startedAt) : "开始时间未记录"}</summary>
    <dl className="related-task-fields">
      <div><dt>来源</dt><dd>{sources[run.source]} · 会话 #{run.conversationId}</dd></div>
      <div><dt>任务</dt><dd>{run.taskId}</dd></div><div><dt>本次执行</dt><dd>{run.id}</dd></div>
      {run.workerConversationId !== undefined && <div><dt>执行会话</dt><dd>#{run.workerConversationId}</dd></div>}
      {run.finishedAt !== null && <div><dt>结束</dt><dd>{fmt(run.finishedAt)}</dd></div>}
      <div><dt>交付</dt><dd>{delivery[run.delivery.status]}{run.delivery.detail && `：${run.delivery.detail}`}</dd></div>
      {run.cancellation !== "not_requested" && <div><dt>停止</dt><dd>{cancellation[run.cancellation]}</dd></div>}
    </dl>
    {run.result && <article className="md" aria-label="执行成果"><MarkdownContent text={run.result} /></article>}
    {run.evidence.length > 0 && <section aria-label="验收依据"><h4>验收依据</h4><ul>{run.evidence.map((item, i) => <li key={i}>{item}</li>)}</ul></section>}
    {run.error && <p role="alert">{run.error}</p>}
    {run.review?.status === "accepted" && <p role="status">已人工验收{run.review.reviewedAt ? ` · ${fmt(run.review.reviewedAt)}` : ""}</p>}
    {run.review?.status === "rejected" && <p role="status">验收未通过</p>}
    {run.review?.note && <p>{run.review.note}</p>}
    {run.source === "goal" && run.review.status === "pending" && <p>本轮成果等待委托验收，请在任务卡确认完成。</p>}
    {reviewable && <div className="workspace-edit-form" aria-label="成果验收">
      <label>验收备注<input value={note} maxLength={2000} disabled={pending} onChange={event => setNote(event.target.value)} /></label>
      <div className="workspace-record-actions"><button type="button" disabled={pending} onClick={() => decide("accepted")}>确认验收</button><button type="button" disabled={pending} onClick={() => decide("rejected")}>需要修改</button></div>
    </div>}
  </details>;
}
