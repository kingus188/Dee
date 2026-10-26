import type { MailMessage, MailStatus } from "./mail.js";
import type { ExecutionRun } from "./tasks.js";

export type WorkspaceActivity = {
  id: string;
  kind: "reminder" | "schedule" | "background";
  /** Owning parent conversation, not the background worker's child conversation. */
  conversationId: number;
  conversationTitle: string;
  text: string;
  status: string;
  at: number | null;
  /** Reminders have no creation timestamp; they use the owning conversation's createdAt. */
  createdAt: number;
  result?: string | null;
  daylightTaskId?: string;
  execution?: ExecutionRun;
};
export type WorkspaceActivities = { items: WorkspaceActivity[]; total: number; truncated: boolean };
export type WorkspaceMail = {
  status: Pick<MailStatus, "enabled" | "connected" | "offline" | "syncing" | "lastSuccessAt" | "error">;
  messages: MailMessage[];
};
