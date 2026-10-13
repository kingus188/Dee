export type CardGroup = "tasks" | "memory" | "skills" | "notes";
export type CardAction =
  | { label: string; kind: "request"; path: string }
  | { label: string; kind: "edit"; path: string; text: string }
  | { label: string; kind: "prompt"; text: string }
  | { label: string; kind: "link"; href: string; download?: boolean }
  | { label: string; kind: "refresh" };
export type ConversationCard = {
  key: string;
  group: CardGroup;
  title: string;
  text: string;
  status?: string;
  tone?: "pending" | "done" | "error";
  meta?: string;
  details?: string;
  actions?: CardAction[];
};
