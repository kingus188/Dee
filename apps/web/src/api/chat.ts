import type { MessageRequest, MessageResponse, MessageStatus } from "@assistant/contracts";
import { request } from "./request.js";
export const sendMessage = (id: string | number, body: MessageRequest) => request<MessageResponse>(`/api/conversations/${encodeURIComponent(id)}/messages`, body);
export const abortConversation = (id: string | number) => request(`/api/conversations/${encodeURIComponent(id)}/abort`, {});
export const readMessageStatus = (id: number, requestId: string) => request<MessageStatus | null>(`/api/conversations/${id}/messages?${new URLSearchParams({ requestId })}`);
