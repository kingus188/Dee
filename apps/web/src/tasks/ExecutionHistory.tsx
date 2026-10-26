import type { ExecutionRun } from "@assistant/contracts";
import { renderMarkdown } from "../chat/markdown.js";
import { fmt } from "../ui/elements.js";
const labels = { queued: "等待执行", running: "正在执行", done: "已交付", failed: "执行失败", cancelled: "已停止" };
export function ExecutionHistory({ runs }: { runs: ExecutionRun[] }) {
  return <section aria-label="逐次执行记录">{runs.length ? [...runs].sort((a, b) => b.queuedAt - a.queuedAt).map(run => <details key={run.id}><summary>{labels[run.status]} · {fmt(run.startedAt ?? run.queuedAt)}</summary>
    <p className="workspace-muted">开始：{run.startedAt ? fmt(run.startedAt) : "等待中"} · 结束：{run.finishedAt ? fmt(run.finishedAt) : "尚未结束"}</p>
    {run.result && <article className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(run.result) }} />}
    {run.error && <p role="alert">{run.error}</p>}
    {run.deliveryError && <p role="alert">结果已生成，关联待办待同步：{run.deliveryError}。刷新后会重试。</p>}
    {run.daylightTaskId && <a href={`#tasks/${encodeURIComponent(run.daylightTaskId)}`}>查看关联待办</a>}
  </details>) : <p className="workspace-muted">暂无执行记录，安排触发后会在此保留结果。</p>}</section>;
}
