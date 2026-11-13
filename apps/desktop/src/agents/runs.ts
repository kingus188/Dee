import type { DesktopAgentRun, DesktopAgentKind } from "@assistant/contracts";
import type { StoredAgentSession } from "./store.js";

export function nativeRequestResults(session: StoredAgentSession): Map<string, string> {
  const results = new Map<string, string[]>();
  let requestId: string | undefined;
  for (const message of session.messages) {
    if (message.role === "user") { requestId = message.id; results.set(requestId, []); }
    else if (requestId && message.id.startsWith(`${requestId}:`)) results.get(requestId)!.push(message.text);
  }
  return new Map([...results].map(([id, parts]) => [id, parts.join("\n")]));
}

export function nativeRuns(session: StoredAgentSession | undefined, agent: Exclude<DesktopAgentKind, "pi">): DesktopAgentRun[] {
  if (!session) return [];
  const results = nativeRequestResults(session);
  // Legacy messages without a request record have an unknown outcome, even if the session ended.
  return session.messages.filter(message => message.role === "user").map(message => {
    const recorded = session.requests?.[message.id]?.status;
    const status = recorded === "done" ? "succeeded" : recorded ?? "unknown";
    const result = results.get(message.id) ?? "";
    return {
      id: message.id, sessionId: session.id, nativeSessionId: session.nativeId, agent, status,
      request: message.text, result: result || null,
      cancellation: recorded === "cancelled" ? "confirmed" : recorded === "interrupted" ? "unknown" : "not_requested",
      review: "unsupported",
    };
  });
}
