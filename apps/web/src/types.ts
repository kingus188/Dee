import type { ConversationView } from "@assistant/contracts";
export type { ConversationItem, RunningTool, ServerInfo, ToolArgs, Usage, ViewEntry } from "@assistant/contracts";
export type { LiveView as BrowserLive } from "@assistant/contracts";
export type BrowserView = Omit<ConversationView, "notes"> & {
  notes: Omit<ConversationView["notes"], "memos"> & { memos: (string | { text?: string })[] };
};
export type PendingAttachment = { kind: "image" | "text"; name: string; mimeType: string; size: number; data: string; previewUrl?: string };
