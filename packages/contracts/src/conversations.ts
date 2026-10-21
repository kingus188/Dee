import type { AttachmentSummary } from "./attachments.js";
import type { Reminder } from "./tasks.js";

export type ConversationItem = {
  id: number; title: string; createdAt: string; archivedAt?: string | null;
  channel?: string; forkOf?: number; forkAtEntry?: number;
};
export type ServerInfo = { pid: number; startedAt: string; boots: number; model: string; api: string; configured: boolean };
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
export type ConversationNotes = { todos: { text: string; done: boolean }[]; memos: string[] };
// todos 与 memos 合计最多 1000 条，每条最多 16000 字，总正文最多 128000 字。
// base 必填；保存事务中与当前笔记逐字段比较，不同返回 409，applied 幂等记录不变。
export type NotesEditRequest = { notes: ConversationNotes; base: ConversationNotes };
export type ConversationView = {
  conversationId: number; entries: ViewEntry[]; live: LiveView; busy: boolean; inbox: number;
  notes: ConversationNotes;
  usage: Usage | null; tasks: TaskView[]; reminders: Reminder[];
  subagents: { conversationId: number; task: string; status: string }[]; parentId: number | null;
};
export type MessageRequest = { text?: string; requestId?: string; mode?: "steer" | "followUp"; attachments?: import("./attachments.js").AttachmentInput[] };
export type MessageResponse = { submissionId: number };
