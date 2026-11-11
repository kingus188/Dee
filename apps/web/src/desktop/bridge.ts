import type { DesktopAgentBridge } from "@assistant/contracts";

export type { DesktopAgentBridge } from "@assistant/contracts";

export function desktopAgentBridge(): DesktopAgentBridge | undefined {
  return (window as unknown as { desktopAgent?: DesktopAgentBridge }).desktopAgent;
}
