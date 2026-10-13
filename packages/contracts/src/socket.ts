import type { ConversationView } from "./conversations.js";

export type ApiRequest = { type: "request"; id: string; method: "GET" | "POST"; path: string; body?: Record<string, unknown> };
export type ApiResponse = { type: "response"; id: string; status: number; data?: unknown; error?: string };
export type ApiEvent = { type: "event"; event: "view"; data: ConversationView };
export type ServerMessage = ApiResponse | ApiEvent;
