import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
export type ConversationStatus = "active" | "waiting" | "completed";
export const conversationStatus = (item: { status?: ConversationStatus }): ConversationStatus => item.status ?? "active";
export type ConversationItem = {
  id: ConversationId;
  title: string;
  createdAt: string;
  archivedAt?: string | null;
  archivingAt?: string | null;
  status?: ConversationStatus;
  channel?: string;
  forkOf?: ConversationId;
  forkAtEntry?: EntryId;
};
export type ConversationIndex = { items: ConversationItem[]; children?: Record<string, ConversationId> };
export const Index = defineDoc<ConversationIndex>({
	kind: "app.index",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

export const Meta = defineDoc<{ boots: number; lastBootAt: string | null }>({
	kind: "app.meta",
	version: 1,
	scope: "session",
	initial: () => ({ boots: 0, lastBootAt: null }),
});
