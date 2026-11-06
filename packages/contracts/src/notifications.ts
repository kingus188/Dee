export type NotificationPriority = "normal" | "urgent" | "approval";

export type NotificationStatus = "pending" | "sent" | "failed" | "cancelled";

export type NotificationReadState = { keys: string[] };
export type NotificationReadPatch = { keys: string[]; read: boolean };
export type NotificationQuietHours = { enabled: boolean; start: string; end: string; timeZone: string };
export type WebhookDigestPreferences = { enabled: boolean; windowSeconds: number };
export type WebhookAttentionPreferences = { enabled: boolean; maxPerHour: number; cooldownSeconds: number };
/** Requested reminders and schedules retain their existing delivery timing. */
export type NotificationAttentionClass = "normal" | "requested" | "unclassified";
export type NotificationDeliveryReason = "ready" | "quiet_hours" | "cooldown" | "hourly_budget" | "retry_backoff" | "digest_window";
export type NotificationPreferences = { quietHours: NotificationQuietHours; webhookDigest?: WebhookDigestPreferences; webhookAttention?: WebhookAttentionPreferences };

export type NotificationRecord = {
  id: string;
  /** Present for persisted digest delivery units; source records remain stored. */
  memberIds?: string[];
  status: NotificationStatus;
  attempts: number;
  nextAt: number;
  createdAt: number;
  finishedAt: number | null;
  lastError: string | null;
  /** Structured policy explanation only; never contains message content or destination. */
  delivery?: { priority: NotificationPriority; category: NotificationAttentionClass; reason: NotificationDeliveryReason };
};

export type NotificationOverview = {
  enabled: boolean;
  mode: string;
  kind: string;
  items: NotificationRecord[];
};
