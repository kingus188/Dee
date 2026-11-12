import type { TeamsTriageItem } from "./teams-triage.js";

/** Online Teams views. Counts describe loaded pages, never unread state. */
export type TeamsConversation = {
  id: string;
  title: string;
  kind: "oneOnOne" | "group" | "meeting" | "unknown";
  updatedAt?: string;
  preview?: string;
  sourceUrl?: string;
};
export type TeamsConversationList = {
  available: boolean;
  canSend?: boolean;
  items: TeamsConversation[];
  nextCursor: string | null;
  fetchedAt: string;
};
export type TeamsConversationReply = { requestId: string; chatId: string; text: string };
export type TeamsConversationReplyResult = {
  requestId: string;
  chatId: string;
  state: "sending" | "sent" | "rejected" | "unknown";
  error?: string;
};
export type TeamsConversationMedia = {
  id: string; name: string; kind: "image" | "file"; status: string; url?: string; previewUrl?: string;
};
export type TeamsChatRecord = { chatId: string; id: string; chatLabel: string; sender: string; createdAt: string; text: string; direction?: "in" | "out" | "unknown"; deleted?: boolean; media: TeamsConversationMedia[] };
export type TeamsConversationMessage = {
  id: string;
  chatId: string;
  senderName: string;
  direction: "in" | "out" | "unknown";
  createdAt: string;
  modifiedAt?: string;
  text: string;
  deleted: boolean;
  unavailable: boolean;
  sourceUrl?: string;
  media: TeamsConversationMedia[];
  suggestion?: TeamsTriageItem;
};
export type TeamsConversationMessages = {
  chatId: string;
  items: TeamsConversationMessage[];
  nextCursor: string | null;
  fetchedAt: string;
};
