import type { AgentActivity, AgentApproval, AgentApprovalAnswer, ExternalAgentConfig } from "@assistant/contracts";
import type { PeerMcp } from "./peer-tools.js";

export type AgentEvent = { type: "capabilities"; nativeResume: boolean } | { type: "session"; id: string } | { type: "text"; id: string; text: string; delta?: boolean } | { type: "activity"; activity: AgentActivity };
export type AgentDriver = { send(text: string, requestId: string): Promise<void>; abort(): Promise<void>; close(): Promise<void> };
export type DriverOptions = {
  cwd: string; config: ExternalAgentConfig; sessionId?: string; signal: AbortSignal;
  searchPath?: string;
  env?: NodeJS.ProcessEnv;
  peerMcp?: PeerMcp;
  emit(event: AgentEvent): void;
  ask(request: Omit<AgentApproval, "id">, signal?: AbortSignal): Promise<AgentApprovalAnswer>;
  failed(error: Error): void;
};
export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
export const string = (value: unknown): string => typeof value === "string" ? value : "";
export function questions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const q = object(item);
    return { id: string(q.id) || string(q.question) || String(index), text: string(q.question) || string(q.header), secret: q.isSecret === true,
      options: Array.isArray(q.options) ? q.options.map(option => typeof option === "string" ? option : string(object(option).label)).filter(Boolean) : undefined };
  });
}
