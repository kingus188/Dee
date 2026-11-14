import { ConversationSync } from "./ConversationSync.js";
import { AgentRuns } from "./AgentRuns.js";
import { AgentContext } from "./AgentContext.js";
import { useState } from "react";
import { PeerJobs } from "./PeerJobs.js";
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
    {snapshot && <AgentContext snapshot={snapshot}>
      {snapshot.conversationSync && bridge.setConversationSync && <ConversationSync key={snapshot.conversationSync.sessionId} sync={snapshot.conversationSync} disabled={pending.length > 0 || !!local.pollError} save={async input => {
        if (!await action("conversation-sync", () => bridge.setConversationSync!(input))) throw new Error("Sync preference was not saved. Check the current conversation and try again.");
      }} />}
    </AgentContext>}
    {snapshot && <AgentRuns snapshot={snapshot} />}
    {snapshot?.external?.status === "waiting" && <p className="turn-loading" role="status">等待你处理</p>}
    {snapshot?.external && <AgentRequests activities={snapshot.external.activities} approvals={snapshot.external.approvals} answer={async input => { if (!await action("approval", () => bridge.answerApproval(input))) throw new Error("审批未完成，请重试。"); }} />}
    <PeerJobs local={local} />
  </>;
}
