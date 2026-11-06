import type { NotificationAttentionClass, NotificationPriority } from "@assistant/contracts";

export type NotificationConfig = { url: string; mode: string; kind: string };
type NotificationSource = { source: string; revision?: number; messageIds?: string[] };
export type NotifyEvent = (event: { id: string; type: string; text: string; failed?: boolean; priority?: NotificationPriority; sources?: NotificationSource[] }) => Promise<void>;
export function createNotifier(config: NotificationConfig, enqueue: (event: { id: string; body: string; priority?: NotificationPriority; attentionClass?: NotificationAttentionClass; sources?: NotificationSource[] }) => Promise<void>): NotifyEvent {
  return async ({ id, type, text, failed = false, priority = "normal", sources }) => {
    // A caller's default priority must not downgrade an explicit failure or approval.
    priority = failed ? "urgent" : type === "approval" ? "approval" : priority;
    const mode = config.mode || "errors";
    if (!config.url || mode === "off" || (mode === "errors" && !failed && priority === "normal")) return;
    const body = config.kind === "feishu"
      ? { msg_type: "text", content: { text } }
      : { id, type, text, failed, at: new Date().toISOString() };
    await enqueue({ id, body: JSON.stringify(body), priority, attentionClass: type === "reminder" || type === "schedule" ? "requested" : "normal", sources });
  };
}
