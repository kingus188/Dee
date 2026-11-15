import type { AgentActivity, DesktopAgentSnapshot, ExternalAgentState, DesktopRunReview } from "@assistant/contracts";

export type StoredAgentSession = {
  id: string; binding: string; nativeId?: string; status: ExternalAgentState["status"];
  messages: DesktopAgentSnapshot["messages"]; activities: AgentActivity[]; error?: string;
  reviews?: Record<string, DesktopRunReview[]>;
  requests?: Record<string, { status: "running" | "done" | "failed" | "cancelled" | "interrupted" }>;
};
