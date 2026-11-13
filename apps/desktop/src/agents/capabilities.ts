import type { AgentCapabilities, DesktopAgentKind } from "@assistant/contracts";

// These describe Dee's implemented adapters, not every feature of the upstream CLI.
export function agentCapabilities(kind: DesktopAgentKind, canResume?: boolean): AgentCapabilities {
  return {
    nativeResume: kind === "acp" || kind === "omp" ? canResume === undefined ? "unknown" : canResume ? "supported" : "unsupported" : "supported",
    approval: kind === "pi" ? "tool-callback" : "provider-request",
    cancellation: kind === "pi" ? "runtime-task" : "process-stop",
    historyTransfer: "text-only", rollback: false,
  };
}
