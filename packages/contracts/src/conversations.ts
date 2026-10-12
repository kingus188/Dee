import type { AttachmentSummary } from "./attachments.js";
import type { Reminder } from "./tasks.js";

export type ConversationItem = {
  id: number; title: string; createdAt: string; archivedAt?: string | null;
  channel?: string; forkOf?: number; forkAtEntry?: number;
};
export type ServerInfo = { pid: number; startedAt: string; boots: number; model: string; api: string };
export type ToolArgs = Record<string, unknown> & { task?: string; seconds?: number };
export type RunningTool = { name: string; callId?: string; args?: ToolArgs; status: string; output?: string; details?: unknown };
export type LiveView = {
  text?: string; stream?: string;
  generation?: { text?: string; message?: { content: string | { type: string; text?: string; thinking?: string; name?: string; arguments?: ToolArgs; args?: ToolArgs }[] } };
  tools?: RunningTool[];
};
export type Usage = {
  input?: number; output?: number; inputTokens?: number; outputTokens?: number;
  totalTokens?: number; models?: Record<string, Usage>;
};
export type ViewEntry = {
  id: number; kind: "user" | "assistant" | "tool"; text: string;
  attachments?: AttachmentSummary[];
  toolCalls?: { id: string; name: string; args: ToolArgs }[];
  error?: string; toolCallId?: string; name?: string; isError?: boolean;
};
export type TaskView = {
  id: number; kind: string; status: string; phase: string | null;
  owner: number | null; background: boolean; conversationId: number; conversations: readonly number[];
};
export type ConversationView = {
  conversationId: number; entries: ViewEntry[]; live: LiveView; busy: boolean; inbox: number;
  notes: { todos: { text: string; done: boolean }[]; memos: string[] };
  usage: Usage | null; tasks: TaskView[]; reminders: Reminder[];
  subagents: { conversationId: number; task: string; status: string }[]; parentId: number | null;
};
export type MessageRequest = { text?: string; requestId?: string; mode?: "steer" | "followUp"; attachments?: import("./attachments.js").AttachmentInput[] };
export type MessageResponse = { submissionId: number };
