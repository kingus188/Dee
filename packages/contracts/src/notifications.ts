export type NotificationPriority = "normal" | "urgent" | "approval";

export type NotificationStatus = "pending" | "sent" | "failed";

export type NotificationReadState = { keys: string[] };
export type NotificationReadPatch = { keys: string[]; read: boolean };
export type NotificationQuietHours = { enabled: boolean; start: string; end: string; timeZone: string };
export type WebhookDigestPreferences = { enabled: boolean; windowSeconds: number };
export type NotificationPreferences = { quietHours: NotificationQuietHours; webhookDigest?: WebhookDigestPreferences };

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
};

export type NotificationOverview = {
  enabled: boolean;
  mode: string;
  kind: string;
  items: NotificationRecord[];
};
