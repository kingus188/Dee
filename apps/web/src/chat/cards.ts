import type { DaylightTask, UnifiedRun } from "@assistant/contracts";

export type CardGroup = "tasks" | "memory" | "skills" | "notes";
export type CardAction =
  | { label: string; kind: "request"; path: string; body?: Record<string, unknown> }
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
  runs?: UnifiedRun[];
  daylight?: { task: DaylightTask; project?: string };
  actions?: CardAction[];
};
