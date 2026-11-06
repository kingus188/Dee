import type { TeamsTriageItem } from "./teams-triage.js";

/** Read-only, online Teams views. Counts describe loaded pages, never unread state. */
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
  items: TeamsConversation[];
  nextCursor: string | null;
  fetchedAt: string;
};
export type TeamsConversationMedia = {
  id: string; name: string; kind: "image" | "file"; status: string; url?: string; previewUrl?: string;
};
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
