import type { NotificationPriority } from "@assistant/contracts";

export type NotificationConfig = { url: string; mode: string; kind: string };
export type NotifyEvent = (event: { id: string; type: string; text: string; failed?: boolean; priority?: NotificationPriority }) => Promise<void>;
export function createNotifier(config: NotificationConfig, enqueue: (event: { id: string; body: string; priority?: NotificationPriority }) => Promise<void>): NotifyEvent {
  return async ({ id, type, text, failed = false, priority = failed ? "urgent" : type === "approval" ? "approval" : "normal" }) => {
    const mode = config.mode || "errors";
    if (!config.url || mode === "off" || (mode === "errors" && !failed && priority === "normal")) return;
    const body = config.kind === "feishu"
      ? { msg_type: "text", content: { text } }
      : { id, type, text, failed, at: new Date().toISOString() };
    await enqueue({ id, body: JSON.stringify(body), priority });
  };
}
