import type { DesktopAgentSnapshot } from "@assistant/contracts";
import { agentNames } from "./AgentPicker.js";

export function AgentContext({ snapshot }: { snapshot: DesktopAgentSnapshot }) {
  const capabilities = snapshot.capabilities, handoff = snapshot.handoff;
  if (!capabilities && !handoff) return null;
  return <details className="desktop-agent-context">
    <summary>{handoff ? `${agentNames[handoff.source]} → ${agentNames[handoff.target]} · 上下文交接` : "Agent 能力"}</summary>
    {handoff && <>
      <p>{handoff.status === "pending" ? "下次发送时携带" : "已提交执行（不代表执行成功）"}：最近 {handoff.includedMessages} / {handoff.totalMessages} 条文字消息{handoff.omittedMessages > 0 ? `，${handoff.omittedMessages} 条未携带` : ""}。</p>
      <p>不携带附件、工具执行状态或隐藏推理；当前用户消息完整保留。</p>
    </>}
    {capabilities && <p>原生会话恢复：{capabilities.nativeResume === "supported" ? "支持" : capabilities.nativeResume === "unsupported" ? "不支持" : "等待 Agent 协议确认"}；审批：{capabilities.approval === "tool-callback" ? "支持工具调用审批，按当前权限设置执行" : "支持 Provider 请求审批，按当前权限设置执行"}；停止：{capabilities.cancellation === "runtime-task" ? "运行时取消" : "终止进程，不回滚已产生的改动"}。不支持上下文回滚。</p>}
  </details>;
}
