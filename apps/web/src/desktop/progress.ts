import type { DesktopAgentSnapshot } from "@assistant/contracts";

/** Silence is an observation, never a failed-task decision or a retry trigger. */
export function executionProgress(snapshot: DesktopAgentSnapshot, now = Date.now()) {
  const external = snapshot.external;
  const elapsed = (date?: string) => date && Number.isFinite(Date.parse(date)) ? Math.max(0, Math.floor((now - Date.parse(date)) / 1000)) : undefined;
  const elapsedSeconds = elapsed(external?.progress?.startedAt);
  const quietSeconds = elapsed(external?.progress?.lastEventAt ?? external?.progress?.startedAt);
  const approval = !!external?.approvals.length;
  const activity = external?.activities.findLast(item => item.status === "running");
  const waitingFor = approval ? "Approval" : snapshot.busy ? activity ? "Tool result" : "Execution result" : "Nothing";
  return { waitingFor, elapsedSeconds, quietSeconds, activity: snapshot.busy ? activity?.title : undefined,
    quiet: !!snapshot.busy && !approval && quietSeconds !== undefined && quietSeconds >= 120 };
}
