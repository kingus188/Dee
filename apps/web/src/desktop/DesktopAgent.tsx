import { useState } from "react";
import { renderMarkdown } from "../chat/markdown.js";
import { Icon } from "../ui/Icon.js";
import { ExternalAgentSettings } from "./ExternalAgentSettings.js";
import { AgentRequests } from "./AgentRequests.js";
import { AgentPicker, agentNames } from "./AgentPicker.js";
import { PermissionPicker } from "./PermissionPicker.js";
import type { useDesktopConversation } from "./useDesktopConversation.js";

type LocalConversation = ReturnType<typeof useDesktopConversation>;

export function DesktopAgentControls({ local }: { local: LocalConversation }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { bridge, snapshot, pending, action, warning } = local;
  if (!bridge) return null;
  const kind = snapshot?.agent ?? "pi";
  return <>
    {warning && <span className="desktop-agent-warning" role="alert" aria-label={warning} title={warning} tabIndex={0}><Icon name="circle-alert" /></span>}
    <AgentPicker bridge={bridge} saved={local.refresh} snapshot={snapshot} disabled={!snapshot || snapshot.busy || pending.length > 0} select={kind => action("agent", () => bridge.selectAgent({ kind }))} settings={() => setSettingsOpen(true)} />
    <PermissionPicker snapshot={snapshot} bridge={bridge} disabled={!snapshot || snapshot.busy || pending.length > 0} select={config => action("permission", () => bridge.selectAgent({ kind, config }))} selectPi={piAccess => action("permission", () => bridge.selectAgent({ kind: "pi", piAccess }))} />
    {(kind === "acp" || kind === "omp") && <button className="icon-button" type="button" aria-label="Agent 设置" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}><Icon name="settings" /></button>}
    {settingsOpen && (kind === "acp" || kind === "omp") && snapshot && <div className="local-agent-settings" role="dialog" aria-label="本机 Agent 设置"><header><strong>{agentNames[kind]}</strong><button type="button" className="icon-button" aria-label="关闭 Agent 设置" onClick={() => setSettingsOpen(false)}><Icon name="x" /></button></header><ExternalAgentSettings key={kind} snapshot={snapshot} bridge={bridge} busy={snapshot.busy || pending.length > 0} saved={local.refresh} /></div>}
  </>;
}

export function DesktopAgent({ local }: { local: LocalConversation }) {
  const { bridge, snapshot, action, pending } = local;
  if (!bridge) return null;
  return <>
    {snapshot?.external?.status === "waiting" && <p className="turn-loading" role="status">等待你处理</p>}
    {snapshot?.external && <AgentRequests activities={snapshot.external.activities} approvals={snapshot.external.approvals} answer={async input => { if (!await action("approval", () => bridge.answerApproval(input))) throw new Error("审批未完成，请重试。"); }} />}
    {snapshot?.jobs.filter(job => job.status === "queued" && job.target === snapshot.nodeId && (job.source === "server" || job.source === snapshot.nodeId)).map(job => <article className="desktop-agent-job" key={job.id}>
      <p role="status">{job.approved ? "等待空闲" : "等待批准"}</p>
      <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(job.task) }} />
      <div className="desktop-agent-job-actions">{!job.approved && <button type="button" className="header-button" disabled={pending.includes(job.id) || ((!job.targetSession || job.targetSession.agent === "pi") && !(snapshot.piConfigured ?? snapshot.configured)) || !!local.pollError} onClick={() => void action(job.id, () => bridge.approve(job.id))}>批准 {agentNames[job.targetSession?.agent ?? "pi"]} 执行</button>}<button type="button" className="header-button" disabled={pending.includes(job.id) || !!local.pollError} onClick={() => void action(job.id, () => bridge.reject(job.id))}>拒绝</button></div>
    </article>)}
  </>;
}
