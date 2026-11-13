import type { DesktopAgentSnapshot } from "@assistant/contracts";
import { MarkdownContent } from "../chat/MarkdownContent.js";

const labels = { running: "执行中", succeeded: "执行完成", failed: "失败", cancelled: "已取消", interrupted: "已中断", unknown: "历史结果未知" };
export function AgentRuns({ snapshot }: { snapshot: DesktopAgentSnapshot }) {
  if (snapshot.agent === "pi") return <details><summary>本机执行记录</summary><p>Pi 的逐次执行记录尚未接入此视图，请查看对话和任务状态。</p></details>;
  const runs = snapshot.runs;
  if (!runs?.length) return null;
  return <details className="desktop-agent-runs"><summary>本机执行记录 · {runs.length}</summary>
    <p>展示执行结果，不代表成果已验收；本机结果暂不支持持久人工验收。</p>
    {[...runs].reverse().map(run => <details key={`${run.sessionId}:${run.id}`}>
      <summary>{labels[run.status]} · {run.request.slice(0, 80)}</summary>
      <p>请求 {run.id} · 会话 {run.sessionId}{run.nativeSessionId ? ` · 原生会话 ${run.nativeSessionId}` : ""}</p>
      <div className="md"><MarkdownContent text={run.request} /></div>
      {run.result && <div className="md"><MarkdownContent text={run.result} /></div>}
      {run.cancellation === "confirmed" && <p>执行已停止，已产生的改动未回滚。</p>}
      {run.cancellation === "unknown" && <p>停止结果未确认，请核对原生会话。</p>}
    </details>)}
  </details>;
}
