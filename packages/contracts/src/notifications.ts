export type NotificationStatus = "pending" | "sent" | "failed";

export type NotificationRecord = {
  id: string;
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
