import type { DesktopAgentSnapshot } from "@assistant/contracts";
import { agentNames } from "./AgentPicker.js";

export function AgentContext({ snapshot, children }: { snapshot: DesktopAgentSnapshot; children?: import("react").ReactNode }) {
  const capabilities = snapshot.capabilities, handoff = snapshot.handoff;
  if (!capabilities && !handoff && !snapshot.busy && !snapshot.runs?.length && !snapshot.conversationSync) return null;
  return <details className="desktop-agent-context">
    <summary>{handoff ? `${agentNames[handoff.source]} → ${agentNames[handoff.target]} · 上下文交接` : "执行位置与 Agent 能力"}</summary>
    <dl className="related-task-fields">
      <div><dt>Runs on</dt><dd>Local · {snapshot.nodeId}</dd></div>
      <div><dt>Workspace</dt><dd>{snapshot.workspace ?? "Not selected"}</dd></div>
      <div><dt>服务端连接</dt><dd>{snapshot.serverConnected ? "Connected" : "Disconnected"}</dd></div>
      <div><dt>Sync status</dt><dd>{!snapshot.conversationSync ? "Unknown" : snapshot.conversationSync.status === "local" ? "Local only" : snapshot.conversationSync.status === "pending" ? "Pending" : "Synced"}</dd></div>
      <div><dt>Waiting for</dt><dd>{snapshot.conversationSync?.serverMismatch && snapshot.conversationSync.mode !== "local" ? "Original server" : snapshot.external?.approvals.length ? "Approval" : snapshot.conversationSync && snapshot.conversationSync.mode !== "local" && !snapshot.serverConnected ? "Server connection" : snapshot.busy ? "Execution result" : "Nothing"}</dd></div>
      <div><dt>控制范围</dt><dd>本机执行在此客户端控制；未同步历史不受服务端归档控制。本机结果暂不支持持久人工验收。</dd></div>
    </dl>
    {children}
    <p>Workspace selection is not a sandbox. Local execution stays available when the server disconnects; cloud models still require a network.</p>
    {handoff && <>
      <p>{handoff.status === "pending" ? "下次发送时携带" : "已提交执行（不代表执行成功）"}：最近 {handoff.includedMessages} / {handoff.totalMessages} 条文字消息{handoff.omittedMessages > 0 ? `，${handoff.omittedMessages} 条未携带` : ""}。</p>
      <p>不携带附件、工具执行状态或隐藏推理；当前用户消息完整保留。</p>
    </>}
    {capabilities && <p>原生会话恢复：{capabilities.nativeResume === "supported" ? "支持" : capabilities.nativeResume === "unsupported" ? "不支持" : "等待 Agent 协议确认"}；审批：{capabilities.approval === "tool-callback" ? "支持工具调用审批，按当前权限设置执行" : "支持 Provider 请求审批，按当前权限设置执行"}；停止：{capabilities.cancellation === "runtime-task" ? "运行时取消" : "终止进程，不回滚已产生的改动"}。不支持上下文回滚。</p>}
  </details>;
}
